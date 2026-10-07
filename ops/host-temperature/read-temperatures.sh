#!/bin/sh
# POSIX shell; compatible with Debian and OpenWrt BusyBox. Read-only, no fan data.
# No arguments, remote command text or environment-supplied paths are executed.
set -eu
PATH=/usr/bin:/bin
export PATH LC_ALL=C
if [ "$#" -ne 0 ]; then exit 64; fi
if [ -n "${SSH_CONNECTION-}" ]; then
  allowed_file=/etc/one-minihouse-temperature-reader/allowed-source
  [ -r "$allowed_file" ] || exit 77
  allowed_source=$(cat "$allowed_file")
  [ -n "$allowed_source" ] && [ "${SSH_CONNECTION%% *}" = "$allowed_source" ] || exit 77
  case "${SSH_ORIGINAL_COMMAND-}" in ''|'/usr/local/libexec/one-minihouse-temperatures') ;; *) exit 64 ;; esac
fi
printf '%s\n' 'one-minihouse-temperatures-v1'
safe_name() { printf '%s' "$1" | tr '\t\r\n:' '____'; }
# NVMe controller numbers and hwmon numbers may change at boot. The PCI slot
# identifies the physical connection; keep the old unqualified rows for callers
# with a single controller, and add an unambiguous slot-qualified alias.
nvme_pci_chip() {
  device=$(readlink -f "$1/device") || return 1
  while [ "$device" != / ] && [ -n "$device" ]; do
    if [ -r "$device/vendor" ] && [ -r "$device/device" ]; then
      slot=${device##*/}
      case "$slot" in
        ????:??:??.?) printf 'nvme.pci-%s' "$(safe_name "$slot")"; return 0 ;;
      esac
    fi
    device=${device%/*}
  done
  return 1
}
for zone in /sys/class/thermal/thermal_zone*; do
  [ -r "$zone/type" ] && [ -r "$zone/temp" ] || continue
  chip=$(cat "$zone/type") || continue
  value=$(cat "$zone/temp" 2>/dev/null) || continue
  printf 'thermal\t%s\ttemp\t%s\n' "$(safe_name "$chip")" "$value"
done
for hwmon in /sys/class/hwmon/hwmon*; do
  [ -r "$hwmon/name" ] || continue
  chip=$(cat "$hwmon/name") || continue
  qualified_chip=
  if [ "$chip" = nvme ]; then qualified_chip=$(nvme_pci_chip "$hwmon") || qualified_chip=; fi
  for input in "$hwmon"/temp*_input; do
    [ -r "$input" ] || continue
    base=${input%_input}
    label=${base##*/}
    [ ! -r "${base}_label" ] || label=$(cat "${base}_label")
    # Faulted/disabled channels are absent, never a fabricated zero temperature.
    if [ -r "${base}_fault" ] && [ "$(cat "${base}_fault")" != 0 ]; then continue; fi
    if [ -r "${base}_enable" ] && [ "$(cat "${base}_enable")" = 0 ]; then continue; fi
    value=$(cat "$input" 2>/dev/null) || continue
    printf 'hwmon\t%s\t%s\t%s\n' "$(safe_name "$chip")" "$(safe_name "$label")" "$value"
    if [ -n "$qualified_chip" ]; then
      printf 'hwmon\t%s\t%s\t%s\n' "$qualified_chip" "$(safe_name "$label")" "$value"
    fi
  done
done
