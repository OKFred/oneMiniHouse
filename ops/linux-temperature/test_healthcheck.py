import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from healthcheck import heartbeat_fresh


class HealthcheckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "health.json"
        self.now = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)

    def write(self, value):
        self.path.write_text(json.dumps(value), encoding="utf-8")

    def stamp(self, age):
        return (self.now - timedelta(seconds=age)).isoformat()

    def fresh(self, key="heartbeat_time_utc"):
        return heartbeat_fresh(self.path, 180, key, self.now)

    def test_explicit_utc_timestamp_formats(self):
        for stamp in (self.stamp(10), self.stamp(10).replace("+00:00", "Z")):
            with self.subTest(stamp=stamp):
                self.write({"heartbeat_time_utc": stamp})
                self.assertTrue(self.fresh())

    def test_rejects_naive_and_non_utc_timestamps(self):
        for stamp in ("2026-01-01T12:00:00", "2026-01-01T20:00:00+08:00"):
            with self.subTest(stamp=stamp):
                self.write({"heartbeat_time_utc": stamp})
                self.assertFalse(self.fresh())

    def test_heartbeat_expires_after_maximum_age(self):
        for age, expected in ((179, True), (180, True), (181, False)):
            with self.subTest(age=age):
                self.write({"heartbeat_time_utc": self.stamp(age)})
                self.assertEqual(self.fresh(), expected)

    def test_future_timestamps_allow_only_small_clock_skew(self):
        for age, expected in ((-30, True), (-31, False), (-3600, False)):
            with self.subTest(age=age):
                self.write({"heartbeat_time_utc": self.stamp(age)})
                self.assertEqual(self.fresh(), expected)

    def test_malformed_json_or_wrong_shape_is_unhealthy(self):
        self.path.write_text("{broken", encoding="utf-8")
        self.assertFalse(self.fresh())
        self.path.write_bytes(b"\xff")
        self.assertFalse(self.fresh())
        for value in ({}, [], None, "text", {"heartbeat_time_utc": None},
                      {"heartbeat_time_utc": 42}, {"heartbeat_time_utc": "not a time"}):
            with self.subTest(value=value):
                self.write(value)
                self.assertFalse(self.fresh())

    def test_missing_or_unreadable_file_is_unhealthy(self):
        self.assertFalse(self.fresh())
        self.path.mkdir()
        self.assertFalse(self.fresh())

    def test_json_read_is_bounded(self):
        self.write({"heartbeat_time_utc": self.stamp(1)})
        content = self.path.read_bytes()
        self.path.write_bytes(content + b" " * (65536 - len(content)))
        self.assertTrue(self.fresh())
        with self.path.open("ab") as stream:
            stream.write(b" ")
        self.assertFalse(self.fresh())

    def test_network_failure_does_not_mask_a_live_scheduler(self):
        self.write({"heartbeat_time_utc": self.stamp(10), "mqtt_connected": False,
                    "quality": "degraded", "missing_metrics": ["cpu_temperature_c"]})
        self.assertTrue(self.fresh())

    def test_standby_disk_cache_is_live_without_fabricated_metrics(self):
        self.write({"read_time_utc": self.stamp(10), "metrics": {},
                    "missing_metrics": ["sata_hdd_a_temperature_c"],
                    "errors": {"sata_hdd_a_temperature_c": "device_standby"}})
        self.assertTrue(self.fresh("read_time_utc"))
        self.assertFalse(self.fresh())


if __name__ == "__main__":
    unittest.main()
