#!/bin/sh
# Only in a disposable Debian container with --network none and a read-only source mount.
set -eu
[ "${TEMPERATURE_TEST_DISPOSABLE:-}" = 1 ] || { echo 'Disposable container required' >&2; exit 64; }
src=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
sh -n "$src/install-reader.sh"
sh -n "$src/read-temperatures.sh"
work=$(mktemp -d)
key="$work/collector.pub"
# Synthetic public-key bytes; this test does not establish an SSH session.
printf 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA example\n' > "$key"
deny() {
  expected=$1; shift
  status=0
  "$@" > "$work/out" 2> "$work/err" || status=$?
  [ "$status" -eq "$expected" ] || { echo "Expected exit $expected, got $status" >&2; exit 1; }
}
deny 64 sh "$src/install-reader.sh" --authorize "$key"
for ip in '192.0.2.999' '192.0.2.1/24' '192.0.2.1,192.0.2.2' '*'; do
  deny 65 sh "$src/install-reader.sh" --authorize "$key" --account example-temperature --source "$ip"
done
deny 65 sh "$src/install-reader.sh" --authorize "$key" --account root --source 192.0.2.31
[ ! -e /etc/one-minihouse-temperature-reader ]
sh "$src/install-reader.sh" --authorize "$key" --account example-temperature --source 192.0.2.31
auth=/var/lib/one-minihouse-temperature/.ssh/authorized_keys
grep -q '^from="192.0.2.31",command="/usr/local/libexec/one-minihouse-temperatures",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ' "$auth"
cp "$auth" "$work/authorized"
sh "$src/install-reader.sh" --authorize "$key" --account example-temperature --source 192.0.2.31
cmp "$auth" "$work/authorized"
# Re-authorizing the same key from another source must leave all prior settings intact.
deny 65 sh "$src/install-reader.sh" --authorize "$key" --account example-temperature --source 192.0.2.32
cmp "$auth" "$work/authorized"
[ "$(cat /etc/one-minihouse-temperature-reader/allowed-source)" = 192.0.2.31 ]
reader=/usr/local/libexec/one-minihouse-temperatures
deny 77 env SSH_CONNECTION='192.0.2.32 40000 192.0.2.20 22' sh "$reader"
deny 64 env SSH_CONNECTION='192.0.2.31 40000 192.0.2.20 22' SSH_ORIGINAL_COMMAND='id' sh "$reader"
env SSH_CONNECTION='192.0.2.31 40000 192.0.2.20 22' SSH_ORIGINAL_COMMAND="$reader" sh "$reader" > "$work/read"
[ "$(head -n 1 "$work/read")" = one-minihouse-temperatures-v1 ]
mv /etc/one-minihouse-temperature-reader/allowed-source "$work/source"
deny 77 env SSH_CONNECTION='192.0.2.31 40000 192.0.2.20 22' sh "$reader"
printf 'PASS: explicit source/account, idempotent install, conflict preservation and fail-closed reader\n'
