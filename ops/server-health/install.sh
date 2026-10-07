#!/bin/sh
set -eu
cd "$(dirname "$0")"
test "$(id -u)" = 0
python3 --version
docker --version
systemctl --version >/dev/null
stamp=$(date -u +%Y%m%dT%H%M%SZ)
install -d -m 700 /etc/one-minihouse-server-health /var/lib/one-minihouse-server-health
install -d -m 755 /opt/one-minihouse-server-health
if test -f /opt/one-minihouse-server-health/health_agent.py; then
    install -d -m 700 /var/backups/one-minihouse-server-health/"$stamp"
    cp -a /opt/one-minihouse-server-health/health_agent.py /etc/one-minihouse-server-health/config.json /var/backups/one-minihouse-server-health/"$stamp"/
fi
install -m 644 health_agent.py /opt/one-minihouse-server-health/health_agent.py
if ! test -f /etc/one-minihouse-server-health/config.json; then
    install -m 600 config.example.json /etc/one-minihouse-server-health/config.json
fi
if ! test -f /var/lib/one-minihouse-server-health/health.sqlite; then
    # A previously installed marker means a missing ledger is a fault, not a reset.
    if test -e /etc/one-minihouse-server-health/initialized; then
        echo 'Missing budget ledger: restore it before enabling uploads.' >&2
        exit 1
    fi
    python3 /opt/one-minihouse-server-health/health_agent.py --config /etc/one-minihouse-server-health/config.json --initialize
    touch /etc/one-minihouse-server-health/initialized
fi
install -m 644 one-minihouse-server-health.service one-minihouse-server-health.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now one-minihouse-server-health.timer
systemctl start one-minihouse-server-health.service
systemctl list-timers one-minihouse-server-health.timer --no-pager
