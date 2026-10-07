#!/bin/sh
set -eu
mkdir -p /tmp/mqtt-uci
cp /fixture/files/etc/config/collectd_mqtt_ui /tmp/mqtt-uci/
render=/fixture/files/usr/libexec/collectd-mqtt-ui-render
check() { /usr/sbin/collectd -t -C /tmp/mqtt-candidate; }
setopt() { uci -c /tmp/mqtt-uci set "collectd_mqtt_ui.main.$1=$2"; uci -c /tmp/mqtt-uci commit collectd_mqtt_ui; }
expect_invalid() {
	if sh "$render" /tmp/mqtt-uci > /tmp/mqtt-candidate 2>/tmp/mqtt-error; then
		echo "Unexpectedly accepted: $1" >&2; exit 1
	fi
	[ ! -s /tmp/mqtt-candidate ] || { echo 'Partial secret-bearing output on failure' >&2; exit 1; }
}
sh "$render" /tmp/mqtt-uci > /tmp/mqtt-candidate
! grep -q LoadPlugin /tmp/mqtt-candidate
check
echo 'PASS default disabled and no publisher'
setopt enabled 1
setopt host mqtt.example.invalid
setopt username fixture-user
setopt client_id fixture-collectd
setopt prefix test/collectd
expect_invalid 'missing password'
setopt password 'test-only-password'
sh "$render" /tmp/mqtt-uci > /tmp/mqtt-candidate
check
grep -q 'Retain false' /tmp/mqtt-candidate
grep -q 'StoreRates true' /tmp/mqtt-candidate
grep -q 'CACert ' /tmp/mqtt-candidate
echo 'PASS real collectd 5.12 MQTT/TLS configuration parser'
setopt password 'test-"quoted"-\slash-$()-literal'
sh "$render" /tmp/mqtt-uci > /tmp/mqtt-candidate
check
echo 'PASS literal quotes and backslashes'
setopt password "injected
LoadPlugin exec"
expect_invalid 'line injection'
! grep -q injected /tmp/mqtt-error
setopt password 'test-only-password'
setopt prefix 'forbidden/#'
expect_invalid 'wildcard prefix'
setopt prefix 'test/collectd'
setopt qos 3
expect_invalid 'invalid QoS'
setopt qos 1
setopt port 65536
expect_invalid 'invalid port'
setopt port 8883
setopt tls_protocol tlsv1
expect_invalid 'legacy TLS'
setopt tls_protocol tlsv1.2
setopt ca_cert /missing/ca.pem
expect_invalid 'missing CA'
echo 'PASS invalid settings fail closed without secret output'
