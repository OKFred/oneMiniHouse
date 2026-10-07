#!/usr/bin/env bash
# Run on your deployment host. Keeps a recoverable copy of code, secrets, SQLite WAL, and image IDs.
set -euo pipefail
umask 077
root=${DEPLOYMENT_ROOT:?Set DEPLOYMENT_ROOT to the private deployment directory}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=${BACKUP_ROOT:?Set BACKUP_ROOT to a private backup directory}/$stamp
[[ -d "$root/gateway" && -d "$root/ingestor" ]] || { echo 'Unexpected deployment path' >&2; exit 1; }
mkdir -p "$backup"
docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' > "$backup/containers.before.txt"
services=(one-minihouse-gateway-1 one-minihouse-storage-ingestor-1)
paused=()
resume() {
  for container in "${paused[@]}"; do docker unpause "$container" >/dev/null || true; done
}
trap resume EXIT
for container in "${services[@]}"; do
  docker inspect "$container" > "$backup/$container.inspect.json"
  image=$(docker inspect --format '{{.Image}}' "$container")
  docker image tag "$image" "one-minihouse-rollback-${container}:$stamp"
  if [[ $(docker inspect --format '{{.State.Running}}:{{.State.Paused}}' "$container") == true:false ]]; then
    docker pause "$container" >/dev/null
    paused+=("$container")
  fi
done
# Pausing just these processes makes the SQLite database + WAL pair consistent.
tar -C "$root" -czf "$backup/deployment.tgz" gateway ingestor
resume
paused=()
sha256sum "$backup/deployment.tgz" > "$backup/SHA256SUMS"
printf 'Backup complete: %s\n' "$backup"
printf 'Database schema/data backups must also complete before applying SQL migrations.\n'
