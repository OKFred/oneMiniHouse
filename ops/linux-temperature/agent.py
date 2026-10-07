#!/usr/bin/env python3
"""Read sysfs and isolated SMART/GPU caches into a durable MQTT 5 outbox."""
import argparse
import json
import math
import os
import re
import signal
import sqlite3
import ssl
import subprocess
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse


SMART_CACHE_FILE = "/run/one-minihouse-smart-temperature/readings.json"
GPU_CACHE_FILE = "/run/one-minihouse-nvidia-temperature/readings.json"
METRIC_PATTERN = r"[a-z][a-z0-9_]{0,44}_temperature_c"


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def log(event, **fields):
    print(encode({"event_time_utc": utc(), "event": event, **fields}), flush=True)


def validate(config):
    for name in ("site_id", "gateway_id", "device_id"):
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(config.get(name, ""))):
            raise ValueError("Invalid identity")
    m = config["mqtt"]
    url = urlparse(m["url"])
    if url.scheme != "mqtts" or not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
        raise ValueError("MQTT requires TLS and a separate password file")
    if not m.get("username") or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", m.get("client_id", "")):
        raise ValueError("Invalid MQTT identity")
    if not PurePosixPath(m["password_file"]).is_absolute():
        raise ValueError("Password file must be absolute")
    if type(config["interval_seconds"]) is not int or not 10 <= config["interval_seconds"] <= 86400:
        raise ValueError("Invalid interval")
    sensors = config["sensors"]
    if not isinstance(sensors, list) or not 0 <= len(sensors) <= 64:
        raise ValueError("Select at most 64 sysfs channels")
    for s in sensors:
        if not re.fullmatch(r"(?:thermal|hwmon):[A-Za-z0-9_. -]{1,80}:[A-Za-z0-9_. -]{1,80}", s["selector"]) or not re.fullmatch(r"[a-z][a-z0-9_]{0,44}_temperature_c", s["metric"]):
            raise ValueError("Invalid channel")
    if len({s["selector"] for s in sensors}) != len(sensors) or len({s["metric"] for s in sensors}) != len(sensors):
        raise ValueError("Duplicate channel")
    if "smart" in config:
        smart = config["smart"]
        if not isinstance(smart, dict) or smart.get("cache_file", SMART_CACHE_FILE) != SMART_CACHE_FILE:
            raise ValueError("SMART requires the fixed helper cache path")
        metrics = smart.get("metrics")
        if not isinstance(metrics, list) or not 1 <= len(metrics) <= 64 or any(not isinstance(metric, str) or not re.fullmatch(METRIC_PATTERN, metric) for metric in metrics):
            raise ValueError("Invalid SMART metrics")
        if len(set(metrics)) != len(metrics) or set(metrics) & {s["metric"] for s in sensors}:
            raise ValueError("Duplicate SMART channel")
        age = smart.get("max_age_seconds", 120)
        if type(age) is not int or not 1 <= age <= 3600:
            raise ValueError("Invalid SMART cache age")
        smart["cache_file"] = SMART_CACHE_FILE
        smart["max_age_seconds"] = age
    if "gpu" in config:
        gpu = config["gpu"]
        if not isinstance(gpu, dict) or gpu.get("cache_file", GPU_CACHE_FILE) != GPU_CACHE_FILE or set(gpu) - {"cache_file", "metrics", "max_age_seconds"}:
            raise ValueError("GPU requires the fixed helper cache path")
        metrics = gpu.get("metrics")
        if not isinstance(metrics, list) or not 1 <= len(metrics) <= 8 or any(not isinstance(metric, str) or not re.fullmatch(METRIC_PATTERN, metric) for metric in metrics):
            raise ValueError("Invalid GPU metrics")
        existing = {s["metric"] for s in sensors} | set(config.get("smart", {}).get("metrics", []))
        if len(set(metrics)) != len(metrics) or set(metrics) & existing:
            raise ValueError("Duplicate GPU channel")
        age = gpu.get("max_age_seconds", 120)
        if type(age) is not int or not 1 <= age <= 3600:
            raise ValueError("Invalid GPU cache age")
        gpu["cache_file"] = GPU_CACHE_FILE
        gpu["max_age_seconds"] = age
    if not sensors and "gpu" not in config:
        raise ValueError("An empty sysfs selection requires a valid GPU configuration")
    q = config.get("queue", {"max_age_days": 7, "max_rows": 100000})
    if type(q["max_rows"]) is not int or not 1 <= q["max_rows"] <= 100000 or type(q["max_age_days"]) is not int or not 1 <= q["max_age_days"] <= 7:
        raise ValueError("Invalid queue bounds")
    config["queue"] = q
    return config


