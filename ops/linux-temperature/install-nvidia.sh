#!/bin/sh
# Install the separate NVIDIA cache reader only; no packages, driver settings,
# MQTT credential changes, GPU resets, persistence changes, or automatic starts.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 77; }
[ "$#" = 1 ] || { echo 'Usage: install-nvidia.sh ROOT_OWNED_PRIVATE_CONFIG_JSON' >&2; exit 64; }
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
config=$1
target=/opt/one-minihouse-nvidia-temperature
conf=/etc/one-minihouse-nvidia-temperature
service=/etc/systemd/system/one-minihouse-nvidia-temperature.service
timer=/etc/systemd/system/one-minihouse-nvidia-temperature.timer
dropins=/etc/systemd/system/one-minihouse-nvidia-temperature.service.d
stage=$(mktemp -d /run/one-minihouse-nvidia-install.XXXXXX)
trap 'rm -rf -- "$stage"' EXIT HUP INT TERM
/usr/bin/python3 -I -B "$src/nvidia_reader.py" --config "$config" --check
install -m 600 "$config" "$stage/config.json"
install -m 644 "$src/nvidia_reader.py" "$src/one-minihouse-nvidia-temperature.service" "$src/one-minihouse-nvidia-temperature.timer" "$stage/"
/usr/bin/python3 -I -B - "$stage" <<'PY'
import importlib.util
import pathlib
import sys

stage = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("nvidia_reader", stage / "nvidia_reader.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)
config = reader.load_config(stage / "config.json")
for device in config["devices"]:
    reader.check_device(device)
lines = ["[Service]", "DeviceAllow=", "DeviceAllow=/dev/nvidiactl rw",
         *["DeviceAllow=" + device["device_node"] + " rw" for device in config["devices"]]]
(stage / "20-devices.conf").write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
systemd-analyze verify "$stage/one-minihouse-nvidia-temperature.service" "$stage/one-minihouse-nvidia-temperature.timer"
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
install -d -m 700 /root/one-minihouse-nvidia-temperature-backup
backup=$(mktemp -d "/root/one-minihouse-nvidia-temperature-backup/$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
for item in "$target" "$conf" "$service" "$timer" "$dropins"; do
  [ ! -e "$item" ] || cp -a --parents "$item" "$backup/"
done
install -d -m 755 "$target" "$dropins"
install -d -m 700 "$conf"
install -m 644 "$stage/nvidia_reader.py" "$target/nvidia_reader.py"
install -m 600 "$stage/config.json" "$conf/config.json"
install -m 644 "$stage/one-minihouse-nvidia-temperature.service" "$service"
install -m 644 "$stage/one-minihouse-nvidia-temperature.timer" "$timer"
install -m 644 "$stage/20-devices.conf" "$dropins/20-devices.conf"
systemd-analyze verify "$service" "$timer"
systemctl daemon-reload
echo "NVIDIA helper installed; prior files backed up in $backup"
echo 'No service or timer was started or enabled; no driver setting was changed.'
echo 'Validate an actual sandbox read before enabling one-minihouse-nvidia-temperature.timer.'
