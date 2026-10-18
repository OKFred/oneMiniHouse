#!/usr/bin/env python3
"""Check that a collector/cache heartbeat advances, regardless of MQTT quality."""
import argparse
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path


def heartbeat_fresh(path, max_age_seconds, timestamp_key="heartbeat_time_utc", now=None):
    try:
        with Path(path).open("rb") as stream:
            content = stream.read(65537)
        if len(content) > 65536:
            return False
        value = json.loads(content)
        stamp = value[timestamp_key]
        if not isinstance(stamp, str):
            return False
        observed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        if observed.utcoffset() != timedelta(0):
            return False
        age = ((now or datetime.now(timezone.utc)) - observed).total_seconds()
        return -30 <= age <= max_age_seconds
    except (OSError, ValueError, KeyError, TypeError, OverflowError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", required=True)
    parser.add_argument("--timestamp-key", choices=("heartbeat_time_utc", "read_time_utc"), default="heartbeat_time_utc")
    parser.add_argument("--max-age-seconds", type=int, default=180)
    args = parser.parse_args()
    if not 1 <= args.max_age_seconds <= 604800:
        parser.error("max-age-seconds must be between 1 and 604800")
    return 0 if heartbeat_fresh(args.file, args.max_age_seconds, args.timestamp_key) else 1


if __name__ == "__main__":
    raise SystemExit(main())
