#!/usr/bin/env python3
"""Fixed-argument SMART reader; the MQTT service only reads its public cache.

DeviceAllow=r and O_RDONLY do not constrain ATA/SCSI ioctl payloads. The trusted,
root-owned code/config and fixed command below are the read-only command boundary.
No SMART enable, test, power-setting, auto-detection or device-scan command exists.
"""
import argparse
import json
import math
import os
import re
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SMARTCTL = "/usr/sbin/smartctl"
DEFAULT_CONFIG = "/etc/one-minihouse-smart-temperature/config.json"
DEFAULT_OUTPUT = "/run/one-minihouse-smart-temperature/readings.json"
MAX_DEVICES = 8
DEVICE_TIMEOUT_SECONDS = 5
MAX_JSON_BYTES = 262144
DEVICE_TYPES = {"ata", "sat", "sat,12", "sat,16"}
METRIC = re.compile(r"[a-z][a-z0-9_]{0,44}_temperature_c")
BY_ID = re.compile(r"/dev/disk/by-id/(?:ata|usb)-[A-Za-z0-9_.:+-]{1,220}")
BLOCK_PATH = re.compile(r"/dev/sd[a-z]+")
TEMPERATURE_ATTRIBUTES = {190: {"Airflow_Temperature_Cel", "Airflow_Temperature_Celsius"},
                          194: {"Temperature_Celsius", "Temperature_Internal"}}


class ReadError(ValueError):
    """Only a fixed, non-sensitive error code may cross the cache boundary."""


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate_key")
            result[key] = value
        return result

    def constant(_):
        raise ValueError("invalid_number")

    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def validate(config):
    if (not isinstance(config, dict) or set(config) != {"version", "devices"}
            or type(config["version"]) is not int or config["version"] != 1):
        raise ReadError("invalid_config")
    devices = config["devices"]
    if not isinstance(devices, list) or not 1 <= len(devices) <= MAX_DEVICES:
        raise ReadError("invalid_config")
    paths, metrics, identities = set(), set(), set()
    for device in devices:
        required = {"path", "metric", "expected_model", "expected_serial"}
        if (not isinstance(device, dict) or not required <= set(device)
                or set(device) - required - {"rotation", "device_type"}):
            raise ReadError("invalid_config")
        if (not isinstance(device["path"], str) or not BY_ID.fullmatch(device["path"])
                or re.search(r"-part[0-9]+$", device["path"])
                or not isinstance(device["metric"], str) or not METRIC.fullmatch(device["metric"])):
            raise ReadError("invalid_config")
        for key in ("expected_model", "expected_serial"):
            value = device[key]
            if not isinstance(value, str) or not 1 <= len(value) <= 120 or not all(32 <= ord(c) <= 126 for c in value) or value != value.strip():
                raise ReadError("invalid_config")
        if (device.get("rotation", "ssd") not in ("ssd", "hdd")
                or not isinstance(device.get("device_type", "ata"), str)
                or device.get("device_type", "ata") not in DEVICE_TYPES):
            raise ReadError("invalid_config")
        identity = (device["expected_model"], device["expected_serial"])
        if device["path"] in paths or device["metric"] in metrics or identity in identities:
            raise ReadError("duplicate_device")
        paths.add(device["path"])
        metrics.add(device["metric"])
        identities.add(identity)
    return config


def trusted_stat(info, kind, private=False):
    if (info.st_uid != 0 or info.st_gid != 0 or not kind(info.st_mode)
            or info.st_mode & (0o077 if private else 0o022)):
        raise ReadError("unsafe_file_permissions")


def trusted_parents(path):
    for parent in path.parents:
        trusted_stat(parent.lstat(), stat.S_ISDIR)


