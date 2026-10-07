import copy
import importlib.util
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

spec = importlib.util.spec_from_file_location("smart_reader", Path(__file__).with_name("smart_reader.py"))
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def device(index=0, rotation="ssd", device_type="ata"):
    return {"path": "/dev/disk/by-id/ata-EXAMPLE_DISK_SYNTHETIC%03d" % index,
            "expected_model": "EXAMPLE SATA DISK", "expected_serial": "SYNTHETIC%03d" % index,
            "metric": "sata_%s_%s_temperature_c" % (rotation, chr(97 + index)),
            "rotation": rotation, "device_type": device_type}


def fixture(selected=None, temperature=34, status=0):
    selected = selected or device()
    return {"smartctl": {"exit_status": status}, "device": {"protocol": "ATA"},
            "model_name": selected["expected_model"], "serial_number": selected["expected_serial"],
            "rotation_rate": 5900 if selected.get("rotation") == "hdd" else 0,
            "sata_version": {"string": "SATA 3.3"},
            "smart_support": {"available": True, "enabled": True},
            "temperature": {"current": temperature}}


def result(document=None, status=0, output=None):
    return SimpleNamespace(returncode=status, stdout=output if output is not None else json.dumps(document or fixture()))


class SmartReaderTests(unittest.TestCase):
    def config(self, *devices):
        return {"version": 1, "devices": list(devices or [device()])}

    def collect(self, response=None, devices=None, resolver=None, clock=None):
        return reader.collect(self.config(*(devices or [device()])),
                              runner=lambda _: response or result(),
                              resolver=resolver or (lambda _: "/dev/sda"),
                              clock=clock or (lambda: "2026-01-01T00:00:00.000Z"))

    def assert_missing(self, batch, code):
        metric = device()["metric"]
        self.assertEqual(batch["metrics"], {})
        self.assertEqual(batch["missing_metrics"], [metric])
        self.assertEqual(batch["errors"], {metric: code})
        self.assertEqual(batch["per_metric_read_time_utc"], {})

    def test_exact_fixed_commands_for_supported_transports(self):
        for kind in sorted(reader.DEVICE_TYPES):
            selected = device(device_type=kind)
            commands = []
            def runner(argv):
                commands.append(argv)
                return result(fixture(selected))
            batch = reader.collect(self.config(selected), runner, lambda _: "/dev/sda")
            self.assertEqual(commands, [["/usr/sbin/smartctl", "-i", "-A", "-j", "-d", kind,
                                         "-n", "standby,3,5", "/dev/sda"]])
            self.assertEqual(batch["metrics"][selected["metric"]], 34)

    def test_runner_has_five_second_deadline_and_drops_stderr(self):
        with patch.object(reader.subprocess, "run", return_value=result()) as run:
            reader.run_command(reader.command(device(), "/dev/sda"))
        kwargs = run.call_args.kwargs
        self.assertEqual(kwargs["timeout"], 5)
        self.assertIs(kwargs["stderr"], subprocess.DEVNULL)
        self.assertFalse(kwargs.get("shell", False))
        self.assertEqual(kwargs["env"], {"PATH": "/usr/sbin:/usr/bin:/bin", "LC_ALL": "C"})

    def test_cache_contract_and_completion_times(self):
        times = iter(["2026-01-01T00:00:01.000Z", "2026-01-01T00:00:02.000Z"])
        batch = self.collect(clock=lambda: next(times))
        self.assertEqual(batch["version"], 1)
        self.assertEqual(str(uuid.UUID(batch["batch_id"])), batch["batch_id"])
        self.assertEqual(batch["read_time_utc"], "2026-01-01T00:00:02.000Z")
        self.assertEqual(batch["per_metric_read_time_utc"][device()["metric"]], "2026-01-01T00:00:01.000Z")
        self.assertIsNone(batch["sample_time_utc"])
        self.assertEqual(batch["missing_metrics"], [])
        for private in (device()["path"], device()["expected_model"], device()["expected_serial"]):
            self.assertNotIn(private, reader.encode(batch))

    def test_standby_and_unsupported_power_checks_never_produce_temperature(self):
        for status, code in [(3, "device_standby"), (5, "power_check_unsupported")]:
            with self.subTest(status=status):
                # Even plausible temperature output cannot override these statuses.
                document = fixture(status=status)
                text = "Device is in STANDBY mode, exit(3)" if status == 3 else "CHECK POWER MODE not implemented, exit(5)"
                document["smartctl"]["messages"] = [{"string": text, "severity": "information"}]
                self.assert_missing(self.collect(result(document, status)), code)
                self.assert_missing(self.collect(result(status=status, output="")), "smartctl_failed")

    def test_power_check_error_is_not_mislabeled_as_verified_standby(self):
        document = fixture(status=3)
        document["power_mode"] = {"ata_value": -1, "name": "SLEEP"}
        document["smartctl"]["messages"] = [{"string": "Device is in SLEEP mode, exit(3)", "severity": "information"}]
        self.assert_missing(self.collect(result(document, 3)), "power_check_failed_or_sleep")
        for status in (3, 5):
            document = fixture(status=status)
            document["smartctl"]["messages"] = [{"string": "Permission denied"}]
            self.assert_missing(self.collect(result(document, status)), "smartctl_failed")

    def test_lower_exit_bits_and_signals_fail_closed(self):
        for status in (1, 2, 4, 6, 7, 9, 12, -9, 256):
            with self.subTest(status=status):
                self.assert_missing(self.collect(result(fixture(status=status), status)), "smartctl_failed")

    def test_health_bits_keep_temperature_with_quality_note(self):
        for status in (8, 16, 32, 64, 128, 248):
            batch = self.collect(result(fixture(status=status), status))
            self.assertEqual(batch["metrics"], {device()["metric"]: 34})
            self.assertIn("smart_health_warning", batch["quality_notes"][device()["metric"]])

    def test_wrong_or_missing_identity_never_publishes(self):
        for key in ("model_name", "serial_number"):
            for value in (None, "UNEXPECTED", "EXAMPLE SATA DISK "):
                document = fixture()
                document[key] = value
                self.assert_missing(self.collect(result(document)), "identity_mismatch")

    def test_default_rejects_hdd_but_explicit_hdd_is_supported(self):
        document = fixture()
        document["rotation_rate"] = 5900
        self.assert_missing(self.collect(result(document)), "rotation_mismatch")
        selected = device(rotation="hdd")
        batch = self.collect(result(fixture(selected)), devices=[selected])
        self.assertEqual(batch["metrics"], {selected["metric"]: 34})
        for rotation in (None, "unknown", True, -1):
            document = fixture()
            document["rotation_rate"] = rotation
            self.assert_missing(self.collect(result(document)), "rotation_mismatch")

    def test_wrong_protocol_or_missing_sata_info_rejected(self):
        for key, value in [("device", {"protocol": "NVMe"}), ("device", []),
                           ("sata_version", None), ("sata_version", {"string": "SAS 3.0"})]:
            document = fixture()
            document[key] = value
            self.assert_missing(self.collect(result(document)), "unsupported_interface")

    def test_disabled_smart_does_not_enable_or_publish(self):
        document = fixture()
        document["smart_support"]["enabled"] = False
        self.assert_missing(self.collect(result(document)), "smart_unavailable")

    def test_invalid_structured_temperature_never_falls_back(self):
        for value in (True, None, "34", -51, 151, 10 ** 400):
            document = fixture(temperature=value)
            document["ata_smart_attributes"] = {"table": [{"id": 194, "name": "Temperature_Celsius", "raw": {"value": 34}}]}
            self.assert_missing(self.collect(result(document)), "invalid_temperature")
        for value in (0, -50, 150, 33.5):
            self.assertEqual(self.collect(result(fixture(temperature=value)))["metrics"][device()["metric"]], value)

    def test_named_ata_temperature_attribute_fallback(self):
        for identifier, name in [(190, "Airflow_Temperature_Cel"), (194, "Temperature_Celsius")]:
            document = fixture()
            del document["temperature"]
            document["ata_smart_attributes"] = {"table": [{"id": identifier, "name": name, "raw": {"value": 31, "string": "31 (Min/Max 20/50)"}}]}
            batch = self.collect(result(document))
            self.assertEqual(batch["metrics"][device()["metric"]], 31)
            self.assertIn("ata_attribute_temperature", batch["quality_notes"][device()["metric"]])
            for invalid in (True, "31", 0x001e0028, 31.0):
                document["ata_smart_attributes"]["table"][0]["raw"]["value"] = invalid
                self.assert_missing(self.collect(result(document)), "invalid_temperature")

    def test_ambiguous_attributes_and_unknown_names_rejected(self):
        document = fixture()
        document.pop("temperature")
        document["ata_smart_attributes"] = {"table": [
            {"id": 190, "name": "Airflow_Temperature_Cel", "raw": {"value": 31}},
            {"id": 194, "name": "Temperature_Celsius", "raw": {"value": 32}}]}
        self.assert_missing(self.collect(result(document)), "ambiguous_temperature")
        document["ata_smart_attributes"]["table"] = [{"id": 194, "name": ["unexpected"], "raw": {"value": 30}}]
        self.assert_missing(self.collect(result(document)), "temperature_unavailable")

    def test_malformed_json_and_exit_status_mismatch_rejected(self):
        for output in ("", "[]", '{"smartctl":{},"smartctl":{}}', '{"temperature":NaN}', "x" * (reader.MAX_JSON_BYTES + 1)):
            self.assert_missing(self.collect(result(output=output)), "invalid_response")
        for status in (None, True, 8):
            document = fixture()
            document["smartctl"]["exit_status"] = status
            self.assert_missing(self.collect(result(document)), "invalid_response")

    def test_timeout_isolated_from_next_disk_and_no_exception_secrets(self):
        devices = [device(0), device(1)]
        def runner(argv):
            if argv[-1] == "/dev/sda":
                raise subprocess.TimeoutExpired("PRIVATE_COMMAND", 5, output="PRIVATE_STDOUT", stderr="PRIVATE_STDERR")
            return result(fixture(devices[1]))
        batch = reader.collect(self.config(*devices), runner, lambda selected: "/dev/sd" + ("a" if selected is devices[0] else "b"))
        self.assertEqual(batch["errors"], {devices[0]["metric"]: "read_timeout"})
        self.assertEqual(batch["metrics"], {devices[1]["metric"]: 34})
        self.assertNotIn("PRIVATE", reader.encode(batch))

    def test_preflight_rotation_error_never_opens_disk(self):
        def resolver(_):
            raise reader.ReadError("rotation_mismatch")
        with patch.object(reader, "run_command", side_effect=AssertionError("must not execute")):
            self.assert_missing(self.collect(resolver=resolver), "rotation_mismatch")

    def test_maximum_eight_devices_are_bounded_and_no_extra_scan(self):
        devices = [device(i) for i in range(8)]
        commands = []
        def runner(argv):
            commands.append(argv)
            raise subprocess.TimeoutExpired(argv, 5)
        batch = reader.collect(self.config(*devices), runner, lambda selected: "/dev/sd" + selected["metric"].split("_")[2])
        self.assertEqual(len(commands), 8)
        self.assertEqual(len(batch["missing_metrics"]), 8)
        with self.assertRaises(reader.ReadError):
            reader.validate(self.config(*(devices + [device(8)])))

    def test_config_rejects_injections_partitions_duplicates_and_unknown_keys(self):
        cases = [("path", "/dev/sda"), ("path", "/dev/disk/by-id/ata-example-part1"),
                 ("path", "/dev/disk/by-id/ata-example;touch_x"), ("path", "/dev/disk/by-id/ata-../x"),
                 ("device_type", "auto"), ("device_type", "sat -s on"), ("device_type", []),
                 ("rotation", "any"), ("expected_serial", "SERIAL\nInjected"), ("args", ["-s", "on"])]
        for key, value in cases:
            selected = device()
            selected[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(reader.ReadError):
                reader.validate(self.config(selected))
        with self.assertRaises(reader.ReadError):
            reader.validate(self.config(device(), copy.deepcopy(device())))
        for invalid in (None, [], {"version": True, "devices": [device()]}, self.config() | {"extra": True}):
            with self.assertRaises(reader.ReadError):
                reader.validate(invalid)

    def test_root_permissions_validation(self):
        reader.trusted_stat(SimpleNamespace(st_uid=0, st_gid=0, st_mode=stat.S_IFREG | 0o600), stat.S_ISREG, private=True)
        for uid, gid, mode in [(1000, 0, 0o600), (0, 1000, 0o600), (0, 0, 0o644), (0, 0, 0o622)]:
            with self.assertRaises(reader.ReadError):
                reader.trusted_stat(SimpleNamespace(st_uid=uid, st_gid=gid, st_mode=stat.S_IFREG | mode), stat.S_ISREG, private=True)

    def test_example_is_synthetic_and_valid(self):
        config = reader.validate(json.loads(Path(__file__).with_name("smart.example.json").read_text()))
        self.assertEqual(len(config["devices"]), 2)
        for selected in config["devices"]:
            self.assertTrue(selected["expected_serial"].startswith("SYNTHETIC"))

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "root Linux filesystem test; never opens hardware")
    def test_atomic_public_cache_and_symlink_rejection(self):
        with tempfile.TemporaryDirectory(prefix="smart-reader-test-", dir="/run") as root:
            parent = Path(root) / "cache"
            parent.mkdir(mode=0o755)
            output = parent / "readings.json"
            batch = self.collect()
            reader.write_cache(output, batch)
            self.assertEqual(json.loads(output.read_text()), batch)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o644)
            self.assertEqual(output.stat().st_uid, 0)
            replacement = self.collect(result(status=3, output=""))
            reader.write_cache(output, replacement)
            self.assertEqual(json.loads(output.read_text()), replacement)
            self.assertEqual(list(parent.iterdir()), [output])
            output.unlink()
            secret = Path(root) / "secret"
            secret.write_text("unchanged")
            output.symlink_to(secret)
            with self.assertRaises(reader.ReadError):
                reader.write_cache(output, batch)
            self.assertEqual(secret.read_text(), "unchanged")

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "root Linux filesystem test; never opens hardware")
    def test_private_config_and_symlink_permissions(self):
        with tempfile.TemporaryDirectory(prefix="smart-reader-test-", dir="/run") as root:
            config = Path(root) / "config.json"
            config.write_text(json.dumps(self.config()))
            config.chmod(0o600)
            self.assertEqual(reader.load_config(config), self.config())
            config.chmod(0o644)
            with self.assertRaises(reader.ReadError):
                reader.load_config(config)
            config.chmod(0o600)
            link = Path(root) / "link.json"
            link.symlink_to(config)
            with self.assertRaises(OSError):
                reader.load_config(link)


if __name__ == "__main__":
    unittest.main()
