#!/usr/bin/env python3
"""Read-only pipeline observer. It never opens ingestor SQLite or controls Docker."""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import sqlite3
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass


def utc(timestamp: float) -> str:
    return dt.datetime.fromtimestamp(timestamp, dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp(value) -> float | None:
    try:
        if isinstance(value, str):
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            number = parsed.timestamp()
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            number = float(value) / 1000  # Queue counters use Unix milliseconds.
        else:
            return None
        return number if math.isfinite(number) else None
    except (ValueError, OverflowError, OSError):
        return None


def age(value, now: float) -> float | None:
    parsed = timestamp(value)
    if parsed is None or parsed > now + 60:
        return None
    return max(0, now - parsed)


def bounded_json(path: str, limit: int = 1048576) -> dict:
    with open(path, "rb") as source:
        content = source.read(limit + 1)
    if len(content) > limit:
        raise ValueError("HEALTH_TOO_LARGE")
    result = json.loads(content)
    if not isinstance(result, dict):
        raise ValueError("HEALTH_NOT_OBJECT")
    return result


def atomic_json(path: Path, value: dict):
    temporary = path.with_suffix(".tmp")
    with open(temporary, "w", encoding="utf-8") as output:
        json.dump(value, output, ensure_ascii=False, separators=(",", ":"))
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def count(value) -> int:
    return int(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0 else 0


def valid_count(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0


@dataclass(frozen=True)
class Observation:
    key: str
    state: str  # bad / good / unknown; unknown must never clear a previous fault.
    detail: str
    severity: str = "warning"
    duration: int = 0


DEFAULTS = {
    "check_interval_seconds": 60, "startup_grace_seconds": 300,
    "heartbeat_max_age_seconds": 90, "mqtt_failure_seconds": 180,
    "target_failure_seconds": 300, "queue_warning_seconds": 600,
    "queue_critical_seconds": 1800, "repeat_seconds": 3600, "recovery_seconds": 180,
}
NOTIFICATION_DEFAULTS = {
    "enabled": False, "allowed_hosts": ["open.feishu.cn"], "timeout_seconds": 5,
    "max_attempts": 10, "max_age_seconds": 21600, "max_pending": 500,
    "requests_per_hour": 30, "requests_per_day": 120,
}
FAILURE_KINDS = ("failure", "escalation", "reminder")
REMINDER_CATEGORIES = {"validity", "freshness", "clock", "actual_sample", "mqtt", "target", "queue", "storage", "heartbeat", "event_loop", "collector", "other"}
HOST_CONDITIONS = {
    "memory_pressure": "内存压力", "io_pressure": "I/O 阻塞", "temperature": "设备温度", "storage": "存储空间",
}
HOST_DETAIL_CODES = {"none", "metric_unavailable", "memory_available_low", "memory_available_critical", "io_wait_blocked", "temperature_high", "storage_low"}
HOST_ACTION_RESULTS = {"claimed": "已记录执行意图，尚未确认结果", "succeeded": "执行成功", "failed": "执行失败", "uncertain": "执行结果不确定"}


def canonical_uuid(value) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except (ValueError, AttributeError):
        return False


def finite_number(value) -> bool:
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def severity_rank(value: str | None) -> int:
    return {"warning": 1, "critical": 2}.get(value, 0)


def reminder_category(key: str) -> str:
    if key.startswith("device:"):
        suffix = key.rsplit(":", 1)[-1]
        return suffix if suffix in {"validity", "freshness", "clock", "actual_sample"} else "other"
    if key == "ingestor:heartbeat":
        return "heartbeat"
    if key == "ingestor:event_loop":
        return "event_loop"
    prefix = key.split(":", 1)[0]
    return prefix if prefix in {"mqtt", "target", "queue", "storage", "collector"} else "other"


def device_check_key(device: dict) -> str:
    return "device:" + "/".join(part for part in (device.get("site_id"), device["gateway_id"], device["device_id"]) if part)


def device_alerts_paused(cfg: dict, key: str) -> bool:
    # Match the complete identity and a check separator. A longer configured
    # identity wins, so an identifier containing ':' cannot inherit a short ID's switch.
    for device in sorted(cfg["devices"], key=lambda item: len(device_check_key(item)), reverse=True):
        if key.startswith(device_check_key(device) + ":"):
            return device.get("alerts_enabled", True) is False
    return False


def load_config(path: str) -> dict:
    cfg = bounded_json(path)
    for key, default in DEFAULTS.items():
        cfg.setdefault(key, default)
        if not isinstance(cfg[key], int) or isinstance(cfg[key], bool) or cfg[key] <= 0:
            raise ValueError("INVALID_CONFIG_" + key)
    if not 10 <= cfg["check_interval_seconds"] <= 300 or cfg["repeat_seconds"] < 3600:
        raise ValueError("INVALID_CHECK_OR_REPEAT_INTERVAL")
    if cfg["queue_critical_seconds"] <= cfg["queue_warning_seconds"]:
        raise ValueError("INVALID_QUEUE_THRESHOLDS")
    reminders = cfg.setdefault("reminder_seconds_by_category", {})
    if not isinstance(reminders, dict) or any(category not in REMINDER_CATEGORIES or type(value) is not int or value < 3600 or value > 604800 for category, value in reminders.items()):
        raise ValueError("INVALID_REMINDER_OVERRIDES")
    cfg.setdefault("devices", [])
    cfg.setdefault("targets", [])
    cfg.setdefault("mqtt_client_ids", [])
    cfg.setdefault("collector_health_files", [])
    cfg.setdefault("storage", [])
    cfg.setdefault("host_health_sources", [])
    for key, maximum in (("devices", 256), ("targets", 16), ("mqtt_client_ids", 16), ("collector_health_files", 32), ("storage", 16), ("host_health_sources", 32)):
        if not isinstance(cfg[key], list) or len(cfg[key]) > maximum:
            raise ValueError("INVALID_CONFIG_LIST_" + key)
    def identifier(value):
        return isinstance(value, str) and 0 < len(value) <= 160 and not any(ord(char) < 32 for char in value)
    for key in ("targets", "mqtt_client_ids"):
        if not all(identifier(value) for value in cfg[key]) or len(set(cfg[key])) != len(cfg[key]):
            raise ValueError("INVALID_OR_DUPLICATE_" + key)
    hosts, host_ids = set(), set()
    for host in cfg["host_health_sources"]:
        def safe_id(value):
            return isinstance(value, str) and 0 < len(value) <= 128 and all(char.isascii() and (char.isalnum() or char in "_-") for char in value)
        if (not isinstance(host, dict) or not all(safe_id(host.get(key)) for key in ("id", "site_id", "host_id"))
                or host["id"] in host_ids or (host["site_id"], host["host_id"]) in hosts
                or any(not isinstance(host.get(key), str) or not os.path.isabs(host[key]) or len(host[key]) > 1024
                       or any(ord(char) < 32 for char in host[key]) for key in ("path", "receiver_health_path"))
                or not identifier(host.get("label", host["id"]))):
            raise ValueError("INVALID_HOST_HEALTH_SOURCE")
        hosts.add((host["site_id"], host["host_id"]))
        host_ids.add(host["id"])
        for key, default in (("freshness_seconds", 180), ("critical_freshness_seconds", 300), ("receiver_freshness_seconds", 90), ("receiver_failure_seconds", 180)):
            host.setdefault(key, default)
            if type(host[key]) is not int or not 10 <= host[key] <= 3600:
                raise ValueError("INVALID_HOST_HEALTH_THRESHOLD")
        if host["critical_freshness_seconds"] <= host["freshness_seconds"]:
            raise ValueError("INVALID_HOST_HEALTH_THRESHOLD")
    for path_key in ("state_directory", "ingestor_health_file"):
        if not isinstance(cfg.get(path_key), str) or not cfg[path_key]:
            raise ValueError("INVALID_PATH_" + path_key)
    seen = set()
    for device in cfg["devices"]:
        if not isinstance(device, dict) or not identifier(device.get("gateway_id")) or not identifier(device.get("device_id")) or (device.get("site_id") is not None and not identifier(device["site_id"])):
            raise ValueError("INVALID_DEVICE_IDENTITY")
        identity = (device.get("site_id"), device["gateway_id"], device["device_id"])
        if identity in seen:
            raise ValueError("DUPLICATE_DEVICE")
        seen.add(identity)
        device.setdefault("interval_seconds", 60)
        device.setdefault("freshness_seconds", max(300, device["interval_seconds"] * 5))
        device.setdefault("invalid_samples", 3)
        device.setdefault("require_actual_sample", False)
        device.setdefault("alerts_enabled", True)
        if type(device["require_actual_sample"]) is not bool or type(device["alerts_enabled"]) is not bool:
            raise ValueError("INVALID_DEVICE_FLAG")
        for key in ("interval_seconds", "freshness_seconds", "invalid_samples"):
            if not isinstance(device[key], int) or isinstance(device[key], bool) or device[key] <= 0:
                raise ValueError("INVALID_DEVICE_THRESHOLD")
        if device["freshness_seconds"] < device["interval_seconds"]:
            raise ValueError("FRESHNESS_SMALLER_THAN_INTERVAL")
        if "label" in device and not identifier(device["label"]):
            raise ValueError("INVALID_DEVICE_LABEL")
    for list_key in ("storage", "collector_health_files"):
        identities = set()
        for item in cfg[list_key]:
            if not isinstance(item, dict) or not identifier(item.get("id")) or not isinstance(item.get("path"), str) or not item["path"] or item["id"] in identities:
                raise ValueError("INVALID_OBSERVER_PATHS")
            identities.add(item["id"])
    for resource in cfg["storage"]:
        for key in ("min_free_fraction", "min_free_inode_fraction"):
            value = resource.get(key, 0.1)
            if not valid_count(value) or value > 1:
                raise ValueError("INVALID_STORAGE_FRACTION")
        if not valid_count(resource.get("min_free_bytes", 0)):
            raise ValueError("INVALID_STORAGE_MIN_BYTES")
    temp_fraction = cfg.get("sqlite_temp_min_free_fraction", 0.2)
    if not valid_count(temp_fraction) or temp_fraction > 1:
        raise ValueError("INVALID_TEMP_FRACTION")
    notifications = cfg.setdefault("notifications", {})
    if not isinstance(notifications, dict):
        raise ValueError("INVALID_NOTIFICATIONS")
    for key, default in NOTIFICATION_DEFAULTS.items():
        notifications.setdefault(key, default)
    for key in ("timeout_seconds", "max_attempts", "max_age_seconds", "max_pending", "requests_per_hour", "requests_per_day"):
        if not isinstance(notifications[key], (int, float)) or isinstance(notifications[key], bool) or not math.isfinite(notifications[key]) or notifications[key] <= 0:
            raise ValueError("INVALID_NOTIFICATION_LIMIT")
    if type(notifications["enabled"]) is not bool:
        raise ValueError("INVALID_NOTIFICATION_FLAG")
    if not isinstance(notifications["allowed_hosts"], list) or not notifications["allowed_hosts"] or not all(identifier(host) and "/" not in host and ":" not in host for host in notifications["allowed_hosts"]):
        raise ValueError("INVALID_WEBHOOK_HOSTS")
    if notifications["timeout_seconds"] > 10 or notifications["max_pending"] > 1000:
        raise ValueError("NOTIFICATION_LIMIT_TOO_HIGH")
    if notifications["enabled"] and not notifications.get("webhook_file"):
        raise ValueError("WEBHOOK_FILE_REQUIRED")
    return cfg


class State:
    def __init__(self, path: Path):
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS fault(key TEXT PRIMARY KEY,first_bad_time_utc REAL,active INTEGER NOT NULL DEFAULT 0,
            severity TEXT,detail TEXT,last_enqueue_time_utc REAL,last_sent_time_utc REAL,notified INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,fault_key TEXT NOT NULL,kind TEXT NOT NULL,
            severity TEXT NOT NULL,detail TEXT NOT NULL,create_time_utc REAL NOT NULL,next_attempt_time_utc REAL NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_time_utc);
          CREATE TABLE IF NOT EXISTS request_budget(attempt_time_utc REAL NOT NULL);
          CREATE TABLE IF NOT EXISTS host_action_receipt(event_id TEXT PRIMARY KEY,host_id TEXT NOT NULL,seen_time_utc REAL NOT NULL);
          CREATE INDEX IF NOT EXISTS host_action_receipt_seen ON host_action_receipt(seen_time_utc);
        """)
        # Additive and repeatable migration: keep incidents, queued notifications
        # and request budgets. Legacy delivered severity is the best persisted
        # evidence available; subsequent ACKs maintain the incident's high-water mark.
        with self.db:
            columns = {row["name"] for row in self.db.execute("PRAGMA table_info(fault)")}
            for column, sql_type in (("good_since_time_utc", "REAL"), ("last_good_time_utc", "REAL"), ("notified_highest_severity", "TEXT"),
                                     ("notification_retry_after_time_utc", "REAL"), ("notification_retry_attempts", "INTEGER"), ("notification_event_id", "TEXT")):
                if column not in columns:
                    self.db.execute(f"ALTER TABLE fault ADD COLUMN {column} {sql_type}")
            for column in ("alerts_paused_time_utc", "alerts_recheck_bad_since_time_utc"):
                if column not in columns:
                    self.db.execute(f"ALTER TABLE fault ADD COLUMN {column} REAL")
            outbox_columns = {row["name"] for row in self.db.execute("PRAGMA table_info(outbox)")}
            if "suspended_time_utc" not in outbox_columns:
                self.db.execute("ALTER TABLE outbox ADD COLUMN suspended_time_utc REAL")
            # Current critical severity plus an unsent critical event does not
            # prove the legacy incident's critical notification was acknowledged.
            self.db.execute("""UPDATE fault SET notified_highest_severity=CASE WHEN severity='critical'
              AND NOT EXISTS (SELECT 1 FROM outbox WHERE fault_key=fault.key AND severity='critical'
                AND kind IN ('failure','escalation','reminder')) THEN 'critical' ELSE 'warning' END
              WHERE notified=1 AND notified_highest_severity IS NULL""")
            self.set("state_schema_version", 4)

    def get(self, key, default=None):
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    def set(self, key, value):
        self.db.execute("INSERT OR REPLACE INTO meta VALUES (?,?)", (key, json.dumps(value)))

    def close(self):
        self.db.close()


def evaluate(cfg: dict, health: dict | None, now: float, startup: float, state: State) -> list[Observation]:
    result = []
    if health is None:
        return [Observation("ingestor:heartbeat", "bad", "入库服务健康文件缺失或无法解析", "critical")]
    heartbeat_age = age(health.get("heartbeat_time_utc"), now)
    fresh = heartbeat_age is not None and heartbeat_age <= cfg["heartbeat_max_age_seconds"]
    result.append(Observation("ingestor:heartbeat", "good" if fresh else "bad", "入库服务心跳正常" if fresh else "入库服务心跳过期或时间无效", "critical"))
    if not fresh:
        return result  # Stale snapshots cannot prove that any dependent fault recovered.
    if not isinstance(health.get("mqtt_connections"), list) or not isinstance(health.get("targets"), dict):
        result.append(Observation("ingestor:health_schema", "bad", "入库服务健康字段缺失或格式错误", "critical"))
        return result
    result.append(Observation("ingestor:health_schema", "good", "入库服务健康字段正常"))
    intake = health.get("intake_paused")
    if type(intake) is bool:
        result.append(Observation("ingestor:intake", "bad" if intake else "good", "消息接收暂停", "critical", 60))
        result.append(Observation("capability:intake", "good", "接收状态字段正常"))
    else:
        result.append(Observation("ingestor:intake", "unknown", "接收状态字段缺失或无效"))
        result.append(Observation("capability:intake", "bad", "接收状态字段缺失或无效", "warning", cfg["startup_grace_seconds"]))
    for field, label in (("processing_failed", "处理失败"), ("delivery_failed", "不可重试投递失败")):
        if valid_count(health.get(field)):
            result.append(Observation("ingestor:" + field, "bad" if count(health[field]) else "good", label + "记录存在", "critical", 60))
            result.append(Observation("capability:" + field, "good", label + "字段正常"))
        else:
            result.append(Observation("ingestor:" + field, "unknown", label + "记录数缺失或无效"))
            result.append(Observation("capability:" + field, "bad", label + "记录数缺失或无效", "warning", cfg["startup_grace_seconds"]))
    business = health.get("business_health")
    schema_good = isinstance(business, dict) and type(business.get("schema_version", business.get("version"))) is int and business.get("schema_version", business.get("version")) == 1
    business = business if isinstance(business, dict) else {}
    monitor_failed = bool(business.get("monitor_error") or business.get("persistence_error") or business.get("export_error"))
    result.append(Observation("ingestor:monitor", "unknown" if not schema_good else "bad" if monitor_failed else "good", "入库监控数据无法可靠保存", "critical"))
    result.append(Observation("capability:business_health", "good" if schema_good else "bad", "业务监控字段缺失或版本无效", "warning", cfg["startup_grace_seconds"]))
    connections = health.get("mqtt_connections", [])
    if not isinstance(connections, list):
        connections = []
    if not connections:
        result.append(Observation("mqtt:status", "bad", "MQTT 连接状态缺失", "warning", cfg["mqtt_failure_seconds"]))
    else:
        valid_connections = all(isinstance(connection, dict) and isinstance(connection.get("client_id"), str) and type(connection.get("connected")) is bool and type(connection.get("subscribed")) is bool for connection in connections)
        result.append(Observation("mqtt:status", "good" if valid_connections else "bad", "MQTT 连接状态字段格式错误", "warning", cfg["mqtt_failure_seconds"]))
    by_client = {connection["client_id"]: connection for connection in connections
                 if isinstance(connection, dict) and isinstance(connection.get("client_id"), str)}
    for identity in cfg.get("mqtt_client_ids", []):
        if identity not in by_client:
            result.append(Observation("mqtt:" + identity, "bad", "MQTT 连接状态缺失：" + identity, "warning", cfg["mqtt_failure_seconds"]))
    for connection in connections:
        if not isinstance(connection, dict):
            continue
        identity = str(connection.get("client_id", "unknown"))
        healthy = connection.get("connected") is True and connection.get("subscribed") is True
        result.append(Observation("mqtt:" + identity, "good" if healthy else "bad", "MQTT 连接或订阅不可用：" + identity, "warning", cfg["mqtt_failure_seconds"]))
    targets = business.get("targets", {})
    targets = targets if isinstance(targets, dict) else {}
    existing_targets = health.get("targets", {})
    existing_targets = existing_targets if isinstance(existing_targets, dict) else {}
    for target in cfg["targets"]:
        record = targets.get(target, existing_targets.get(target, {}))
        if not isinstance(record, dict) or ("pending" not in record and target + "_pending" not in health):
            result.append(Observation("target:" + target, "unknown", target + "缺少待发监控字段"))
            result.append(Observation("capability:target:" + target, "bad", target + "缺少入库状态字段", "warning", cfg["startup_grace_seconds"]))
            continue
        pending_value = record.get("pending", health.get(target + "_pending"))
        if not valid_count(pending_value):
            result.append(Observation("target:" + target, "unknown", target + "待发记录数无效"))
            result.append(Observation("capability:target:" + target, "bad", target + "待发记录数字段格式错误", "warning", cfg["startup_grace_seconds"]))
            continue
        result.append(Observation("capability:target:" + target, "good", "入库状态字段已提供"))
        pending = count(pending_value)
        success_age = age(record.get("last_success_time_utc"), now)
        success_time = timestamp(record.get("last_success_time_utc")) if success_age is not None else None
        legacy_target = existing_targets.get(target, {})
        target_error = record.get("error", legacy_target.get("error") if isinstance(legacy_target, dict) else None)
        prior_fault = state.db.execute("SELECT active,first_bad_time_utc FROM fault WHERE key=?", ("target:" + target,)).fetchone()
        proven_recovery = not prior_fault or not prior_fault["active"] or (success_time is not None and success_time >= prior_fault["first_bad_time_utc"] and not target_error)
        failure = pending > 0 and (success_age is None or success_age > cfg["target_failure_seconds"])
        target_state = "bad" if failure else "unknown" if target_error or not proven_recovery else "good"
        result.append(Observation("target:" + target, target_state, f"{target} 入库停滞，待发 {pending} 条" if target_state == "bad" else f"{target} 尚无成功写入证据，不能确认恢复" if target_state == "unknown" else f"{target} 入库正常", "warning", cfg["target_failure_seconds"] if success_age is None else 0))
        oldest = record.get("oldest_pending_time_utc")
        if oldest is not None:
            oldest_age = age(oldest, now)
            severity = "critical" if oldest_age is not None and oldest_age >= cfg["queue_critical_seconds"] else "warning"
            queue_state = "unknown" if pending and oldest_age is None else "bad" if pending and oldest_age >= cfg["queue_warning_seconds"] else "good"
            result.append(Observation("queue:" + target, queue_state, f"{target} 最老待发记录已等待 {int(oldest_age or 0)} 秒", severity))
    oldest_age = age(health.get("oldest_pending_time_utc"), now)
    pending = count(health.get("outstanding_raw", health.get("queued")))
    severity = "critical" if oldest_age is not None and oldest_age >= cfg["queue_critical_seconds"] else "warning"
    pending_value = health.get("outstanding_raw", health.get("queued"))
    queue_state = "unknown" if not valid_count(pending_value) or (pending and oldest_age is None) else "bad" if pending and oldest_age >= cfg["queue_warning_seconds"] else "good"
    result.append(Observation("queue:all", queue_state, f"最老待发记录已等待 {int(oldest_age or 0)} 秒，积压 {pending} 条", severity))
    devices = business.get("devices", [])
    device_records = list(devices.values()) if isinstance(devices, dict) else devices if isinstance(devices, list) else []
    # Identity fields come from a JSON snapshot. Malformed lists/objects must not
    # crash the observer or turn an omitted invalid record into recovery proof.
    valid_devices = [d for d in device_records if isinstance(d, dict)
                     and (d.get("site_id") is None or isinstance(d["site_id"], str))
                     and isinstance(d.get("gateway_id"), str) and isinstance(d.get("device_id"), str)]
    by_identity = {(d.get("site_id"), d["gateway_id"], d["device_id"]): d for d in valid_devices}
    capable = (schema_good and isinstance(devices, (dict, list))
               and len(valid_devices) == len(device_records) and len(by_identity) == len(valid_devices))
    if any(device.get("alerts_enabled", True) for device in cfg["devices"]):
        result.append(Observation("capability:devices", "good" if capable else "bad", "入库服务尚未提供设备新鲜度监控字段", "warning", cfg["startup_grace_seconds"]))
    for device in cfg["devices"]:
        if not device.get("alerts_enabled", True):
            continue
        identity = (device.get("site_id"), device["gateway_id"], device["device_id"])
        key = device_check_key(device)
        label = device.get("label", device["device_id"])
        record = by_identity.get(identity)
        if record is None and device.get("site_id") is None:
            matches = [entry for entry_key, entry in by_identity.items() if entry_key[1:] == identity[1:]]
            if len(matches) == 1:
                record = matches[0]
        if not capable:
            continue
        if monitor_failed:
            result.append(Observation(key + ":freshness", "unknown", "监控状态异常，暂停设备恢复判断"))
            continue
        collect_age = age(record.get("last_collect_time_utc"), now) if record else None
        clock_invalid = record.get("clock_invalid") if record else None
        stale = collect_age is None or collect_age > device["freshness_seconds"]
        if record:
            clock_state = "unknown" if type(clock_invalid) is not bool else "bad" if clock_invalid else "good" if not stale else "unknown"
            result.append(Observation(key + ":clock", clock_state, label + "采样时间无效或处于未来", "warning", 60))
        if now - startup < cfg["startup_grace_seconds"] and stale:
            result.append(Observation(key + ":freshness", "unknown", "启动等待设备首条数据"))
        else:
            result.append(Observation(key + ":freshness", "bad" if stale else "good", label + ("采样时间无效" if clock_invalid else "没有新采样"), "warning"))
        if record and not stale and "consecutive_invalid_samples" in record:
            invalid_value = record.get("consecutive_invalid_samples")
            invalid_count = count(invalid_value)
            invalid_state = "unknown" if not valid_count(invalid_value) else "bad" if invalid_count >= device["invalid_samples"] else "unknown" if invalid_count else "good"
            result.append(Observation(key + ":validity", invalid_state, label + "连续采到无效或越界读数", "warning"))
            result.append(Observation(key + ":validity_schema", "good" if valid_count(invalid_value) else "bad", label + "无效读数计数格式错误", "warning", cfg["startup_grace_seconds"]))
        if record and device.get("require_actual_sample"):
            sample_age = age(record.get("last_sample_time_utc"), now)
            if sample_age is None:
                result.append(Observation(key + ":actual_sample", "unknown", label + "未提供实际测量时间，不能判定测量新鲜度"))
            else:
                result.append(Observation(key + ":actual_sample", "bad" if sample_age > device["freshness_seconds"] else "good", label + "实际测量数据过期", "warning"))
        if record and (record.get("monitor_error") or record.get("persistence_error")):
            result.append(Observation(key + ":monitor", "bad", label + "监控状态无法可靠保存", "critical"))
        elif record:
            result.append(Observation(key + ":monitor", "good", "设备监控状态正常"))
    loop = business.get("event_loop", {})
    lag_ms = loop.get("lag_ms", business.get("event_loop_lag_ms")) if isinstance(loop, dict) else business.get("event_loop_lag_ms")
    if valid_count(lag_ms):
        result.append(Observation("ingestor:event_loop", "bad" if lag_ms > 1000 else "good", "入库服务事件循环延迟超过 1 秒", "warning", 60))
    else:
        result.append(Observation("ingestor:event_loop", "unknown", "入库服务事件循环延迟字段缺失或格式错误"))
    runtime = business.get("runtime_start_time_utc", business.get("startup_time_utc"))
    if timestamp(runtime) is not None:
        history = state.get("runtime_history", [])
        if not history or history[-1]["runtime"] != runtime:
            history.append({"runtime": runtime, "observed": now})
        history = [entry for entry in history if entry["observed"] >= now - 600][-50:]
        state.set("runtime_history", history)
        result.append(Observation("ingestor:restarts", "bad" if max(0, len(history) - 1) >= cfg.get("restart_warning_count", 3) else "good", "入库服务在 10 分钟内反复启动", "warning"))
    return result


def resource_observations(cfg: dict, now: float, state: State, health: dict | None = None) -> list[Observation]:
    result = []
    for resource in cfg["storage"]:
        key = "storage:" + resource["id"]
        try:
            stat = os.statvfs(resource["path"])
            free = stat.f_bavail * stat.f_frsize
            total = stat.f_blocks * stat.f_frsize
            bytes_low = free < resource.get("min_free_bytes", 0)
            fraction_low = total > 0 and free / total < resource.get("min_free_fraction", 0.10)
            inode_low = stat.f_files > 0 and stat.f_favail / stat.f_files < resource.get("min_free_inode_fraction", 0.10)
            bad = bytes_low or fraction_low or inode_low
            result.append(Observation(key + ":access", "good", "存储监控路径可读取"))
            result.append(Observation(key, "bad" if bad else "good", resource["id"] + "可用空间或 inode 不足", "critical", 60))
        except (OSError, AttributeError):
            result.append(Observation(key + ":access", "bad", resource["id"] + "监控路径不可读取", "warning", 60))
    wal = cfg.get("wal")
    if health:
        heartbeat_age = age(health.get("heartbeat_time_utc"), now)
        if heartbeat_age is None or heartbeat_age > cfg["heartbeat_max_age_seconds"]:
            result.append(Observation("storage:sqlite_temp", "unknown", "健康快照过期，暂停实际临时空间恢复判断"))
            if wal:
                result.append(Observation("storage:wal", "unknown", "健康快照过期，暂停 WAL 恢复判断"))
            return result
        business = health.get("business_health", {})
        storage = business.get("storage", {}) if isinstance(business, dict) else {}
        if not isinstance(storage, dict):
            storage = {}
        expected = cfg.get("expected_sqlite_temp_directory")
        actual = storage.get("temp_directory")
        free_bytes, total_bytes = storage.get("temp_free_bytes"), storage.get("temp_total_bytes")
        available = isinstance(actual, str) and valid_count(free_bytes) and valid_count(total_bytes) and total_bytes > 0 and not storage.get("error")
        if expected:
            if not available:
                result.append(Observation("storage:sqlite_temp", "unknown", "实际 SQLite 临时空间状态缺失，不能确认空间充足"))
                result.append(Observation("capability:sqlite_temp", "bad", "无法读取实际 SQLite 临时目录信息", "warning", cfg["startup_grace_seconds"]))
            else:
                result.append(Observation("capability:sqlite_temp", "good", "实际 SQLite 临时目录信息正常"))
                result.append(Observation("storage:sqlite_temp_directory", "bad" if actual.rstrip("/") != expected.rstrip("/") else "good", "SQLite 实际临时目录与指定持久目录不一致", "critical"))
                inode_free, inode_total = storage.get("temp_free_inodes"), storage.get("temp_total_inodes")
                inode_low = valid_count(inode_free) and valid_count(inode_total) and inode_total > 0 and inode_free / inode_total < 0.10
                bad = free_bytes / total_bytes < cfg.get("sqlite_temp_min_free_fraction", 0.20) or inode_low
                result.append(Observation("storage:sqlite_temp", "bad" if bad else "good", "SQLite 实际临时空间或 inode 即将耗尽", "critical", 60))
        if not wal:
            return result
        size = storage.get("sqlite_wal_bytes") if isinstance(storage, dict) else None
        if not valid_count(size):
            result.append(Observation("storage:wal", "unknown", "尚未提供 SQLite WAL 大小监控字段"))
            return result
        previous = state.get("wal_sample", {"size": size, "time": now})
        elapsed = now - previous["time"]
        growth = max(0, size - previous["size"]) * 60 / elapsed if elapsed > 0 else 0
        state.set("wal_sample", {"size": size, "time": now})
        bad = size >= wal.get("warning_bytes", 268435456) or growth >= wal.get("growth_bytes_per_minute", 67108864)
        result.append(Observation("storage:wal", "bad" if bad else "good", f"SQLite WAL 膨胀：{size} 字节", "warning", wal.get("duration_seconds", 300)))
    return result


def host_snapshot(record: dict, host: dict, now: float) -> tuple[float, str]:
    """Validate the bounded receiver export; never use its file modification time."""
    read = timestamp(record.get("read_time_utc"))
    received = timestamp(record.get("receive_time_utc"))
    if (type(record.get("schema_version")) is not int or record["schema_version"] != 1
            or record.get("site_id") != host["site_id"] or record.get("host_id") != host["host_id"]
            or not canonical_uuid(record.get("message_id")) or not canonical_uuid(record.get("boot_id"))
            or type(record.get("sequence")) is not int or not 1 <= record["sequence"] <= 2 ** 53 - 1
            or not finite_number(record.get("uptime_seconds")) or record["uptime_seconds"] < 0
            or not isinstance(record.get("read_time_utc"), str) or not record["read_time_utc"].endswith("Z")
            or not isinstance(record.get("receive_time_utc"), str) or not record["receive_time_utc"].endswith("Z")
            or read is None or received is None or read > now + 60 or received > now + 60 or read > received + 60):
        raise ValueError("INVALID_HOST_SNAPSHOT")
    digest = record.get("payload_sha256")
    metrics = record.get("metrics")
    if (not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest)
            or not isinstance(metrics, dict) or len(metrics) > 128
            or any(not isinstance(key, str) or not key or len(key) > 64
                   or any(not char.isascii() or not (char.isalnum() or char == "_") for char in key)
                   or not finite_number(value)
                   for key, value in metrics.items())):
        raise ValueError("INVALID_HOST_SNAPSHOT")
    # Actions are merged independently by the receiver. They may change without
    # advancing the resource sample, so exclude them from the resource watermark.
    core = {key: record.get(key) for key in ("message_id", "boot_id", "sequence", "read_time_utc", "uptime_seconds", "metrics", "conditions")}
    return read, hashlib.sha256(json.dumps(core, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def host_health_observations(cfg: dict, now: float, startup: float, state: State):
    observations, blocked, action_sources = [], set(), []
    for host in cfg.get("host_health_sources", []):
        prefix = "host:" + host["id"] + ":"
        label = host.get("label", host["id"])
        condition_keys = {prefix + kind for kind in HOST_CONDITIONS}
        all_keys = condition_keys | {prefix + "reporting"}
        try:
            receiver = bounded_json(host["receiver_health_path"], 8192)
            receiver_age = age(receiver.get("heartbeat_time_utc"), now)
            receiver_good = (type(receiver.get("schema_version")) is int and receiver["schema_version"] == 1
                             and receiver_age is not None and receiver_age <= host["receiver_freshness_seconds"]
                             and receiver.get("connected") is True and receiver.get("subscribed") is True
                             and receiver.get("last_error") is None)
        except (OSError, ValueError):
            receiver_good = False
        observations.append(Observation("receiver:" + host["id"] + ":mqtt", "good" if receiver_good else "bad",
                                        label + "健康接收端 MQTT 或心跳不可用", "critical", host["receiver_failure_seconds"]))
        record = None
        try:
            record = bounded_json(host["path"], 65536)
            read, fingerprint = host_snapshot(record, host, now)
            cursor = state.get("host_sample:" + host["id"])
            if (cursor is not None and (read < cursor["read_time"]
                    or read == cursor["read_time"] and (record["boot_id"] != cursor["boot_id"]
                        or record["sequence"] < cursor["sequence"]
                        or record["sequence"] == cursor["sequence"] and fingerprint != cursor["fingerprint"]))):
                raise ValueError("HOST_RESOURCE_REPLAY")
            if cursor is None or read > cursor["read_time"] or record["sequence"] > cursor["sequence"]:
                state.set("host_sample:" + host["id"], {"read_time": read, "boot_id": record["boot_id"], "sequence": record["sequence"], "fingerprint": fingerprint})
            action_sources.append((host, record))
        except (OSError, ValueError, TypeError, KeyError):
            read = None
        if not receiver_good:
            blocked.update(all_keys)
            observations.extend(Observation(key, "unknown", label + "接收链路不可用，暂停主机判断") for key in sorted(all_keys))
            continue
        cursor = state.get("host_sample:" + host["id"])
        last_read = read if read is not None else cursor.get("read_time") if cursor else startup
        sample_age = max(0, now - last_read)
        if read is None:
            # Invalid/future/replayed input cannot clear either a resource fault
            # or a reporting fault. Missing reports still age from the last good read.
            if record is not None:
                blocked.update(all_keys)
                observations.extend(Observation(key, "unknown", label + "主机快照无效或旧资源重放，暂停判断") for key in sorted(all_keys))
                continue
        reporting_bad = sample_age > host["freshness_seconds"]
        severity = "critical" if sample_age > host["critical_freshness_seconds"] else "warning"
        observations.append(Observation(prefix + "reporting", "bad" if reporting_bad else "good" if read is not None else "unknown",
                                        label + "没有新健康采样", severity))
        if read is None or reporting_bad:
            blocked.update(condition_keys)
            observations.extend(Observation(key, "unknown", label + "健康采样缺失或过期，暂停资源判断") for key in sorted(condition_keys))
            continue
        conditions = record.get("conditions")
        complete = isinstance(conditions, dict) and set(conditions) == set(HOST_CONDITIONS)
        for kind, title in HOST_CONDITIONS.items():
            value = conditions.get(kind) if complete else None
            key = prefix + kind
            valid = (isinstance(value, dict) and isinstance(value.get("state"), str) and value["state"] in ("good", "bad", "unknown")
                     and isinstance(value.get("severity"), str) and value["severity"] in ("warning", "critical")
                     and isinstance(value.get("detail_code"), str) and value["detail_code"] in HOST_DETAIL_CODES
                     and (value.get("incident_id") is None or canonical_uuid(value["incident_id"])))
            if not valid or value["state"] == "unknown":
                blocked.add(key)
                observations.append(Observation(key, "unknown", label + title + "状态缺失或无效，暂停判断"))
            else:
                observations.append(Observation(key, value["state"], label + title + "异常", value["severity"]))
    return observations, blocked, action_sources


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never disclose the webhook token to a redirected host.


def webhook_url(cfg: dict) -> str:
    content = Path(cfg["webhook_file"]).read_text(encoding="utf-8").strip()
    parsed = urllib.parse.urlsplit(content)
    if parsed.scheme != "https" or parsed.hostname not in cfg["allowed_hosts"] or parsed.port not in (None, 443) or parsed.username or parsed.password or parsed.fragment:
        raise ValueError("INVALID_WEBHOOK")
    if not parsed.path.startswith("/open-apis/bot/v2/hook/") or parsed.query:
        raise ValueError("INVALID_WEBHOOK_PATH")
    return content


def post_feishu_http(url: str, payload: dict, timeout: float) -> bool:
    request = urllib.request.Request(url, json.dumps(payload, ensure_ascii=False).encode("utf-8"), {"Content-Type": "application/json"}, method="POST")
    # Explicitly disable inherited HTTP proxy settings and require normal CA validation.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context()))
    with opener.open(request, timeout=timeout) as response:
        content = response.read(65537)
        if not 200 <= response.status < 300 or len(content) > 65536:
            return False
        decoded = json.loads(content)
        return isinstance(decoded, dict) and type(decoded.get("code")) is int and decoded["code"] == 0


def post_feishu(url: str, payload: dict, timeout: float) -> bool:
    # Socket timeouts do not bound DNS or a slowly streamed response. A short-lived
    # child provides a total deadline and cannot hold the observer loop indefinitely.
    # The secret URL is sent over stdin, never placed in argv, logs or stdout.
    content = json.dumps({"url": url, "payload": payload, "timeout": timeout}, ensure_ascii=False).encode("utf-8")
    try:
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), "--webhook-worker"], input=content,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        return result.returncode == 0 and result.stdout == b"confirmed\n"
    except (OSError, subprocess.TimeoutExpired):
        return False


class Supervisor:
    def __init__(self, cfg: dict, now: float | None = None):
        self.cfg = cfg
        directory = Path(cfg["state_directory"])
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = directory
        self.state = State(directory / "supervisor.sqlite")
        self.startup = time.time() if now is None else now
        self.notification_error = None
        self.host_notification_blocks = {"host:" + host["id"] + ":" + kind for host in cfg.get("host_health_sources", []) for kind in (*HOST_CONDITIONS, "reporting")}
        with self.state.db:
            self.sync_device_pauses(self.startup)
            # A new process must obtain a new bad observation before completing
            # an administrative-pause recheck; it cannot count unobserved downtime.
            self.state.db.execute("UPDATE fault SET alerts_recheck_bad_since_time_utc=NULL WHERE alerts_paused_time_utc IS NOT NULL")

    def sync_device_pauses(self, now: float):
        for row in self.state.db.execute("SELECT key FROM fault").fetchall():
            if device_alerts_paused(self.cfg, row["key"]):
                self.state.db.execute("""UPDATE fault SET alerts_paused_time_utc=COALESCE(alerts_paused_time_utc,?),
                  alerts_recheck_bad_since_time_utc=NULL,good_since_time_utc=NULL,last_good_time_utc=NULL WHERE key=?""", (now, row["key"]))
        for row in self.state.db.execute("SELECT id,fault_key FROM outbox").fetchall():
            if device_alerts_paused(self.cfg, row["fault_key"]):
                self.state.db.execute("UPDATE outbox SET suspended_time_utc=COALESCE(suspended_time_utc,?) WHERE id=?", (now, row["id"]))

    def device_notification_blocked(self, key: str) -> bool:
        host_ids = {host["id"] for host in self.cfg.get("host_health_sources", [])}
        if key.startswith(("host:", "host-action:", "receiver:")) and key.split(":", 2)[1] not in host_ids:
            return True  # Removing a source does not replay its old queued notices.
        if key == "host-actions:capacity" and not host_ids:
            return True
        if key in self.host_notification_blocks:
            return True
        if device_alerts_paused(self.cfg, key):
            return True
        fault = self.state.db.execute("SELECT alerts_paused_time_utc FROM fault WHERE key=?", (key,)).fetchone()
        return fault is not None and fault[0] is not None

    def record_host_actions(self, sources: list, now: float) -> list[Observation]:
        """Queue each original action phase once, separately from persistent faults."""
        self.state.db.execute("DELETE FROM host_action_receipt WHERE seen_time_utc<?", (now - 7 * 86400,))
        capacity = self.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0] >= 4096
        for host, record in sources:
            actions = record.get("actions", [])
            if not isinstance(actions, list) or len(actions) > 128:
                continue
            for action in actions:
                if not isinstance(action, dict):
                    continue
                action_time = timestamp(action.get("action_time_utc"))
                if (not all(canonical_uuid(action.get(key)) for key in ("event_id", "action_id", "incident_id"))
                        or not isinstance(action.get("result"), str) or action["result"] not in HOST_ACTION_RESULTS
                        or action.get("kind") != "restart_proxy" or action.get("target_id") != "proxy"
                        or not isinstance(action.get("action_time_utc"), str) or not action["action_time_utc"].endswith("Z")
                        or action_time is None or action_time > now + 60 or action_time < now - 21600):
                    continue
                event_id = action["event_id"].lower()
                if self.state.db.execute("SELECT 1 FROM host_action_receipt WHERE event_id=?", (event_id,)).fetchone():
                    continue
                if self.state.db.execute("SELECT count(*) FROM host_action_receipt").fetchone()[0] >= 4096:
                    capacity = True
                    continue  # Keep existing receipts: evicting them could re-send old phases.
                key = "host-action:" + host["id"] + ":" + event_id
                notification_id = str(uuid.uuid5(uuid.NAMESPACE_URL, "one-minihouse:" + key))
                detail = (host.get("label", host["id"]) + "代理重启：" + HOST_ACTION_RESULTS[action["result"]]
                          + "；原始时间 " + utc(action_time) + "；动作 " + action["action_id"] + "；来源事件 " + event_id)
                self.state.db.execute("INSERT INTO outbox(id,fault_key,kind,severity,detail,create_time_utc,next_attempt_time_utc,attempts,suspended_time_utc) VALUES (?,?, 'action','warning',?,?,?,0,NULL)",
                                      (notification_id, key, detail[:1000], now, now))
                self.state.db.execute("INSERT INTO host_action_receipt VALUES (?,?,?)", (event_id, host["id"], now))
        if not self.cfg.get("host_health_sources"):
            return []
        return [Observation("host-actions:capacity", "bad" if capacity else "good", "主机缓解事件去重记录达到容量，暂停接收新事件", "warning")]

    def enqueue(self, key: str, kind: str, severity: str, detail: str, now: float):
        fault = self.state.db.execute("SELECT * FROM fault WHERE key=?", (key,)).fetchone()
        carry = fault is not None and kind in FAILURE_KINDS
        event_id = fault["notification_event_id"] if carry else None
        attempts = (fault["notification_retry_attempts"] or 0) if carry else 0
        next_attempt = max(now, fault["notification_retry_after_time_utc"] or now) if carry else now
        self.state.db.execute("DELETE FROM outbox WHERE fault_key=?", (key,))
        self.state.db.execute("INSERT INTO outbox(id,fault_key,kind,severity,detail,create_time_utc,next_attempt_time_utc,attempts,suspended_time_utc) VALUES (?,?,?,?,?,?,?,?,?)",
                              (event_id or str(uuid.uuid4()), key, kind, severity, detail[:1000], now, next_attempt, attempts, now if device_alerts_paused(self.cfg, key) else None))
        self.state.db.execute("UPDATE fault SET last_enqueue_time_utc=? WHERE key=?", (now, key))

    def prune_notifications(self, now: float):
        cfg = self.cfg["notifications"]
        rows = self.state.db.execute("""SELECT * FROM outbox WHERE create_time_utc<? OR attempts>=?
          OR id IN (SELECT id FROM outbox ORDER BY create_time_utc DESC,id LIMIT -1 OFFSET ?)""",
                                    (now - cfg["max_age_seconds"], cfg["max_attempts"], int(cfg["max_pending"]))).fetchall()
        for row in rows:
            if row["kind"] in FAILURE_KINDS:
                interval = self.cfg.get("reminder_seconds_by_category", {}).get(reminder_category(row["fault_key"]), self.cfg["repeat_seconds"])
                exhausted = row["attempts"] >= cfg["max_attempts"]
                # An active, unacknowledged incident still owes its first notice.
                # Persist retry evidence outside bounded outbox, so eviction and
                # flapping cannot either lose it or reset attempts on every tick.
                self.state.db.execute("""UPDATE fault SET notification_retry_after_time_utc=?,notification_retry_attempts=?,notification_event_id=?
                  WHERE key=? AND active=1""",
                                      (max(row["next_attempt_time_utc"], now + interval if exhausted else now),
                                       0 if exhausted else row["attempts"], None if exhausted else row["id"], row["fault_key"]))
            self.state.db.execute("DELETE FROM outbox WHERE id=?", (row["id"],))

    def reconcile(self, observations: list[Observation], now: float):
        self.sync_device_pauses(now)
        observations = [entry for entry in observations if not device_alerts_paused(self.cfg, entry.key)]
        self.prune_notifications(now)
        observed_keys = {observation.key for observation in observations}
        # A stale parent snapshot omits dependent observations. Their absence is
        # unknown, never proof of a continuous good interval.
        for row in self.state.db.execute("SELECT key FROM fault WHERE (active=1 AND good_since_time_utc IS NOT NULL) OR alerts_recheck_bad_since_time_utc IS NOT NULL").fetchall():
            if row["key"] not in observed_keys:
                self.state.db.execute("UPDATE fault SET good_since_time_utc=NULL,last_good_time_utc=NULL,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (row["key"],))
        for observation in observations:
            row = self.state.db.execute("SELECT * FROM fault WHERE key=?", (observation.key,)).fetchone()
            if observation.state == "unknown":
                if row:
                    self.state.db.execute("UPDATE fault SET good_since_time_utc=NULL,last_good_time_utc=NULL,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (observation.key,))
                continue
            if observation.state == "good":
                if not row:
                    continue
                self.state.db.execute("UPDATE outbox SET suspended_time_utc=COALESCE(suspended_time_utc,?) WHERE fault_key=? AND kind IN ('failure','escalation','reminder')", (now, observation.key))
                if row["active"] or row["alerts_paused_time_utc"] is not None:
                    gap_limit = max(self.cfg["heartbeat_max_age_seconds"], self.cfg["check_interval_seconds"] * 2)
                    since, last = row["good_since_time_utc"], row["last_good_time_utc"]
                    if since is None or last is None or now < last or now - last > gap_limit:
                        since = now
                    self.state.db.execute("UPDATE fault SET good_since_time_utc=?,last_good_time_utc=?,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (since, now, observation.key))
                    if now - since < self.cfg["recovery_seconds"]:
                        continue
                self.state.db.execute("DELETE FROM outbox WHERE fault_key=? AND kind IN ('failure','escalation','reminder')", (observation.key,))
                if row["alerts_paused_time_utc"] is not None:
                    # Do not catch up a recovery that predates administrative pause.
                    self.state.db.execute("DELETE FROM outbox WHERE fault_key=? AND kind='recovery'", (observation.key,))
                if row["active"] and row["notified"]:
                    self.enqueue(observation.key, "recovery", row["notified_highest_severity"] or row["severity"], "已持续恢复；原故障：" + row["detail"], now)
                self.state.db.execute("UPDATE fault SET active=0,first_bad_time_utc=NULL,notified=0,notified_highest_severity=NULL,good_since_time_utc=NULL,last_good_time_utc=NULL,notification_retry_after_time_utc=NULL,notification_retry_attempts=NULL,notification_event_id=NULL,alerts_paused_time_utc=NULL,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (observation.key,))
                continue
            if not row:
                self.state.db.execute("INSERT INTO fault(key,first_bad_time_utc,severity,detail) VALUES (?,?,?,?)", (observation.key, now, observation.severity, observation.detail))
                row = self.state.db.execute("SELECT * FROM fault WHERE key=?", (observation.key,)).fetchone()
            elif row["first_bad_time_utc"] is None:
                self.state.db.execute("DELETE FROM outbox WHERE fault_key=?", (observation.key,))
                self.state.db.execute("UPDATE fault SET first_bad_time_utc=?,severity=?,detail=?,last_sent_time_utc=NULL,last_enqueue_time_utc=NULL,notified=0,notified_highest_severity=NULL,notification_retry_after_time_utc=NULL,notification_retry_attempts=NULL,notification_event_id=NULL,alerts_paused_time_utc=NULL,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (now, observation.severity, observation.detail, observation.key))
                row = self.state.db.execute("SELECT * FROM fault WHERE key=?", (observation.key,)).fetchone()
            self.state.db.execute("UPDATE fault SET detail=?,good_since_time_utc=NULL,last_good_time_utc=NULL WHERE key=?", (observation.detail[:1000], observation.key))
            confirmation_start = row["first_bad_time_utc"]
            if row["alerts_paused_time_utc"] is not None:
                confirmation_start = row["alerts_recheck_bad_since_time_utc"]
                if confirmation_start is None:
                    confirmation_start = now
                    self.state.db.execute("UPDATE fault SET alerts_recheck_bad_since_time_utc=? WHERE key=?", (now, observation.key))
            if now - confirmation_start < observation.duration:
                continue
            if row["alerts_paused_time_utc"] is not None:
                self.state.db.execute("UPDATE fault SET alerts_paused_time_utc=NULL,alerts_recheck_bad_since_time_utc=NULL WHERE key=?", (observation.key,))
                self.state.db.execute("DELETE FROM outbox WHERE fault_key=? AND kind='recovery'", (observation.key,))
            pending = self.state.db.execute("SELECT * FROM outbox WHERE fault_key=? AND kind IN ('failure','escalation','reminder')", (observation.key,)).fetchone()
            highest = row["notified_highest_severity"]
            upgrade_due = highest is not None and severity_rank(observation.severity) > severity_rank(highest)
            repeat_from = row["last_sent_time_utc"] or row["last_enqueue_time_utc"] or 0
            repeat_interval = self.cfg.get("reminder_seconds_by_category", {}).get(reminder_category(observation.key), self.cfg["repeat_seconds"])
            repeat_due = now - repeat_from >= repeat_interval
            retry_ready = row["notification_retry_after_time_utc"] is None or now >= row["notification_retry_after_time_utc"]
            if not row["active"]:
                self.enqueue(observation.key, "failure", observation.severity, observation.detail, now)
            elif pending:
                if pending["kind"] == "escalation" and not upgrade_due:
                    # Suspend an unsent upgrade at the delivered level, keeping
                    # its retry evidence in case critical returns. Never downgrade.
                    self.state.db.execute("UPDATE outbox SET suspended_time_utc=COALESCE(suspended_time_utc,?) WHERE id=?", (now, pending["id"]))
                else:
                    kind = "escalation" if upgrade_due else pending["kind"]
                    # Keep the ID/backoff/attempt count when updating an unsent
                    # notification; severity oscillation must not reset retries.
                    self.state.db.execute("UPDATE outbox SET kind=?,severity=?,detail=?,suspended_time_utc=NULL WHERE id=?", (kind, observation.severity, observation.detail[:1000], pending["id"]))
            elif upgrade_due and retry_ready:
                self.enqueue(observation.key, "escalation", observation.severity, observation.detail, now)
            elif highest is None and retry_ready:
                self.enqueue(observation.key, "failure", observation.severity, observation.detail, now)
            elif repeat_due and retry_ready:
                self.enqueue(observation.key, "reminder" if highest is not None else "failure", observation.severity, observation.detail, now)
            self.state.db.execute("UPDATE fault SET active=1,severity=? WHERE key=?", (observation.severity, observation.key))
        self.prune_notifications(now)
        self.state.db.execute("DELETE FROM fault WHERE active=0 AND first_bad_time_utc IS NULL AND NOT EXISTS (SELECT 1 FROM outbox WHERE fault_key=fault.key)")

    def deliver(self, now: float, sender=post_feishu, only_key: str | None = None):
        cfg = self.cfg["notifications"]
        if not cfg["enabled"]:
            return "disabled"
        if only_key is None:
            candidates = self.state.db.execute("SELECT * FROM outbox WHERE next_attempt_time_utc<=? AND suspended_time_utc IS NULL AND kind NOT LIKE 'test%' ORDER BY create_time_utc,id", (now,)).fetchall()
        else:
            candidates = self.state.db.execute("SELECT * FROM outbox WHERE next_attempt_time_utc<=? AND suspended_time_utc IS NULL AND fault_key=? ORDER BY create_time_utc,id", (now, only_key)).fetchall()
        rows = [row for row in candidates if not self.device_notification_blocked(row["fault_key"])][:20]
        if not rows:
            return "idle"
        last_attempt = self.state.get("last_request_time_utc", 0)
        if now < last_attempt - 60:
            self.notification_error = "CLOCK_ROLLBACK"
            return "clock_invalid"
        hour = self.state.db.execute("SELECT count(*) FROM request_budget WHERE attempt_time_utc>=?", (now - 3600,)).fetchone()[0]
        day = self.state.db.execute("SELECT count(*) FROM request_budget WHERE attempt_time_utc>=?", (now - 86400,)).fetchone()[0]
        if hour >= cfg["requests_per_hour"] or day >= cfg["requests_per_day"]:
            self.notification_error = "NOTIFICATION_BUDGET_EXHAUSTED"
            return "budget_exhausted"
        try:
            url = webhook_url(cfg)
        except (OSError, ValueError):
            self.notification_error = "WEBHOOK_CONFIG_INVALID"
            return "config_invalid"
        lines = ["家庭采集链路 · " + self.cfg.get("supervisor_id", "supervisor"), utc(now)]
        selected = []
        for row in rows:
            label = "测试" if row["kind"].startswith("test") else "缓解记录" if row["kind"] == "action" else "恢复" if row["kind"] == "recovery" else "严重升级" if row["kind"] == "escalation" else "持续提醒" if row["kind"] == "reminder" else "首次告警"
            if row["kind"] in FAILURE_KINDS:
                label += "·严重" if row["severity"] == "critical" else "·注意"
            line = f"[{label}] {row['detail']}\n事件 {row['id']}"
            if len("\n".join(lines + [line]).encode("utf-8")) > 16000:
                break
            lines.append(line)
            selected.append(row)
        rows = selected
        payload = {"msg_type": "text", "content": {"text": "\n".join(lines)}}
        # Persist every attempt before network I/O, including uncertain HTTP outcomes.
        with self.state.db:
            self.state.db.execute("INSERT INTO request_budget VALUES (?)", (now,))
            self.state.db.execute("DELETE FROM request_budget WHERE attempt_time_utc<?", (now - 172800,))
            self.state.set("last_request_time_utc", now)
            for row in rows:
                attempts = row["attempts"] + 1
                delay = min(3600, 60 * 2 ** min(attempts - 1, 6))
                self.state.db.execute("UPDATE outbox SET attempts=?,next_attempt_time_utc=? WHERE id=?", (attempts, now + delay, row["id"]))
        try:
            success = sender(url, payload, cfg["timeout_seconds"])
        except Exception:
            success = False  # Never log the exception, URL or arbitrary HTTP response body.
        if not success:
            self.notification_error = "WEBHOOK_DELIVERY_FAILED"
            return "failed"
        with self.state.db:
            for row in rows:
                self.state.db.execute("DELETE FROM outbox WHERE id=?", (row["id"],))
                if row["kind"] in FAILURE_KINDS:
                    fault = self.state.db.execute("SELECT notified_highest_severity FROM fault WHERE key=? AND active=1", (row["fault_key"],)).fetchone()
                    if fault:
                        highest = row["severity"] if severity_rank(row["severity"]) > severity_rank(fault["notified_highest_severity"]) else fault["notified_highest_severity"]
                        self.state.db.execute("UPDATE fault SET notified=1,last_sent_time_utc=?,notified_highest_severity=?,notification_retry_after_time_utc=NULL,notification_retry_attempts=NULL,notification_event_id=NULL WHERE key=? AND active=1", (now, highest, row["fault_key"]))
            self.state.set("last_notification_success_time_utc", utc(now))
        self.notification_error = None
        return "sent"

    def notification_test(self, cycle: bool = False, sender=post_feishu, now: float | None = None) -> dict:
        now = time.time() if now is None else now
        key = "supervisor:notification-test"
        with self.state.db:
            self.enqueue(key, "test_failure" if cycle else "test", "warning", "监督通道验收测试：模拟故障（非生产故障）" if cycle else "监督通道测试（非生产故障）", now)
        first = self.deliver(now, sender, only_key=key)
        report = {"test": "fault_and_recovery" if cycle else "notification", "failure_or_channel_result": first, "recovery_result": None,
                  "notification_error": self.notification_error, "production_health_modified": False, "uses_persistent_request_budget": True}
        if cycle and first == "sent":
            with self.state.db:
                self.enqueue(key, "test_recovery", "warning", "监督通道验收测试：模拟故障已恢复（非生产恢复）", now)
            report["recovery_result"] = self.deliver(now, sender, only_key=key)
            report["notification_error"] = self.notification_error
        return report

    def tick(self, now: float | None = None, sender=post_feishu) -> dict:
        now = time.time() if now is None else now
        previous = self.state.get("last_clock_time_utc", now)
        try:
            health = bounded_json(self.cfg["ingestor_health_file"])
        except (OSError, ValueError):
            health = None
        clock_rollback = now < previous - 60
        action_sources = []
        if clock_rollback:
            observations = [Observation("supervisor:clock", "bad", "监督程序时钟倒退，暂停故障恢复判断", "critical")]
        else:
            observations = evaluate(self.cfg, health, now, self.startup, self.state)
            observations.append(Observation("supervisor:clock", "good", "监督程序时钟恢复"))
            observations.extend(resource_observations(self.cfg, now, self.state, health))
            host_observations, self.host_notification_blocks, action_sources = host_health_observations(self.cfg, now, self.startup, self.state)
            observations.extend(host_observations)
            for collector in self.cfg["collector_health_files"]:
                try:
                    record = bounded_json(collector["path"])
                    heartbeat_age = age(record.get("heartbeat_time_utc", record.get("utc")), now)
                    good = heartbeat_age is not None and heartbeat_age <= collector.get("max_age_seconds", 180)
                    observations.append(Observation("collector:" + collector["id"], "good" if good else "bad", collector.get("label", collector["id"]) + "采集器心跳异常", "warning", 60))
                except (OSError, ValueError):
                    observations.append(Observation("collector:" + collector["id"], "bad", collector.get("label", collector["id"]) + "采集器健康文件不可读", "warning", 60))
        with self.state.db:
            if not clock_rollback:
                observations.extend(self.record_host_actions(action_sources, now))
            self.reconcile(observations, now)
            self.state.set("last_clock_time_utc", max(now, previous))
        if clock_rollback:
            self.notification_error = "CLOCK_ROLLBACK"
            result = "clock_invalid"
        else:
            if self.notification_error == "CLOCK_ROLLBACK":
                self.notification_error = None
            result = self.deliver(now, sender)
        faults = [dict(row) for row in self.state.db.execute("SELECT key,severity,detail,first_bad_time_utc,good_since_time_utc,last_good_time_utc,notified_highest_severity FROM fault WHERE active=1 ORDER BY key") if not self.device_notification_blocked(row["key"])]
        pending = sum(1 for row in self.state.db.execute("SELECT fault_key FROM outbox WHERE kind NOT LIKE 'test%' AND suspended_time_utc IS NULL") if not self.device_notification_blocked(row["fault_key"]))
        suspended = self.state.db.execute("SELECT count(*) FROM outbox WHERE kind NOT LIKE 'test%' AND suspended_time_utc IS NOT NULL").fetchone()[0]
        test_pending = self.state.db.execute("SELECT count(*) FROM outbox WHERE kind LIKE 'test%'").fetchone()[0]
        unknown = [{"key": entry.key, "detail": entry.detail} for entry in observations if entry.state == "unknown"]
        fresh = health is not None and age(health.get("heartbeat_time_utc"), now) is not None and age(health.get("heartbeat_time_utc"), now) <= self.cfg["heartbeat_max_age_seconds"]
        notification_blocked = self.cfg["notifications"]["enabled"] and pending > 0
        status = {"heartbeat_time_utc": utc(now), "quality": "degraded" if faults or self.notification_error or unknown or notification_blocked else "ok", "active_faults": faults, "unknown_checks": unknown,
                  "notification_pending": pending, "notification_suspended": suspended, "paused_device_alerts": [{"site_id": entry.get("site_id"), "gateway_id": entry["gateway_id"], "device_id": entry["device_id"]} for entry in self.cfg["devices"] if entry.get("alerts_enabled", True) is False],
                  "test_notification_pending": test_pending, "notification_result": result, "notification_error": self.notification_error,
                  "host_health_blocked_checks": sorted(self.host_notification_blocks),
                  "last_notification_success_time_utc": self.state.get("last_notification_success_time_utc"), "observed_health_fresh": fresh}
        atomic_json(self.directory / "status.json", status)
        atomic_json(self.directory / "health.json", {"heartbeat_time_utc": utc(now), "check_interval_seconds": self.cfg["check_interval_seconds"], "quality": status["quality"], "notification_error": self.notification_error,
                                                  "mqtt_connected": bool(fresh and health.get("mqtt_connected") is True), "mqtt_connection_source": "supervised_ingestor"})
        return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config")
    parser.add_argument("--healthcheck")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--test-notification", action="store_true")
    parser.add_argument("--test-alert-cycle", action="store_true")
    parser.add_argument("--webhook-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.webhook_worker:
        try:
            content = sys.stdin.buffer.read(65537)
            if len(content) > 65536:
                return 1
            request = json.loads(content)
            confirmed = post_feishu_http(request["url"], request["payload"], request["timeout"])
            if confirmed:
                print("confirmed")
            return 0 if confirmed else 1
        except Exception:
            return 1
    if args.healthcheck:
        try:
            health = bounded_json(args.healthcheck)
            heartbeat_age = age(health.get("heartbeat_time_utc"), time.time())
            return 0 if heartbeat_age is not None and heartbeat_age <= max(180, health.get("check_interval_seconds", 60) * 3) else 1
        except (OSError, ValueError, TypeError):
            return 1
    if not args.config:
        parser.error("--config is required")
    cfg = load_config(args.config)
    supervisor = Supervisor(cfg)
    if args.test_notification or args.test_alert_cycle:
        try:
            result = supervisor.notification_test(cycle=args.test_alert_cycle)
            print(json.dumps(result, ensure_ascii=False))
            return 0 if result["failure_or_channel_result"] == "sent" and (not args.test_alert_cycle or result["recovery_result"] == "sent") else 2
        finally:
            supervisor.state.close()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not stopping:
            start = time.monotonic()
            status = supervisor.tick()
            print(json.dumps({"event": "supervisor_check", "event_time_utc": status["heartbeat_time_utc"], "quality": status["quality"], "fault_count": len(status["active_faults"]), "notification_result": status["notification_result"]}), flush=True)
            if args.once:
                break
            while not stopping and time.monotonic() - start < cfg["check_interval_seconds"]:
                time.sleep(max(0, min(1, cfg["check_interval_seconds"] - (time.monotonic() - start))))
    finally:
        supervisor.state.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
