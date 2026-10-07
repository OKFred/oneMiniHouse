import copy
import json
import sqlite3
import subprocess
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent import (SMART_CACHE_FILE, GPU_CACHE_FILE, Outbox, Transport, collect_samples, collect_all_samples, envelope,
                   parse_reading, parse_smart_cache, read_smart_cache, smart_envelope,
                   parse_gpu_cache, read_gpu_cache, gpu_envelope, validate)


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name("config.example.json").read_text())
        self.config.pop("smart", None)
        self.limits = {"max_age_days": 1, "max_rows": 2}

    def test_config_requires_tls_separate_secrets_and_bounded_unique_channels(self):
        validate(self.config)
        for key, value in [("url", "mqtt://broker.example.com"), ("url", "mqtts://user:secret@broker.example.com"), ("password_file", "relative-file")]:
            config = copy.deepcopy(self.config)
            config["mqtt"][key] = value
            with self.assertRaises(ValueError):
                validate(config)
        config = copy.deepcopy(self.config)
        config["sensors"] *= 2
        with self.assertRaises(ValueError):
            validate(config)
        config["sensors"] = [{"selector": f"hwmon:coretemp:Core {i}", "metric": f"cpu_core_{i}_temperature_c"} for i in range(64)]
        validate(config)
        config["sensors"].append({"selector": "hwmon:board:temp1", "metric": "board_temperature_c"})
        with self.assertRaises(ValueError):
            validate(config)

    def test_distinct_nvme_slots_partial_failure_zero_and_no_fabrication(self):
        sensors = self.config["sensors"] + [{"selector": "hwmon:nvme.pci-0000_02_00.0:Composite", "metric": "nvme_b_temperature_c"}]
        rows = ["hwmon\tcoretemp\tPackage id 0\t0", "hwmon\tnvme\tComposite\t45850", "hwmon\tnvme.pci-0000_01_00.0\tComposite\t45850", "hwmon\tnvme\tComposite\t48850", "hwmon\tnvme.pci-0000_02_00.0\tComposite\t48850"]
        response = lambda data: "one-minihouse-temperatures-v1\n" + "\n".join(data) + "\n"
        expected = ({"cpu_package_temperature_c": 0, "nvme_a_temperature_c": 45.85, "nvme_b_temperature_c": 48.85}, [])
        self.assertEqual(parse_reading(response(rows), sensors), expected)
        self.assertEqual(parse_reading(response(list(reversed(rows))), sensors), expected)
        metrics, missing = parse_reading(response(rows[:-1]), sensors)
        self.assertEqual(missing, ["nvme_b_temperature_c"])
        self.assertNotIn("nvme_b_temperature_c", metrics)
        self.assertEqual(parse_reading(response(rows), [{"selector": "hwmon:nvme:Composite", "metric": "nvme_temperature_c"}]), ({}, ["nvme_temperature_c"]))
        self.assertEqual(parse_reading(response(["hwmon\tcoretemp\tPackage id 0\t200000"]), sensors)[0], {})
        with self.assertRaises(ValueError):
            parse_reading("invalid", sensors)

    def test_restart_successful_puback_only_stable_replay_and_latest_state(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.sqlite"
            box = Outbox(path, self.limits)
            a = envelope(self.config, {"cpu_package_temperature_c": 50}, [])
            b = envelope(self.config, {"cpu_package_temperature_c": 51}, [])
            self.assertIsNone(a["sample_time_utc"])
            self.assertTrue(a["read_time_utc"].endswith("Z"))
            box.save(a, a)
            box.save(b, b)
            first = box.first()
            box.close()
            box = Outbox(path, self.limits)
            self.assertEqual(first, box.first())
            for reason in (None, 128, 135, -1, False):
                with self.assertRaises(ValueError):
                    box.ack(a["message_id"], reason)
                self.assertEqual(first, box.first())
            box.ack(a["message_id"], 0)
            self.assertEqual(box.first()[0], b["message_id"])
            self.assertEqual(json.loads(box.state())["message_id"], b["message_id"])
            box.ack(a["message_id"], 0)  # Duplicate acknowledgement is harmless.
            box.ack(b["message_id"], 16)  # MQTT No matching subscribers is successful PUBACK.
            self.assertEqual(box.stats()["pending"], 0)
            self.assertEqual(json.loads(box.state())["message_id"], b["message_id"])
            box.close()

    def test_age_count_limits_drop_oldest_and_keep_latest_error_state(self):
        with tempfile.TemporaryDirectory() as directory:
            box = Outbox(Path(directory) / "outbox.sqlite", self.limits)
            for index in range(4):
                sample = envelope(self.config, {"cpu_package_temperature_c": index}, [])
                box.save(sample, sample, now=86400000+index)
            self.assertEqual(box.prune(now=86400004), 2)
            self.assertEqual(box.stats(), {"pending": 2, "dropped": 2})
            self.assertEqual(json.loads(box.first()[1])["metrics"]["cpu_package_temperature_c"], 2)
            state = {"quality": "degraded", "metrics": {}, "message_id": "error-state"}
            box.save(None, state)
            self.assertEqual(box.prune(now=3*86400000), 2)
            self.assertEqual(box.stats(), {"pending": 0, "dropped": 4})
            self.assertEqual(json.loads(box.state()), state)
            box.close()

    def test_transport_puback_callback_controls_outbox_delivery(self):
        for reason in (135, 0, 16):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                box = Outbox(Path(directory) / "outbox.sqlite", self.limits)
                sample = envelope(self.config, {"cpu_package_temperature_c": 50}, [])
                box.save(sample, sample)
                first = box.first()
                # Exercise the real callback and publish synchronization without
                # opening a broker connection or requiring local credentials.
                transport = Transport.__new__(Transport)
                transport.lock = threading.Lock()
                transport.pending = {}
                callback_started = threading.Event()
                callbacks = []

                def publish(topic, payload, qos, retain):
                    self.assertEqual(qos, 1)
                    self.assertFalse(retain)
                    self.assertEqual(payload, first[1])

                    def acknowledge():
                        callback_started.set()
                        transport.on_publish(None, None, 7, SimpleNamespace(value=reason), None)

                    callback = threading.Thread(target=acknowledge, daemon=True)
                    callbacks.append(callback)
                    callback.start()
                    self.assertTrue(callback_started.wait(1))
                    return SimpleNamespace(rc=0, mid=7)

                transport.client = SimpleNamespace(publish=publish)
                try:
                    if reason >= 128:
                        with self.assertRaises(ConnectionError):
                            box.ack(first[0], transport.publish("test/telemetry", first[1]))
                        self.assertEqual(box.first(), first)
                    else:
                        result = transport.publish("test/telemetry", first[1])
                        self.assertEqual(result, reason)
                        box.ack(first[0], result)
                        self.assertIsNone(box.first())
                    self.assertEqual(transport.pending, {})
                finally:
                    for callback in callbacks:
                        callback.join(1)
                        self.assertFalse(callback.is_alive())
                    box.close()

    def test_missing_puback_keeps_outbox_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            box = Outbox(Path(directory) / "outbox.sqlite", self.limits)
            sample = envelope(self.config, {"cpu_package_temperature_c": 50}, [])
            box.save(sample, sample)
            first = box.first()
            transport = Transport.__new__(Transport)
            transport.lock, transport.pending = threading.Lock(), {}
            transport.client = SimpleNamespace(publish=lambda *args, **kwargs: SimpleNamespace(rc=0, mid=7))
            with patch("agent.threading.Event", return_value=SimpleNamespace(wait=lambda timeout: False)):
                with self.assertRaises(ConnectionError):
                    box.ack(first[0], transport.publish("test/telemetry", first[1]))
            self.assertEqual(box.first(), first)
            self.assertEqual(transport.pending, {})
            box.close()


class SmartCacheTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name("config.example.json").read_text())
        self.config["smart"] = {"cache_file": SMART_CACHE_FILE,
                                "metrics": ["sata_ssd_a_temperature_c", "sata_hdd_a_temperature_c"],
                                "max_age_seconds": 120}
        self.smart = self.config["smart"]
        self.now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        self.cache = {"version": 1, "batch_id": "af9fce22-7eab-42f5-9904-e04cdcc61292",
                      "read_time_utc": "2026-09-28T11:59:55.000Z", "sample_time_utc": None,
                      "metrics": {"sata_ssd_a_temperature_c": 34, "sata_hdd_a_temperature_c": 0},
                      "missing_metrics": [], "errors": {}, "quality_notes": {},
                      "per_metric_read_time_utc": {"sata_ssd_a_temperature_c": "2026-09-28T11:59:54.000Z",
                                                   "sata_hdd_a_temperature_c": "2026-09-28T11:59:55.000Z"}}
        self.limits = {"max_age_days": 1, "max_rows": 20}

    def parsed(self, cache=None):
        return parse_smart_cache(self.cache if cache is None else cache, self.smart, now=self.now)

    def test_smart_config_optional_fixed_path_unique_channels_and_bounded_age(self):
        validate(self.config)
        for change in ({"cache_file": "/tmp/cache.json"}, {"metrics": ["bad"]},
                       {"metrics": ["sata_ssd_a_temperature_c"] * 2},
                       {"metrics": [self.config["sensors"][0]["metric"]]},
                       {"max_age_seconds": True}, {"max_age_seconds": 0}, {"max_age_seconds": 3601}):
            with self.subTest(change=change):
                config = copy.deepcopy(self.config)
                config["smart"].update(change)
                with self.assertRaises(ValueError):
                    validate(config)
        config = copy.deepcopy(self.config)
        del config["smart"]["cache_file"]
        del config["smart"]["max_age_seconds"]
        self.assertEqual(validate(config)["smart"], self.smart)
        del config["smart"]
        self.assertNotIn("smart", validate(config))

    def test_valid_zero_partial_standby_and_source_times_are_preserved(self):
        parsed = self.parsed()
        self.assertEqual(parsed["metrics"]["sata_hdd_a_temperature_c"], 0)
        cache = copy.deepcopy(self.cache)
        del cache["metrics"]["sata_hdd_a_temperature_c"]
        del cache["per_metric_read_time_utc"]["sata_hdd_a_temperature_c"]
        cache["missing_metrics"] = ["sata_hdd_a_temperature_c"]
        cache["errors"] = {"sata_hdd_a_temperature_c": "device_standby"}
        sample = smart_envelope(self.config, self.parsed(cache))
        self.assertEqual(sample["metrics"], {"sata_ssd_a_temperature_c": 34})
        self.assertEqual(sample["read_time_utc"], cache["read_time_utc"])
        self.assertIsNone(sample["sample_time_utc"])
        self.assertEqual(sample["observation_kind"], "direct_read")
        self.assertEqual(sample["source"]["temperature_source"], "smartctl")
        self.assertEqual(sample["source"]["errors"], cache["errors"])
        self.assertEqual(sample["source"]["per_metric_read_time_utc"], cache["per_metric_read_time_utc"])
        self.assertEqual(sample["device_id"], self.config["device_id"])
        self.assertEqual(sample["message_id"], smart_envelope(self.config, self.parsed(cache))["message_id"])

    def test_reject_stale_future_malformed_mismatched_and_non_numeric_snapshots(self):
        changes = [
            {"version": True}, {"batch_id": "not-a-uuid"}, {"sample_time_utc": self.cache["read_time_utc"]},
            {"read_time_utc": "2026-09-28T11:57:59.000Z"},
            {"read_time_utc": "2026-09-28T12:00:01.000Z"},
            {"read_time_utc": "2026-09-28T11:59:55+00:00"},
            {"metrics": {"sata_ssd_a_temperature_c": 34}},
            {"missing_metrics": ["sata_ssd_a_temperature_c"]},
            {"metrics": {**self.cache["metrics"], "unexpected_temperature_c": 12}},
            {"per_metric_read_time_utc": {}},
            {"per_metric_read_time_utc": {**self.cache["per_metric_read_time_utc"], "sata_ssd_a_temperature_c": "2026-09-28T11:59:56.000Z"}},
            {"errors": {"sata_ssd_a_temperature_c": "device_standby"}},
            {"quality_notes": {"sata_ssd_a_temperature_c": ["/dev/private-id"]}},
        ]
        for value in (None, True, "34", float("nan"), float("inf"), 151, -51):
            changes.append({"metrics": {**self.cache["metrics"], "sata_ssd_a_temperature_c": value}})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.parsed({**self.cache, **change})

    def test_cache_unavailable_malformed_or_partial_failure_does_not_drop_sysfs(self):
        sysfs = SimpleNamespace(stdout="one-minihouse-temperatures-v1\nhwmon\tcoretemp\tPackage id 0\t50000\nhwmon\tnvme.pci-0000_01_00.0\tComposite\t42000\n")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "readings.json"
            self.smart["cache_file"] = str(path)
            with patch("agent.subprocess.run", return_value=sysfs):
                sample, smart_sample, state, cache = collect_samples(self.config)
                self.assertEqual(sample["metrics"]["cpu_package_temperature_c"], 50)
                self.assertIsNone(smart_sample)
                self.assertIsNone(cache)
                self.assertEqual(state["quality"], "degraded")
                self.assertEqual(state["source"]["smart_error"], "smart_cache_unavailable")
                self.assertEqual(state["source"]["smart_missing_metrics"], self.smart["metrics"])
                for raw in (b"{invalid", b"[]", b"\xff", b" " * 65537, b"[" * 2000):
                    path.write_bytes(raw)
                    self.assertEqual(read_smart_cache(self.smart), (None, "smart_cache_invalid"))
                    self.assertEqual(collect_samples(self.config)[0]["metrics"], sample["metrics"])
            partial = copy.deepcopy(self.cache)
            del partial["metrics"]["sata_hdd_a_temperature_c"]
            del partial["per_metric_read_time_utc"]["sata_hdd_a_temperature_c"]
            partial["missing_metrics"] = ["sata_hdd_a_temperature_c"]
            partial["errors"] = {"sata_hdd_a_temperature_c": "device_standby"}
            with patch("agent.subprocess.run", return_value=sysfs), patch("agent.read_smart_cache", return_value=(self.parsed(partial), None)):
                sample, smart_sample, state, _ = collect_samples(self.config)
                self.assertEqual(state["metrics"], sample["metrics"])
                self.assertNotIn("sata_ssd_a_temperature_c", state["metrics"])
                self.assertEqual(state["source"]["smart_read_time_utc"], partial["read_time_utc"])
                self.assertEqual(smart_sample["metrics"], partial["metrics"])
                self.assertEqual(state["quality"], "degraded")

    def test_sysfs_timeout_does_not_drop_smart_and_health_warning_preserves_value(self):
        cache = self.parsed()
        cache["quality_notes"] = {"sata_ssd_a_temperature_c": ["smart_health_warning"]}
        with patch("agent.subprocess.run", side_effect=subprocess.TimeoutExpired("reader", 10)), patch("agent.read_smart_cache", return_value=(cache, None)):
            sample, smart_sample, state, _ = collect_samples(self.config)
        self.assertEqual(sample["metrics"], {})
        self.assertEqual(smart_sample["metrics"], cache["metrics"])
        self.assertEqual(smart_sample["source"]["quality_notes"], cache["quality_notes"])
        self.assertEqual(state["quality"], "degraded")
        self.assertEqual(state["source"]["smart_quality_notes"], cache["quality_notes"])
        sysfs = SimpleNamespace(stdout="one-minihouse-temperatures-v1\nhwmon\tcoretemp\tPackage id 0\t50000\nhwmon\tnvme.pci-0000_01_00.0\tComposite\t42000\n")
        with patch("agent.subprocess.run", return_value=sysfs), patch("agent.read_smart_cache", return_value=(cache, None)):
            self.assertEqual(collect_samples(self.config)[2]["quality"], "degraded")
            cache["quality_notes"] = {}
            self.assertEqual(collect_samples(self.config)[2]["quality"], "ok")

    def test_cache_dedupe_survives_ack_restart_and_old_snapshot_after_new_batch(self):
        cache = self.parsed()
        sample = smart_envelope(self.config, cache)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.sqlite"
            box = Outbox(path, self.limits)
            box.save(None, sample, smart_sample=sample, smart_batch=cache)
            first = box.first()
            box.save(None, sample, smart_sample=sample, smart_batch=cache)
            self.assertEqual(box.stats()["pending"], 1)
            box.close()
            box = Outbox(path, self.limits)
            self.assertEqual(box.first(), first)
            for reason in (None, 128):
                with self.assertRaises(ValueError):
                    box.ack(sample["message_id"], reason)
                self.assertEqual(box.first(), first)
            box.ack(sample["message_id"], 0)
            box.close()
            box = Outbox(path, self.limits)
            box.save(None, sample, smart_sample=sample, smart_batch=cache)
            self.assertIsNone(box.first())
            newer = {**cache, "batch_id": "0792cfc9-3a4a-4416-a758-f13810532185", "read_time_utc": "2026-09-28T11:59:59.000Z"}
            newer_sample = smart_envelope(self.config, newer)
            box.save(None, newer_sample, smart_sample=newer_sample, smart_batch=newer)
            box.ack(newer_sample["message_id"], 0)
            box.save(None, sample, smart_sample=sample, smart_batch=cache)
            self.assertIsNone(box.first())
            box.close()

    def test_enqueue_marker_and_state_rollback_atomically_and_preserve_existing_sqlite(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.sqlite"
            legacy = envelope(self.config, {"cpu_package_temperature_c": 50}, [])
            # Existing on-disk schema is upgraded by opening it, without replacing
            # acknowledged state, queued readings, or drop accounting.
            with sqlite3.connect(path) as db:
                db.executescript("CREATE TABLE outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,captured_ms INTEGER NOT NULL,payload TEXT NOT NULL); CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")
                db.execute("INSERT INTO outbox(id,captured_ms,payload) VALUES(?,?,?)", (legacy["message_id"], 1, json.dumps(legacy)))
                db.execute("INSERT INTO meta VALUES('state',?)", (json.dumps(legacy),))
                db.execute("INSERT INTO meta VALUES('dropped','3')")
            db.close()
            box = Outbox(path, self.limits)
            self.assertEqual(json.loads(box.first()[1]), legacy)
            cache = self.parsed()
            sample = smart_envelope(self.config, cache)
            with self.assertRaises(ValueError):
                box.save(None, {"bad": float("nan")}, smart_sample=sample, smart_batch=cache)
            self.assertEqual(box.stats(), {"pending": 1, "dropped": 3})
            self.assertEqual(json.loads(box.state()), legacy)
            self.assertIsNone(box.db.execute("SELECT value FROM meta WHERE key='smart_last_batch'").fetchone())
            box.save(None, legacy, smart_sample=sample, smart_batch=cache)
            self.assertEqual(box.stats()["pending"], 2)
            self.assertEqual(json.loads(box.state()), legacy)
            box.close()


class GpuCacheTests(unittest.TestCase):
    def setUp(self):
        self.config = json.loads(Path(__file__).with_name("config.example.json").read_text())
        self.config.pop("smart", None)
        self.config["gpu"] = {"cache_file": GPU_CACHE_FILE, "metrics": ["gpu_temperature_c"], "max_age_seconds": 120}
        self.gpu = self.config["gpu"]
        self.now = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
        self.cache = {"version": 1, "batch_id": "af9fce22-7eab-42f5-9904-e04cdcc61292",
                      "read_time_utc": "2026-09-28T11:59:55.000Z", "sample_time_utc": None,
                      "metrics": {"gpu_temperature_c": 42}, "missing_metrics": [], "errors": {}, "quality_notes": {},
                      "per_metric_read_time_utc": {"gpu_temperature_c": "2026-09-28T11:59:55.000Z"}}
        self.limits = {"max_age_days": 1, "max_rows": 20}

    def parsed(self, cache=None):
        return parse_gpu_cache(self.cache if cache is None else cache, self.gpu, now=self.now)

    def test_gpu_only_requires_valid_gpu_and_disjoint_fixed_metrics(self):
        example = validate(json.loads(Path(__file__).with_name("config.gpu.example.json").read_text()))
        self.assertEqual(example["sensors"], [])
        self.assertEqual(example["gpu"]["metrics"], ["gpu_temperature_c"])
        self.config["sensors"] = []
        validate(self.config)
        for change in ({"cache_file": "/tmp/gpu.json"}, {"metrics": []}, {"metrics": ["gpu_temperature_c"] * 2},
                       {"metrics": ["invalid"]}, {"metrics": ["gpu_%d_temperature_c" % i for i in range(9)]},
                       {"max_age_seconds": True}, {"max_age_seconds": 0}, {"max_age_seconds": 3601}, {"args": []}):
            config = copy.deepcopy(self.config)
            config["gpu"].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate(config)
        config = copy.deepcopy(self.config)
        del config["gpu"]
        with self.assertRaises(ValueError):
            validate(config)
        config["smart"] = {"metrics": ["gpu_temperature_c"]}
        with self.assertRaises(ValueError):
            validate(config)
        config["gpu"] = copy.deepcopy(self.gpu)
        with self.assertRaises(ValueError):
            validate(config)

    def test_gpu_only_skips_sysfs_and_preserves_measurement_time_and_source(self):
        self.config["sensors"] = []
        cache = self.parsed()
        with patch("agent.subprocess.run", side_effect=AssertionError("no sysfs for GPU-only")), patch("agent.read_gpu_cache", return_value=(cache, None)):
            sample, smart, state, smart_batch, gpu, batch = collect_all_samples(self.config)
        self.assertEqual(sample["metrics"], {})
        self.assertIsNone(smart)
        self.assertIsNone(smart_batch)
        self.assertEqual(gpu["metrics"], {"gpu_temperature_c": 42})
        self.assertEqual(gpu["source"]["temperature_source"], "nvidia_smi")
        self.assertEqual(gpu["read_time_utc"], self.cache["read_time_utc"])
        self.assertIsNone(gpu["sample_time_utc"])
        self.assertEqual(state["metrics"], gpu["metrics"])
        self.assertEqual(state["read_time_utc"], gpu["read_time_utc"])
        self.assertEqual(state["quality"], "ok")
        self.assertEqual(batch, cache)
        self.assertEqual(gpu["message_id"], gpu_envelope(self.config, cache)["message_id"])
        self.assertNotEqual(gpu["message_id"], smart_envelope(self.config, cache)["message_id"])

    def test_gpu_only_failures_do_not_fabricate_zero_or_time(self):
        self.config["sensors"] = []
        for code in ("gpu_cache_unavailable", "gpu_cache_stale", "gpu_cache_invalid"):
            with patch("agent.read_gpu_cache", return_value=(None, code)):
                sample, _, state, _, gpu, batch = collect_all_samples(self.config)
            self.assertEqual(sample["metrics"], {})
            self.assertEqual(state["metrics"], {})
            self.assertIsNone(state["read_time_utc"])
            self.assertEqual(state["quality"], "degraded")
            self.assertIsNone(gpu)
            self.assertIsNone(batch)
            self.assertEqual(state["source"]["gpu_error"], code)
        missing = {**self.cache, "metrics": {}, "missing_metrics": ["gpu_temperature_c"],
                   "errors": {"gpu_temperature_c": "temperature_unavailable"}, "per_metric_read_time_utc": {}}
        with patch("agent.read_gpu_cache", return_value=(self.parsed(missing), None)):
            self.assertIsNone(collect_all_samples(self.config)[4])

    def test_invalid_stale_future_and_mismatched_gpu_cache(self):
        for change in ({"version": True}, {"batch_id": "invalid"}, {"read_time_utc": "2026-09-28T11:57:00.000Z"},
                       {"read_time_utc": "2026-09-28T12:01:00.000Z"}, {"metrics": {"gpu_temperature_c": True}},
                       {"metrics": {"gpu_temperature_c": "N/A"}}, {"metrics": {"gpu_temperature_c": 151}},
                       {"metrics": {"other_temperature_c": 42}}, {"per_metric_read_time_utc": {}},
                       {"errors": {"gpu_temperature_c": "error"}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.parsed({**self.cache, **change})
        with tempfile.TemporaryDirectory() as directory:
            self.gpu["cache_file"] = str(Path(directory) / "readings.json")
            self.assertEqual(read_gpu_cache(self.gpu), (None, "gpu_cache_unavailable"))
            for raw in (b"{invalid", b"[]", b"\xff", b" " * 65537, b"[" * 2000):
                Path(self.gpu["cache_file"]).write_bytes(raw)
                self.assertEqual(read_gpu_cache(self.gpu), (None, "gpu_cache_invalid"))

    def test_gpu_failure_does_not_change_sysfs_or_smart(self):
        self.config["smart"] = {"metrics": ["sata_ssd_a_temperature_c"], "cache_file": SMART_CACHE_FILE, "max_age_seconds": 120}
        smart = {**self.cache, "metrics": {"sata_ssd_a_temperature_c": 34},
                 "per_metric_read_time_utc": {"sata_ssd_a_temperature_c": self.cache["read_time_utc"]}}
        sysfs = SimpleNamespace(stdout="one-minihouse-temperatures-v1\nhwmon\tcoretemp\tPackage id 0\t50000\nhwmon\tnvme.pci-0000_01_00.0\tComposite\t42000\n")
        with patch("agent.subprocess.run", return_value=sysfs), patch("agent.read_smart_cache", return_value=(smart, None)), patch("agent.read_gpu_cache", return_value=(None, "gpu_cache_stale")):
            original = collect_samples(self.config)
            sample, smart_sample, state, smart_batch, gpu, _ = collect_all_samples(self.config)
        self.assertEqual(sample["metrics"], original[0]["metrics"])
        self.assertEqual(smart_sample, original[1])
        self.assertEqual(smart_batch, smart)
        self.assertEqual(state["metrics"], sample["metrics"])
        self.assertEqual(state["source"]["smart_error"], None)
        self.assertEqual(state["source"]["gpu_error"], "gpu_cache_stale")
        self.assertEqual(state["quality"], "degraded")
        self.assertIsNone(gpu)

    def test_gpu_keeps_working_if_sysfs_and_smart_fail(self):
        self.config["smart"] = {"metrics": ["sata_ssd_a_temperature_c"], "cache_file": SMART_CACHE_FILE, "max_age_seconds": 120}
        with patch("agent.subprocess.run", side_effect=subprocess.TimeoutExpired("sysfs", 10)), patch("agent.read_smart_cache", return_value=(None, "smart_cache_unavailable")), patch("agent.read_gpu_cache", return_value=(self.parsed(), None)):
            sample, smart_sample, state, _, gpu, _ = collect_all_samples(self.config)
        self.assertEqual(sample["metrics"], {})
        self.assertIsNone(smart_sample)
        self.assertEqual(gpu["metrics"], self.cache["metrics"])
        self.assertEqual(state["quality"], "degraded")

    def test_gpu_batch_dedupe_is_durable_independent_and_transactional(self):
        batch = self.parsed()
        gpu = gpu_envelope(self.config, batch)
        smart = smart_envelope(self.config, batch)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "outbox.sqlite"
            box = Outbox(path, self.limits)
            legacy = envelope(self.config, {"cpu_package_temperature_c": 45}, [])
            box.save(legacy, legacy)
            original = box.first()
            with self.assertRaises(ValueError):
                box.save(None, {"bad": float("nan")}, gpu_sample=gpu, gpu_batch=batch)
            self.assertEqual(box.first(), original)
            self.assertIsNone(box.db.execute("SELECT value FROM meta WHERE key='gpu_last_batch'").fetchone())
            box.save(None, gpu, smart_sample=smart, smart_batch=batch, gpu_sample=gpu, gpu_batch=batch)
            self.assertEqual(box.stats()["pending"], 3)
            for sample in (legacy, smart, gpu):
                box.ack(sample["message_id"], 0)
            box.close()
            box = Outbox(path, self.limits)
            box.save(None, gpu, smart_sample=smart, smart_batch=batch, gpu_sample=gpu, gpu_batch=batch)
            self.assertIsNone(box.first())
            newer = {**batch, "batch_id": "0792cfc9-3a4a-4416-a758-f13810532185", "read_time_utc": "2026-09-28T11:59:59.000Z"}
            newer_gpu = gpu_envelope(self.config, newer)
            box.save(None, newer_gpu, gpu_sample=newer_gpu, gpu_batch=newer)
            box.ack(newer_gpu["message_id"], 0)
            box.save(None, gpu, gpu_sample=gpu, gpu_batch=batch)
            self.assertIsNone(box.first())
            self.assertEqual(json.loads(box.db.execute("SELECT value FROM meta WHERE key='smart_last_batch'").fetchone()[0])["batch_id"], batch["batch_id"])
            box.close()


if __name__ == "__main__":
    unittest.main()
