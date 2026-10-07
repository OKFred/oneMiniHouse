#!/bin/sh
# BusyBox/POSIX shell. Collection and delivery are separate procd instances.
set -eu
umask 077
export LC_ALL=C
STATE_DIR=${STATE_DIR:-/tmp/one-minihouse-temperature}
SYS_ROOT=${SYS_ROOT:-/sys}
CONFIG_DIR=${CONFIG_DIR:-/etc/one-minihouse-temperature}
# Three data lines, not shell code. No production identity is part of the package.
[ -r "$CONFIG_DIR/identity" ] || { echo 'Missing MQTT identity file' >&2; exit 64; }
[ "$(wc -l < "$CONFIG_DIR/identity")" -eq 3 ] || exit 64
SITE_ID=$(sed -n '1p' "$CONFIG_DIR/identity")
GATEWAY_ID=$(sed -n '2p' "$CONFIG_DIR/identity")
DEVICE_ID=$(sed -n '3p' "$CONFIG_DIR/identity")
for identity in "$SITE_ID" "$GATEWAY_ID" "$DEVICE_ID"; do
  case "$identity" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid MQTT identity' >&2; exit 64 ;; esac
  [ "${#identity}" -le 128 ] || exit 64
done
TOPIC="iot/v1/$SITE_ID/$GATEWAY_ID/devices/$DEVICE_ID/telemetry"
mkdir -p "$STATE_DIR/queue"
chmod 700 "$STATE_DIR" "$STATE_DIR/queue"

warn() { logger -t one-minihouse-temperature "$1"; }
read_channel() {
  count=0
  value=
  for zone in "$SYS_ROOT"/class/thermal/thermal_zone*; do
    [ -r "$zone/type" ] || continue
    [ "$(cat "$zone/type")" = "$1" ] || continue
    count=$((count + 1))
    value=$(cat "$zone/temp" 2>/dev/null) || return 1
  done
  [ "$count" -eq 1 ] || return 1
  printf '%s\n' "$value" | awk '
    NR != 1 || $0 !~ /^-?[0-9]+$/ || $0+0 < -50000 || $0+0 > 150000 {bad=1}
    END {if (bad || NR != 1) exit 1; printf "%.3f", $0/1000}'
}
sample() {
  cpu=$(read_channel cpu-thermal) || return 1
  gpu=$(read_channel gpu-thermal) || return 1
  # Unsynchronised boot clocks must not invent historical readings.
  epoch=$(date -u +%s)
  [ "$epoch" -ge 1704067200 ] || return 1
  read_time=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  id=$(cat /proc/sys/kernel/random/uuid)
  printf '{"schema_version":2,"message_id":"%s","site_id":"%s","gateway_id":"%s","device_id":"%s","sample_time_utc":null,"read_time_utc":"%s","observation_kind":"direct_read","quality":"ok","metrics":{"cpu_temperature_c":%s,"gpu_temperature_c":%s},"source":{"driver":"openwrt-temperature-mqtt","interface":"linux_sysfs"}}\n' "$id" "$SITE_ID" "$GATEWAY_ID" "$DEVICE_ID" "$read_time" "$cpu" "$gpu"
}
prune() {
  now=$(date -u +%s)
  dropped=0
  set -- "$STATE_DIR"/queue/*.json
  count=$#
  for file do
    [ -f "$file" ] || continue
    name=${file##*/}
    born=${name%%-*}
    if [ "$count" -gt 360 ] || [ "$((now - born))" -ge 21600 ]; then
      rm -f "$file"
      dropped=$((dropped + 1))
    fi
    count=$((count - 1))
  done
  if [ "$dropped" -gt 0 ]; then
    total=0
    [ ! -r "$STATE_DIR/dropped_count" ] || total=$(cat "$STATE_DIR/dropped_count")
    printf '%s\n' "$((total + dropped))" > "$STATE_DIR/dropped_count"
    warn "queue_limit: dropped=$dropped total=$((total + dropped))"
  fi
}
enqueue() {
  if sample > "$STATE_DIR/sample.tmp"; then
    # Atomic rename keeps the publisher from seeing partial JSON.
    mv "$STATE_DIR/sample.tmp" "$STATE_DIR/queue/$(date -u +%s)-$(cat /proc/sys/kernel/random/uuid).json"
  else
    rm -f "$STATE_DIR/sample.tmp"
    warn 'temperature_read_failed: no telemetry generated'
    prune
    return 1
  fi
  prune
}
drain() {
  [ -r "$CONFIG_DIR/mosquitto_pub" ] || return 1
  for file in "$STATE_DIR"/queue/*.json; do
    [ -f "$file" ] || continue
    name=${file##*/}
    born=${name%%-*}
    # Collection prunes the queue. Delivery must never send an expired record
    # during its short overlap with that pruning pass.
    [ "$(( $(date -u +%s) - born ))" -lt 21600 ] || continue
    # Old mosquitto 2.0 can exit 0 even for a negative MQTT 5 PUBACK.
    # Require a positive ACK AND empty stderr; never log raw debug/credentials.
    if XDG_CONFIG_HOME="$CONFIG_DIR" timeout -s KILL 15 mosquitto_pub \
      -V mqttv5 -q 1 -d -t "$TOPIC" -f "$file" \
      > "$STATE_DIR/pub.out" 2> "$STATE_DIR/pub.err" \
      && [ ! -s "$STATE_DIR/pub.err" ] \
      && awk '/received PUBACK / && /RC:(0|16)\)/ {ok=1} END {exit !ok}' "$STATE_DIR/pub.out"; then
      rm -f "$file"
      date -u '+%Y-%m-%dT%H:%M:%SZ' > "$STATE_DIR/last_publish_time_utc"
    else
      return 1
    fi
  done
}
case "${1:-}" in
  sample) sample ;;
  enqueue) enqueue ;;
  prune) prune ;;
  drain) drain ;;
  collect)
    while :; do
      started=$(cut -d. -f1 /proc/uptime)
      enqueue || true
      elapsed=$(($(cut -d. -f1 /proc/uptime) - started))
      delay=$((60 - elapsed))
      [ "$delay" -gt 0 ] || delay=1
      sleep "$delay"
    done ;;
  publish)
    failures=0
    while :; do
      if drain; then
        [ "$failures" -eq 0 ] || warn 'mqtt_recovered'
        failures=0
      else
        failures=$((failures + 1))
        # Log only the first failure and then once per minute.
        [ "$((failures % 12))" -ne 1 ] || warn 'mqtt_delivery_failed: pending samples retained'
      fi
      sleep 5
    done ;;
  *) printf 'Usage: %s sample|enqueue|prune|drain|collect|publish\n' "$0" >&2; exit 64 ;;
esac
