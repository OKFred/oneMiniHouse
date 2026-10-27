import copy
import json
import sqlite3
import subprocess
from pathlib import Path
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch

from supervisor import (Observation, Supervisor, bounded_json, evaluate, load_config,
                        post_feishu, post_feishu_http, resource_observations, timestamp, utc, webhook_url, State, device_check_key)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.now = 1800000000.0
        config = json.loads((Path(__file__).parent / "config.example.json").read_text(encoding="utf-8"))
        config["state_directory"] = str(self.root / "state")
        config["ingestor_health_file"] = str(self.root / "observed.json")
        config["storage"] = []
        config.pop("wal")
        config["notifications"]["webhook_file"] = str(self.root / "webhook")
        (self.root / "webhook").write_text("https://open.feishu.cn/open-apis/bot/v2/hook/example-token", encoding="utf-8")
        (self.root / "config.json").write_text(json.dumps(config), encoding="utf-8")
        self.cfg = load_config(str(self.root / "config.json"))
        self.monitor = Supervisor(self.cfg, self.now - 600)
        self.health = self.good_health(self.now)
        self.write_health()

    def tearDown(self):
        self.monitor.state.close()
        self.temporary.cleanup()

    def good_health(self, now):
        return {
            "heartbeat_time_utc": utc(now), "intake_paused": False, "mqtt_connected": True,
            "processing_failed": 0, "delivery_failed": 0,
            "mqtt_connections": [{"client_id": name, "connected": True, "subscribed": True} for name in self.cfg["mqtt_client_ids"]],
            "targets": {name: {"last_success_time_utc": utc(now), "error": None} for name in self.cfg["targets"]},
            "local_pending": 0, "supabase_pending": 0, "d1_pending": 0,
            "queued": 0, "outstanding_raw": 0, "oldest_pending_time_utc": None,
            "business_health": {"schema_version": 1, "runtime_start_time_utc": utc(now - 600), "event_loop_lag_ms": 5,
                "storage": {"temp_directory": "/app/data/sqlite-tmp", "temp_free_bytes": 5000000, "temp_total_bytes": 10000000, "temp_free_inodes": 90, "temp_total_inodes": 100, "sqlite_wal_bytes": 0},
                "devices": {"example-site/example-gateway/temperature-example": {
                    "site_id": "example-site", "gateway_id": "example-gateway", "device_id": "temperature-example",
                    "last_received_time_utc": utc(now), "last_collect_time_utc": utc(now),
                    "last_valid_time_utc": utc(now), "last_sample_time_utc": None,
                    "consecutive_invalid_samples": 0, "last_invalid_metrics": [], "clock_invalid": False}}}}

    def write_health(self, now=None):
        if now is not None:
            self.health["heartbeat_time_utc"] = utc(now)
        Path(self.cfg["ingestor_health_file"]).write_text(json.dumps(self.health), encoding="utf-8")

    def fresh_ticks(self, start, duration=180):
        for offset in range(0, duration + 1, 60):
            moment = start + offset
            for device in self.health.get("business_health", {}).get("devices", {}).values():
                device["last_collect_time_utc"] = utc(moment)
            self.write_health(moment)
            self.monitor.tick(moment)

    def faults(self):
        return [dict(row) for row in self.monitor.state.db.execute("SELECT * FROM fault WHERE active=1")]

    def outbox(self):
        return [dict(row) for row in self.monitor.state.db.execute("SELECT * FROM outbox WHERE suspended_time_utc IS NULL ORDER BY create_time_utc")]

    def all_outbox(self):
        return [dict(row) for row in self.monitor.state.db.execute("SELECT * FROM outbox ORDER BY create_time_utc")]

    def test_healthy_pipeline(self):
        status = self.monitor.tick(self.now)
        self.assertEqual(status["quality"], "ok")
        self.assertEqual(status["notification_pending"], 0)

    def test_mqtt_sustained_threshold_independent_connection(self):
        self.health["mqtt_connections"][1]["connected"] = False
        self.write_health()
        self.monitor.tick(self.now)
        self.assertFalse(self.faults())
        self.write_health(self.now + 179)
        self.monitor.tick(self.now + 179)
        self.assertFalse(self.faults())
        self.write_health(self.now + 180)
        self.monitor.tick(self.now + 180)
        self.assertEqual([entry["key"] for entry in self.faults()], ["mqtt:example-ingestor-secondary"])

    def test_missing_expected_mqtt_connection(self):
        self.health["mqtt_connections"].pop()
        self.write_health()
        self.monitor.tick(self.now)
        self.write_health(self.now + 180)
        self.monitor.tick(self.now + 180)
        self.assertIn("mqtt:example-ingestor-secondary", [entry["key"] for entry in self.faults()])

    def test_malformed_mqtt_identity_does_not_crash_or_clear_existing_fault(self):
        key = "mqtt:example-ingestor-primary"
        with self.monitor.state.db:
            self.monitor.reconcile([Observation(key, "bad", "existing fault")], self.now)
        for malformed in ([], {}, 123, None):
            with self.subTest(identity=malformed):
                self.health["mqtt_connections"][0]["client_id"] = malformed
                self.write_health()
                status = self.monitor.tick(self.now)
                self.assertEqual(status["quality"], "degraded")
                self.assertIn(key, [entry["key"] for entry in status["active_faults"]])
                row = self.monitor.state.db.execute("SELECT good_since_time_utc FROM fault WHERE key=?", (key,)).fetchone()
                self.assertIsNone(row[0])

    def test_malformed_or_duplicate_device_identity_cannot_prove_recovery(self):
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        with self.monitor.state.db:
            self.monitor.reconcile([Observation(key, "bad", "existing fault")], self.now)
        record = next(iter(self.health["business_health"]["devices"].values()))
        variants = [dict(record, **{field: value}) for field in ("site_id", "gateway_id", "device_id") for value in ([], {})]
        for records in [[entry] for entry in variants] + [[record, dict(record)]]:
            with self.subTest(records=records):
                self.health["business_health"]["devices"] = records
                self.write_health()
                status = self.monitor.tick(self.now)
                self.assertIn(key, [entry["key"] for entry in status["active_faults"]])
                row = self.monitor.state.db.execute("SELECT good_since_time_utc FROM fault WHERE key=?", (key,)).fetchone()
                self.assertIsNone(row[0])

    def test_empty_mqtt_snapshot_then_restored_clears_generic_and_clients(self):
        self.health["mqtt_connections"] = []
        self.write_health()
        self.monitor.tick(self.now)
        self.write_health(self.now + 180)
        self.monitor.tick(self.now + 180)
        self.assertIn("mqtt:status", [entry["key"] for entry in self.faults()])
        self.health["mqtt_connections"] = self.good_health(self.now)["mqtt_connections"]
        self.fresh_ticks(self.now + 240)
        self.assertFalse(any(entry["key"].startswith("mqtt:") for entry in self.faults()))

    def test_stale_health_cannot_clear_previous_fault(self):
        self.monitor.reconcile([Observation("device:a", "bad", "故障")], self.now)
        self.monitor.state.db.commit()
        self.write_health(self.now - 1000)
        self.monitor.tick(self.now)
        self.assertIn("device:a", [entry["key"] for entry in self.faults()])
        self.assertIn("ingestor:heartbeat", [entry["key"] for entry in self.faults()])

    def test_missing_malformed_and_oversized_health(self):
        path = Path(self.cfg["ingestor_health_file"])
        for content in ("not-json", "[]", "{" * 1048577):
            path.write_text(content, encoding="utf-8")
            status = self.monitor.tick(self.now)
            self.assertIn("ingestor:heartbeat", [entry["key"] for entry in status["active_faults"]])
        path.unlink()
        self.assertEqual(self.monitor.tick(self.now)["quality"], "degraded")

    def test_fresh_malformed_schema_does_not_recover_fault(self):
        self.monitor.reconcile([Observation("mqtt:example-ingestor-primary", "bad", "故障")], self.now)
        self.monitor.state.db.commit()
        self.health.pop("mqtt_connections")
        self.write_health()
        keys = [entry["key"] for entry in self.monitor.tick(self.now)["active_faults"]]
        self.assertIn("ingestor:health_schema", keys)
        self.assertIn("mqtt:example-ingestor-primary", keys)

    def test_target_idle_not_failure_pending_without_success_is_failure(self):
        self.health["targets"]["local"]["last_success_time_utc"] = None
        self.write_health()
        self.assertEqual(self.monitor.tick(self.now)["quality"], "ok")
        self.health["local_pending"] = 2
        self.write_health()
        self.monitor.tick(self.now)
        self.write_health(self.now + 300)
        self.monitor.tick(self.now + 300)
        self.assertIn("target:local", [entry["key"] for entry in self.faults()])

    def test_missing_target_status_does_not_clear_fault(self):
        self.monitor.reconcile([Observation("target:local", "bad", "故障")], self.now)
        self.monitor.state.db.commit()
        self.health.pop("local_pending")
        self.health["targets"].pop("local")
        self.write_health()
        result = self.monitor.tick(self.now)
        self.assertTrue(result["unknown_checks"])
        self.assertIn("target:local", [entry["key"] for entry in self.faults()])

    def test_backlog_replay_does_not_prove_device_fresh(self):
        device = next(iter(self.health["business_health"]["devices"].values()))
        device["last_received_time_utc"] = utc(self.now)
        device["last_collect_time_utc"] = utc(self.now - 3600)
        self.write_health()
        result = self.monitor.tick(self.now)
        self.assertIn("device:example-site/example-gateway/temperature-example:freshness", [entry["key"] for entry in result["active_faults"]])

    def test_future_sample_clock_invalid(self):
        device = next(iter(self.health["business_health"]["devices"].values()))
        device["last_collect_time_utc"] = utc(self.now + 600)
        device["clock_invalid"] = True
        self.write_health()
        self.assertTrue(any("采样时间无效" in entry["detail"] for entry in self.monitor.tick(self.now)["active_faults"]))

    def test_invalid_samples_distinct_from_stale(self):
        device = next(iter(self.health["business_health"]["devices"].values()))
        device["consecutive_invalid_samples"] = 3
        self.write_health()
        faults = self.monitor.tick(self.now)["active_faults"]
        self.assertTrue(any(entry["key"].endswith(":validity") for entry in faults))
        self.assertFalse(any(entry["key"].endswith(":freshness") for entry in faults))
        device["consecutive_invalid_samples"] = 1
        self.write_health()
        self.monitor.tick(self.now)
        self.assertTrue(any(entry["key"].endswith(":validity") for entry in self.faults()))
        device["consecutive_invalid_samples"] = 0
        self.fresh_ticks(self.now)
        self.assertFalse(self.faults())

    def test_unknown_actual_measure_time_is_not_fabricated(self):
        self.cfg["devices"][0]["require_actual_sample"] = True
        result = self.monitor.tick(self.now)
        self.assertFalse(result["active_faults"])
        self.assertTrue(any(entry["key"].endswith(":actual_sample") for entry in result["unknown_checks"]))

    def test_startup_grace_device_missing(self):
        self.monitor.startup = self.now
        self.health["business_health"]["devices"] = {}
        self.write_health()
        self.assertFalse(self.monitor.tick(self.now)["active_faults"])
        self.write_health(self.now + 301)
        self.assertTrue(self.monitor.tick(self.now + 301)["active_faults"])

    def test_queue_severity_replaces_old_pending_notification(self):
        self.health["outstanding_raw"] = 2
        self.health["oldest_pending_time_utc"] = (self.now - 600) * 1000
        self.write_health()
        self.monitor.tick(self.now)
        self.assertEqual(self.outbox()[0]["severity"], "warning")
        self.write_health(self.now + 1200)
        self.monitor.tick(self.now + 1200)
        alerts = [entry for entry in self.outbox() if entry["fault_key"] == "queue:all"]
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["severity"], "critical")

    def test_persistence_restart_recovery_notification(self):
        self.cfg["notifications"]["enabled"] = True
        self.monitor.reconcile([Observation("test", "bad", "测试故障")], self.now)
        self.monitor.state.db.commit()
        self.assertEqual(self.monitor.deliver(self.now, lambda *_: True), "sent")
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 60)
        self.monitor.reconcile([Observation("test", "good", "正常")], self.now + 60)
        self.monitor.state.db.commit()
        self.assertFalse(self.outbox())
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 120)
        for offset in (120, 180, 240):
            self.monitor.reconcile([Observation("test", "good", "正常")], self.now + offset)
            self.monitor.state.db.commit()
        self.assertEqual(self.outbox()[0]["kind"], "recovery")
        # Repeated good checks must retain the pending recovery until delivered.
        self.monitor.reconcile([Observation("test", "good", "正常")], self.now + 300)
        self.monitor.state.db.commit()
        self.assertEqual(len(self.outbox()), 1)
        self.assertEqual(self.monitor.deliver(self.now + 300, lambda *_: True), "sent")

    def test_unsent_fault_removed_on_recovery_no_false_recovery(self):
        self.monitor.reconcile([Observation("test", "bad", "测试故障")], self.now)
        self.monitor.reconcile([Observation("test", "good", "正常")], self.now + 60)
        self.monitor.state.db.commit()
        self.assertFalse(self.outbox())

    def test_deduplicate_and_repeat_only_hourly(self):
        self.cfg["notifications"]["enabled"] = True
        bad = [Observation("test", "bad", "测试故障")]
        self.monitor.reconcile(bad, self.now)
        self.monitor.state.db.commit()
        self.monitor.deliver(self.now, lambda *_: True)
        self.monitor.reconcile(bad, self.now + 3599)
        self.assertFalse(self.outbox())
        self.monitor.reconcile(bad, self.now + 3600)
        self.assertEqual(len(self.outbox()), 1)

    def test_webhook_timeout_retries_persisted(self):
        self.cfg["notifications"]["enabled"] = True
        self.monitor.reconcile([Observation("test", "bad", "测试故障")], self.now)
        self.monitor.state.db.commit()
        def timeout(*_):
            raise TimeoutError("sensitive response must never be logged")
        self.assertEqual(self.monitor.deliver(self.now, timeout), "failed")
        self.assertEqual(self.outbox()[0]["attempts"], 1)
        self.assertEqual(self.monitor.deliver(self.now + 59, timeout), "idle")
        self.assertEqual(self.monitor.deliver(self.now + 60, timeout), "failed")
        self.assertEqual(self.outbox()[0]["attempts"], 2)

    def test_notification_request_budget_counts_failure(self):
        self.cfg["notifications"].update(enabled=True, requests_per_hour=1)
        self.monitor.reconcile([Observation("test", "bad", "测试故障")], self.now)
        self.monitor.state.db.commit()
        self.monitor.deliver(self.now, lambda *_: False)
        self.assertEqual(self.monitor.deliver(self.now + 60, lambda *_: True), "budget_exhausted")
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)

    def test_clock_rollback_no_recovery_or_send(self):
        self.cfg["notifications"]["enabled"] = True
        self.monitor.tick(self.now)
        self.write_health(self.now - 120)
        sender = lambda *_: self.fail("clock rollback must not send")
        result = self.monitor.tick(self.now - 120, sender)
        self.assertEqual(result["notification_result"], "clock_invalid")
        self.assertIn("supervisor:clock", [entry["key"] for entry in result["active_faults"]])

    def test_wal_metadata_only_and_stale_does_not_clear(self):
        self.cfg["wal"] = {"warning_bytes": 100, "growth_bytes_per_minute": 10000, "duration_seconds": 60}
        self.health["business_health"]["storage"] = {"sqlite_wal_bytes": 200}
        self.write_health()
        self.monitor.tick(self.now)
        self.write_health(self.now + 60)
        self.monitor.tick(self.now + 60)
        self.assertIn("storage:wal", [entry["key"] for entry in self.faults()])
        self.health["business_health"]["storage"]["sqlite_wal_bytes"] = 0
        self.write_health(self.now - 1000)
        self.monitor.tick(self.now + 120)
        self.assertIn("storage:wal", [entry["key"] for entry in self.faults()])

    def test_storage_inodes_and_small_tmp_volume_config(self):
        self.cfg["storage"] = [{"id": "temp", "path": "/example-temp", "min_free_bytes": 0, "min_free_fraction": 0.1, "min_free_inode_fraction": 0.1}]
        stat = types.SimpleNamespace(f_bavail=8, f_blocks=16, f_frsize=1048576, f_files=100, f_favail=90)
        with patch("supervisor.os.statvfs", return_value=stat, create=True):
            checks = resource_observations(self.cfg, self.now, self.monitor.state)
        self.assertTrue(all(entry.state == "good" for entry in checks))
        stat.f_favail = 2
        with patch("supervisor.os.statvfs", return_value=stat, create=True):
            checks = resource_observations(self.cfg, self.now, self.monitor.state)
        self.assertTrue(any(entry.state == "bad" for entry in checks))

    def test_runtime_restart_proxy(self):
        for index in range(4):
            moment = self.now + index * 60
            self.health["business_health"]["runtime_start_time_utc"] = utc(moment)
            self.write_health(moment)
            self.monitor.tick(moment)
        self.assertIn("ingestor:restarts", [entry["key"] for entry in self.faults()])

    def test_atomic_status_files_and_healthcheck_liveness(self):
        self.monitor.tick(self.now)
        status = bounded_json(str(self.monitor.directory / "status.json"))
        heartbeat = bounded_json(str(self.monitor.directory / "health.json"))
        self.assertEqual(status["heartbeat_time_utc"], heartbeat["heartbeat_time_utc"])
        self.assertFalse(list(self.monitor.directory.glob("*.tmp")))

    def test_url_validation_and_no_credentials_in_config_example(self):
        config = self.cfg["notifications"]
        for value in ("http://open.feishu.cn/open-apis/bot/v2/hook/example", "https://evil.example/open-apis/bot/v2/hook/example", "https://open.feishu.cn:444/open-apis/bot/v2/hook/example", "https://user@open.feishu.cn/open-apis/bot/v2/hook/example", "https://open.feishu.cn/open-apis/bot/v2/hook/example?token=x"):
            Path(config["webhook_file"]).write_text(value, encoding="utf-8")
            with self.assertRaises(ValueError):
                webhook_url(config)

    def test_business_code_and_http_status_must_confirm(self):
        class Response:
            status = 200
            content = b'{"code":0}'
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, _): return self.content
        response = Response()
        opener = types.SimpleNamespace(open=lambda *_args, **_kwargs: response)
        with patch("supervisor.urllib.request.build_opener", return_value=opener):
            for content, expected in ((b'{"code":0}', True), (b'{"code":1}', False), (b'{"code":false}', False), (b'{}', False)):
                response.content = content
                self.assertEqual(post_feishu_http("https://open.feishu.cn/open-apis/bot/v2/hook/example", {}, 5), expected)
            response.status = 500
            response.content = b'{"code":0}'
            self.assertFalse(post_feishu_http("https://open.feishu.cn/open-apis/bot/v2/hook/example", {}, 5))

    def test_webhook_total_deadline_and_secret_not_in_argv(self):
        url = "https://open.feishu.cn/open-apis/bot/v2/hook/example-secret"
        with patch("supervisor.subprocess.run", return_value=types.SimpleNamespace(returncode=0, stdout=b"confirmed\n")) as run:
            self.assertTrue(post_feishu(url, {"msg_type": "text"}, 5))
            self.assertNotIn("example-secret", str(run.call_args.args))
            self.assertIn(b"example-secret", run.call_args.kwargs["input"])
            self.assertEqual(run.call_args.kwargs["timeout"], 5)
        with patch("supervisor.subprocess.run", side_effect=subprocess.TimeoutExpired("worker", 5)):
            self.assertFalse(post_feishu(url, {}, 5))

    def test_actual_sqlite_temp_directory_mismatch_and_space(self):
        storage = self.health["business_health"]["storage"]
        storage["temp_directory"] = "/tmp"
        self.write_health()
        self.monitor.tick(self.now)
        self.assertIn("storage:sqlite_temp_directory", [entry["key"] for entry in self.faults()])
        storage["temp_directory"] = "/app/data/sqlite-tmp"
        storage["temp_free_bytes"] = 100
        self.write_health(self.now + 60)
        self.monitor.tick(self.now + 60)
        self.assertIn("storage:sqlite_temp_directory", [entry["key"] for entry in self.faults()])
        self.write_health(self.now + 120)
        self.monitor.tick(self.now + 120)
        self.assertIn("storage:sqlite_temp", [entry["key"] for entry in self.faults()])
        self.fresh_ticks(self.now + 120)
        self.assertNotIn("storage:sqlite_temp_directory", [entry["key"] for entry in self.faults()])
        self.health["business_health"].pop("storage")
        self.write_health(self.now + 360)
        self.monitor.tick(self.now + 360)
        self.assertIn("storage:sqlite_temp", [entry["key"] for entry in self.faults()])

    def test_future_new_read_after_recent_valid_watermark_alerts_clock(self):
        device = next(iter(self.health["business_health"]["devices"].values()))
        device["clock_invalid"] = True
        self.write_health()
        self.monitor.tick(self.now)
        self.write_health(self.now + 60)
        self.monitor.tick(self.now + 60)
        self.assertIn("device:example-site/example-gateway/temperature-example:clock", [entry["key"] for entry in self.faults()])
        device.pop("clock_invalid")
        self.write_health(self.now + 120)
        self.monitor.tick(self.now + 120)
        self.assertIn("device:example-site/example-gateway/temperature-example:clock", [entry["key"] for entry in self.faults()])
        device["clock_invalid"] = False
        device["last_collect_time_utc"] = utc(self.now + 180)
        self.fresh_ticks(self.now + 180)
        self.assertNotIn("device:example-site/example-gateway/temperature-example:clock", [entry["key"] for entry in self.faults()])

    def test_malformed_business_metric_metadata_never_recovers(self):
        keys = ["ingestor:monitor", "ingestor:event_loop", "device:example-site/example-gateway/temperature-example:validity"]
        self.monitor.reconcile([Observation(key, "bad", "故障") for key in keys], self.now)
        self.monitor.state.db.commit()
        self.health["business_health"]["event_loop_lag_ms"] = float("nan")
        next(iter(self.health["business_health"]["devices"].values()))["consecutive_invalid_samples"] = "0"
        self.health["business_health"]["schema_version"] = True
        self.write_health()
        self.monitor.tick(self.now)
        for key in keys:
            self.assertIn(key, [entry["key"] for entry in self.faults()])
        self.health["business_health"]["schema_version"] = 1
        self.monitor.reconcile([Observation("storage:wal", "bad", "故障")], self.now)
        self.monitor.state.db.commit()
        self.cfg["wal"] = {"warning_bytes": 100}
        self.health["business_health"]["storage"]["sqlite_wal_bytes"] = float("nan")
        self.write_health()
        self.monitor.tick(self.now)
        self.assertIn("storage:wal", [entry["key"] for entry in self.faults()])

    def test_config_flags_and_identity_uniqueness_are_strict(self):
        path = self.root / "config.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        cases = []
        case = copy.deepcopy(original)
        case["notifications"]["enabled"] = "false"
        cases.append(case)
        case = copy.deepcopy(original)
        case["devices"][0]["require_actual_sample"] = 1
        cases.append(case)
        case = copy.deepcopy(original)
        case["devices"].append(copy.deepcopy(case["devices"][0]))
        cases.append(case)
        case = copy.deepcopy(original)
        case["mqtt_client_ids"].append(case["mqtt_client_ids"][0])
        cases.append(case)
        case = copy.deepcopy(original)
        case["storage"] = [{"id": "data", "path": "/data", "min_free_fraction": 2}]
        cases.append(case)
        for config in cases:
            path.write_text(json.dumps(config), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(str(path))

    def test_date_requires_timezone(self):
        self.assertIsNone(timestamp("2026-01-01T12:00:00"))
        self.assertIsNone(timestamp(float("nan")))
        self.assertIsNotNone(timestamp("2026-01-01T12:00:00Z"))

    def test_expired_pending_is_not_database_recovery(self):
        self.monitor.reconcile([Observation("target:local", "bad", "数据库故障")], self.now)
        self.monitor.state.db.commit()
        self.health["local_pending"] = 0
        self.health["targets"]["local"] = {"error": "CONNECTION_OR_QUERY_FAILED", "last_success_time_utc": utc(self.now - 1000)}
        self.write_health()
        self.monitor.tick(self.now)
        self.assertIn("target:local", [entry["key"] for entry in self.faults()])
        self.health["targets"]["local"]["error"] = None
        self.write_health()
        self.monitor.tick(self.now)
        self.assertIn("target:local", [entry["key"] for entry in self.faults()])
        self.health["targets"]["local"]["last_success_time_utc"] = utc(self.now + 60)
        self.fresh_ticks(self.now + 60)
        self.assertNotIn("target:local", [entry["key"] for entry in self.faults()])

    def test_malformed_counters_do_not_recover_previous_faults(self):
        observations = [Observation("ingestor:" + name, "bad", "故障") for name in ("intake", "processing_failed", "delivery_failed")]
        self.monitor.reconcile(observations, self.now)
        self.monitor.state.db.commit()
        self.health["intake_paused"] = "false"
        self.health["processing_failed"] = False
        self.health.pop("delivery_failed")
        self.write_health()
        self.monitor.tick(self.now)
        for observation in observations:
            self.assertIn(observation.key, [entry["key"] for entry in self.faults()])

    def test_notification_self_test_has_real_budget_and_no_production_faults(self):
        self.cfg["notifications"]["enabled"] = True
        sent = []
        def sender(_, body, __):
            sent.append(body["content"]["text"])
            return True
        report = self.monitor.notification_test(cycle=True, sender=sender, now=self.now)
        self.assertEqual(report["failure_or_channel_result"], "sent")
        self.assertEqual(report["recovery_result"], "sent")
        self.assertEqual(len(sent), 2)
        self.assertIn("非生产故障", sent[0])
        self.assertIn("非生产恢复", sent[1])
        self.assertFalse(self.faults())
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 2)

    def test_self_test_does_not_flush_production_outbox(self):
        self.cfg["notifications"]["enabled"] = True
        self.monitor.reconcile([Observation("production", "bad", "生产告警")], self.now)
        self.monitor.state.db.commit()
        payloads = []
        report = self.monitor.notification_test(sender=lambda _, body, __: payloads.append(body) or True, now=self.now)
        self.assertEqual(report["failure_or_channel_result"], "sent")
        self.assertNotIn("生产告警", payloads[0]["content"]["text"])
        self.assertEqual(self.outbox()[0]["fault_key"], "production")

    def reconcile_one(self, state, moment, severity="warning", key="noise:test"):
        self.monitor.reconcile([Observation(key, state, "模拟设备链路", severity)], moment)
        self.monitor.state.db.commit()

    def fault(self, key="noise:test"):
        row = self.monitor.state.db.execute("SELECT * FROM fault WHERE key=?", (key,)).fetchone()
        return dict(row) if row else None

    def test_recovery_requires_sustained_good_not_one_success(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("good", self.now + 60)
        self.assertEqual(self.fault()["active"], 1)
        self.assertFalse(self.outbox())
        for offset in (120, 180):
            self.reconcile_one("good", self.now + offset)
            self.assertEqual(self.fault()["active"], 1)
        self.reconcile_one("good", self.now + 240)
        self.assertEqual(self.fault()["active"], 0)
        self.assertEqual([row["kind"] for row in self.outbox()], ["recovery"])

    def test_flapping_does_not_create_recovery_and_new_incident_spam(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: True)
        for offset in range(60, 1200, 60):
            self.reconcile_one("good" if offset % 120 == 60 else "bad", self.now + offset)
            self.assertEqual(self.fault()["active"], 1)
            self.assertFalse(self.outbox())
        self.assertEqual(self.fault()["first_bad_time_utc"], self.now)
        self.assertEqual(self.fault()["notified_highest_severity"], "warning")

    def test_unknown_and_absent_observation_break_recovery_window(self):
        self.reconcile_one("bad", self.now)
        for offset in (60, 120):
            self.reconcile_one("good", self.now + offset)
        self.reconcile_one("unknown", self.now + 180)
        self.assertIsNone(self.fault()["good_since_time_utc"])
        self.reconcile_one("good", self.now + 240)
        self.monitor.reconcile([], self.now + 300)
        self.monitor.state.db.commit()
        self.assertIsNone(self.fault()["good_since_time_utc"])
        for offset in (360, 420, 480):
            self.reconcile_one("good", self.now + offset)
            self.assertEqual(self.fault()["active"], 1)
        self.reconcile_one("good", self.now + 540)
        self.assertIsNone(self.fault())  # An unsent recovered incident needs no recovery notification.

    def test_long_unobserved_gap_cannot_complete_recovery(self):
        self.reconcile_one("bad", self.now)
        self.reconcile_one("good", self.now + 60)
        self.reconcile_one("good", self.now + 600)
        self.assertEqual(self.fault()["active"], 1)
        self.assertEqual(self.fault()["good_since_time_utc"], self.now + 600)

    def test_good_window_survives_short_restart(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("good", self.now + 60)
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 120)
        for offset in (120, 180, 240):
            self.reconcile_one("good", self.now + offset)
        self.assertEqual(self.fault()["active"], 0)
        self.assertEqual(self.outbox()[0]["kind"], "recovery")

    def test_critical_downgrade_and_return_does_not_renotify(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now, "critical")
        self.assertEqual(self.monitor.deliver(self.now, lambda *_: True), "sent")
        self.assertEqual(self.fault()["notified_highest_severity"], "critical")
        for offset, severity in ((60, "warning"), (120, "critical"), (180, "warning"), (240, "critical")):
            self.reconcile_one("bad", self.now + offset, severity)
            self.assertEqual(self.fault()["severity"], severity)
            self.assertEqual(self.fault()["notified_highest_severity"], "critical")
            self.assertFalse(self.outbox())

    def test_only_first_acked_warning_to_critical_is_escalation(self):
        self.cfg["notifications"]["enabled"] = True
        sent = []
        sender = lambda _, payload, __: sent.append(payload["content"]["text"]) or True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, sender)
        self.reconcile_one("bad", self.now + 60, "critical")
        self.assertEqual(self.outbox()[0]["kind"], "escalation")
        self.monitor.deliver(self.now + 60, sender)
        self.reconcile_one("bad", self.now + 120, "warning")
        self.reconcile_one("bad", self.now + 180, "critical")
        self.assertFalse(self.outbox())
        self.assertEqual(len(sent), 2)
        self.assertIn("首次告警", sent[0])
        self.assertIn("严重升级", sent[1])

    def test_http_failure_does_not_promote_highest_and_unsent_escalation_can_expire(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("bad", self.now + 60, "critical")
        self.assertEqual(self.monitor.deliver(self.now + 60, lambda *_: False), "failed")
        self.assertEqual(self.fault()["notified_highest_severity"], "warning")
        self.reconcile_one("bad", self.now + 120, "warning")
        self.assertFalse(self.outbox())
        self.reconcile_one("bad", self.now + 180, "critical")
        self.assertEqual(self.outbox()[0]["kind"], "escalation")
        self.monitor.deliver(self.now + 180, lambda *_: True)
        self.assertEqual(self.fault()["notified_highest_severity"], "critical")

    def test_unacked_first_notification_updates_without_resetting_backoff(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.assertIsNone(self.fault()["notified_highest_severity"])
        self.reconcile_one("bad", self.now + 30, "critical")
        pending = self.outbox()[0]
        self.assertEqual(pending["id"], original["id"])
        self.assertEqual(pending["attempts"], original["attempts"])
        self.assertEqual(pending["next_attempt_time_utc"], original["next_attempt_time_utc"])
        self.assertEqual(pending["severity"], "critical")
        self.assertEqual(pending["kind"], "failure")
        self.monitor.deliver(self.now + 60, lambda *_: True)
        self.assertEqual(self.fault()["notified_highest_severity"], "critical")

    def test_failed_first_notice_good_unknown_then_bad_resumes_original(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.reconcile_one("good", self.now + 60)
        self.assertFalse(self.outbox())
        self.assertEqual(self.all_outbox()[0]["suspended_time_utc"], self.now + 60)
        self.reconcile_one("unknown", self.now + 120)
        self.assertIsNone(self.fault()["good_since_time_utc"])
        self.assertEqual(self.monitor.deliver(self.now + 120, lambda *_: self.fail("unknown must not resume a paused notice")), "idle")
        self.reconcile_one("bad", self.now + 180, "critical")
        resumed = self.outbox()[0]
        for field in ("id", "attempts", "next_attempt_time_utc"):
            self.assertEqual(resumed[field], original[field])
        self.assertEqual(resumed["kind"], "failure")
        self.assertEqual(resumed["severity"], "critical")
        sent = []
        self.assertEqual(self.monitor.deliver(self.now + 180, lambda _, body, __: sent.append(body["content"]["text"]) or True), "sent")
        self.assertIn("首次告警·严重", sent[0])
        self.assertEqual(self.fault()["notified_highest_severity"], "critical")

    def test_failed_first_notice_good_absent_then_bad_after_restart(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.reconcile_one("good", self.now + 60)
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 120)
        self.assertEqual(self.all_outbox()[0]["suspended_time_utc"], self.now + 60)
        self.monitor.reconcile([], self.now + 120)
        self.monitor.state.db.commit()
        self.assertIsNone(self.fault()["good_since_time_utc"])
        self.reconcile_one("bad", self.now + 180, "critical")
        self.assertEqual(self.outbox()[0]["id"], original["id"])
        self.assertEqual(self.outbox()[0]["attempts"], 1)
        self.assertEqual(self.monitor.deliver(self.now + 180, lambda *_: True), "sent")

    def test_many_unacked_flaps_preserve_id_attempts_backoff_and_budget(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original_id = self.outbox()[0]["id"]
        for base in (10, 90, 330):
            before = self.all_outbox()[0]
            self.reconcile_one("good", self.now + base)
            self.reconcile_one("unknown", self.now + base + 10)
            self.reconcile_one("bad", self.now + base + 20, "critical")
            resumed = self.outbox()[0]
            self.assertEqual(resumed["id"], original_id)
            self.assertEqual(resumed["attempts"], before["attempts"])
            self.assertEqual(resumed["next_attempt_time_utc"], before["next_attempt_time_utc"])
            self.assertEqual(self.monitor.deliver(before["next_attempt_time_utc"] - 1, lambda *_: self.fail("backoff was reset")), "idle")
            self.monitor.deliver(max(self.now + base + 20, before["next_attempt_time_utc"]), lambda *_: False)
        self.assertEqual(self.outbox()[0]["attempts"], 4)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 4)

    def test_legacy_active_unacknowledged_missing_outbox_repairs_immediately(self):
        self.reconcile_one("bad", self.now)
        self.monitor.state.db.execute("DELETE FROM outbox")
        self.monitor.state.db.commit()
        self.reconcile_one("unknown", self.now + 60)
        self.reconcile_one("bad", self.now + 120, "critical")
        self.assertEqual(len(self.outbox()), 1)
        self.assertEqual(self.outbox()[0]["kind"], "failure")
        self.assertEqual(self.outbox()[0]["severity"], "critical")

    def test_suspended_expiry_keeps_unsent_obligation_and_retry_metadata(self):
        self.cfg["notifications"]["enabled"] = True
        self.cfg["notifications"]["max_age_seconds"] = 90
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.reconcile_one("good", self.now + 60)
        self.reconcile_one("unknown", self.now + 120)
        self.assertFalse(self.all_outbox())
        self.assertEqual(self.fault()["notification_event_id"], original["id"])
        self.reconcile_one("bad", self.now + 180, "critical")
        event = self.outbox()[0]
        self.assertEqual(event["id"], original["id"])
        self.assertEqual(event["attempts"], 1)
        self.assertEqual(event["kind"], "failure")
        self.assertEqual(self.monitor.deliver(self.now + 180, lambda *_: True), "sent")

    def test_capacity_eviction_preserves_unsent_obligation_and_backoff(self):
        self.cfg["notifications"]["enabled"] = True
        self.cfg["notifications"]["max_pending"] = 1
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.reconcile_one("good", self.now + 10)
        self.monitor.enqueue("supervisor:notification-test", "test", "warning", "模拟验收", self.now + 20)
        self.reconcile_one("unknown", self.now + 20)
        self.assertEqual(len(self.all_outbox()), 1)
        self.assertEqual(self.fault()["notification_event_id"], original["id"])
        self.reconcile_one("bad", self.now + 30, "critical")
        self.assertFalse(any(event["fault_key"] == "noise:test" for event in self.outbox()))
        self.assertEqual(self.monitor.deliver(self.now + 30, lambda *_: self.fail("capacity pruning reset backoff")), "idle")
        self.reconcile_one("bad", self.now + 60, "critical")
        event = self.outbox()[0]
        self.assertEqual(event["id"], original["id"])
        self.assertEqual(event["attempts"], 1)
        self.assertEqual(event["next_attempt_time_utc"], self.now + 60)
        self.assertEqual(self.monitor.deliver(self.now + 60, lambda *_: True), "sent")

    def test_exhausted_retry_cooldown_survives_flaps_and_restart(self):
        self.cfg["notifications"]["enabled"] = True
        self.cfg["notifications"]["max_attempts"] = 1
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        self.reconcile_one("good", self.now + 60)
        retry_after = self.fault()["notification_retry_after_time_utc"]
        self.assertEqual(retry_after, self.now + 3660)
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 90)
        for offset in range(120, 1800, 60):
            self.reconcile_one("good" if offset % 180 == 0 else "unknown" if offset % 180 == 60 else "bad", self.now + offset, "critical")
            self.assertFalse(self.outbox())
            self.assertEqual(self.fault()["notification_retry_after_time_utc"], retry_after)
            self.assertEqual(self.monitor.deliver(self.now + offset, lambda *_: self.fail("flapping bypassed retry limit")), "idle")
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)
        self.reconcile_one("bad", retry_after, "critical")
        self.assertEqual(self.outbox()[0]["attempts"], 0)
        self.assertEqual(self.outbox()[0]["kind"], "failure")
        self.assertEqual(self.monitor.deliver(retry_after, lambda *_: True), "sent")
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 2)

    def test_unacknowledged_confirmed_recovery_discards_suspended_notice_without_recovery_message(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: False)
        for offset in (60, 120, 180):
            self.reconcile_one("good", self.now + offset)
            self.assertEqual(self.monitor.deliver(self.now + offset, lambda *_: self.fail("paused fault must not be delivered")), "idle")
            self.assertEqual(len(self.all_outbox()), 1)
        self.reconcile_one("good", self.now + 240)
        self.assertFalse(self.all_outbox())
        self.assertIsNone(self.fault())

    def test_failed_escalation_downgrade_and_return_preserves_retry(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now)
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("bad", self.now + 60, "critical")
        self.monitor.deliver(self.now + 60, lambda *_: False)
        original = self.outbox()[0]
        self.reconcile_one("bad", self.now + 90, "warning")
        self.assertFalse(self.outbox())
        self.assertEqual(self.all_outbox()[0]["id"], original["id"])
        self.reconcile_one("unknown", self.now + 100)
        self.reconcile_one("bad", self.now + 110, "critical")
        for field in ("id", "attempts", "next_attempt_time_utc"):
            self.assertEqual(self.outbox()[0][field], original[field])
        self.assertEqual(self.monitor.deliver(self.now + 110, lambda *_: self.fail("escalation reset backoff")), "idle")
        self.assertEqual(self.monitor.deliver(self.now + 120, lambda *_: True), "sent")

    def test_hourly_reminder_preserves_incident_highest_level(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now, "critical")
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("bad", self.now + 3599, "warning")
        self.assertFalse(self.outbox())
        self.reconcile_one("bad", self.now + 3600, "warning")
        self.assertEqual(self.outbox()[0]["kind"], "reminder")
        payloads = []
        self.monitor.deliver(self.now + 3600, lambda _, payload, __: payloads.append(payload) or True)
        self.assertIn("持续提醒", payloads[0]["content"]["text"])
        self.assertEqual(self.fault()["notified_highest_severity"], "critical")
        self.reconcile_one("bad", self.now + 3660, "critical")
        self.assertFalse(self.outbox())

    def test_validity_override_delays_repeat_without_changing_other_categories(self):
        self.cfg["notifications"]["enabled"] = True
        self.cfg["reminder_seconds_by_category"] = {"validity": 21600}
        key = "device:example-site/example-gateway/temperature-example:validity"
        self.reconcile_one("bad", self.now, key=key)
        self.monitor.deliver(self.now, lambda *_: True)
        self.reconcile_one("bad", self.now + 3600, key=key)
        self.assertFalse(self.outbox())
        self.reconcile_one("bad", self.now + 21600, key=key)
        self.assertEqual(self.outbox()[0]["kind"], "reminder")
        self.cfg["reminder_seconds_by_category"] = {}
        self.reconcile_one("bad", self.now + 22000, key="mqtt:example-secondary")
        self.monitor.deliver(self.now + 22000, lambda *_: True)
        self.reconcile_one("bad", self.now + 25600, key="mqtt:example-secondary")
        self.assertEqual(self.outbox()[0]["kind"], "reminder")

    def test_new_incident_can_alert_critical_after_confirmed_recovery(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now, "critical")
        self.monitor.deliver(self.now, lambda *_: True)
        for offset in (60, 120, 180, 240):
            self.reconcile_one("good", self.now + offset)
        self.assertEqual(self.outbox()[0]["kind"], "recovery")
        self.reconcile_one("bad", self.now + 300, "critical")
        self.assertEqual(self.outbox()[0]["kind"], "failure")
        self.assertIsNone(self.fault()["notified_highest_severity"])
        self.assertEqual(self.fault()["first_bad_time_utc"], self.now + 300)

    def test_test_outbox_never_sent_by_daemon_and_does_not_degrade_it(self):
        self.cfg["notifications"]["enabled"] = True
        for kind in ("test", "test_failure", "test_recovery"):
            self.monitor.enqueue("supervisor:notification-test", kind, "warning", "模拟验收", self.now)
            self.monitor.state.db.commit()
            self.assertEqual(self.monitor.deliver(self.now, lambda *_: self.fail("daemon must not send test events")), "idle")
        status = self.monitor.tick(self.now, lambda *_: self.fail("daemon must not send test events"))
        self.assertEqual(status["quality"], "ok")
        self.assertEqual(status["notification_pending"], 0)
        self.assertEqual(status["test_notification_pending"], 1)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 0)

    def test_explicit_failed_test_nonzero_report_and_shared_budget_without_daemon_retry(self):
        self.cfg["notifications"]["enabled"] = True
        report = self.monitor.notification_test(cycle=True, sender=lambda *_: False, now=self.now)
        self.assertEqual(report["failure_or_channel_result"], "failed")
        self.assertIsNone(report["recovery_result"])
        self.assertEqual(self.monitor.deliver(self.now + 60, lambda *_: self.fail("must not retry test in daemon")), "idle")
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)

    def test_old_database_additive_migration_keeps_incident_outbox_and_budget(self):
        path = self.root / "legacy.sqlite"
        db = sqlite3.connect(path)
        db.executescript("""
          CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE fault(key TEXT PRIMARY KEY,first_bad_time_utc REAL,active INTEGER NOT NULL DEFAULT 0,
            severity TEXT,detail TEXT,last_enqueue_time_utc REAL,last_sent_time_utc REAL,notified INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE outbox(id TEXT PRIMARY KEY,fault_key TEXT NOT NULL,kind TEXT NOT NULL,severity TEXT NOT NULL,
            detail TEXT NOT NULL,create_time_utc REAL NOT NULL,next_attempt_time_utc REAL NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE request_budget(attempt_time_utc REAL NOT NULL);
        """)
        db.execute("INSERT INTO fault VALUES (?,?,?,?,?,?,?,?)", ("legacy", self.now, 1, "critical", "旧故障", self.now, self.now, 1))
        db.execute("INSERT INTO fault VALUES (?,?,?,?,?,?,?,?)", ("legacy-no-pending", self.now, 1, "critical", "旧已确认故障", self.now, self.now, 1))
        db.execute("INSERT INTO outbox VALUES (?,?,?,?,?,?,?,?)", ("original-event", "legacy", "failure", "critical", "旧待发", self.now, self.now + 60, 2))
        db.execute("INSERT INTO request_budget VALUES (?)", (self.now,))
        db.commit()
        db.close()
        for _ in range(3):
            state = State(path)
            try:
                row = state.db.execute("SELECT * FROM fault WHERE key='legacy'").fetchone()
                self.assertEqual(row["notified_highest_severity"], "warning")
                self.assertEqual(state.db.execute("SELECT notified_highest_severity FROM fault WHERE key='legacy-no-pending'").fetchone()[0], "critical")
                self.assertIsNone(row["good_since_time_utc"])
                event = state.db.execute("SELECT * FROM outbox").fetchone()
                self.assertEqual(event["id"], "original-event")
                self.assertEqual(event["attempts"], 2)
                self.assertEqual(state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)
                self.assertIsNone(event["suspended_time_utc"])
                self.assertEqual(state.get("state_schema_version"), 4)
                names = [column["name"] for column in state.db.execute("PRAGMA table_info(fault)")]
                self.assertEqual(names.count("good_since_time_utc"), 1)
                self.assertEqual(names.count("notification_retry_after_time_utc"), 1)
            finally:
                state.close()

    def test_repeated_migration_does_not_downgrade_known_acked_critical(self):
        self.cfg["notifications"]["enabled"] = True
        self.reconcile_one("bad", self.now, "critical")
        self.monitor.deliver(self.now, lambda *_: True)
        self.monitor.enqueue("noise:test", "reminder", "critical", "模拟持续提醒", self.now + 3600)
        self.monitor.state.db.commit()
        for _ in range(3):
            self.monitor.state.close()
            self.monitor = Supervisor(self.cfg, self.now + 3600)
            self.assertEqual(self.fault()["notified_highest_severity"], "critical")

    def test_recovery_and_reminder_configuration_validation(self):
        path = self.root / "config.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        invalid = [({"recovery_seconds": 0}), ({"recovery_seconds": True}), ({"reminder_seconds_by_category": {"validity": 60}}),
                   ({"reminder_seconds_by_category": {"unknown-kind": 21600}}), ({"reminder_seconds_by_category": {"validity": True}})]
        for change in invalid:
            value = {**original, **change}
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(str(path))
        path.write_text(json.dumps({**original, "recovery_seconds": 240, "reminder_seconds_by_category": {"validity": 21600}}), encoding="utf-8")
        loaded = load_config(str(path))
        self.assertEqual(loaded["recovery_seconds"], 240)
        self.assertEqual(loaded["reminder_seconds_by_category"]["validity"], 21600)

    def test_device_alert_switch_defaults_true_and_requires_boolean(self):
        path = self.root / "config.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        value["devices"][0].pop("alerts_enabled")
        path.write_text(json.dumps(value), encoding="utf-8")
        self.assertTrue(load_config(str(path))["devices"][0]["alerts_enabled"])
        for invalid in (0, 1, "false", None):
            value["devices"][0]["alerts_enabled"] = invalid
            path.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaises(ValueError):
                load_config(str(path))
        value["devices"][0]["alerts_enabled"] = False
        path.write_text(json.dumps(value), encoding="utf-8")
        self.assertFalse(load_config(str(path))["devices"][0]["alerts_enabled"])

    def test_paused_device_skips_all_checks_but_global_mqtt_and_target_continue(self):
        self.cfg["devices"][0]["alerts_enabled"] = False
        record = next(iter(self.health["business_health"]["devices"].values()))
        record.update(last_collect_time_utc=utc(self.now + 600), clock_invalid=True,
                      consecutive_invalid_samples=100, monitor_error="MONITOR_ERROR")
        self.health["mqtt_connections"][0]["connected"] = False
        self.health["local_pending"] = 3
        self.health["targets"]["local"]["last_success_time_utc"] = utc(self.now - 600)
        observations = evaluate(self.cfg, self.health, self.now, self.monitor.startup, self.monitor.state)
        self.assertFalse(any(entry.key.startswith("device:") for entry in observations))
        self.assertTrue(any(entry.key.startswith("mqtt:") and entry.state == "bad" for entry in observations))
        self.assertTrue(any(entry.key == "target:local" and entry.state == "bad" for entry in observations))

    def test_paused_device_existing_all_notification_kinds_never_send_directly(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        self.reconcile_one("bad", self.now, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = False
        for kind in ("failure", "escalation", "reminder", "recovery"):
            self.monitor.enqueue(key, kind, "warning", "模拟设备通知", self.now)
            self.monitor.state.db.commit()
            self.assertEqual(self.monitor.deliver(self.now, lambda *_: self.fail("paused device notification leaked")), "idle")
            self.assertEqual(self.all_outbox()[0]["kind"], kind)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 0)
        self.assertEqual(self.fault(key)["active"], 1)

    def test_paused_device_preserves_active_fault_and_budget_without_degrading_status(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        self.reconcile_one("bad", self.now, key=key)
        self.monitor.deliver(self.now, lambda *_: True)
        self.cfg["devices"][0]["alerts_enabled"] = False
        original = self.fault(key)
        record = next(iter(self.health["business_health"]["devices"].values()))
        record["last_collect_time_utc"] = utc(self.now - 3600)
        self.write_health()
        status = self.monitor.tick(self.now, lambda *_: self.fail("pause must not send recovery"))
        self.assertEqual(status["quality"], "ok")
        self.assertFalse(status["active_faults"])
        self.assertEqual(len(status["paused_device_alerts"]), 1)
        retained = self.fault(key)
        for field in ("first_bad_time_utc", "notified", "notified_highest_severity", "last_sent_time_utc"):
            self.assertEqual(retained[field], original[field])
        self.assertIsNotNone(retained["alerts_paused_time_utc"])
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)

    def test_reenabled_device_unknown_then_bad_reconfirms_and_keeps_pending_retry(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":clock"
        self.reconcile_one("bad", self.now, key=key)
        self.monitor.deliver(self.now, lambda *_: False)
        original = self.outbox()[0]
        self.cfg["devices"][0]["alerts_enabled"] = False
        self.reconcile_one("good", self.now + 10, key=key)
        self.monitor.state.close()
        self.cfg["devices"][0]["alerts_enabled"] = True
        self.monitor = Supervisor(self.cfg, self.now + 30)
        self.reconcile_one("unknown", self.now + 30, key=key)
        self.assertEqual(self.monitor.deliver(self.now + 120, lambda *_: self.fail("reenable cannot replay unconfirmed fault")), "idle")
        self.monitor.reconcile([Observation(key, "bad", "模拟时钟异常", "warning", 60)], self.now + 180)
        self.monitor.state.db.commit()
        self.assertIsNotNone(self.fault(key)["alerts_paused_time_utc"])
        self.assertEqual(self.monitor.deliver(self.now + 180, lambda *_: self.fail("old first bad time bypassed recheck")), "idle")
        self.monitor.reconcile([Observation(key, "bad", "模拟时钟异常", "warning", 60)], self.now + 240)
        self.monitor.state.db.commit()
        self.assertIsNone(self.fault(key)["alerts_paused_time_utc"])
        resumed = self.outbox()[0]
        for field in ("id", "attempts", "next_attempt_time_utc"):
            self.assertEqual(resumed[field], original[field])
        self.assertEqual(self.monitor.deliver(self.now + 240, lambda *_: True), "sent")
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 2)

    def test_reenabled_device_missing_observation_breaks_bad_reconfirmation(self):
        key = device_check_key(self.cfg["devices"][0]) + ":clock"
        self.reconcile_one("bad", self.now, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = False
        self.reconcile_one("good", self.now + 10, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = True
        self.monitor.reconcile([Observation(key, "bad", "模拟异常", duration=60)], self.now + 60)
        self.monitor.reconcile([], self.now + 90)
        self.monitor.reconcile([Observation(key, "bad", "模拟异常", duration=60)], self.now + 120)
        self.monitor.state.db.commit()
        self.assertEqual(self.fault(key)["alerts_recheck_bad_since_time_utc"], self.now + 120)
        self.assertIsNotNone(self.fault(key)["alerts_paused_time_utc"])

    def test_reenabled_device_stale_health_does_not_release_pending(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        self.reconcile_one("bad", self.now, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = False
        self.reconcile_one("good", self.now + 10, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = True
        self.write_health(self.now - 1000)
        sent = []
        self.monitor.tick(self.now + 60, lambda _, body, __: sent.append(body["content"]["text"]) or True)
        self.assertTrue(sent)  # The global stale heartbeat remains supervised.
        self.assertNotIn("模拟设备链路", sent[0])
        self.assertIsNotNone(self.fault(key)["alerts_paused_time_utc"])

    def test_paused_prior_recovery_is_not_replayed_on_reenable(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        self.reconcile_one("bad", self.now, key=key)
        self.monitor.deliver(self.now, lambda *_: True)
        for offset in (60, 120, 180, 240):
            self.reconcile_one("good", self.now + offset, key=key)
        self.assertEqual(self.outbox()[0]["kind"], "recovery")
        old_recovery = self.outbox()[0]["id"]
        self.cfg["devices"][0]["alerts_enabled"] = False
        self.reconcile_one("good", self.now + 300, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = True
        for offset in (360, 420, 480, 540):
            self.reconcile_one("good", self.now + offset, key=key)
            self.assertEqual(self.monitor.deliver(self.now + offset, lambda *_: self.fail("old recovery must not be replayed")), "idle")
        self.assertFalse(any(entry["id"] == old_recovery for entry in self.all_outbox()))
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM request_budget").fetchone()[0], 1)

    def test_reenabled_acked_fault_needs_sustained_new_good_before_recovery(self):
        self.cfg["notifications"]["enabled"] = True
        key = device_check_key(self.cfg["devices"][0]) + ":freshness"
        self.reconcile_one("bad", self.now, key=key)
        self.monitor.deliver(self.now, lambda *_: True)
        self.cfg["devices"][0]["alerts_enabled"] = False
        self.reconcile_one("good", self.now + 60, key=key)
        self.cfg["devices"][0]["alerts_enabled"] = True
        for offset in (120, 180, 240):
            self.reconcile_one("good", self.now + offset, key=key)
            self.assertFalse(self.outbox())
        self.reconcile_one("good", self.now + 300, key=key)
        self.assertEqual(self.outbox()[0]["kind"], "recovery")
        self.assertFalse(self.monitor.device_notification_blocked(key))

    def test_pause_identity_does_not_suppress_other_site_gateway_or_longer_id(self):
        original = self.cfg["devices"][0]
        original["alerts_enabled"] = False
        others = [dict(original, site_id="another-example-site", alerts_enabled=True),
                  dict(original, gateway_id="another-example-gateway", alerts_enabled=True),
                  dict(original, device_id=original["device_id"] + ":extended", alerts_enabled=True)]
        self.cfg["devices"].extend(others)
        self.reconcile_one("bad", self.now, key=device_check_key(original) + ":freshness")
        for other in others:
            self.reconcile_one("bad", self.now, key=device_check_key(other) + ":freshness")
        self.reconcile_one("bad", self.now, key="mqtt:example-global")
        self.reconcile_one("bad", self.now, key="target:local")
        keys = [entry["fault_key"] for entry in self.outbox()]
        self.assertNotIn(device_check_key(original) + ":freshness", keys)
        for other in others:
            self.assertIn(device_check_key(other) + ":freshness", keys)
        self.assertIn("mqtt:example-global", keys)
        self.assertIn("target:local", keys)


class HostHealthTests(unittest.TestCase):
    good_health = SupervisorTests.good_health
    write_health = SupervisorTests.write_health
    faults = SupervisorTests.faults
    outbox = SupervisorTests.outbox
    all_outbox = SupervisorTests.all_outbox

    def setUp(self):
        SupervisorTests.setUp(self)
        self.monitor.state.close()
        self.cfg["host_health_sources"] = [{"id": "example-router", "site_id": "example-site", "host_id": "example-router",
            "label": "示例路由器", "path": str(self.root / "router.json"), "receiver_health_path": str(self.root / "receiver.json")}]
        self.reload_config()
        self.monitor = Supervisor(self.cfg, self.now - 600)
        self.host = self.cfg["host_health_sources"][0]
        self.sample = {"schema_version": 1, "message_id": str(uuid.uuid4()), "site_id": "example-site", "host_id": "example-router",
            "boot_id": str(uuid.uuid4()), "sequence": 1, "read_time_utc": utc(self.now), "receive_time_utc": utc(self.now),
            "uptime_seconds": 600, "payload_sha256": "a" * 64, "metrics": {"mem_available_bytes": 500000000},
            "conditions": {name: {"state": "good", "severity": "warning", "incident_id": None, "detail_code": "none"}
                           for name in ("memory_pressure", "io_pressure", "temperature", "storage")}, "actions": []}
        self.write_receiver(self.now)
        self.write_sample()

    def tearDown(self):
        SupervisorTests.tearDown(self)

    def reload_config(self):
        (self.root / "config.json").write_text(json.dumps(self.cfg), encoding="utf-8")
        self.cfg = load_config(str(self.root / "config.json"))

    def write_receiver(self, now, connected=True, subscribed=True):
        Path(self.host["receiver_health_path"]).write_text(json.dumps({"schema_version": 1, "heartbeat_time_utc": utc(now),
            "connected": connected, "subscribed": subscribed, "last_error": None}), encoding="utf-8")

    def write_sample(self):
        Path(self.host["path"]).write_text(json.dumps(self.sample), encoding="utf-8")

    def tick(self, now, fresh=False, sender=lambda *_: True):
        self.write_health(now)
        self.write_receiver(now)
        if fresh:
            self.sample.update(sequence=self.sample["sequence"] + 1, message_id=str(uuid.uuid4()),
                               read_time_utc=utc(now), receive_time_utc=utc(now))
            self.write_sample()
        return self.monitor.tick(now, sender)

    def memory_bad(self, severity="warning"):
        self.sample["conditions"]["memory_pressure"] = {"state": "bad", "severity": severity,
            "incident_id": str(uuid.uuid4()), "detail_code": "memory_available_critical" if severity == "critical" else "memory_available_low"}

    def action(self, result="succeeded", moment=None, action_id=None):
        return {"event_id": str(uuid.uuid4()), "action_id": action_id or str(uuid.uuid4()), "incident_id": str(uuid.uuid4()),
            "action_time_utc": utc(self.now if moment is None else moment), "kind": "restart_proxy", "result": result, "target_id": "proxy"}

    def test_optional_host_sources_and_strict_configuration(self):
        original = copy.deepcopy(self.cfg)
        self.assertEqual(self.host["freshness_seconds"], 180)
        self.assertEqual(self.host["critical_freshness_seconds"], 300)
        variants = [dict(self.host, id="bad:identity"), dict(self.host, site_id=[]), dict(self.host, path="relative.json"),
                    dict(self.host, receiver_health_path=None), dict(self.host, freshness_seconds=True),
                    dict(self.host, critical_freshness_seconds=180)]
        for variant in variants:
            with self.subTest(config=variant):
                self.cfg = copy.deepcopy(original)
                self.cfg["host_health_sources"] = [variant]
                with self.assertRaisesRegex(ValueError, "HOST_HEALTH"):
                    self.reload_config()
        self.cfg = copy.deepcopy(original)
        self.cfg["host_health_sources"].append(copy.deepcopy(self.host))
        with self.assertRaisesRegex(ValueError, "HOST_HEALTH"):
            self.reload_config()
        self.cfg = copy.deepcopy(original)
        del self.cfg["host_health_sources"]
        self.reload_config()
        self.assertEqual(self.cfg["host_health_sources"], [])

    def test_fresh_host_is_healthy_without_metric_threshold_inference(self):
        self.sample["metrics"]["mem_available_bytes"] = 1
        self.write_sample()
        status = self.tick(self.now)
        self.assertEqual(status["quality"], "ok")
        self.assertFalse(status["host_health_blocked_checks"])
        self.assertFalse(self.faults())  # Local guard conditions are authoritative.

    def test_reporting_uses_original_read_time_and_escalates_without_child_storm(self):
        self.sample["receive_time_utc"] = utc(self.now + 181)
        self.write_sample()
        first = self.tick(self.now + 181)
        fault = next(row for row in first["active_faults"] if row["key"] == "host:example-router:reporting")
        self.assertEqual(fault["severity"], "warning")
        second = self.tick(self.now + 301)
        fault = next(row for row in second["active_faults"] if row["key"] == "host:example-router:reporting")
        self.assertEqual(fault["severity"], "critical")
        self.assertFalse(any(row["key"].startswith("host:example-router:") and row["key"] != fault["key"] for row in self.faults()))

    def test_missing_host_file_ages_from_last_sample(self):
        self.tick(self.now)
        Path(self.host["path"]).unlink()
        status = self.tick(self.now + 301)
        self.assertIn("host:example-router:reporting", [row["key"] for row in status["active_faults"]])

    def test_receiver_failure_suppresses_existing_child_notice_and_only_alerts_parent(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        key = "host:example-router:memory_pressure"
        old = dict(self.monitor.state.db.execute("SELECT * FROM outbox WHERE fault_key=?", (key,)).fetchone())
        self.cfg["notifications"]["enabled"] = True
        for offset in (60, 240):
            self.write_health(self.now + offset)
            self.write_receiver(self.now + offset, connected=False)
            self.monitor.tick(self.now + offset, lambda *args: self.fail("Disconnected receiver cannot prove the child fault")) if offset == 60 else self.monitor.tick(self.now + offset, lambda *_: True)
        row = dict(self.monitor.state.db.execute("SELECT * FROM outbox WHERE fault_key=?", (key,)).fetchone())
        self.assertEqual(row, old)
        self.assertIn("receiver:example-router:mqtt", [row["key"] for row in self.faults()])
        self.assertEqual(self.monitor.state.db.execute("SELECT good_since_time_utc FROM fault WHERE key=?", (key,)).fetchone()[0], None)

    def test_local_fault_escalates_only_once_and_has_stable_key(self):
        self.cfg["notifications"]["enabled"] = True
        sent = []
        self.memory_bad()
        self.tick(self.now, fresh=True, sender=lambda *args: sent.append(args[1]) or True)
        for offset, severity in ((60, "critical"), (120, "warning"), (180, "critical")):
            self.memory_bad(severity)
            self.tick(self.now + offset, fresh=True, sender=lambda *args: sent.append(args[1]) or True)
        self.assertEqual(len(sent), 2)
        self.assertEqual([row["key"] for row in self.faults()], ["host:example-router:memory_pressure"])

    def test_receiver_interruption_resets_full_recovery_window(self):
        self.cfg["notifications"]["enabled"] = True
        self.memory_bad()
        self.tick(self.now, fresh=True)
        self.sample["conditions"]["memory_pressure"]["state"] = "good"
        self.tick(self.now + 60, fresh=True)
        self.write_health(self.now + 120)
        self.write_receiver(self.now + 120, subscribed=False)
        self.monitor.tick(self.now + 120)
        for offset in (180, 240, 300):
            self.tick(self.now + offset, fresh=True)
            self.assertTrue(any(row["key"] == "host:example-router:memory_pressure" for row in self.faults()))
        self.tick(self.now + 360, fresh=True)
        self.assertFalse(any(row["key"] == "host:example-router:memory_pressure" for row in self.faults()))

    def test_old_resource_replay_cannot_clear_newer_fault(self):
        old = copy.deepcopy(self.sample)
        self.memory_bad()
        self.tick(self.now + 60, fresh=True)
        self.sample = old
        self.sample["receive_time_utc"] = utc(self.now + 120)
        self.write_sample()
        self.tick(self.now + 120)
        key = "host:example-router:memory_pressure"
        self.assertTrue(any(row["key"] == key for row in self.faults()))
        self.assertIsNone(self.monitor.state.db.execute("SELECT good_since_time_utc FROM fault WHERE key=?", (key,)).fetchone()[0])
        self.assertTrue(self.monitor.device_notification_blocked(key))

    def test_malformed_missing_and_future_condition_data_never_recovers(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        baseline = copy.deepcopy(self.sample)
        variants = []
        for field, value in (("state", []), ("severity", {}), ("detail_code", []), ("incident_id", "bad-id")):
            sample = copy.deepcopy(baseline)
            sample["conditions"]["memory_pressure"][field] = value
            variants.append(sample)
        sample = copy.deepcopy(baseline); del sample["conditions"]; variants.append(sample)
        sample = copy.deepcopy(baseline); sample["read_time_utc"] = utc(self.now + 1000); variants.append(sample)
        sample = copy.deepcopy(baseline); sample["host_id"] = "another-example"; variants.append(sample)
        for sample in variants:
            with self.subTest(sample=sample):
                self.sample = sample
                self.write_sample()
                self.tick(self.now + 60)
                key = "host:example-router:memory_pressure"
                self.assertTrue(any(row["key"] == key for row in self.faults()))
                self.assertTrue(self.monitor.device_notification_blocked(key))

    def test_restart_blocks_persisted_host_notice_until_new_observation(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 60)
        self.cfg["notifications"]["enabled"] = True
        self.assertEqual(self.monitor.deliver(self.now + 60, lambda *args: self.fail("New process has not observed the host")), "idle")
        self.tick(self.now + 60, fresh=True, sender=lambda *_: True)
        self.assertFalse(self.outbox())

    def test_delayed_action_is_not_lost_and_does_not_clobber_existing_fault(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        key = "host:example-router:memory_pressure"
        old_id = self.monitor.state.db.execute("SELECT id FROM outbox WHERE fault_key=?", (key,)).fetchone()[0]
        self.sample["actions"] = [self.action(moment=self.now - 5 * 3600)]
        self.write_sample()
        self.tick(self.now + 240)
        self.assertEqual(self.monitor.state.db.execute("SELECT id FROM outbox WHERE fault_key=?", (key,)).fetchone()[0], old_id)
        actions = [row for row in self.all_outbox() if row["kind"] == "action"]
        self.assertEqual(len(actions), 1)
        self.assertIn(utc(self.now - 5 * 3600), actions[0]["detail"])
        action_id = actions[0]["id"]
        self.tick(self.now + 300)
        self.assertEqual([row["id"] for row in self.all_outbox() if row["kind"] == "action"], [action_id])

    def test_each_action_phase_is_notified_once_across_observer_restart(self):
        action_id = str(uuid.uuid4())
        self.sample["actions"] = [self.action(result, action_id=action_id) for result in ("claimed", "succeeded", "failed", "uncertain")]
        self.cfg["notifications"]["enabled"] = True
        sent = []
        self.write_sample()
        self.tick(self.now, sender=lambda *args: sent.append(args[1]) or True)
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["content"]["text"].count("[缓解记录]"), 4)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0], 4)
        self.monitor.state.close()
        self.monitor = Supervisor(self.cfg, self.now + 60)
        self.tick(self.now + 60, fresh=True, sender=lambda *args: self.fail("Acknowledged phases must not be replayed"))

    def test_action_uses_existing_http_budget_and_keeps_pending_phase(self):
        self.cfg["notifications"].update(enabled=True, requests_per_hour=1)
        action_id = str(uuid.uuid4())
        self.sample["actions"] = [self.action("claimed", action_id=action_id)]
        self.write_sample()
        self.tick(self.now)
        self.sample["actions"].append(self.action("succeeded", moment=self.now + 60, action_id=action_id))
        status = self.tick(self.now + 60, fresh=True, sender=lambda *args: self.fail("Hourly budget must apply to action audit"))
        self.assertEqual(status["notification_result"], "budget_exhausted")
        self.assertEqual(len([row for row in self.outbox() if row["kind"] == "action"]), 1)

    def test_action_receipts_have_bounded_capacity_and_expiry(self):
        with self.monitor.state.db:
            self.monitor.state.db.executemany("INSERT INTO host_action_receipt VALUES (?,?,?)", [(str(uuid.uuid4()), "example-router", self.now) for _ in range(4096)])
        self.sample["actions"] = [self.action()]
        self.write_sample()
        self.tick(self.now)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0], 4096)
        self.assertFalse(any(row["kind"] == "action" for row in self.outbox()))
        with self.monitor.state.db:
            self.monitor.state.db.execute("UPDATE host_action_receipt SET seen_time_utc=?", (self.now - 7 * 86400 - 1,))
        self.tick(self.now + 60, fresh=True)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0], 1)
        self.assertEqual(len([row for row in self.outbox() if row["kind"] == "action"]), 1)

    def test_expired_invalid_or_future_actions_are_not_notified(self):
        actions = [self.action(moment=self.now - 21601), self.action(moment=self.now + 61), self.action()]
        actions[2]["target_id"] = "arbitrary-command"
        self.sample["actions"] = actions
        self.write_sample()
        self.tick(self.now)
        self.assertFalse(any(row["kind"] == "action" for row in self.outbox()))

    def test_new_host_failure_does_not_pause_original_device_checks(self):
        device = next(iter(self.health["business_health"]["devices"].values()))
        device["last_collect_time_utc"] = utc(self.now - 301)
        self.write_health(self.now)
        self.write_receiver(self.now, connected=False)
        status = self.monitor.tick(self.now)
        self.assertIn(device_check_key(self.cfg["devices"][0]) + ":freshness", [row["key"] for row in status["active_faults"]])

    def test_nonfinite_or_huge_metrics_are_unknown_without_crashing(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        original = copy.deepcopy(self.sample)
        for value in (True, float("nan"), float("inf"), 10 ** 1000):
            with self.subTest(metric=value):
                self.sample = copy.deepcopy(original)
                self.sample["metrics"]["mem_available_bytes"] = value
                self.write_sample()
                status = self.tick(self.now + 60)
                self.assertIn("host:example-router:memory_pressure", status["host_health_blocked_checks"])

    def test_removing_host_source_blocks_old_audit_and_fault_without_deleting_state(self):
        self.memory_bad()
        self.sample["actions"] = [self.action()]
        self.write_sample()
        self.tick(self.now, fresh=True)
        before = self.all_outbox()
        self.cfg["host_health_sources"] = []
        self.cfg["notifications"]["enabled"] = True
        self.tick(self.now + 60, sender=lambda *args: self.fail("Removed source cannot emit old notices"))
        self.assertEqual(self.all_outbox(), before)
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0], 1)

    def test_host_alert_path_is_independent_of_missing_ingestor_snapshot(self):
        self.memory_bad()
        self.write_sample()
        Path(self.cfg["ingestor_health_file"]).unlink()
        status = self.monitor.tick(self.now)
        self.assertIn("host:example-router:memory_pressure", [row["key"] for row in status["active_faults"]])
        self.assertIn("ingestor:heartbeat", [row["key"] for row in status["active_faults"]])

    def test_three_day_audit_is_not_a_new_notice_or_resource_recovery(self):
        self.memory_bad()
        self.tick(self.now, fresh=True)
        self.sample["actions"] = [self.action(moment=self.now - 3 * 86400)]
        self.write_sample()
        self.tick(self.now + 240)
        self.assertFalse(any(row["kind"] == "action" for row in self.all_outbox()))
        self.assertEqual(self.monitor.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0], 0)
        row = self.monitor.state.db.execute("SELECT active,good_since_time_utc FROM fault WHERE key='host:example-router:memory_pressure'").fetchone()
        self.assertEqual(row["active"], 1)
        self.assertIsNone(row["good_since_time_utc"])
        cursor = self.monitor.state.get("host_sample:example-router")
        self.assertEqual(cursor["read_time"], self.now)



if __name__ == "__main__":
    unittest.main()
