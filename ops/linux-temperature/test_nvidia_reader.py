import copy
import csv
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import nvidia_reader as reader


def device(index=0):
    return {"uuid": "GPU-aaaaaaaa-bbbb-cccc-dddd-%012x" % index,
            "expected_model": "EXAMPLE NVIDIA GPU", "device_node": "/dev/nvidia%d" % index,
            "metric": "gpu_%s_temperature_c" % chr(97 + index)}


def response(selected=None, temperature="42", status=0):
    selected = selected or device()
    buffer = io.StringIO()
    csv.writer(buffer, lineterminator="\n").writerow([selected["uuid"], selected["expected_model"], temperature])
    return SimpleNamespace(returncode=status, stdout=buffer.getvalue().encode("utf-8"))


class NvidiaReaderTests(unittest.TestCase):
    def config(self, *devices):
        return {"version": 1, "devices": list(devices or [device()])}

    def collect(self, result=None, devices=None, runner=None, clock=None):
        return reader.collect(self.config(*(devices or [device()])), runner or (lambda _: result or response()),
                              device_check=lambda _: None, clock=clock or (lambda: "2026-01-01T00:00:01.000Z"))

    def assert_missing(self, batch, code):
        self.assertEqual(batch["metrics"], {})
        self.assertEqual(batch["missing_metrics"], [device()["metric"]])
        self.assertEqual(batch["errors"], {device()["metric"]: code})
        self.assertEqual(batch["per_metric_read_time_utc"], {})

    def test_fixed_identity_scoped_temperature_only_query_and_timeout(self):
        expected = ["/usr/bin/nvidia-smi", "--id=" + device()["uuid"],
                    "--query-gpu=uuid,name,temperature.gpu", "--format=csv,noheader,nounits"]
        self.assertEqual(reader.command(device()), expected)
        with patch.object(reader.subprocess, "run", return_value=response()) as run:
            reader.run_command(expected)
        self.assertEqual(run.call_args.args[0], expected)
        self.assertEqual(run.call_args.kwargs["timeout"], 5)
        self.assertFalse(run.call_args.kwargs.get("shell", False))
        self.assertIs(run.call_args.kwargs["stderr"], subprocess.DEVNULL)
        self.assertEqual(run.call_args.kwargs["env"], {"PATH": "/usr/bin:/bin", "LC_ALL": "C"})

    def test_snapshot_contract_keeps_read_completion_times_and_no_identity(self):
        ticks = iter(["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"])
        batch = self.collect(clock=lambda: next(ticks))
        self.assertEqual(batch["version"], 1)
        self.assertEqual(str(uuid.UUID(batch["batch_id"])), batch["batch_id"])
        self.assertEqual(batch["read_time_utc"], "2026-01-01T00:00:02.000Z")
        self.assertEqual(batch["per_metric_read_time_utc"][device()["metric"]], "2026-01-01T00:00:01.000Z")
        self.assertIsNone(batch["sample_time_utc"])
        self.assertEqual(batch["metrics"], {device()["metric"]: 42})
        for private in (device()["uuid"], device()["expected_model"], device()["device_node"]):
            self.assertNotIn(private, reader.encode(batch))

    def test_na_errors_and_malformed_values_never_create_zero(self):
        for value in ("N/A", "[N/A]", "Not Supported", "[Not Supported]", ""):
            self.assert_missing(self.collect(response(temperature=value)), "temperature_unavailable")
        for value in ("True", "nan", "inf", "42 C", "42.5", "-51", "151", "9999"):
            self.assert_missing(self.collect(response(temperature=value)), "invalid_temperature")
        for status in (1, 9, -9, True):
            self.assert_missing(self.collect(response(status=status)), "nvidia_smi_failed")
        for value in ("0", "-50", "150"):
            self.assertEqual(self.collect(response(temperature=value))["metrics"][device()["metric"]], int(value))

    def test_identity_mismatch_and_extra_rows_fail_closed(self):
        for key, value in [("uuid", device(1)["uuid"]), ("expected_model", "OTHER GPU")]:
            selected = device()
            selected[key] = value
            self.assert_missing(self.collect(response(selected)), "identity_mismatch")
        for output in (b"", b"header\n", response().stdout * 2, b"\xff", b"x" * 16385,
                       response().stdout + b"\n", b'"unterminated'):
            self.assert_missing(self.collect(SimpleNamespace(returncode=0, stdout=output)), "invalid_response")

    def test_timeout_isolated_and_exception_output_not_exposed(self):
        first, second = device(), device(1)
        def runner(argv):
            if argv[1] == "--id=" + first["uuid"]:
                raise subprocess.TimeoutExpired("PRIVATE_COMMAND", 5, output="PRIVATE_STDOUT", stderr="PRIVATE_STDERR")
            return response(second, "37")
        batch = self.collect(devices=[first, second], runner=runner)
        self.assertEqual(batch["metrics"], {second["metric"]: 37})
        self.assertEqual(batch["errors"], {first["metric"]: "read_timeout"})
        self.assertNotIn("PRIVATE", reader.encode(batch))

    def test_absent_device_never_runs_cli(self):
        def unavailable(_):
            raise reader.ReadError("gpu_device_unavailable")
        with patch.object(reader, "run_command", side_effect=AssertionError("must not query")) as run:
            batch = reader.collect(self.config(), runner=run, device_check=unavailable)
        run.assert_not_called()
        self.assert_missing(batch, "gpu_device_unavailable")

    def test_configuration_rejects_freeform_flags_duplicate_or_unbounded_devices(self):
        invalid = [("uuid", "0"), ("uuid", device()["uuid"] + " --reset"),
                   ("expected_model", " MODEL "), ("expected_model", "GPU\nunsafe"),
                   ("device_node", "/dev/nvidiactl"), ("device_node", "/dev/nvidia255"),
                   ("device_node", "/dev/nvidia-uvm"), ("device_node", "/dev/nvidia0;echo"),
                   ("metric", "temperature"), ("args", ["-pm", "1"])]
        for key, value in invalid:
            selected = device()
            selected[key] = value
            with self.subTest(key=key), self.assertRaises(reader.ReadError):
                reader.validate(self.config(selected))
        for config in (self.config(device(), copy.deepcopy(device())), self.config(*[device(i) for i in range(9)]),
                       {"version": True, "devices": [device()]}, {"version": 1, "devices": []}):
            with self.assertRaises(reader.ReadError):
                reader.validate(config)
        reader.validate(self.config(*[device(i) for i in range(8)]))

    def test_synthetic_example(self):
        config = reader.validate(json.loads(Path(__file__).with_name("nvidia.example.json").read_text()))
        self.assertEqual(config["devices"][0]["expected_model"], "EXAMPLE NVIDIA GPU")

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "Linux root filesystem fixture, no GPU device access")
    def test_private_config_and_atomic_cache_permissions_symlink_refusal(self):
        with tempfile.TemporaryDirectory(prefix="nvidia-reader-test-", dir="/run") as root:
            config = Path(root) / "config.json"
            config.write_text(json.dumps(self.config()))
            config.chmod(0o600)
            self.assertEqual(reader.load_config(config), self.config())
            config.chmod(0o644)
            with self.assertRaises(reader.ReadError):
                reader.load_config(config)
            parent = Path(root) / "cache"
            parent.mkdir(mode=0o755)
            output = parent / "readings.json"
            batch = self.collect()
            reader.write_cache(output, batch)
            self.assertEqual(json.loads(output.read_text()), batch)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o644)
            self.assertEqual(output.stat().st_uid, 0)
            missing = self.collect(response(temperature="N/A"))
            reader.write_cache(output, missing)
            self.assertEqual(json.loads(output.read_text()), missing)
            self.assertEqual(list(parent.iterdir()), [output])
            output.unlink()
            output.symlink_to(config)
            with self.assertRaises(reader.ReadError):
                reader.write_cache(output, batch)


if __name__ == "__main__":
    unittest.main()