def parse_reading(output, sensors):
    if len(output) > 65536 or not output.startswith("one-minihouse-temperatures-v1\n"):
        raise ValueError("Invalid reader response")
    channels = {}
    for line in output.splitlines()[1:]:
        parts = line.split("\t")
        if len(parts) != 4:
            raise ValueError("Malformed channel")
        key = ":".join(parts[:3])
        channels.setdefault(key, []).append(parts[3])
    metrics, missing = {}, []
    for sensor in sensors:
        values = channels.get(sensor["selector"], [])
        if len(values) != 1 or not re.fullmatch(r"-?\d+", values[0]):
            missing.append(sensor["metric"])
            continue
        value = int(values[0]) / 1000
        if not math.isfinite(value) or not -50 <= value <= 150:
            missing.append(sensor["metric"])
            continue
        metrics[sensor["metric"]] = value
    return metrics, missing


def envelope(config, metrics, missing):
    return {"schema_version": 2, "message_id": str(uuid.uuid4()),
            "site_id": config["site_id"], "gateway_id": config["gateway_id"], "device_id": config["device_id"],
            "read_time_utc": utc(), "sample_time_utc": None, "observation_kind": "direct_read",
            "quality": "ok", "metrics": metrics,
            "source": {"driver": "linux-temperature-mqtt", "temperature_source": "linux_sysfs",
                       "missing_metrics": missing}}


