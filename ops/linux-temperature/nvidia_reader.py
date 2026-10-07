#!/usr/bin/env python3
"""Query allowlisted NVIDIA GPU core temperatures into a public atomic cache.

The fixed root-owned query command is the read-only boundary. Character-device
rw access is needed by NVML and does not restrict ioctl payloads. The service has
no capabilities, no network, and no access to MQTT credentials.
"""
import argparse
import csv
import io
import json
import os
import re
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

NVIDIA_SMI = "/usr/bin/nvidia-smi"
DEFAULT_CONFIG = "/etc/one-minihouse-nvidia-temperature/config.json"
DEFAULT_OUTPUT = "/run/one-minihouse-nvidia-temperature/readings.json"
MAX_DEVICES = 8
DEVICE_TIMEOUT_SECONDS = 5
MAX_RESPONSE_BYTES = 16384
UUID_PATTERN = re.compile(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")
METRIC_PATTERN = re.compile(r"[a-z][a-z0-9_]{0,44}_temperature_c")
NODE_PATTERN = re.compile(r"/dev/nvidia(0|[1-9][0-9]{0,2})")


class ReadError(ValueError):
    """A fixed non-sensitive error code, never a command or device identifier."""


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def strict_json(content):
    def pairs(items):
        parsed = {}
        for key, value in items:
            if key in parsed:
                raise ReadError("invalid_config")
            parsed[key] = value
        return parsed

    def constant(_):
        raise ReadError("invalid_config")

    return json.loads(content, object_pairs_hook=pairs, parse_constant=constant)


def validate(config):
    if (not isinstance(config, dict) or set(config) != {"version", "devices"}
            or type(config["version"]) is not int or config["version"] != 1
            or not isinstance(config["devices"], list) or not 1 <= len(config["devices"]) <= MAX_DEVICES):
        raise ReadError("invalid_config")
    identities, nodes, metrics = set(), set(), set()
    for device in config["devices"]:
        if not isinstance(device, dict) or set(device) != {"uuid", "expected_model", "device_node", "metric"}:
            raise ReadError("invalid_config")
        if not isinstance(device["uuid"], str) or not UUID_PATTERN.fullmatch(device["uuid"]):
            raise ReadError("invalid_config")
        model = device["expected_model"]
        if not isinstance(model, str) or not 1 <= len(model) <= 120 or model != model.strip() or not all(32 <= ord(c) <= 126 for c in model):
            raise ReadError("invalid_config")
        node = NODE_PATTERN.fullmatch(device["device_node"]) if isinstance(device["device_node"], str) else None
        if node is None or int(node.group(1)) > 254:
            raise ReadError("invalid_config")
        if not isinstance(device["metric"], str) or not METRIC_PATTERN.fullmatch(device["metric"]):
            raise ReadError("invalid_config")
        if device["uuid"].lower() in identities or device["device_node"] in nodes or device["metric"] in metrics:
            raise ReadError("duplicate_device")
        identities.add(device["uuid"].lower())
        nodes.add(device["device_node"])
        metrics.add(device["metric"])
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
    return validate(strict_json(content))


def check_executable():
    binary = Path(NVIDIA_SMI).resolve(strict=True)
    trusted_parents(binary)
    trusted_stat(binary.stat(), stat.S_ISREG)
    if not os.access(binary, os.X_OK):
        raise ReadError("nvidia_smi_unavailable")


def check_node(path, minor):
    path = Path(path)
    trusted_parents(path)
    info = path.lstat()
    # NVIDIA nodes are commonly 0666. Access is narrowed by systemd's device
    # allowlist; do not chmod, recreate, or change driver-managed device nodes.
    if (not stat.S_ISCHR(info.st_mode) or info.st_uid != 0
            or os.major(info.st_rdev) != 195 or os.minor(info.st_rdev) != minor):
        raise ReadError("gpu_device_unavailable")


def check_device(device):
    check_node("/dev/nvidiactl", 255)
    check_node(device["device_node"], int(NODE_PATTERN.fullmatch(device["device_node"]).group(1)))


def command(device):
    # No arbitrary flags, paths, shell text, loop or persistence-mode changes.
    return [NVIDIA_SMI, "--id=" + device["uuid"], "--query-gpu=uuid,name,temperature.gpu",
            "--format=csv,noheader,nounits"]


def run_command(argv):
    return subprocess.run(argv, check=False, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          timeout=DEVICE_TIMEOUT_SECONDS, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})


def parse_result(result, device):
    if type(result.returncode) is not int or result.returncode != 0:
        raise ReadError("nvidia_smi_failed")
    if not isinstance(result.stdout, (bytes, str)) or len(result.stdout) > MAX_RESPONSE_BYTES:
        raise ReadError("invalid_response")
    try:
        output = result.stdout.decode("utf-8") if isinstance(result.stdout, bytes) else result.stdout
        rows = list(csv.reader(io.StringIO(output), skipinitialspace=True, strict=True))
    except (UnicodeError, csv.Error) as error:
        raise ReadError("invalid_response") from error
    if len(rows) != 1 or len(rows[0]) != 3:
        raise ReadError("invalid_response")
    identity, model, temperature = (value.strip() for value in rows[0])
    if identity != device["uuid"] or model != device["expected_model"]:
        raise ReadError("identity_mismatch")
    if temperature in ("N/A", "[N/A]", "Not Supported", "[Not Supported]", ""):
        raise ReadError("temperature_unavailable")
    if not re.fullmatch(r"-?[0-9]{1,3}", temperature):
        raise ReadError("invalid_temperature")
    value = int(temperature)
    if not -50 <= value <= 150:
        raise ReadError("invalid_temperature")
    return value


def collect(config, runner=run_command, device_check=check_device, clock=utc):
    config = validate(config)
    metrics, missing, errors, times = {}, [], {}, {}
    for device in config["devices"]:
        metric = device["metric"]
        try:
            device_check(device)
            metrics[metric] = parse_result(runner(command(device)), device)
            times[metric] = clock()
        except ReadError as error:
            missing.append(metric)
            errors[metric] = str(error)
        except subprocess.TimeoutExpired:
            missing.append(metric)
            errors[metric] = "read_timeout"
        except (OSError, subprocess.SubprocessError):
            missing.append(metric)
            errors[metric] = "gpu_read_failed"
    return {"version": 1, "batch_id": str(uuid.uuid4()), "read_time_utc": clock(), "sample_time_utc": None,
            "metrics": metrics, "missing_metrics": missing, "errors": errors,
            "quality_notes": {}, "per_metric_read_time_utc": times}


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
            for device in config["devices"]:
                check_device(device)
            print("NVIDIA configuration and device nodes valid; identity requires an actual query")
            return 0
        batch = collect(config)
        write_cache(args.output, batch)
        print(encode({"event": "nvidia_read_completed", "read_time_utc": batch["read_time_utc"],
                      "channels": len(batch["metrics"]), "missing": len(batch["missing_metrics"])}))
        return 0
    except (OSError, ValueError):
        print("NVIDIA reader configuration or cache failure", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
