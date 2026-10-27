#!/usr/bin/env python3
"""Bounded MQTT host-health inbox. Never controls hosts or accesses business DBs."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import sqlite3
import ssl
import sys
import time
import urllib.parse
import uuid
from dataclasses import dataclass


IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
METRICS = {
    "memory_total_bytes", "memory_available_bytes", "memory_anon_bytes", "memory_slab_bytes",
    "memory_unreclaimable_slab_bytes", "memory_shmem_bytes", "memory_dirty_bytes", "memory_writeback_bytes",
    "load_1m", "cpu_iowait_pct", "blocked_tasks", "psi_memory_some_avg10_pct", "psi_io_some_avg10_pct",
    "cpu_temperature_c", "rootfs_free_bytes", "rootfs_used_pct", "datafs_free_bytes", "datafs_used_pct",
    "proxy_working_set_bytes", "proxy_rss_bytes",
}
CONDITIONS = {"memory_pressure", "io_pressure", "temperature", "storage"}
DETAIL_CODES = {"none", "metric_unavailable", "memory_available_low", "memory_available_critical",
                "io_wait_blocked", "temperature_high", "storage_low"}


class PayloadConflict(ValueError):
    """A validated poison message conflicts with an immutable stored event."""


def valid_uuid(value) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except ValueError:
        return False


def subscribe_accepted(reasons, expected: int) -> bool:
    return len(reasons) == expected and all(type(getattr(reason, "value", reason)) is int and getattr(reason, "value", reason) == 1 for reason in reasons)


def utc(value: float) -> str:
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def timestamp(value) -> float:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("INVALID_UTC_TIME")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        number = parsed.timestamp()
    except (ValueError, OverflowError, OSError):
        raise ValueError("INVALID_UTC_TIME") from None
    if not math.isfinite(number):
        raise ValueError("INVALID_UTC_TIME")
    return number


def encode(value) -> bytes:
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")


def strict_json(raw: bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("DUPLICATE_JSON_KEY")
            result[key] = value
        return result
    try:
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("NONFINITE_JSON")))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise ValueError("INVALID_JSON") from None


def read_config(path: str) -> dict:
    raw = Path(path).read_bytes()
    if len(raw) > 65536:
        raise ValueError("CONFIG_TOO_LARGE")
    cfg = strict_json(raw)
    if not isinstance(cfg, dict) or set(cfg) - {"schema_version", "receiver_id", "state_directory", "mqtt", "sources", "limits"} or type(cfg.get("schema_version")) is not int or cfg["schema_version"] != 1:
        raise ValueError("INVALID_CONFIG")
    if not isinstance(cfg.get("receiver_id"), str) or not IDENTITY.fullmatch(cfg["receiver_id"]) or not isinstance(cfg.get("state_directory"), str) or not Path(cfg["state_directory"]).is_absolute():
        raise ValueError("INVALID_RECEIVER_ID_OR_DIRECTORY")
    mqtt = cfg.get("mqtt")
    if not isinstance(mqtt, dict) or set(mqtt) - {"url", "client_id", "username", "password_file", "keepalive_seconds", "session_expiry_seconds"}:
        raise ValueError("INVALID_MQTT_CONFIG")
    parsed = urllib.parse.urlsplit(mqtt.get("url", ""))
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("INVALID_MQTT_URL") from None
    if parsed.scheme != "mqtts" or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.path not in ("", "/") or parsed.query or parsed.fragment or port not in (None, 8883):
        raise ValueError("INVALID_MQTT_URL")
    for key in ("client_id", "username"):
        if not isinstance(mqtt.get(key), str) or not IDENTITY.fullmatch(mqtt[key]):
            raise ValueError("INVALID_MQTT_IDENTITY")
    if not isinstance(mqtt.get("password_file"), str) or not Path(mqtt["password_file"]).is_absolute():
        raise ValueError("INVALID_PASSWORD_FILE")
    mqtt.setdefault("keepalive_seconds", 30)
    mqtt.setdefault("session_expiry_seconds", 86400)
    if type(mqtt["keepalive_seconds"]) is not int or not 15 <= mqtt["keepalive_seconds"] <= 300 or type(mqtt["session_expiry_seconds"]) is not int or not 3600 <= mqtt["session_expiry_seconds"] <= 604800:
        raise ValueError("INVALID_MQTT_TIMING")
    sources = cfg.get("sources")
    if not isinstance(sources, list) or not 1 <= len(sources) <= 10:
        raise ValueError("INVALID_SOURCES")
    ids, topics = set(), set()
    for source in sources:
        if not isinstance(source, dict) or set(source) - {"id", "topic", "site_id", "host_id", "max_age_seconds", "max_future_seconds"}:
            raise ValueError("INVALID_SOURCE")
        for key in ("id", "site_id", "host_id"):
            if not isinstance(source.get(key), str) or not IDENTITY.fullmatch(source[key]):
                raise ValueError("INVALID_SOURCE_IDENTITY")
        expected = "iot/v1/{site_id}/{host_id}/host-health".format(**source)
        if source.get("topic") != expected or source["id"] != source["host_id"] or source["id"] in ids or source["topic"] in topics:
            raise ValueError("INVALID_OR_DUPLICATE_SOURCE")
        source.setdefault("max_age_seconds", 180)
        source.setdefault("max_future_seconds", 30)
        if type(source["max_age_seconds"]) is not int or not 60 <= source["max_age_seconds"] <= 900 or type(source["max_future_seconds"]) is not int or not 0 <= source["max_future_seconds"] <= 60:
            raise ValueError("INVALID_SOURCE_TIMING")
        ids.add(source["id"]); topics.add(source["topic"])
    limits = cfg.setdefault("limits", {})
    defaults = {"max_message_bytes": 16384, "max_records": 10000, "retention_seconds": 604800, "max_database_bytes": 33554432}
    if not isinstance(limits, dict) or set(limits) - set(defaults):
        raise ValueError("INVALID_LIMITS")
    for key, default in defaults.items():
        limits.setdefault(key, default)
        if type(limits[key]) is not int or limits[key] <= 0:
            raise ValueError("INVALID_LIMITS")
    if not 1024 <= limits["max_message_bytes"] <= 32768 or not 64 <= limits["max_records"] <= 10000 or not 3600 <= limits["retention_seconds"] <= 604800 or not 4194304 <= limits["max_database_bytes"] <= 67108864:
        raise ValueError("INVALID_LIMITS")
    return cfg


def atomic_json(path: Path, value: dict) -> None:
    raw = encode(value)
    if len(raw) > 65536:
        raise ValueError("EXPORT_TOO_LARGE")
    temporary = path.with_name(path.name + ".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o640)
    with os.fdopen(descriptor, "wb") as output:
        output.write(raw); output.flush(); os.fsync(output.fileno())
    os.replace(temporary, path)


@dataclass(frozen=True)
class Accepted:
    message_id: str
    observed: float
    boot_id: str
    sequence: int
    document: dict


class Store:
    """SQLite commit precedes export and PUBACK; duplicates repair failed exports."""
    def __init__(self, cfg: dict, now=time.time):
        self.cfg, self.now = cfg, now
        self.directory = Path(cfg["state_directory"])
        self.directory.mkdir(parents=True, exist_ok=True)
        self.exports = self.directory / "monitor"
        self.exports.mkdir(exist_ok=True)
        os.chmod(self.exports, 0o750)
        self.lock_fd = os.open(self.directory / "receiver.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        if os.name == "posix":
            import fcntl
            try:
                fcntl.flock(self.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                os.close(self.lock_fd)
                raise RuntimeError("RECEIVER_ALREADY_RUNNING") from None
        self.db = sqlite3.connect(self.directory / "receiver.sqlite", timeout=3)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("PRAGMA temp_store=MEMORY")
        self.db.execute("PRAGMA wal_autocheckpoint=64")
        self.db.execute("PRAGMA journal_size_limit=1048576")
        pages = max(1, cfg["limits"]["max_database_bytes"] // self.db.execute("PRAGMA page_size").fetchone()[0])
        actual_limit = self.db.execute("PRAGMA max_page_count=" + str(pages)).fetchone()[0]
        if actual_limit > pages:
            self.db.close(); os.close(self.lock_fd)
            raise ValueError("DATABASE_EXCEEDS_CONFIGURED_CAPACITY")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,sha256 TEXT NOT NULL,receive_time REAL NOT NULL,status TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS messages_receive_time ON messages(receive_time,id);
          CREATE TABLE IF NOT EXISTS latest(source_id TEXT PRIMARY KEY,id TEXT NOT NULL,sha256 TEXT NOT NULL,observed REAL NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,receive_time REAL NOT NULL,document TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS actions(event_id TEXT PRIMARY KEY,source_id TEXT NOT NULL,sha256 TEXT NOT NULL,action_time REAL NOT NULL,document TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS actions_source_time ON actions(source_id,action_time,event_id);
          CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY,value INTEGER NOT NULL);
        """)
        self.db.commit()

    def _count(self, key: str):
        self.db.execute("INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1", (key,))

    def counts(self):
        return {row["name"]: row["value"] for row in self.db.execute("SELECT name,value FROM counters")}

    def export(self, source_id: str):
        row = self.db.execute("SELECT * FROM latest WHERE source_id=?", (source_id,)).fetchone()
        if row:
            document = strict_json(row["document"].encode())
            document["actions"] = [strict_json(value["document"].encode()) for value in reversed(list(self.db.execute(
                "SELECT document FROM actions WHERE source_id=? AND action_time>=? ORDER BY action_time DESC,event_id DESC LIMIT 128",
                (source_id, self.now() - 604800))))]
            document.update(receive_time_utc=utc(row["receive_time"]), payload_sha256=row["sha256"])
            atomic_json(self.exports / (source_id + ".json"), document)

    def _actions(self, source: dict, value: Accepted, now: float):
        self.db.execute("DELETE FROM actions WHERE action_time<?", (now - 604800,))
        pending = []
        for action in value.document["actions"]:
            stamp = timestamp(action["action_time_utc"])
            if stamp < now - 604800:
                continue  # Keep audit for seven days; the supervisor has its own notification horizon.
            raw = encode(action)
            digest = hashlib.sha256(raw).hexdigest()
            old = self.db.execute("SELECT source_id,sha256 FROM actions WHERE event_id=?", (action["event_id"],)).fetchone()
            if old:
                if old["source_id"] != source["id"] or old["sha256"] != digest:
                    raise PayloadConflict("ACTION_ID_CONFLICT")
            else:
                pending.append((action["event_id"], source["id"], digest, stamp, raw.decode()))
        count = self.db.execute("SELECT count(*) FROM actions WHERE source_id=?", (source["id"],)).fetchone()[0]
        if count + len(pending) > 256:
            raise RuntimeError("ACTION_CAPACITY")
        self.db.executemany("INSERT INTO actions VALUES(?,?,?,?,?)", pending)

    def save(self, source: dict, raw: bytes, value: Accepted) -> str:
        now = self.now()
        digest = hashlib.sha256(raw).hexdigest()
        old = self.db.execute("SELECT * FROM messages WHERE id=?", (value.message_id,)).fetchone()
        if old:
            if old["sha256"] != digest or old["source_id"] != source["id"]:
                with self.db:
                    self._count("conflicts")
                    self._count("rejected")
                return "conflict"
            with self.db:
                self._count("duplicates")
            self.export(source["id"])
            return "duplicate"
        current = self.db.execute("SELECT * FROM latest WHERE source_id=?", (source["id"],)).fetchone()
        fresh = now - source["max_age_seconds"] <= value.observed <= now + source["max_future_seconds"]
        advances = not current or (value.observed > current["observed"] and (value.boot_id != current["boot_id"] or value.sequence > current["sequence"]))
        status = "saved" if fresh and advances else "stale"
        with self.db:
            self._actions(source, value, now)
            self.db.execute("DELETE FROM messages WHERE receive_time<?", (now - self.cfg["limits"]["retention_seconds"],))
            maximum = self.cfg["limits"]["max_records"]
            count = self.db.execute("SELECT count(*) FROM messages").fetchone()[0]
            if count >= maximum:
                self.db.execute("DELETE FROM messages WHERE id IN (SELECT id FROM messages ORDER BY receive_time,id LIMIT ?)", (count - maximum + 1,))
            self.db.execute("INSERT INTO messages VALUES(?,?,?,?,?)", (value.message_id, source["id"], digest, now, status))
            self._count(status)
            # Bootstrap audit visibility using its original old resource envelope.
            # It remains stale (including counters and original UTC watermarks),
            # so the supervisor can process actions without inventing fresh health.
            audit_bootstrap = current is None and self.db.execute(
                "SELECT 1 FROM actions WHERE source_id=? LIMIT 1", (source["id"],)).fetchone() is not None
            if status == "saved" or audit_bootstrap:
                document = dict(value.document, actions=[])
                self.db.execute("INSERT INTO latest VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET id=excluded.id,sha256=excluded.sha256,observed=excluded.observed,boot_id=excluded.boot_id,sequence=excluded.sequence,receive_time=excluded.receive_time,document=excluded.document",
                    (source["id"], value.message_id, digest, value.observed, value.boot_id, value.sequence, now, encode(document).decode()))
        self.export(source["id"])
        return status

    def reject(self):
        with self.db:
            self._count("rejected")

    def close(self):
        self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.db.close()
        os.close(self.lock_fd)


