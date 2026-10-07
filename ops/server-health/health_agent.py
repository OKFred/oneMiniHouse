#!/usr/bin/env python3
"""Bounded server health summaries; Python stdlib only, Debian 12 Python 3.11+.

Run on the host via a systemd timer, not in a privileged Docker container.
No application log bodies, environment variables or protocol frames are read.
"""
import argparse
import base64
import datetime as dt
import email.utils
import hashlib
import hmac
import http.client
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import ssl
import subprocess
import time
import uuid
import zlib

DAY = 86400
# Deliberately below 25% of 500 MB / 1 million, shared by ALL send attempts
# from this installation. A rolling 32 days also bounds any calendar month.
BYTE_LIMIT = 100_000_000
REQUEST_LIMIT = 100_000
WINDOW = 32 * DAY
RECORD_LIMIT = 8192
LOCAL_RECORD_LIMIT = 10000
LOCAL_DAYS = 7


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def utc(now):
    return dt.datetime.fromtimestamp(now, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_config(path):
    cfg = json.loads(Path(path).read_text(encoding="utf-8"))
    if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", cfg["server_id"]):
        raise ValueError("invalid server_id")
    names = cfg.get("containers", [])
    if len(names) > 8 or len(set(names)) != len(names) or any(not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}", n) for n in names):
        raise ValueError("invalid container allowlist (maximum 8)")
    files = cfg.get("health_files", {})
    if len(files) > 8 or any(not re.fullmatch(r"[a-zA-Z0-9_-]{1,32}", k) for k in files):
        raise ValueError("invalid health file allowlist")
    sls = cfg.get("sls", {})
    if sls.get("enabled") is True:
        if not re.fullmatch(r"[a-z0-9-]+\.log\.aliyuncs\.com", sls["endpoint"]):
            raise ValueError("invalid SLS endpoint")
        for key in ("project", "logstore"):
            if not re.fullmatch(r"[a-z][a-z0-9_-]{1,61}[a-z0-9]", sls[key]):
                raise ValueError("invalid SLS resource")
    return cfg


def connect(path, initialize=False):
    path = Path(path)
    if initialize:
        # Refuse to reset a live or previously initialized ledger.
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(fd)
        db = sqlite3.connect(path)
        db.executescript("""
          PRAGMA journal_mode=WAL;
          PRAGMA synchronous=FULL;
          CREATE TABLE events (
            event_id TEXT PRIMARY KEY, generate_time_utc INTEGER NOT NULL,
            body TEXT NOT NULL, delivery TEXT NOT NULL);
          CREATE INDEX pending ON events(delivery, generate_time_utc);
          CREATE TABLE attempts (
            attempt_time_utc INTEGER NOT NULL, accounted_bytes INTEGER NOT NULL);
          CREATE INDEX attempt_time ON attempts(attempt_time_utc);
          CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT INTO meta VALUES ('schema_version','1');
        """)
    else:
        # Missing/corrupted state must not silently give the uploader a new budget.
        db = sqlite3.connect(path.resolve().as_uri() + "?mode=rw", uri=True)
        if db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != ("1",):
            raise ValueError("invalid ledger")
    db.execute("PRAGMA synchronous=FULL")
    return db


def get_meta(db, key, default=None):
    row = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def set_meta(db, key, value):
    db.execute("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(value)))


def budget(db, now):
    used = db.execute("SELECT coalesce(sum(accounted_bytes),0),count(*) FROM attempts WHERE attempt_time_utc>=?", (now - WINDOW,)).fetchone()
    return {"accounted_bytes_32d": used[0], "requests_32d": used[1],
            "byte_limit_32d": BYTE_LIMIT, "request_limit_32d": REQUEST_LIMIT}


def reserve(db, now, size):
    if type(size) is not int or size <= 0:
        raise ValueError("invalid reservation")
    db.execute("BEGIN IMMEDIATE")
    try:
        last = int(get_meta(db, "last_attempt_time_utc", "0"))
        used = budget(db, now)
        reason = "clock_regressed" if now < last else "budget_exhausted" if used["accounted_bytes_32d"] + size > BYTE_LIMIT or used["requests_32d"] + 1 > REQUEST_LIMIT else None
        if reason:
            db.rollback()
            return reason
        db.execute("INSERT INTO attempts VALUES(?,?)", (now, size))
        set_meta(db, "last_attempt_time_utc", now)
        db.commit()  # Commit BEFORE network I/O. Failed/uncertain requests consume budget.
    except BaseException:
        db.rollback()
        raise
    return None


def command(args):
    return subprocess.run(args, check=True, text=True, capture_output=True, timeout=12).stdout.strip()


def read_small(path):
    with open(path, "rb") as stream:
        body = stream.read(65537)
    if len(body) > 65536:
        raise ValueError("health input too large")
    return body.decode("utf-8")


def collect(cfg, now):
    issues = []
    snapshot = {"containers": {}, "services": {}}
    try:
        mem = dict(re.findall(r"^(MemTotal|MemAvailable):\s+(\d+)", Path("/proc/meminfo").read_text(), re.M))
        total, available = int(mem["MemTotal"]), int(mem["MemAvailable"])
        usage = shutil.disk_usage(cfg["data_dir"])
        snapshot.update({"boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
                         "uptime_s": int(float(Path("/proc/uptime").read_text().split()[0])),
                         "load_1m": round(os.getloadavg()[0], 2),
                         "cpu_count": len(os.sched_getaffinity(0)),
                         "memory_used_pct": round(100 * (total - available) / total, 1),
                         "disk_used_pct": round(100 * usage.used / usage.total, 1)})
        if snapshot["memory_used_pct"] >= 90:
            issues.append("memory_high")
        if snapshot["disk_used_pct"] >= 85:
            issues.append("disk_high")
        if snapshot["load_1m"] > 2 * snapshot["cpu_count"]:
            issues.append("load_high")
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        issues.append("resource_probe_failed")
    try:
        # Unit names only, not arbitrary journal messages which can contain secrets.
        failed = command(["systemctl", "--failed", "--no-legend", "--plain", "--no-pager"]).splitlines()
        snapshot["failed_units"] = [line.split()[0][:100] for line in failed[:12] if line.strip()]
        if failed:
            issues.append("systemd_failed_units")
    except (OSError, subprocess.SubprocessError):
        issues.append("systemd_probe_failed")
    for name in cfg.get("containers", []):
        try:
            # Docker is queried on the host. No Docker socket is shared with an app.
            template = '{"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"restart_count":{{.RestartCount}},"start_time_utc":{{json .State.StartedAt}},"oom_killed":{{.State.OOMKilled}},"exit_code":{{.State.ExitCode}}}'
            state = json.loads(command(["docker", "inspect", "--format", template, name]))
            snapshot["containers"][name] = state
            if state["status"] != "running" or state["health"] in ("starting", "unhealthy") or state["oom_killed"]:
                issues.append("container:" + name)
        except (OSError, ValueError, KeyError, subprocess.SubprocessError):
            snapshot["containers"][name] = {"status": "probe_failed"}
            issues.append("container_probe:" + name)
    for name, path in cfg.get("health_files", {}).items():
        try:
            body = json.loads(read_small(path))
            stamp = body.get("heartbeat_time_utc", body.get("utc"))
            age = now - dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
            quality = body.get("quality")
            state = {"quality": quality if quality in ("ok", "degraded", "error") else "unknown",
                     "heartbeat_age_s": round(age), "mqtt_connected": body.get("mqtt_connected") is True}
            snapshot["services"][name] = state
            if age < -60 or age > 90 or state["quality"] != "ok" or not state["mqtt_connected"]:
                issues.append("service:" + name)
        except (OSError, ValueError, TypeError, AttributeError):
            snapshot["services"][name] = {"quality": "probe_failed"}
            issues.append("service_probe:" + name)
    return snapshot, sorted(issues)


def save_event(db, cfg, now, snapshot, issues):
    # Fingerprint only transitions; resource sample jitter must not create fake changes.
    condition = compact({"boot_id": snapshot.get("boot_id"), "containers": snapshot["containers"], "issues": issues})
    previous = get_meta(db, "condition")
    event = {"schema_version": 1, "event_id": str(uuid.uuid4()), "server_id": cfg["server_id"],
             "generate_time_utc": utc(now), "store_time_utc": utc(now),
             "event_type": "baseline" if previous is None else "state_change" if previous != condition else "heartbeat",
             "quality": "degraded" if issues else "ok", "issues": issues, "snapshot": snapshot}
    body = compact(event)
    if len(body.encode()) > RECORD_LIMIT:
        raise ValueError("health record exceeds 8 KiB; reduce monitored scope")
    with db:
        db.execute("INSERT INTO events VALUES(?,?,?,?)", (event["event_id"], now, body, "pending" if cfg.get("sls", {}).get("enabled") is True else "local"))
        set_meta(db, "condition", condition)
        # Cloud replay has a short horizon: old heartbeats must not pretend to be live.
        db.execute("UPDATE events SET delivery='expired' WHERE delivery='pending' AND generate_time_utc<?", (now - DAY,))
        old = db.execute("SELECT count(*) FROM events WHERE delivery='pending' AND (generate_time_utc<? OR rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT ?))", (now - LOCAL_DAYS * DAY, LOCAL_RECORD_LIMIT)).fetchone()[0]
        set_meta(db, "pending_evicted", int(get_meta(db, "pending_evicted", "0")) + old)
        db.execute("DELETE FROM events WHERE generate_time_utc<? OR rowid NOT IN (SELECT rowid FROM events ORDER BY rowid DESC LIMIT ?)", (now - LOCAL_DAYS * DAY, LOCAL_RECORD_LIMIT))
        db.execute("DELETE FROM attempts WHERE attempt_time_utc<?", (now - WINDOW - DAY,))
    return event


# SLS's public LogGroup protobuf schema: no third-party runtime dependency.
def varint(value):
    out = bytearray()
    while value > 127:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def field(number, value):
    if isinstance(value, str):
        value = value.encode()
    return varint((number << 3) | 2) + varint(len(value)) + value


def log_group(events, now):
    out = b""
    for event in events:
        row = varint(8) + varint(now)
        for key in ("event_id", "server_id", "generate_time_utc", "store_time_utc", "event_type", "quality"):
            row += field(2, field(1, key) + field(2, str(event[key])))
        row += field(2, field(1, "details") + field(2, compact({"issues": event["issues"], "snapshot": event["snapshot"]})))
        out += field(1, row)
    return out + field(3, "server_health") + field(4, "oneMiniHouse")


def signed_headers(path, compressed, raw_size, key_id, key_secret, date):
    headers = {"content-type": "application/x-protobuf", "content-md5": hashlib.md5(compressed).hexdigest().upper(),
               "date": date, "x-log-apiversion": "0.6.0", "x-log-bodyrawsize": str(raw_size),
               "x-log-compresstype": "deflate", "x-log-signaturemethod": "hmac-sha1"}
    canonical = "".join(k + ":" + headers[k] + "\n" for k in sorted(headers) if k.startswith("x-log-"))
    message = "POST\n" + headers["content-md5"] + "\n" + headers["content-type"] + "\n" + date + "\n" + canonical + path
    signature = base64.b64encode(hmac.new(key_secret.encode(), message.encode(), hashlib.sha1).digest()).decode()
    headers["authorization"] = "LOG " + key_id + ":" + signature
    return headers


def provider_error_code(response):
    # Provider messages may echo inputs; retain only a bounded symbolic code.
    body = response.read(4097)
    if len(body) > 4096:
        return "ErrorResponseTooLarge"
    try:
        value = json.loads(body)
        code = value.get("errorCode") if isinstance(value, dict) else None
        return code if isinstance(code, str) and re.fullmatch(r"[A-Za-z][A-Za-z0-9_.]{0,63}", code) else "UnknownProviderError"
    except (ValueError, UnicodeError):
        return "InvalidErrorResponse"


def upload(db, cfg, now, transport=None):
    if cfg.get("sls", {}).get("enabled") is not True:
        return "disabled"
    if now < int(get_meta(db, "next_attempt_time_utc", "0")):
        return "backoff"
    rows = db.execute("SELECT event_id,body FROM events WHERE delivery='pending' ORDER BY generate_time_utc,rowid LIMIT 12").fetchall()
    if not rows:
        return "idle"
    raw = log_group([json.loads(row[1]) for row in rows], now)
    # SLS deflate uses an RFC 1950 zlib wrapper, not a .gz file header.
    compressed = zlib.compress(raw)
    # Covers uncompressed index fields, compressed write/storage and additional
    # reserved-field/metadata headroom. This is not an account-wide billing meter.
    cost = len(raw) + len(compressed) + 2048 * len(rows)
    reason = reserve(db, now, cost)
    if reason:
        return reason
    sls = cfg["sls"]
    status = None
    error_code = ""
    try:
        if transport:
            status = transport(raw, compressed)
        else:
            key_id = Path(sls["access_key_id_file"]).read_text().strip()
            key_secret = Path(sls["access_key_secret_file"]).read_text().strip()
            if not key_id or not key_secret:
                raise ValueError("empty credentials")
            path = "/logstores/" + sls["logstore"] + "/shards/lb"
            headers = signed_headers(path, compressed, len(raw), key_id, key_secret, email.utils.formatdate(now, usegmt=True))
            conn = http.client.HTTPSConnection(sls["project"] + "." + sls["endpoint"], timeout=15, context=ssl.create_default_context())
            try:
                conn.request("POST", path, compressed, headers)
                response = conn.getresponse()
                status = response.status  # No redirects, no unbounded response body.
                if status != 200:
                    error_code = provider_error_code(response)
            finally:
                conn.close()
    except (OSError, ValueError, http.client.HTTPException):
        pass  # Do not log credentials or arbitrary provider response text.
    with db:
        if status == 200:
            db.executemany("UPDATE events SET delivery='sent' WHERE event_id=?", [(row[0],) for row in rows])
            set_meta(db, "consecutive_failures", 0)
            set_meta(db, "last_success_time_utc", now)
            set_meta(db, "next_attempt_time_utc", now + 300)
        else:
            failures = min(10, int(get_meta(db, "consecutive_failures", "0")) + 1)
            set_meta(db, "consecutive_failures", failures)
            set_meta(db, "next_attempt_time_utc", now + min(3600, 300 * 2 ** (failures - 1)))
        set_meta(db, "last_http_status", status if status is not None else "transport_error")
        set_meta(db, "last_error_code", error_code)
    return "sent" if status == 200 else "upload_failed"


def run(cfg, initialize=False, status_only=False):
    data = Path(cfg["data_dir"])
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    import fcntl  # Host script targets Linux; tests exercise pure logic on Windows.
    with open(data / "agent.lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        db = connect(data / "health.sqlite", initialize)
        now = int(time.time())
        if not initialize and not status_only:
            last = int(get_meta(db, "last_sample_time_utc", "0"))
            if now - last < 300:
                print(compact({"status": "sample_throttled"}))
                return
            snapshot, issues = collect(cfg, now)
            event = save_event(db, cfg, now, snapshot, issues)
            with db:
                set_meta(db, "last_sample_time_utc", now)
            result = upload(db, cfg, now)
            # Only the latest local status is printed; detailed records stay bounded in SQLite.
            print(compact({"event_id": event["event_id"], "quality": event["quality"], "issues": issues, "upload": result, "http_status": get_meta(db, "last_http_status"), "error_code": get_meta(db, "last_error_code"), **budget(db, now)}))
        else:
            print(compact({"initialized": initialize, **budget(db, now), "events": db.execute("SELECT delivery,count(*) FROM events GROUP BY delivery").fetchall()}))
        db.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--initialize", action="store_true")
    group.add_argument("--status", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        run(load_config(args.config), args.initialize, args.status)
    except Exception as error:
        print(compact({"status": "failed_closed", "error_type": type(error).__name__}))
        raise SystemExit(1)
