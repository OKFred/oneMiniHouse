#!/bin/sh
# Source installation only. Existing secrets, action ledger and service state stay.
set -eu
umask 077
[ "$(id -u)" = 0 ] || { echo 'Root required' >&2; exit 1; }
[ -f /etc/openwrt_release ] || { echo 'OpenWrt required' >&2; exit 1; }
/usr/bin/python3 -c 'import sys; assert sys.version_info >= (3,10)' || exit 1
[ -s /etc/ssl/certs/ca-certificates.crt ] || { echo 'System CA bundle required' >&2; exit 1; }
if [ -x /etc/init.d/one-minihouse-host-health ] && /etc/init.d/one-minihouse-host-health status >/dev/null 2>&1; then
    echo 'Stop only the host-health service before updating its source' >&2
    exit 1
fi
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
sh -n "$src/one-minihouse-host-health.init"
mkdir -p /opt/one-minihouse-host-health /etc/one-minihouse-host-health
chmod 700 /etc/one-minihouse-host-health
for file in agent.py health_core.py requirements.txt; do
    cp "$src/$file" "/opt/one-minihouse-host-health/$file.new"
    chown root:root "/opt/one-minihouse-host-health/$file.new"
    chmod 644 "/opt/one-minihouse-host-health/$file.new"
    mv "/opt/one-minihouse-host-health/$file.new" "/opt/one-minihouse-host-health/$file"
done
cp "$src/one-minihouse-host-health.init" /etc/init.d/one-minihouse-host-health
chown root:root /etc/init.d/one-minihouse-host-health
chmod 755 /etc/init.d/one-minihouse-host-health
echo 'Source installed. No credentials, ledger initialization, enable or start performed.'
