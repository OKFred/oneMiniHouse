#!/bin/sh
# Run only in the disposable, network-disabled OpenWrt acceptance container.
set -eu
[ -d /packages ] || exit 1
original="$(sha256sum /usr/libexec/stat-genconfig /etc/config/luci_statistics)"
opkg install /packages/luci-app-collectd-mqtt_0.1.0-1_all.ipk
target=/etc/collectd/conf.d/90-mqtt-ui.conf
[ -n "$(find /etc/config/collectd_mqtt_ui -perm 600)" ]
[ -n "$(find "$target" -perm 600)" ]
/sbin/reload_config
uci batch <<'EOF'
set collectd_mqtt_ui.main.host='fixture.example.invalid'
set collectd_mqtt_ui.main.port='8883'
set collectd_mqtt_ui.main.client_id='fixture'
set collectd_mqtt_ui.main.username='fixture'
set collectd_mqtt_ui.main.password='fixture-not-real'
set collectd_mqtt_ui.main.prefix='fixture/collectd'
set collectd_mqtt_ui.main.enabled='1'
commit collectd_mqtt_ui
EOF
/sbin/reload_config
for n in 1 2 3 4 5; do
	grep -q 'LoadPlugin mqtt' "$target" && break
	sleep 1
done
grep -q 'LoadPlugin mqtt' "$target"
echo 'PASS actual procd/UCI save-and-apply trigger'
before="$(sha256sum "$target")"
uci set collectd_mqtt_ui.main.qos=9
uci commit collectd_mqtt_ui
if /etc/init.d/collectd-mqtt-ui reload; then echo 'Unexpected success for invalid QoS' >&2; exit 1; fi
[ "$(sha256sum "$target")" = "$before" ]
echo 'PASS invalid settings preserve last valid config'
uci set collectd_mqtt_ui.main.enabled=0
uci commit collectd_mqtt_ui
/etc/init.d/collectd-mqtt-ui reload
! grep -q 'LoadPlugin mqtt' "$target"
opkg remove luci-app-collectd-mqtt
[ ! -e "$target" ]
[ ! -e /etc/init.d/collectd-mqtt-ui ]
[ "$original" = "$(sha256sum /usr/libexec/stat-genconfig /etc/config/luci_statistics)" ]
test -n "$(find /root/collectd-mqtt-ui-backups -name collectd_mqtt_ui | head -1)"
echo 'PASS uninstall removes publisher, preserves original files and backs up settings'
