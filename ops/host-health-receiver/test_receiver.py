import copy
import hashlib
import json
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

from receiver import Accepted, Receiver, Store, encode, read_config, strict_json, subscribe_accepted, timestamp, utc, validate_payload


class ReceiverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = 1800000000.0
        self.cfg = json.loads((Path(__file__).parent / "config.example.json").read_text())
        self.cfg["state_directory"] = str(self.root / "state")
        self.cfg["mqtt"]["password_file"] = str(self.root / "password")
        (self.root / "config.json").write_text(json.dumps(self.cfg))
        self.cfg = read_config(str(self.root / "config.json"))
        self.source = self.cfg["sources"][0]
        self.receiver = Receiver(self.cfg, now=lambda: self.now)
        self.boot = str(uuid.uuid4())
        self.acks = []
        self.client = types.SimpleNamespace(ack=lambda mid, qos: self.acks.append((mid, qos)))

    def tearDown(self):
        self.receiver.store.close()
        self.temp.cleanup()

    def value(self, sequence=1, at=None):
        return {"schema_version": 1, "message_id": str(uuid.uuid4()), "site_id": self.source["site_id"],
            "host_id": self.source["host_id"], "boot_id": self.boot, "sequence": sequence,
            "read_time_utc": utc(self.now if at is None else at), "uptime_seconds": 1000 + sequence,
            "metrics": {"memory_available_bytes": 300000000, "cpu_iowait_pct": 0.2},
            "conditions": {key: {"state": "good", "severity": "warning", "incident_id": None, "detail_code": "none"}
                for key in ("memory_pressure", "io_pressure", "temperature", "storage")}, "actions": []}

    def action(self, result="claimed", at=None):
        return {"event_id": str(uuid.uuid4()), "action_id": str(uuid.uuid4()), "incident_id": str(uuid.uuid4()),
            "action_time_utc": utc(self.now if at is None else at), "kind": "restart_proxy", "result": result, "target_id": "proxy"}

    def send(self, value, **kwargs):
        packet = types.SimpleNamespace(topic=self.source["topic"], payload=encode(value), mid=12, qos=1, retain=False)
        for key, item in kwargs.items():
            setattr(packet, key, item)
        self.receiver.message(self.client, packet)

    def exported(self):
        return json.loads((self.receiver.store.exports / (self.source["id"] + ".json")).read_text())

    def test_config_rejects_wildcard_and_duplicate_source(self):
        for mutate in (lambda c: c["sources"][0].update(topic="iot/v1/example-site/+/host-health"),
                       lambda c: c["sources"].append(copy.deepcopy(c["sources"][0]))):
            candidate = copy.deepcopy(self.cfg); mutate(candidate)
            (self.root / "bad.json").write_text(json.dumps(candidate))
            with self.assertRaises(ValueError):
                read_config(str(self.root / "bad.json"))

    def test_config_rejects_plaintext_url_and_url_secrets(self):
        for url in ("mqtt://broker.example.invalid:1883", "mqtts://" + "u:secret@broker.example.invalid:8883", "mqtts://broker.example.invalid:8883/?token=x"):
            candidate = copy.deepcopy(self.cfg); candidate["mqtt"]["url"] = url
            (self.root / "bad.json").write_text(json.dumps(candidate))
            with self.assertRaises(ValueError):
                read_config(str(self.root / "bad.json"))

    def test_bool_schema_version_is_not_integer_protocol_version(self):
        candidate = copy.deepcopy(self.cfg); candidate["schema_version"] = True
        (self.root / "bad.json").write_text(json.dumps(candidate))
        with self.assertRaises(ValueError): read_config(str(self.root / "bad.json"))

    def test_suback_must_grant_exactly_qos_one_for_every_topic(self):
        self.assertTrue(subscribe_accepted([types.SimpleNamespace(value=1)], 1))
        for reasons in ([types.SimpleNamespace(value=0)], [types.SimpleNamespace(value=128)], [], [True]):
            self.assertFalse(subscribe_accepted(reasons, 1))

    def test_exact_wire_export_and_hash_before_ack(self):
        value = self.value()
        def ack(mid, qos):
            self.assertEqual(self.exported()["payload_sha256"], hashlib.sha256(encode(value)).hexdigest())
            self.assertEqual(self.receiver.store.db.execute("SELECT count(*) FROM messages").fetchone()[0], 1)
            self.acks.append((mid, qos))
        self.client.ack = ack
        self.send(value)
        exported = self.exported()
        self.assertEqual(exported["message_id"], value["message_id"])
        self.assertEqual(exported["read_time_utc"], value["read_time_utc"])
        self.assertNotIn("sample", exported)
        self.assertEqual(self.acks, [(12, 1)])

    def test_duplicate_repairs_export_after_restart_without_freshness_change(self):
        value = self.value()
        self.send(value)
        original = self.exported()
        self.receiver.store.close()
        self.receiver.store = Store(self.cfg, lambda: self.now)
        (self.receiver.store.exports / (self.source["id"] + ".json")).unlink()
        self.now += 50
        self.send(value)
        self.assertEqual(self.exported(), original)
        self.assertEqual(self.receiver.store.counts()["duplicates"], 1)

    def test_same_id_changed_bytes_rejected_without_replacing(self):
        value = self.value(); self.send(value); first = self.exported()
        value["metrics"]["memory_available_bytes"] += 1
        self.send(value)
        self.assertEqual(self.exported(), first)
        self.assertEqual(self.receiver.store.counts()["conflicts"], 1)
        self.assertEqual(self.receiver.store.counts()["rejected"], 1)

    def test_retained_wrong_topic_and_qos_are_not_current_health(self):
        value = self.value()
        self.send(value, retain=True)
        self.send(value, topic="iot/v1/example-site/other/host-health")
        self.send(value, qos=0)
        self.assertFalse((self.receiver.store.exports / (self.source["id"] + ".json")).exists())
        self.assertEqual(self.receiver.store.counts()["rejected"], 3)

    def test_future_clock_rejected_and_old_replay_does_not_advance(self):
        self.send(self.value(at=self.now + 31))
        current = self.value(2); self.send(current); first = self.exported()
        self.send(self.value(1, self.now - 20))
        self.send(self.value(3, self.now - 181))
        self.assertEqual(self.exported(), first)

    def test_sequence_rollback_same_boot_is_stale(self):
        self.send(self.value(10))
        self.now += 5
        self.send(self.value(9))
        self.assertEqual(self.exported()["sequence"], 10)
        self.assertEqual(self.receiver.store.counts()["stale"], 1)

    def test_new_boot_can_restart_sequence_with_later_timestamp(self):
        self.send(self.value(10))
        self.now += 5; self.boot = str(uuid.uuid4())
        self.send(self.value(1))
        self.assertEqual(self.exported()["sequence"], 1)

    def test_schema_unknown_fields_and_duplicate_json_keys_rejected(self):
        value = self.value(); value["command"] = "unsafe"
        with self.assertRaises(ValueError):
            validate_payload(self.source, encode(value), self.now)
        with self.assertRaises(ValueError):
            strict_json(b'{"schema_version":1,"schema_version":2}')

    def test_metric_types_missing_psi_and_ranges(self):
        value = self.value()
        self.assertNotIn("psi_io_some_avg10_pct", validate_payload(self.source, encode(value), self.now).document["metrics"])
        for metrics in ({"cpu_iowait_pct": 101}, {"memory_available_bytes": True}, {"memory_available_bytes": 0.5}, {"cpu_temperature_c": 151}, {"unlisted_metric": 1}):
            value["metrics"] = metrics
            with self.assertRaises(ValueError):
                validate_payload(self.source, encode(value), self.now)

    def test_condition_bad_requires_uuid_and_all_four_conditions(self):
        value = self.value(); value["conditions"]["memory_pressure"]["state"] = "bad"
        with self.assertRaises(ValueError):
            validate_payload(self.source, encode(value), self.now)
        value["conditions"]["memory_pressure"]["incident_id"] = str(uuid.uuid4())
        validate_payload(self.source, encode(value), self.now)
        value["conditions"].pop("storage")
        with self.assertRaises(ValueError):
            validate_payload(self.source, encode(value), self.now)

    def test_optional_masked_process_diagnostics_persist_export_before_ack(self):
        value = self.value()
        value['diagnostics'] = {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 123456789}}
        def ack(mid, qos):
            self.assertEqual(self.exported()['diagnostics'], value['diagnostics'])
            self.assertEqual(self.exported()['payload_sha256'], hashlib.sha256(encode(value)).hexdigest())
            self.acks.append((mid, qos))
        self.client.ack = ack
        self.send(value)
        self.assertEqual(self.acks, [(12, 1)])
        self.receiver.store.close(); self.receiver.store = Store(self.cfg, lambda: self.now)
        self.receiver.store.export(self.source['id'])
        self.assertEqual(self.exported()['diagnostics'], value['diagnostics'])

    def test_middle_masked_name_and_optional_executable_path_export(self):
        value = self.value()
        value['diagnostics'] = {'memory_top_process': {'name_masked': 'examp***worker', 'rss_bytes': 123456789,
                                                     'path_masked': '/usr/bin/n**e'}}
        self.send(value)
        self.assertEqual(self.exported()['diagnostics'], value['diagnostics'])
        self.assertEqual(self.exported()['payload_sha256'], hashlib.sha256(encode(value)).hexdigest())
        for index, name in enumerate(('a', 'ab', 'n**e', 'pyt***3', '***', 'no***')):
            value = self.value(index + 2, self.now + index + 1)
            value['diagnostics'] = {'memory_top_process': {'name_masked': name, 'rss_bytes': 0}}
            validate_payload(self.source, encode(value), self.now)

    def test_unmasked_or_invalid_executable_paths_rejected_without_replacing_latest(self):
        self.send(self.value()); original = self.exported()
        for path in (None, '', 'usr/bin/n**e', '/usr/bin/node', '/usr/bin/***', '/usr/bin/no***',
                     '/usr/bin/n****e', '/usr//bin/n**e', '/usr/../bin/n**e', '/usr/bin/n**e\n',
                     '/usr/.' + '/n**e', '/usr/' + 'x' * 508 + '/n**e'):
            with self.subTest(path=str(path)[:30]):
                value = self.value(2)
                value['diagnostics'] = {'memory_top_process': {'name_masked': 'n**e', 'rss_bytes': 1, 'path_masked': path}}
                with self.assertRaises(ValueError):
                    validate_payload(self.source, encode(value), self.now)
                self.send(value)
                self.assertEqual(self.exported(), original)

    def test_malformed_or_unmasked_diagnostics_rejected_without_replacing_latest(self):
        self.send(self.value()); original = self.exported()
        for bad in (None, {}, {'other': 1}, {'memory_top_process': None},
                    {'memory_top_process': {'name_masked': 'example-worker', 'rss_bytes': 1}},
                    {'memory_top_process': {'name_masked': 'abc***', 'rss_bytes': 1}},
                    {'memory_top_process': {'name_masked': 'ex***\n', 'rss_bytes': 1}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': True}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 1.0}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': -1}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 2**53}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 1, 'pid': 123}}):
            with self.subTest(bad=bad):
                value = self.value(2); value['diagnostics'] = bad
                with self.assertRaises(ValueError):
                    validate_payload(self.source, encode(value), self.now)
                self.send(value)
                self.assertEqual(self.exported(), original)

    def test_transient_actions_survive_next_snapshot_and_restart(self):
        value = self.value(); value["actions"] = [self.action()]; self.send(value)
        self.now += 60; self.send(self.value(2))
        self.assertEqual(self.exported()["actions"], value["actions"])
        self.receiver.store.close(); self.receiver.store = Store(self.cfg, lambda: self.now)
        self.receiver.store.export(self.source["id"])
        self.assertEqual(self.exported()["actions"], value["actions"])

    def test_stale_sample_can_add_recent_action_but_not_refresh_resource(self):
        current = self.value(2); self.send(current); first = self.exported()
        old = self.value(1, self.now - 240); old["actions"] = [self.action(at=self.now - 250)]
        self.send(old)
        exported = self.exported()
        self.assertEqual(exported["message_id"], first["message_id"])
        self.assertEqual(exported["receive_time_utc"], first["receive_time_utc"])
        self.assertEqual(len(exported["actions"]), 1)

    def test_action_older_than_seven_days_not_newly_queued(self):
        value = self.value(); value["actions"] = [self.action(at=self.now - 604801)]
        self.send(value)
        self.assertEqual(self.exported()["actions"], [])

    def test_three_day_action_is_archived_without_advancing_resource_watermarks(self):
        current = self.value(2); self.send(current); first = self.exported()
        old = self.value(1, self.now - 3 * 86400)
        old["actions"] = [self.action(at=self.now - 3 * 86400)]
        self.send(old)
        exported = self.exported()
        self.assertEqual(exported["message_id"], first["message_id"])
        self.assertEqual(exported["read_time_utc"], first["read_time_utc"])
        self.assertEqual(exported["receive_time_utc"], first["receive_time_utc"])
        self.assertEqual(exported["actions"], old["actions"])

    def test_first_stale_sample_exports_action_with_original_time_then_fresh_replaces(self):
        old = self.value(1, self.now - 3600)
        old["actions"] = [self.action(at=self.now - 10)]
        self.send(old)
        exported = self.exported()
        self.assertEqual(exported["message_id"], old["message_id"])
        self.assertEqual(exported["read_time_utc"], old["read_time_utc"])
        self.assertEqual(exported["receive_time_utc"], utc(self.now))
        self.assertEqual(exported["actions"], old["actions"])
        self.assertEqual(self.receiver.store.counts().get("saved", 0), 0)
        self.assertEqual(self.receiver.store.counts()["stale"], 1)
        self.now += 10
        current = self.value(2); self.send(current)
        exported = self.exported()
        self.assertEqual(exported["message_id"], current["message_id"])
        self.assertEqual(exported["read_time_utc"], current["read_time_utc"])
        self.assertEqual(exported["actions"], old["actions"])

    def test_recent_reconciliation_action_is_independent_of_old_resource_time(self):
        current = self.value(2); self.send(current); first = self.exported()
        old = self.value(1, self.now - 3600)
        old["actions"] = [self.action(result="uncertain", at=self.now - 10)]
        self.send(old)
        exported = self.exported()
        self.assertEqual(exported["message_id"], first["message_id"])
        self.assertEqual(exported["read_time_utc"], first["read_time_utc"])
        self.assertEqual(exported["receive_time_utc"], first["receive_time_utc"])
        self.assertEqual(exported["actions"], old["actions"])

    def test_action_event_id_is_immutable(self):
        value = self.value(); action = self.action(); value["actions"] = [action]; self.send(value)
        self.now += 60; changed = self.value(2); changed["actions"] = [dict(action, result="failed")]
        self.send(changed)
        self.assertEqual(self.exported()["message_id"], value["message_id"])
        self.assertEqual(self.receiver.store.counts()["rejected"], 1)

    def test_future_action_and_arbitrary_target_rejected(self):
        value = self.value(); value["actions"] = [self.action(at=self.now + 31)]
        with self.assertRaises(ValueError): validate_payload(self.source, encode(value), self.now)
        value["actions"][0] = self.action(); value["actions"][0]["target_id"] = "other-service"
        with self.assertRaises(ValueError): validate_payload(self.source, encode(value), self.now)

    def test_message_count_limit_and_restart_recovery(self):
        self.cfg["limits"]["max_records"] = 64
        for number in range(70):
            self.now += 1; self.send(self.value(number + 1))
        self.assertEqual(self.receiver.store.db.execute("SELECT count(*) FROM messages").fetchone()[0], 64)
        self.assertEqual(self.exported()["sequence"], 70)

    def test_export_failure_never_acknowledges_and_duplicate_repairs(self):
        value = self.value()
        with patch("receiver.atomic_json", side_effect=OSError("fixture disk full")):
            with self.assertRaises(OSError): self.send(value)
        self.assertEqual(self.acks, [])
        self.send(value)
        self.assertEqual(self.exported()["message_id"], value["message_id"])
        self.assertEqual(self.acks, [(12, 1)])

    def test_export_value_error_is_storage_failure_not_poison_ack(self):
        value = self.value()
        with patch("receiver.atomic_json", side_effect=ValueError("EXPORT_TOO_LARGE")):
            with self.assertRaises(ValueError): self.send(value)
        self.assertEqual(self.acks, [])
        self.assertEqual(self.receiver.error, "STORAGE_PERSISTENCE_FAILED")
        committed = self.receiver.store.db.execute("SELECT id FROM messages").fetchall()
        self.assertEqual([row[0] for row in committed], [value["message_id"]])
        self.send(value)
        self.assertEqual(self.exported()["message_id"], value["message_id"])
        self.assertEqual(self.acks, [(12, 1)])

    def test_action_capacity_does_not_ack_or_drop_existing_audit(self):
        value = self.value(); value["actions"] = [self.action()]; self.send(value)
        action = value["actions"][0]
        with self.receiver.store.db:
            for number in range(255):
                other = dict(action, event_id=str(uuid.uuid4()))
                raw = encode(other)
                self.receiver.store.db.execute("INSERT INTO actions VALUES(?,?,?,?,?)", (other["event_id"], self.source["id"], hashlib.sha256(raw).hexdigest(), self.now, raw.decode()))
        self.acks.clear(); self.now += 1
        new = self.value(2); new["actions"] = [self.action()]
        with self.assertRaises(RuntimeError): self.send(new)
        self.assertEqual(self.acks, [])
        self.assertEqual(self.receiver.store.db.execute("SELECT count(*) FROM actions").fetchone()[0], 256)

    def test_health_has_real_connection_state_without_secrets(self):
        self.receiver.health()
        health = json.loads((self.receiver.store.exports / "health.json").read_text())
        self.assertFalse(health["connected"]); self.assertFalse(health["subscribed"])
        self.assertEqual(health["last_error"], "NOT_CONNECTED")
        self.assertNotIn("mqtt", health)
        self.receiver.connected = self.receiver.subscribed = True; self.receiver.error = None; self.receiver.health()
        self.assertEqual(json.loads((self.receiver.store.exports / "health.json").read_text())["quality"], "ok")


if __name__ == "__main__":
    unittest.main()
