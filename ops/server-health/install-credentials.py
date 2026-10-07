#!/usr/bin/env python3
"""Install a user-created SLS credential file on the configured host, without printing it.

Stop the health timer during this one-time installation; restart it afterwards.
The budget database is checked but never recreated or reset here.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3


def validate(bundle):
    # Synthetic expected metadata. Configure a private copy for the deployment.
    expected = {"user_name": "example-health-writer", "server_id": "example-host",
                "project": "example-minihouse", "logstore": "server-health",
                "endpoint": "cn-hangzhou.log.aliyuncs.com"}
    if any(bundle.get(k) != v for k, v in expected.items()):
        raise ValueError("Credential metadata does not match this deployment")
    for key in ("access_key_id", "access_key_secret"):
        if not isinstance(bundle.get(key), str) or not re.fullmatch(r"[A-Za-z0-9+/=_-]{16,128}", bundle[key]):
            raise ValueError("Invalid credential format")


def install(source):
    os.umask(0o077)
    bundle = json.loads(Path(source).read_text())
    validate(bundle)
    directory = Path("/etc/one-minihouse-server-health")
    config_path = directory / "config.json"
    config = json.loads(config_path.read_text())
    if config["server_id"] != bundle["server_id"] or any(config["sls"].get(k) != bundle[k] for k in ("project", "logstore", "endpoint")):
        raise ValueError("Installed config differs from the approved destination")
    for key in ("access_key_id", "access_key_secret"):
        if Path(config["sls"][key + "_file"]) != directory / "secrets" / key:
            raise ValueError("Unexpected secret destination")
    db = sqlite3.connect((Path(config["data_dir"]) / "health.sqlite").as_uri() + "?mode=rw", uri=True)
    if db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone() != ("1",):
        raise ValueError("Budget ledger is not initialized")
    db.close()
    secret_dir = directory / "secrets"
    secret_dir.mkdir(mode=0o700, exist_ok=True)
    secret_dir.chmod(0o700)
    # Preflight both files before writing either; refuse an implicit key rotation.
    for key in ("access_key_id", "access_key_secret"):
        path = secret_dir / key
        if path.exists() and path.read_text().strip() != bundle[key]:
            raise ValueError("Existing secret differs; explicit rotation required")
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = directory / ("config.before-sls-" + stamp + ".json")
    if not backup.exists():
        shutil.copy2(config_path, backup)
        backup.chmod(0o600)
    for key in ("access_key_id", "access_key_secret"):
        temporary = secret_dir / (key + ".tmp")
        with temporary.open("w") as stream:
            stream.write(bundle[key] + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(0o600)
        temporary.replace(secret_dir / key)
    config["sls"]["enabled"] = True
    temporary = directory / "config.json.tmp"
    with temporary.open("w") as stream:
        json.dump(config, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    temporary.chmod(0o600)
    temporary.replace(config_path)
    print(json.dumps({"installed": True, "sls_enabled": True, "budget_preserved": True,
                      "project": bundle["project"], "logstore": bundle["logstore"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("credential_file")
    args = parser.parse_args()
    try:
        install(args.credential_file)
    except Exception as error:
        print("Install stopped: " + (str(error) if isinstance(error, ValueError) else type(error).__name__))
        raise SystemExit(1)
