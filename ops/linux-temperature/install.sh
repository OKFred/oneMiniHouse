#!/bin/sh
# Install local MQTT collection, never SSH credentials or a remote shell.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 77; }
[ "$#" = 2 ] || { echo 'Usage: install.sh CONFIG_JSON MQTT_PASSWORD_FILE' >&2; exit 64; }
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
python3 "$src/agent.py" --config "$1" --check
python3 -c 'from paho.mqtt.client import CallbackAPIVersion; assert CallbackAPIVersion.VERSION2'
[ -s "$2" ] || { echo 'Nonempty MQTT password file required' >&2; exit 65; }
target=/opt/one-minihouse-temperature
conf=/etc/one-minihouse-temperature
unit=/etc/systemd/system/one-minihouse-temperature.service
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/root/one-minihouse-temperature-backup/$stamp
if [ -e "$target" ] || [ -e "$conf" ] || [ -e "$unit" ]; then
  install -d -m 700 "$backup"
  for item in "$target" "$conf" "$unit"; do
    [ ! -e "$item" ] || cp -a --parents "$item" "$backup/"
  done
fi
install -d -m 755 "$target"
install -d -m 700 "$conf"
install -m 644 "$src/agent.py" "$src/read-temperatures.sh" "$target/"
install -m 600 "$1" "$conf/config.json"
install -m 600 "$2" "$conf/mqtt_password"
install -m 644 "$src/one-minihouse-temperature.service" "$unit"
systemd-analyze verify "$unit"
systemctl daemon-reload
echo 'Installed. Enable only after scoped MQTT authorization and ingestion subscription are ready.'
echo 'systemctl enable --now one-minihouse-temperature.service'