def validate_payload(source: dict, raw: bytes, now: float) -> Accepted:
    value = strict_json(raw)
    fields = {"schema_version", "message_id", "site_id", "host_id", "boot_id", "sequence", "read_time_utc", "uptime_seconds", "metrics", "conditions", "actions"}
    if not isinstance(value, dict) or set(value) != fields or type(value.get("schema_version")) is not int or value["schema_version"] != 1:
        raise ValueError("INVALID_HOST_HEALTH")
    if value["site_id"] != source["site_id"] or value["host_id"] != source["host_id"] or not valid_uuid(value["message_id"]) or not valid_uuid(value["boot_id"]):
        raise ValueError("INVALID_HOST_IDENTITY")
    if type(value["sequence"]) is not int or not 1 <= value["sequence"] <= 9007199254740991 or type(value["uptime_seconds"]) not in (int, float) or not math.isfinite(value["uptime_seconds"]) or not 0 <= value["uptime_seconds"] <= 9007199254740991:
        raise ValueError("INVALID_HOST_SEQUENCE")
    observed = timestamp(value["read_time_utc"])
    if observed > now + source["max_future_seconds"]:
        raise ValueError("FUTURE_HOST_TIME")
    metrics = value["metrics"]
    if not isinstance(metrics, dict) or not 1 <= len(metrics) <= len(METRICS) or set(metrics) - METRICS:
        raise ValueError("INVALID_METRICS")
    for key, number in metrics.items():
        if type(number) not in (int, float) or not math.isfinite(number):
            raise ValueError("INVALID_METRIC_VALUE")
        lower, upper = (-50, 150) if key == "cpu_temperature_c" else (0, 100) if key.endswith("_pct") else (0, 1024) if key == "load_1m" else (0, 1048576) if key == "blocked_tasks" else (0, 9007199254740991)
        if not lower <= number <= upper or ((key.endswith("_bytes") or key == "blocked_tasks") and type(number) is not int):
            raise ValueError("INVALID_METRIC_RANGE")
    conditions = value["conditions"]
    if not isinstance(conditions, dict) or set(conditions) != CONDITIONS:
        raise ValueError("INVALID_CONDITIONS")
    for condition in conditions.values():
        if not isinstance(condition, dict) or set(condition) != {"state", "severity", "incident_id", "detail_code"} or condition["state"] not in {"good", "bad", "unknown"} or condition["severity"] not in {"warning", "critical"} or condition["detail_code"] not in DETAIL_CODES:
            raise ValueError("INVALID_CONDITION")
        if (condition["state"] == "bad" and not valid_uuid(condition["incident_id"])) or (condition["state"] != "bad" and condition["incident_id"] is not None):
            raise ValueError("INVALID_INCIDENT_ID")
    actions = value["actions"]
    if not isinstance(actions, list) or len(actions) > 8:
        raise ValueError("INVALID_ACTIONS")
    events = set()
    for action in actions:
        if not isinstance(action, dict) or set(action) != {"event_id", "action_id", "incident_id", "action_time_utc", "kind", "result", "target_id"} or not all(valid_uuid(action[field]) for field in ("event_id", "action_id", "incident_id")):
            raise ValueError("INVALID_ACTION")
        if action["kind"] != "restart_proxy" or action["result"] not in {"claimed", "succeeded", "failed", "uncertain"} or action["target_id"] != "proxy" or action["event_id"] in events:
            raise ValueError("INVALID_ACTION_RESULT")
        # Action audit has its own time watermark; it can describe a later
        # reconciliation result even when the accompanying resource sample is old.
        if timestamp(action["action_time_utc"]) > now + source["max_future_seconds"]:
            raise ValueError("FUTURE_ACTION_TIME")
        events.add(action["event_id"])
    return Accepted(value["message_id"], observed, value["boot_id"], value["sequence"], value)


