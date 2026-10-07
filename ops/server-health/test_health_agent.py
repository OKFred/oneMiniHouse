import json
import io
import hashlib
import zlib
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import health_agent as agent


class HealthAgentTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "health.sqlite"
        self.db = agent.connect(self.path, True)
        self.now = 1789826400
        self.cfg = {"server_id": "test", "sls": {"enabled": True}}
        self.snapshot = {"boot_id": "boot-1", "containers": {}, "services": {}}

    def tearDown(self):
        self.db.close()
        self.directory.cleanup()

    def event(self, now=None):
        return agent.save_event(self.db, self.cfg, self.now if now is None else now, self.snapshot, [])

    def test_budget_survives_restart_and_reinitialization_is_rejected(self):
        self.assertIsNone(agent.reserve(self.db, self.now, agent.BYTE_LIMIT - 10))
        self.db.close()
        self.db = agent.connect(self.path)
        self.assertEqual(agent.reserve(self.db, self.now + 1, 11), "budget_exhausted")
        self.assertIsNone(agent.reserve(self.db, self.now + 2, 10))
        with self.assertRaises(FileExistsError):
            agent.connect(self.path, True)

    def test_missing_ledger_never_resets_the_budget(self):
        missing = Path(self.directory.name) / "missing.sqlite"
        with self.assertRaises(sqlite3.OperationalError):
            agent.connect(missing)
        self.assertFalse(missing.exists())

    def test_calendar_rollover_does_not_reset_rolling_budget(self):
        self.assertIsNone(agent.reserve(self.db, self.now, agent.BYTE_LIMIT))
        self.assertEqual(agent.reserve(self.db, self.now + agent.DAY, 1), "budget_exhausted")
        self.assertIsNone(agent.reserve(self.db, self.now + agent.WINDOW + 1, 1))
        self.assertEqual(agent.reserve(self.db, self.now, 1), "clock_regressed")

    def test_request_limit_is_independent_of_bytes(self):
        with patch.object(agent, "REQUEST_LIMIT", 2):
            self.assertIsNone(agent.reserve(self.db, self.now, 1))
            self.assertIsNone(agent.reserve(self.db, self.now, 1))
            self.assertEqual(agent.reserve(self.db, self.now, 1), "budget_exhausted")

    def test_failures_keep_stable_ids_and_every_retry_consumes_budget(self):
        event = self.event()
        calls = []

        def uncertain(raw, body):
            calls.append(raw)
            raise OSError("timeout after server may have accepted")

        self.assertEqual(agent.upload(self.db, self.cfg, self.now, uncertain), "upload_failed")
        self.assertEqual(agent.upload(self.db, self.cfg, self.now + 1, uncertain), "backoff")
        self.assertEqual(agent.upload(self.db, self.cfg, self.now + 300, lambda raw, body: 403), "upload_failed")
        self.assertEqual(agent.upload(self.db, self.cfg, self.now + 900, lambda raw, body: 200), "sent")
        self.assertEqual(agent.budget(self.db, self.now + 900)["requests_32d"], 3)
        self.assertEqual(self.db.execute("SELECT event_id,delivery FROM events").fetchall(), [(event["event_id"], "sent")])

    def test_budget_reserved_before_network_and_exhaustion_sends_nothing(self):
        self.event()
        seen = []

        def accepted(raw, body):
            seen.append(agent.budget(self.db, self.now)["requests_32d"])
            return 200

        self.assertEqual(agent.upload(self.db, self.cfg, self.now, accepted), "sent")
        self.assertEqual(seen, [1])
        self.event(self.now + 300)
        with patch.object(agent, "BYTE_LIMIT", 1):
            self.assertEqual(agent.upload(self.db, self.cfg, self.now + 300, accepted), "budget_exhausted")
        self.assertEqual(seen, [1])

    def test_local_only_records_do_not_become_an_implicit_cloud_backfill(self):
        self.cfg["sls"]["enabled"] = False
        self.event()
        self.cfg["sls"]["enabled"] = True
        self.assertEqual(agent.upload(self.db, self.cfg, self.now, lambda *_: self.fail("unexpected upload")), "idle")

    def test_local_storage_cap_and_stale_replay(self):
        with patch.object(agent, "LOCAL_RECORD_LIMIT", 3):
            for offset in range(5):
                self.event(self.now + offset)
            self.assertEqual(self.db.execute("SELECT count(*) FROM events").fetchone()[0], 3)
            self.assertEqual(agent.get_meta(self.db, "pending_evicted"), "2")
            self.event(self.now + agent.DAY + 10)
            self.assertEqual(self.db.execute("SELECT count(*) FROM events WHERE delivery='pending'").fetchone()[0], 1)
            self.event(self.now + agent.LOCAL_DAYS * agent.DAY + agent.DAY + 11)
            self.assertEqual(self.db.execute("SELECT count(*) FROM events").fetchone()[0], 1)

    def test_service_failure_restart_and_recovery_are_transitions(self):
        self.assertEqual(self.event()["event_type"], "baseline")
        self.assertEqual(self.event(self.now + 300)["event_type"], "heartbeat")
        self.snapshot["containers"]["collector"] = {"status": "restarting"}
        bad = agent.save_event(self.db, self.cfg, self.now + 600, self.snapshot, ["container:collector"])
        self.assertEqual((bad["event_type"], bad["quality"]), ("state_change", "degraded"))
        self.snapshot["containers"]["collector"] = {"status": "running", "restart_count": 1}
        self.assertEqual(self.event(self.now + 900)["event_type"], "state_change")
        self.assertEqual(self.event(self.now + 1200)["event_type"], "heartbeat")

    def test_oversized_record_is_rejected_before_storage(self):
        self.snapshot["test"] = "x" * agent.RECORD_LIMIT
        with self.assertRaises(ValueError):
            self.event()
        self.assertEqual(self.db.execute("SELECT count(*) FROM events").fetchone()[0], 0)

    def test_protobuf_wire_matches_existing_node_fixture(self):
        row = agent.varint(8) + agent.varint(1690254376) + agent.field(2, agent.field(1, "test") + agent.field(2, "hello"))
        wire = agent.field(1, row) + agent.field(3, "iot_protocol_frames") + agent.field(4, "oneMiniHouse")
        self.assertEqual(wire.hex(), "0a1508a8f8fca506120d0a0474657374120568656c6c6f1a13696f745f70726f746f636f6c5f6672616d6573220c6f6e654d696e69486f757365")

    def test_provider_error_only_retains_a_bounded_symbolic_code(self):
        response = io.BytesIO(b'{"errorCode":"InvalidCompression","errorMessage":"credential must never be logged"}')
        self.assertEqual(agent.provider_error_code(response), "InvalidCompression")
        for body in (b'{"errorCode":"secret / unsafe"}', b'[]', b'{"errorCode":123}'):
            self.assertEqual(agent.provider_error_code(io.BytesIO(body)), "UnknownProviderError")
        self.assertEqual(agent.provider_error_code(io.BytesIO(b'not json')), "InvalidErrorResponse")
        response = io.BytesIO(b'x' * 10000)
        self.assertEqual(agent.provider_error_code(response), "ErrorResponseTooLarge")
        self.assertEqual(response.tell(), 4097)

    def test_sls_body_uses_zlib_deflate_and_signs_the_transmitted_bytes(self):
        event = self.event()

        def accepted(raw, body):
            self.assertEqual(zlib.decompress(body), raw)
            self.assertIn(event["event_id"].encode(), raw)
            headers = agent.signed_headers("/logstores/server-health/shards/lb", body, len(raw), "test-id", "test-secret", "Sat, 19 Sep 2026 15:00:00 GMT")
            self.assertEqual(headers["x-log-compresstype"], "deflate")
            self.assertEqual(headers["x-log-bodyrawsize"], str(len(raw)))
            self.assertEqual(headers["content-md5"], hashlib.md5(body).hexdigest().upper())
            return 200

        self.assertEqual(agent.upload(self.db, self.cfg, self.now, accepted), "sent")


if __name__ == "__main__":
    unittest.main()