def parse_utc(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z", value):
        raise ValueError("Invalid UTC timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def parse_smart_cache(cache, smart, now=None):
    """Validate the entire snapshot before trusting its values or original times."""
    now = datetime.now(timezone.utc) if now is None else now
    if not isinstance(cache, dict) or type(cache.get("version")) is not int or cache["version"] != 1:
        raise ValueError("smart_cache_invalid")
    batch_id = cache.get("batch_id")
    if not isinstance(batch_id, str) or str(uuid.UUID(batch_id)) != batch_id:
        raise ValueError("smart_cache_invalid")
    read_time = parse_utc(cache.get("read_time_utc"))
    if read_time > now:
        raise ValueError("smart_cache_future")
    if (now - read_time).total_seconds() > smart["max_age_seconds"]:
        raise ValueError("smart_cache_stale")
    if cache.get("sample_time_utc") is not None:
        raise ValueError("smart_cache_invalid")
    expected = set(smart["metrics"])
    metrics, missing = cache.get("metrics"), cache.get("missing_metrics")
    if not isinstance(metrics, dict) or not isinstance(missing, list) or any(not isinstance(metric, str) for metric in missing):
        raise ValueError("smart_cache_invalid")
    if len(set(missing)) != len(missing) or set(metrics) & set(missing) or set(metrics) | set(missing) != expected:
        raise ValueError("smart_cache_metric_mismatch")
    if any(type(value) not in (int, float) or not math.isfinite(value) or not -50 <= value <= 150 for value in metrics.values()):
        raise ValueError("smart_cache_invalid")
    errors, notes = cache.get("errors", {}), cache.get("quality_notes", {})
    code = lambda value: isinstance(value, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value)
    if not isinstance(errors, dict) or not set(errors) <= set(missing) or any(not code(value) for value in errors.values()):
        raise ValueError("smart_cache_invalid")
    if not isinstance(notes, dict) or not set(notes) <= set(metrics) or any(not isinstance(values, list) or not 1 <= len(values) <= 16 or any(not code(value) for value in values) for values in notes.values()):
        raise ValueError("smart_cache_invalid")
    per_metric = cache.get("per_metric_read_time_utc", {})
    if not isinstance(per_metric, dict) or ("per_metric_read_time_utc" in cache and set(per_metric) != set(metrics)):
        raise ValueError("smart_cache_invalid")
    for value in per_metric.values():
        metric_time = parse_utc(value)
        if metric_time > read_time or (now - metric_time).total_seconds() > smart["max_age_seconds"]:
            raise ValueError("smart_cache_invalid")
    return {"version": 1, "batch_id": batch_id, "read_time_utc": cache["read_time_utc"],
            "metrics": {metric: metrics[metric] for metric in smart["metrics"] if metric in metrics},
            "missing_metrics": [metric for metric in smart["metrics"] if metric in missing],
            "errors": errors, "quality_notes": notes, "per_metric_read_time_utc": per_metric}


def read_smart_cache(smart):
    try:
        with Path(smart["cache_file"]).open("rb") as source:
            raw = source.read(65537)
        if len(raw) > 65536:
            raise ValueError("smart_cache_invalid")
        return parse_smart_cache(json.loads(raw), smart), None
    except OSError:
        return None, "smart_cache_unavailable"
    except (ValueError, TypeError, RecursionError, OverflowError) as error:
        known = {"smart_cache_future", "smart_cache_stale", "smart_cache_metric_mismatch"}
        return None, str(error) if str(error) in known else "smart_cache_invalid"


def parse_gpu_cache(cache, gpu, now=None):
    try:
        return parse_smart_cache(cache, gpu, now)
    except ValueError as error:
        code = str(error)
        known = {"smart_cache_future", "smart_cache_stale", "smart_cache_metric_mismatch"}
        raise ValueError(code.replace("smart_", "gpu_") if code in known else "gpu_cache_invalid") from error


def read_gpu_cache(gpu):
    try:
        with Path(gpu["cache_file"]).open("rb") as source:
            raw = source.read(65537)
        if len(raw) > 65536:
            raise ValueError("gpu_cache_invalid")
        return parse_gpu_cache(json.loads(raw), gpu), None
    except OSError:
        return None, "gpu_cache_unavailable"
    except (ValueError, TypeError, RecursionError, OverflowError) as error:
        known = {"gpu_cache_future", "gpu_cache_stale", "gpu_cache_metric_mismatch"}
        return None, str(error) if str(error) in known else "gpu_cache_invalid"


def cache_envelope(config, cache, source):
    sample = envelope(config, cache["metrics"], cache["missing_metrics"])
    identity = "/".join(config[key] for key in ("site_id", "gateway_id", "device_id"))
    sample["message_id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "one-minihouse/" + source + "/" + identity + "/" + cache["batch_id"]))
    sample["read_time_utc"] = cache["read_time_utc"]
    sample["source"] = {"driver": "linux-temperature-mqtt", "temperature_source": source,
                        "batch_id": cache["batch_id"], "missing_metrics": cache["missing_metrics"],
                        "errors": cache["errors"], "quality_notes": cache["quality_notes"],
                        "per_metric_read_time_utc": cache["per_metric_read_time_utc"]}
    return sample


def smart_envelope(config, cache):
    return cache_envelope(config, cache, "smartctl")


def gpu_envelope(config, cache):
    return cache_envelope(config, cache, "nvidia_smi")


def collect_samples(config):
    """Keep cached SMART observations independent of this sysfs sampling time."""
    metrics, missing = {}, [s["metric"] for s in config["sensors"]]
    if config["sensors"]:
        try:
            reader = Path(__file__).with_name("read-temperatures.sh")
            result = subprocess.run(["/bin/sh", str(reader)], check=True, capture_output=True, text=True, timeout=10, env={"PATH": "/usr/bin:/bin", "LC_ALL": "C"})
            metrics, missing = parse_reading(result.stdout, config["sensors"])
        except (subprocess.SubprocessError, ValueError, OSError):
            pass
    sample = envelope(config, metrics, missing)
    state = {**sample, "source": dict(sample["source"]), "quality": "degraded" if missing else "ok"}
    smart_sample, cache = None, None
    if "smart" in config:
        cache, error = read_smart_cache(config["smart"])
        smart_missing = cache["missing_metrics"] if cache else list(config["smart"]["metrics"])
        notes = cache["quality_notes"] if cache else {}
        state["source"].update(smart_read_time_utc=cache["read_time_utc"] if cache else None,
                               smart_missing_metrics=smart_missing, smart_quality_notes=notes,
                               smart_errors=cache["errors"] if cache else {}, smart_error=error)
        if error or smart_missing or notes:
            state["quality"] = "degraded"
        if cache and cache["metrics"]:
            smart_sample = smart_envelope(config, cache)
    return sample, smart_sample, state, cache


def collect_all_samples(config):
    """The original sysfs/SMART path remains independent of optional GPU reads."""
    sample, smart_sample, state, smart_batch = collect_samples(config)
    gpu_sample, gpu_batch = None, None
    if "gpu" in config:
        gpu_batch, error = read_gpu_cache(config["gpu"])
        missing = gpu_batch["missing_metrics"] if gpu_batch else list(config["gpu"]["metrics"])
        notes = gpu_batch["quality_notes"] if gpu_batch else {}
        if gpu_batch and gpu_batch["metrics"]:
            gpu_sample = gpu_envelope(config, gpu_batch)
        if not config["sensors"]:
            # A GPU-only state retains the actual cache time. An unavailable GPU
            # has no measured value/time; never manufacture an empty sysfs sample.
            smart_status = {key: value for key, value in state["source"].items() if key.startswith("smart_")}
            state = {**(gpu_sample or sample), "quality": state["quality"],
                     "source": {**(gpu_sample["source"] if gpu_sample else sample["source"]), **smart_status}}
            if not gpu_sample:
                state["read_time_utc"] = None
                state["source"].update(temperature_source="nvidia_smi", missing_metrics=missing)
        state["source"].update(gpu_read_time_utc=gpu_batch["read_time_utc"] if gpu_batch else None,
                               gpu_missing_metrics=missing, gpu_quality_notes=notes,
                               gpu_errors=gpu_batch["errors"] if gpu_batch else {}, gpu_error=error)
        if error or missing or notes:
            state["quality"] = "degraded"
    return sample, smart_sample, state, smart_batch, gpu_sample, gpu_batch


class Outbox:
    def __init__(self, path, limits):
        self.db = sqlite3.connect(path, timeout=5)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS outbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,captured_ms INTEGER NOT NULL,payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          INSERT OR IGNORE INTO meta VALUES('dropped','0');
        """)
        self.limits = limits

    def save(self, sample, state, now=None, smart_sample=None, smart_batch=None, gpu_sample=None, gpu_batch=None):
        now = int(time.time()*1000) if now is None else now
        with self.db:
            if sample is not None:
                self.db.execute("INSERT INTO outbox(id,captured_ms,payload) VALUES(?,?,?)", (sample["message_id"], now, encode(sample)))
            for source, cached_sample, batch in (("smart", smart_sample, smart_batch), ("gpu", gpu_sample, gpu_batch)):
                if batch is None:
                    continue
                marker_key = source + "_last_batch"
                row = self.db.execute("SELECT value FROM meta WHERE key=?", (marker_key,)).fetchone()
                previous = json.loads(row[0]) if row else None
                # The marker outlives PUBACK deletion and survives restarts. Ignore
                # old snapshots as well as repeat reads of the current cache.
                if previous is None or (previous["batch_id"] != batch["batch_id"] and parse_utc(batch["read_time_utc"]) > parse_utc(previous["read_time_utc"])):
                    if cached_sample is not None:
                        captured_ms = int(parse_utc(cached_sample["read_time_utc"]).timestamp()*1000)
                        self.db.execute("INSERT OR IGNORE INTO outbox(id,captured_ms,payload) VALUES(?,?,?)", (cached_sample["message_id"], captured_ms, encode(cached_sample)))
                    marker = {key: batch[key] for key in ("batch_id", "read_time_utc")}
                    self.db.execute("INSERT OR REPLACE INTO meta VALUES(?,?)", (marker_key, encode(marker)))
            self.db.execute("INSERT OR REPLACE INTO meta VALUES('state',?)", (encode(state),))

    def prune(self, now=None):
        now = int(time.time()*1000) if now is None else now
        with self.db:
            count = self.db.execute("DELETE FROM outbox WHERE captured_ms < ?", (now - self.limits["max_age_days"]*86400000,)).rowcount
            count += self.db.execute("DELETE FROM outbox WHERE seq IN (SELECT seq FROM outbox ORDER BY seq DESC LIMIT -1 OFFSET ?)", (self.limits["max_rows"],)).rowcount
            self.db.execute("UPDATE meta SET value=CAST(value AS INTEGER)+? WHERE key='dropped'", (count,))
        return count

    def first(self):
        return self.db.execute("SELECT id,payload FROM outbox ORDER BY seq LIMIT 1").fetchone()

    def ack(self, message_id, reason_code):
        # MQTT 5 PUBACK >=128 is a rejection, not a durable delivery.
        if type(reason_code) is not int or not 0 <= reason_code < 128:
            raise ValueError("PUBACK rejected or absent")
        with self.db:
            self.db.execute("DELETE FROM outbox WHERE id=?", (message_id,))

    def state(self):
        row = self.db.execute("SELECT value FROM meta WHERE key='state'").fetchone()
        return row[0] if row else None

    def stats(self):
        return {"pending": self.db.execute("SELECT count(*) FROM outbox").fetchone()[0],
                "dropped": int(self.db.execute("SELECT value FROM meta WHERE key='dropped'").fetchone()[0])}

    def close(self):
        self.db.close()


class Transport:
    def __init__(self, config, topic):
        import paho.mqtt.client as mqtt
        self.lock = threading.Lock()
        self.pending = {}
        self.generation = 0
        m = config["mqtt"]
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=m["client_id"], protocol=mqtt.MQTTv5)
        self.client.max_queued_messages_set(32)
        self.client.max_inflight_messages_set(1)
        self.client.connect_timeout = 10
        credential_dir = os.environ.get("CREDENTIALS_DIRECTORY")
        password_path = Path(credential_dir) / "mqtt_password" if credential_dir else Path(m["password_file"])
        password = password_path.read_text().strip()
        if not password:
            raise ValueError("Empty MQTT password")
        self.client.username_pw_set(m["username"], password)
        self.client.tls_set_context(ssl.create_default_context(cafile=m.get("ca_file")))
        self.client.reconnect_delay_set(2, 60)
        self.client.will_set(topic + "/status", encode({"online": False, "quality": "offline", "read_time_utc": None}), 1, True)
        self.client.on_publish = self.on_publish
        self.client.on_connect = self.on_connect
        url = urlparse(m["url"])
        self.client.connect_async(url.hostname, url.port or 8883, keepalive=30)
        self.client.loop_start()

    def on_connect(self, client, userdata, flags, reason_code, properties):
        if not reason_code.is_failure:
            self.generation += 1
            log("mqtt_connected")
        else:
            log("mqtt_connection_rejected", reason_code=reason_code.value)

    def on_publish(self, client, userdata, mid, reason_code, properties):
        with self.lock:
            if mid in self.pending:
                event, result = self.pending[mid]
                result.append(reason_code.value)
                event.set()

    def publish(self, topic, payload, retained=False):
        event, result = threading.Event(), []
        with self.lock:
            info = self.client.publish(topic, payload, qos=1, retain=retained)
            if info.rc != 0:
                raise ConnectionError("MQTT not connected or queue unavailable")
            self.pending[info.mid] = (event, result)
        try:
            if not event.wait(10) or not result or not 0 <= result[0] < 128:
                raise ConnectionError("PUBACK missing or rejected")
            return result[0]
        finally:
            with self.lock:
                self.pending.pop(info.mid, None)

    def close(self):
        self.client.disconnect()
        self.client.loop_stop()


def run(config, data_dir):
    data_dir.mkdir(parents=True, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    path = data_dir / "outbox.sqlite"
    box = Outbox(path, config["queue"])
    box.prune()
    prefix = "iot/v1/{site_id}/{gateway_id}".format(**config)
    base = prefix + "/devices/" + config["device_id"]
    transport = Transport(config, prefix)
    publisher_failed = []

    def publish_loop():
        queue = Outbox(path, config["queue"])
        seen = None
        try:
            while not stop.is_set():
                try:
                    if transport.client.is_connected():
                        state = queue.state()
                        marker = (transport.generation, state)
                        if state and marker != seen:
                            transport.publish(base + "/state", state, True)
                            value = json.loads(state)
                            transport.publish(prefix + "/status", encode({"online": True, "quality": value["quality"], "read_time_utc": value["read_time_utc"], **queue.stats()}), True)
                            seen = marker
                        row = queue.first()
                        if row:
                            reason = transport.publish(base + "/telemetry", row[1])
                            queue.ack(row[0], reason)
                            continue
                except ConnectionError:
                    log("mqtt_delivery_deferred", **queue.stats())
                    stop.wait(5)
                stop.wait(1)
        except Exception as error:
            publisher_failed.append(type(error).__name__)
            stop.set()
        finally:
            queue.close()

    worker = threading.Thread(target=publish_loop, name="mqtt-publisher")
    worker.start()
    next_sample = time.monotonic()
    try:
        while not stop.is_set():
            sample, smart_sample, state, smart_batch, gpu_sample, gpu_batch = collect_all_samples(config)
            metrics, missing = sample["metrics"], sample["source"]["missing_metrics"]
            box.save(sample if metrics else None, state, smart_sample=smart_sample, smart_batch=smart_batch,
                     gpu_sample=gpu_sample, gpu_batch=gpu_batch)
            dropped = box.prune()
            if dropped:
                log("queue_pruned", dropped=dropped)
            log("sample_saved" if metrics or smart_sample or gpu_sample else "sample_unavailable", channels=len(metrics), missing=len(missing), **box.stats())
            connected = transport.client.is_connected()
            health = {"heartbeat_time_utc": utc(), "quality": state["quality"] if connected else "degraded", "mqtt_connected": connected, "channels": len(metrics), "missing_metrics": missing, **box.stats()}
            if "smart" in config:
                health.update(smart_channels=len(smart_sample["metrics"]) if smart_sample else 0,
                              **{key: value for key, value in state["source"].items() if key.startswith("smart_")})
            if "gpu" in config:
                health.update(gpu_channels=len(gpu_sample["metrics"]) if gpu_sample else 0,
                              **{key: value for key, value in state["source"].items() if key.startswith("gpu_")})
            tmp = data_dir / "health.tmp"
            tmp.write_text(encode(health))
            tmp.replace(data_dir / "health.json")
            next_sample += config["interval_seconds"]
            if next_sample < time.monotonic():
                next_sample = time.monotonic() + config["interval_seconds"]
            stop.wait(max(0, next_sample-time.monotonic()))
    finally:
        stop.set()
        worker.join(15)
        if transport.client.is_connected():
            try:
                transport.publish(prefix + "/status", encode({"online": False, "quality": "offline", "read_time_utc": None}), True)
            except ConnectionError:
                pass
        transport.close()
        box.close()
    if publisher_failed:
        raise RuntimeError("Publisher stopped: " + publisher_failed[0])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default="/etc/one-minihouse-temperature/config.json")
    parser.add_argument("--data", default="/var/lib/one-minihouse-temperature-mqtt")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--read-once", action="store_true")
    args = parser.parse_args()
    cfg = validate(json.loads(Path(args.config).read_text()))
    if args.check:
        print("configuration valid")
    elif args.read_once:
        sample, smart_sample, state, _, gpu_sample, _ = collect_all_samples(cfg)
        # Each cached source keeps its own original observation time in NDJSON.
        print(encode(state if "smart" in cfg or "gpu" in cfg else sample))
        if smart_sample:
            print(encode(smart_sample))
        if gpu_sample:
            print(encode(gpu_sample))
        if state["quality"] != "ok":
            raise SystemExit(2)
    else:
        run(cfg, Path(args.data))
