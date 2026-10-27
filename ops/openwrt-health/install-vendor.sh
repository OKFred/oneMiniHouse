#!/bin/sh
# Trusted PyPI paho-mqtt 2.1.0 wheel, no network or global package upgrades.
set -eu
umask 022
[ "$(id -u)" = 0 ] || exit 1
[ "$#" -eq 1 ] && [ -f "$1" ] || { echo 'Pass the previously verified paho-mqtt wheel path' >&2; exit 1; }
wheel=$1
/usr/bin/python3 - "$wheel" <<'PY'
import hashlib,sys
from pathlib import Path
p=Path(sys.argv[1])
assert p.is_file() and not p.is_symlink() and p.stat().st_size < 1048576
assert hashlib.sha256(p.read_bytes()).hexdigest()=='6db9ba9b34ed5bc6b6e3812718c7e06e2fd7444540df2455d2c51bd58808feee'
PY
if [ -d /opt/one-minihouse-host-health/vendor ]; then
    /usr/bin/python3 -c 'import sys,importlib.metadata;sys.path.insert(0,"/opt/one-minihouse-host-health/vendor");assert importlib.metadata.version("paho-mqtt")=="2.1.0"'
    echo 'Existing vendor version preserved'
    exit 0
fi
/usr/bin/python3 -m pip install --no-index --no-deps --no-compile \
    --target /opt/one-minihouse-host-health/vendor "$wheel"
/usr/bin/python3 -c 'import sys,importlib.metadata;sys.path.insert(0,"/opt/one-minihouse-host-health/vendor");assert importlib.metadata.version("paho-mqtt")=="2.1.0"'
echo 'Pinned vendor dependency installed; no service started'
