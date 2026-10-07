#!/bin/sh
# Installs source only. Does not create credentials or enable the service.
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ -f /etc/openwrt_release ] || { echo 'OpenWrt required' >&2; exit 1; }
command -v mosquitto_pub >/dev/null || { echo 'Install mosquitto-client-ssl first' >&2; exit 1; }
[ -s /etc/ssl/certs/ca-certificates.crt ] || { echo 'CA bundle required' >&2; exit 1; }
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh -n "$src/r4s-temperature.sh"
sh -n "$src/one-minihouse-temperature.init"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /usr/local/libexec /etc/one-minihouse-temperature
chmod 700 /etc/one-minihouse-temperature
for pair in 'r4s-temperature.sh:/usr/local/libexec/one-minihouse-temperature-mqtt' 'one-minihouse-temperature.init:/etc/init.d/one-minihouse-temperature'; do
  source=${pair%%:*}
  target=${pair#*:}
  [ ! -f "$target" ] || cp -p "$target" "$target.bak-$stamp"
  cp "$src/$source" "$target"
  chown root:root "$target"
  chmod 755 "$target"
done
echo 'Source installed; credentials and service activation remain separate.'