class Receiver:
    def __init__(self, cfg: dict, validator=validate_payload, now=time.time):
        self.cfg, self.now, self.validator = cfg, now, validator
        self.store = Store(cfg, now)
        self.sources = {source["topic"]: source for source in cfg["sources"]}
        self.connected = self.subscribed = False
        self.error = "NOT_CONNECTED"
        self.stopping = False

    def message(self, client, packet):
        source = self.sources.get(packet.topic)
        if source is None or packet.qos != 1 or packet.retain or len(packet.payload) > self.cfg["limits"]["max_message_bytes"]:
            self.store.reject()
            if packet.qos == 1:
                client.ack(packet.mid, packet.qos)
            return
        try:
            value = self.validator(source, packet.payload, self.now())
        except (ValueError, TypeError, KeyError, OverflowError, RecursionError):
            self.store.reject()
            client.ack(packet.mid, packet.qos)
            return
        try:
            self.store.save(source, packet.payload, value)
        except PayloadConflict:
            self.store.reject()
            client.ack(packet.mid, packet.qos)
            return
        except (OSError, sqlite3.Error, RuntimeError, ValueError, TypeError, KeyError):
            self.error = "STORAGE_PERSISTENCE_FAILED"
            raise
        # Manual PUBACK is sent only after SQLite commit and successful atomic export.
        client.ack(packet.mid, packet.qos)

    def health(self):
        atomic_json(self.store.exports / "health.json", {"schema_version": 1,
            "heartbeat_time_utc": utc(self.now()), "receiver_id": self.cfg["receiver_id"],
            "connected": self.connected, "subscribed": self.subscribed,
            "quality": "ok" if self.connected and self.subscribed and self.error is None else "degraded",
            "last_error": self.error, "counters": self.store.counts()})

    def run(self):
        import paho.mqtt.client as mqtt
        from paho.mqtt.properties import Properties
        from paho.mqtt.packettypes import PacketTypes
        settings = self.cfg["mqtt"]
        password = Path(settings["password_file"]).read_text(encoding="utf-8").strip()
        if not 1 <= len(password) <= 512 or "\n" in password or "\r" in password:
            raise ValueError("INVALID_PASSWORD_FILE")
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=settings["client_id"], protocol=mqtt.MQTTv5, manual_ack=True)
        client.username_pw_set(settings["username"], password)
        password = None
        client.tls_set_context(ssl.create_default_context())
        client.reconnect_delay_set(min_delay=5, max_delay=60)
        client.max_inflight_messages_set(4)
        client.connect_timeout = 5.0
        def on_connect(c, _userdata, _flags, reason, _properties):
            self.connected = not reason.is_failure
            self.subscribed = False
            self.error = None if self.connected else "MQTT_CONNECT_REJECTED"
            if self.connected:
                options = mqtt.SubscribeOptions(qos=1, retainAsPublished=True, retainHandling=2)
                result, _ = c.subscribe([(topic, options) for topic in self.sources])
                if result != mqtt.MQTT_ERR_SUCCESS:
                    self.error = "MQTT_SUBSCRIBE_FAILED"
        def on_subscribe(_client, _userdata, _mid, reasons, _properties):
            self.subscribed = subscribe_accepted(reasons, len(self.sources))
            self.error = None if self.subscribed else "MQTT_SUBSCRIBE_REJECTED"
        def on_disconnect(_client, _userdata, _flags, _reason, _properties):
            self.connected = self.subscribed = False
            self.error = "MQTT_DISCONNECTED"
        client.on_connect, client.on_subscribe, client.on_disconnect = on_connect, on_subscribe, on_disconnect
        client.on_message = lambda c, _userdata, packet: self.message(c, packet)
        parsed = urllib.parse.urlsplit(settings["url"])
        properties = Properties(PacketTypes.CONNECT)
        properties.SessionExpiryInterval = settings["session_expiry_seconds"]
        properties.ReceiveMaximum = 4
        def stop(_signum, _frame):
            self.stopping = True
        signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
        for source in self.cfg["sources"]:
            self.store.export(source["id"])
        next_connect = 0.0
        next_health = 0.0
        try:
            while not self.stopping:
                now = time.monotonic()
                if not client.is_connected() and now >= next_connect:
                    try:
                        client.connect(parsed.hostname, parsed.port or 8883, settings["keepalive_seconds"], clean_start=False, properties=properties)
                        self.error = "MQTT_CONNECTING"
                    except (OSError, ValueError):
                        self.error = "MQTT_CONNECT_FAILED"
                    next_connect = now + 10
                try:
                    client.loop(timeout=0.5)
                except OSError:
                    self.error = "MQTT_IO_FAILED"
                if now >= next_health:
                    self.health(); next_health = now + 10
                if not client.is_connected():
                    time.sleep(0.2)
        finally:
            client.disconnect()
            self.connected = self.subscribed = False
            self.error = "STOPPED" if self.stopping else self.error or "RECEIVER_FAILED"
            self.health()
            self.store.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config")
    parser.add_argument("--healthcheck")
    args = parser.parse_args()
    if args.healthcheck:
        value = strict_json(Path(args.healthcheck).read_bytes())
        return 0 if 0 <= time.time() - timestamp(value.get("heartbeat_time_utc")) <= 90 else 1
    if not args.config:
        parser.error("--config required")
    Receiver(read_config(args.config)).run()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        print('{"event":"host_health_receiver_failed","code":"RECEIVER_STOPPED"}', flush=True)
        raise SystemExit(1)