def load_config(path):
    path = Path(path)
    if not path.is_absolute():
        raise ReadError("invalid_config_path")
    trusted_parents(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    with os.fdopen(fd, "r", encoding="utf-8") as stream:
        trusted_stat(os.fstat(stream.fileno()), stat.S_ISREG, private=True)
        content = stream.read(65537)
    if len(content) > 65536:
        raise ReadError("invalid_config")
    try:
        return validate(strict_json(content))
    except (TypeError, ValueError, KeyError) as error:
        raise ReadError("invalid_config") from error


def check_executable():
    binary = Path(SMARTCTL).resolve(strict=True)
    trusted_parents(binary)
    trusted_stat(binary.stat(), stat.S_ISREG)
    if not os.access(binary, os.X_OK):
        raise ReadError("smartctl_unavailable")


def resolve_device(device):
    link = Path(device["path"])
    trusted_parents(link)
    if not link.is_symlink() or link.lstat().st_uid != 0:
        raise ReadError("device_unavailable")
    path = link.resolve(strict=True)
    if not BLOCK_PATH.fullmatch(str(path)) or not stat.S_ISBLK(path.stat().st_mode):
        raise ReadError("device_unavailable")
    trusted_parents(path)
    # This read does not open the disk or wake it. Unknown/mismatched media fail closed.
    rotational = (Path("/sys/class/block") / path.name / "queue/rotational").read_text().strip()
    expected = "1" if device.get("rotation", "ssd") == "hdd" else "0"
    if rotational != expected:
        raise ReadError("rotation_mismatch")
    return str(path)


def resolved_devices(config):
    paths = [resolve_device(device) for device in config["devices"]]
    if len(paths) != len(set(paths)):
        raise ReadError("duplicate_device")
    return paths


def command(device, path):
    # No arbitrary command-line arguments are accepted from config or the caller.
    return [SMARTCTL, "-i", "-A", "-j", "-d", device.get("device_type", "ata"),
            "-n", "standby,3,5", path]


def run_command(argv):
    return subprocess.run(argv, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=DEVICE_TIMEOUT_SECONDS, env={"PATH": "/usr/sbin:/usr/bin:/bin", "LC_ALL": "C"})


def valid_temperature(value):
    return type(value) in (int, float) and -50 <= value <= 150 and math.isfinite(value)


def parse_temperature(document):
    temperature = document.get("temperature", {})
    if not isinstance(temperature, dict):
        raise ReadError("invalid_temperature")
    if "current" in temperature:
        value = temperature["current"]
        if not valid_temperature(value):
            raise ReadError("invalid_temperature")
        return value, []
    # ATA attributes are vendor-specific. Only familiar temperature names and
    # small raw integers are accepted; packed raw values and display text are not.
    attributes = document.get("ata_smart_attributes", {})
    table = attributes.get("table", []) if isinstance(attributes, dict) else []
    if not isinstance(table, list):
        raise ReadError("temperature_unavailable")
    candidates = []
    for entry in table:
        if not isinstance(entry, dict):
            continue
        identifier = entry.get("id")
        if type(identifier) is not int or identifier not in TEMPERATURE_ATTRIBUTES:
            continue
        if not isinstance(entry.get("name"), str) or entry["name"] not in TEMPERATURE_ATTRIBUTES[identifier]:
            continue
        raw = entry.get("raw", {})
        value = raw.get("value") if isinstance(raw, dict) else None
        if type(value) is not int or not valid_temperature(value):
            raise ReadError("invalid_temperature")
        candidates.append(value)
    if not candidates:
        raise ReadError("temperature_unavailable")
    if len(set(candidates)) != 1:
        raise ReadError("ambiguous_temperature")
    return candidates[0], ["ata_attribute_temperature"]


def parse_result(result, device):
    status = result.returncode
    if type(status) is not int or not 0 <= status <= 255:
        raise ReadError("smartctl_failed")
    if status & 7:
        raise ReadError(power_failure(result, status))
    if not isinstance(result.stdout, (str, bytes)) or len(result.stdout) > MAX_JSON_BYTES:
        raise ReadError("invalid_response")
    try:
        document = strict_json(result.stdout)
    except (ValueError, UnicodeError) as error:
        raise ReadError("invalid_response") from error
    if not isinstance(document, dict):
        raise ReadError("invalid_response")
    metadata = document.get("smartctl", {})
    if not isinstance(metadata, dict) or type(metadata.get("exit_status")) is not int or metadata["exit_status"] != status:
        raise ReadError("invalid_response")
    if (document.get("model_name") != device["expected_model"]
            or document.get("serial_number") != device["expected_serial"]):
        raise ReadError("identity_mismatch")
    protocol = document.get("device", {})
    sata = document.get("sata_version", {})
    if (not isinstance(protocol, dict) or protocol.get("protocol") != "ATA"
            or not isinstance(sata, dict) or not isinstance(sata.get("string"), str)
            or not sata["string"].startswith("SATA ")):
        raise ReadError("unsupported_interface")
    rotation = document.get("rotation_rate")
    if (type(rotation) is not int or rotation < 0
            or (rotation > 0) != (device.get("rotation", "ssd") == "hdd")):
        raise ReadError("rotation_mismatch")
    support = document.get("smart_support", {})
    if not isinstance(support, dict) or support.get("available") is not True or support.get("enabled") is not True:
        raise ReadError("smart_unavailable")
    value, notes = parse_temperature(document)
    health = document.get("smart_status", {})
    if status & 248 or (isinstance(health, dict) and health.get("passed") is False):
        notes.append("smart_health_warning")
    return value, notes


def power_failure(result, status):
    """Exit 3/5 overlap ordinary error bits; require matching power evidence.

    smartctl labels an ATA power-check failure as SLEEP (-1), including Linux
    HDIO_DRIVE_CMD permission failures. Never claim verified sleep in that case.
    All paths remain missing and do not retry with a waking command.
    """
    if status not in (3, 5) or not isinstance(result.stdout, (str, bytes)) or len(result.stdout) > MAX_JSON_BYTES:
        return "smartctl_failed"
    try:
        document = strict_json(result.stdout)
    except (ValueError, UnicodeError):
        return "smartctl_failed"
    if not isinstance(document, dict):
        return "smartctl_failed"
    metadata = document.get("smartctl", {})
    if not isinstance(metadata, dict) or type(metadata.get("exit_status")) is not int or metadata["exit_status"] != status:
        return "smartctl_failed"
    messages = metadata.get("messages", [])
    if not isinstance(messages, list):
        messages = []
    texts = [item["string"].strip() for item in messages if isinstance(item, dict) and isinstance(item.get("string"), str)]
    power = document.get("power_mode", {})
    if not isinstance(power, dict):
        power = {}
    if status == 3:
        if ((type(power.get("ata_value")) is int and power["ata_value"] in (0, 1)
             and power.get("name") in ("STANDBY", "STANDBY_Y"))
                or any(re.fullmatch(r"Device is in STANDBY(?:_Y)? mode, exit\(3\)", text) for text in texts)):
            return "device_standby"
        if power.get("name") == "SLEEP" or "Device is in SLEEP mode, exit(3)" in texts:
            return "power_check_failed_or_sleep"
    if status == 5 and any(re.fullmatch(r"CHECK POWER MODE (?:not implemented|returned unknown value 0x[0-9a-fA-F]{2}), exit\(5\)", text) for text in texts):
        return "power_check_unsupported"
    return "smartctl_failed"


def collect(config, runner=run_command, resolver=resolve_device, clock=utc):
    config = validate(config)
    metrics, missing, errors, times, notes, used_paths = {}, [], {}, {}, {}, set()
    for device in config["devices"]:
        metric = device["metric"]
        try:
            path = resolver(device)
            if not BLOCK_PATH.fullmatch(path):
                raise ReadError("device_unavailable")
            if path in used_paths:
                raise ReadError("duplicate_device")
            used_paths.add(path)
            value, quality = parse_result(runner(command(device, path)), device)
            metrics[metric] = value
            times[metric] = clock()
            if quality:
                notes[metric] = quality
        except ReadError as error:
            missing.append(metric)
            errors[metric] = str(error)
        except subprocess.TimeoutExpired:
            missing.append(metric)
            errors[metric] = "read_timeout"
        except (OSError, subprocess.SubprocessError):
            missing.append(metric)
            errors[metric] = "device_read_failed"
    return {"version": 1, "batch_id": str(uuid.uuid4()), "read_time_utc": clock(),
            "sample_time_utc": None, "metrics": metrics, "missing_metrics": missing,
            "errors": errors, "per_metric_read_time_utc": times, "quality_notes": notes}


def write_cache(output, batch):
    output = Path(output)
    if not output.is_absolute() or not output.name or output.name in (".", ".."):
        raise ReadError("invalid_output_path")
    trusted_parents(output)
    directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    temporary = ".readings-" + uuid.uuid4().hex + ".tmp"
    try:
        parent = os.fstat(directory)
        trusted_stat(parent, stat.S_ISDIR)
        if stat.S_IMODE(parent.st_mode) != 0o755:
            raise ReadError("unsafe_cache_directory")
        try:
            trusted_stat(os.stat(output.name, dir_fd=directory, follow_symlinks=False), stat.S_ISREG)
        except FileNotFoundError:
            pass
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=directory)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            os.fchmod(stream.fileno(), 0o644)
            stream.write(encode(batch) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output.name, src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(temporary, dir_fd=directory)
        except FileNotFoundError:
            pass
        os.close(directory)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=DEFAULT_CONFIG)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if os.geteuid() != 0 or os.getegid() != 0:
            raise ReadError("root_required")
        config = load_config(args.config)
        check_executable()
        if args.check:
            resolved_devices(config)
            print("SMART configuration and block paths valid; identity requires an active read")
            return 0
        batch = collect(config)
        write_cache(args.output, batch)
        print(encode({"event": "smart_read_completed", "read_time_utc": batch["read_time_utc"],
                      "channels": len(batch["metrics"]), "missing": len(batch["missing_metrics"])}))
        return 0
    except (OSError, ValueError):
        # Never print file paths, identities, smartctl output or exception text.
        print("SMART reader configuration or cache failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
