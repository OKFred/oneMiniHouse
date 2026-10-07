#!/bin/sh
# Run inside eclipse-mosquitto:2.0 with --network none. No production credentials.
set -eu
src=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
export STATE_DIR="$work/state" SYS_ROOT="$work/sys" CONFIG_DIR="$work/client"
script="$src/r4s-temperature.sh"
topic=iot/v1/example-home/example-router/devices/temperature-router/telemetry
mkdir -p "$CONFIG_DIR" "$SYS_ROOT/class/thermal/thermal_zone0" "$SYS_ROOT/class/thermal/thermal_zone1"
if sh "$script" sample > "$work/missing.json" 2>/dev/null; then echo 'Missing identity accepted' >&2; exit 1; fi
[ ! -s "$work/missing.json" ]
printf 'example-home\nexample-router\nbad/identity\n' > "$CONFIG_DIR/identity"
if sh "$script" sample > "$work/bad.json" 2>/dev/null; then echo 'Unsafe identity accepted' >&2; exit 1; fi
[ ! -s "$work/bad.json" ]
cp "$src/identity.example" "$CONFIG_DIR/identity"
printf 'cpu-thermal\n' > "$SYS_ROOT/class/thermal/thermal_zone0/type"
printf '46250\n' > "$SYS_ROOT/class/thermal/thermal_zone0/temp"
printf 'gpu-thermal\n' > "$SYS_ROOT/class/thermal/thermal_zone1/type"
printf '45625\n' > "$SYS_ROOT/class/thermal/thermal_zone1/temp"
sh "$script" sample > "$work/sample.json"
grep -q '"cpu_temperature_c":46.250,"gpu_temperature_c":45.625' "$work/sample.json"
grep -q '"sample_time_utc":null' "$work/sample.json"
grep -q '"site_id":"example-home","gateway_id":"example-router","device_id":"temperature-router"' "$work/sample.json"
printf 'PASS: real shell sensor conversion and explicit time envelope\n'
for bad in NaN 151000 ''; do
  printf '%s\n' "$bad" > "$SYS_ROOT/class/thermal/thermal_zone0/temp"
  if sh "$script" enqueue; then echo 'Invalid temperature accepted' >&2; exit 1; fi
  [ "$(find "$STATE_DIR/queue" -name '*.json' | wc -l)" -eq 0 ]
done
printf '0\n' > "$SYS_ROOT/class/thermal/thermal_zone0/temp"
sh "$script" sample | grep -q '"cpu_temperature_c":0.000'
cp -r "$SYS_ROOT/class/thermal/thermal_zone0" "$SYS_ROOT/class/thermal/thermal_zone2"
if sh "$script" sample >/dev/null; then echo 'Ambiguous sensor accepted' >&2; exit 1; fi
rm -r "$SYS_ROOT/class/thermal/thermal_zone2"
printf 'PASS: invalid and ambiguous sensors rejected; genuine zero preserved\n'

cat > "$work/acl" <<EOF
user allowed
topic readwrite $topic
user denied
topic read unrelated
EOF
cat > "$work/broker.conf" <<EOF
listener 1883 127.0.0.1
allow_anonymous true
user root
acl_file $work/acl
EOF
mosquitto -c "$work/broker.conf" > "$work/broker.log" 2>&1 &
broker=$!
trap 'kill "$broker" 2>/dev/null || true; rm -rf "$work"' EXIT
for i in 1 2 3 4 5 6 7 8 9 10; do
  grep -q 'running' "$work/broker.log" && break
  sleep .1
done
grep -q 'running' "$work/broker.log"
printf '%s\n' '-h 127.0.0.1' '-p 1883' '-u denied' > "$CONFIG_DIR/mosquitto_pub"
sh "$script" enqueue
pending=$(find "$STATE_DIR/queue" -name '*.json')
cp "$pending" "$work/original.json"
if sh "$script" drain; then echo 'Negative PUBACK accepted' >&2; exit 1; fi
cmp "$pending" "$work/original.json"
printf 'PASS: actual broker ACL rejection retains identical pending message\n'
sed -i 's/-u denied/-u allowed/' "$CONFIG_DIR/mosquitto_pub"
mosquitto_sub -h 127.0.0.1 -u allowed -V mqttv5 -q 1 -t "$topic" -C 2 -W 10 -N > "$work/received.jsonl" &
subscriber=$!
sleep .2
sh "$script" drain
[ ! -f "$pending" ]
# Simulate crash after PUBACK but before removing the pending file.
cp "$work/original.json" "$pending"
sh "$script" drain
wait "$subscriber"
[ "$(wc -l < "$work/received.jsonl")" -eq 2 ]
head -n 1 "$work/received.jsonl" > "$work/first.json"
tail -n 1 "$work/received.jsonl" > "$work/second.json"
cmp "$work/first.json" "$work/second.json"
cmp "$work/first.json" "$work/original.json"
printf 'PASS: restart recovery and duplicate delivery preserve message ID and bytes\n'
# Retained telemetry would reach a newly connected subscriber; none must exist.
if mosquitto_sub -h 127.0.0.1 -u allowed -t "$topic" -C 1 -W 1 > "$work/retained" 2>/dev/null; then
  echo 'Telemetry unexpectedly retained' >&2; exit 1
fi
[ ! -s "$work/retained" ]
printf 'PASS: telemetry is non-retained\n'
now=$(date -u +%s)
for i in $(seq 1 362); do cp "$work/original.json" "$STATE_DIR/queue/$((now - 400 + i))-$i.json"; done
cp "$work/original.json" "$STATE_DIR/queue/$((now - 21601))-expired.json"
sh "$script" prune
[ "$(find "$STATE_DIR/queue" -name '*.json' | wc -l)" -eq 360 ]
[ "$(cat "$STATE_DIR/dropped_count")" -eq 3 ]
printf 'PASS: six-hour/360-message cap and drop counter\n'
printf 'All R4S shell/MQTT integration checks passed.\n'
