#!/bin/sh
# Explicit operator action: installs a read-only command and one restricted key.
# Debian/PVE: a dedicated unprivileged system account. OpenWrt uses MQTT push.
set -eu
umask 077
if [ "$#" -ne 6 ] || [ "$1" != '--authorize' ] || [ "$3" != '--account' ] || [ "$5" != '--source' ] || [ "$(id -u)" != 0 ]; then
  printf '%s\n' 'Usage (root): sh install-reader.sh --authorize public-key-file --account dedicated-user --source collector-ipv4' >&2; exit 64
fi
[ ! -f /etc/openwrt_release ] || { echo 'Use R4S MQTT push, not SSH authorization' >&2; exit 64; }
account=$4
source_ip=$6
case "$source_ip" in ''|*[!0-9.]*) echo 'Expected one collector IPv4 address' >&2; exit 65 ;; esac
case "$account" in ''|[!a-z_]*|*[!a-z0-9_-]*) echo 'Invalid dedicated account' >&2; exit 65 ;; esac
[ "${#account}" -le 32 ] || exit 65
printf '%s\n' "$source_ip" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || length($i)>3 || $i+0>255) exit 1}' || { echo 'Expected one collector IPv4 address' >&2; exit 65; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
public=$(cat "$2")
case "$public" in 'ssh-ed25519 '*) ;; *) echo 'Expected an ed25519 public key' >&2; exit 65 ;; esac
[ "$(printf '%s\n' "$public" | wc -l)" = 1 ] || exit 65
key_data=$(printf '%s\n' "$public" | awk '{print $2}')
case "$key_data" in ''|*[!A-Za-z0-9+/=]*) exit 65 ;; esac
if id "$account" >/dev/null 2>&1; then
  [ "$(id -u "$account")" != 0 ] || exit 65
  [ "$(getent passwd "$account" | cut -d: -f6)" = /var/lib/one-minihouse-temperature ] || exit 65
fi
auth=/var/lib/one-minihouse-temperature/.ssh/authorized_keys
line='from="'"$source_ip"'",command="/usr/local/libexec/one-minihouse-temperatures",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 '"$key_data"' one-minihouse-temperature-readonly'
if [ -f "$auth" ] && grep -Fq "$key_data" "$auth" && ! grep -Fxq "$line" "$auth"; then
  echo 'Existing authorization for this key differs; inspect rather than widen it' >&2; exit 65
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
settings=/etc/one-minihouse-temperature-reader
mkdir -p "$settings"
chown root:root "$settings"
chmod 755 "$settings"
[ ! -e "$settings/allowed-source" ] || cp -p "$settings/allowed-source" "$settings/allowed-source.before-$stamp"
printf '%s\n' "$source_ip" > "$settings/allowed-source"
chown root:root "$settings/allowed-source"
chmod 644 "$settings/allowed-source"
mkdir -p /usr/local/libexec
reader=/usr/local/libexec/one-minihouse-temperatures
[ ! -e "$reader" ] || cp -p "$reader" "$reader.before-$stamp"
cp "$script_dir/read-temperatures.sh" "$reader"
chown root:root "$reader"
chmod 755 "$reader"
if ! id "$account" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /var/lib/one-minihouse-temperature --shell /bin/sh "$account"
fi
mkdir -p /var/lib/one-minihouse-temperature/.ssh
chmod 700 /var/lib/one-minihouse-temperature/.ssh
chown "$account" /var/lib/one-minihouse-temperature/.ssh
touch "$auth"
if ! grep -Fxq "$line" "$auth"; then
  cp -p "$auth" "$auth.before-$stamp"
  printf '\n%s\n' "$line" >> "$auth"
fi
chmod 600 "$auth"
chown "$account" "$auth"
printf 'temperature reader ready; account=%s; authorization=%s\n' "$account" "$auth"
