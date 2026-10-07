#!/bin/sh
# Installs only the separate SMART helper. Never changes MQTT config/credentials,
# installs packages, enables SMART, starts tests, or enables/starts a service.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 77; }
[ "$#" = 1 ] || { echo 'Usage: install-smart.sh ROOT_OWNED_PRIVATE_CONFIG_JSON' >&2; exit 64; }
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=$1
target=/opt/one-minihouse-smart-temperature
conf=/etc/one-minihouse-smart-temperature
service=/etc/systemd/system/one-minihouse-smart-temperature.service
timer=/etc/systemd/system/one-minihouse-smart-temperature.timer
dropins=/etc/systemd/system/one-minihouse-smart-temperature.service.d
# Private staging and configuration are validated before any installed file changes.
stage=$(mktemp -d /run/one-minihouse-smart-install.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
/usr/bin/python3 -I -B "$src/smart_reader.py" --config "$config" --check
install -m 600 "$config" "$stage/config.json"
install -m 644 "$src/smart_reader.py" "$src/one-minihouse-smart-temperature.service" "$src/one-minihouse-smart-temperature.timer" "$stage/"
/usr/bin/python3 -I -B - "$stage" <<'PY'
import importlib.util
import pathlib
import sys

stage = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("smart_reader", stage / "smart_reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
config = reader.load_config(stage / "config.json")
reader.resolved_devices(config)
# systemd resolves these at activation, so sdX renumbering after reboot does not
# leave an old device number allowed. Every read still rechecks the identity.
lines = ["[Service]", "DeviceAllow=", *["DeviceAllow=" + device["path"] + " r" for device in config["devices"]]]
(stage / "20-devices.conf").write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
systemd-analyze verify "$stage/one-minihouse-smart-temperature.service" "$stage/one-minihouse-smart-temperature.timer"
# Refuse symlink targets and non-root/writable parent directories before backup.
/usr/bin/python3 -I -B - "$target" "$conf" "$service" "$timer" "$dropins" <<'PY'
import os
import pathlib
import stat
import sys

for name in sys.argv[1:]:
    path = pathlib.Path(name)
    for item in [path, *path.parents]:
        if not os.path.lexists(item):
            continue
        info = item.lstat()
        if stat.S_ISLNK(info.st_mode) or info.st_uid != 0 or info.st_gid != 0 or info.st_mode & 0o022:
            raise SystemExit("Unsafe installation target")
    if path.is_dir():
        for item in path.rglob("*"):
            if item.is_symlink():
                raise SystemExit("Symlink in installation target")
PY
install -d -m 700 /root/one-minihouse-smart-temperature-backup
backup=$(mktemp -d "/root/one-minihouse-smart-temperature-backup/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
for item in "$target" "$conf" "$service" "$timer" "$dropins"; do
  [ ! -e "$item" ] || cp -a --parents "$item" "$backup/"
done
install -d -m 755 "$target" "$dropins"
install -d -m 700 "$conf"
install -m 644 "$stage/smart_reader.py" "$target/smart_reader.py"
install -m 600 "$stage/config.json" "$conf/config.json"
install -m 644 "$stage/one-minihouse-smart-temperature.service" "$service"
install -m 644 "$stage/one-minihouse-smart-temperature.timer" "$timer"
install -m 644 "$stage/20-devices.conf" "$dropins/20-devices.conf"
systemd-analyze verify "$service" "$timer"
systemctl daemon-reload
echo "SMART helper installed with prior files backed up in $backup"
echo 'No service or timer was started or enabled.'
echo 'After reviewing the whitelist and hardware checks: systemctl enable --now one-minihouse-smart-temperature.timer'
echo 'DeviceAllow=r restricts device opens, not ioctl commands; keep helper/config root-owned.'
