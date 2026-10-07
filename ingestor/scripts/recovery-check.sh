#!/bin/bash
# Run on the Docker host from this service's directory. Only this ingestor is interrupted.
set -euo pipefail
umask 077
command -v python3 >/dev/null
exec 9>data/recovery-check.lock
flock -n 9
mkdir -p data/evidence
backup="data/evidence/config-before-recovery-$(date -u +%Y%m%dT%H%M%SZ).json"
cp -p config/local.json "$backup"
utc_now() { date -u +%Y-%m-%dT%H:%M:%S.%3NZ; }
test_started="$(utc_now)"
phase_started="$test_started"
replace_config() {
  # Atomic file replacement needs container recreation to refresh the single-file bind mount.
  python3 - "$backup" "${1:-restore}" <<'PY'
import json,os,stat,sys,tempfile
from pathlib import Path
source=Path(sys.argv[1]); target=Path('config/local.json'); content=source.read_bytes(); original=source.stat()
if sys.argv[2]!='restore':
 c=json.loads(content); matches=[t for t in c['targets'] if t['id']==sys.argv[2]]
 if len(matches)!=1: raise RuntimeError('Expected one database target')
 matches[0].update(host='127.0.0.1',port=1); content=(json.dumps(c)+'\n').encode()
fd,name=tempfile.mkstemp(prefix='.recovery-',dir=target.parent)
try:
 with os.fdopen(fd,'wb') as f:
  f.write(content); f.flush(); os.fchmod(f.fileno(),stat.S_IMODE(original.st_mode))
  if os.geteuid()==0: os.fchown(f.fileno(),original.st_uid,original.st_gid)
  os.fsync(f.fileno())
 os.replace(name,target)
 directory=os.open(target.parent,os.O_RDONLY)
 try: os.fsync(directory)
 finally: os.close(directory)
finally:
 if os.path.exists(name): os.unlink(name)
PY
}
restore() {
  replace_config restore || return $?
  docker compose up -d --no-build --force-recreate ingestor || return $?
  phase_started="$(utc_now)"
  wait_condition live
}
on_exit() {
  local status=$?
  trap - EXIT INT TERM
  if restore; then
    printf 'Original configuration and running ingestor restored; original_exit=%s\n' "$status" >&2
  else
    printf 'RECOVERY_RESTORE_FAILED; original_exit=%s; backup=%s\n' "$status" "$backup" >&2
    ((status!=0)) || status=1
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
wait_condition() {
  for attempt in $(seq 1 48); do
    if python3 - "$1" "$phase_started" <<'PY'
import json,sys
from datetime import datetime,timezone
def stamp(v): return datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
try:
 h=json.load(open('data/health.json')); mode=sys.argv[1]
 heartbeat=stamp(h['heartbeat_time_utc']); age=datetime.now(timezone.utc).timestamp()-heartbeat
 live=heartbeat>=stamp(sys.argv[2]) and -5<=age<=15 and h['mqtt_connected'] and h['subscribed'] and not h['intake_paused']
 if mode=='live': ok=live
 elif mode=='empty': ok=live and h['queued']==0 and h['local_pending']==0 and h['supabase_pending']==0 and h['processing_failed']==0
 elif mode=='archives': ok=live and (not h['archive']['raw_mirror_configured'] or h['d1_pending']==0) and (not h['archive']['frame_mirror_configured'] or h['sls_pending']==0)
 else: ok=live and h[mode+'_pending']>0 and h[('local' if mode=='supabase' else 'supabase')+'_pending']==0
 sys.exit(0 if ok else 1)
except (OSError,KeyError,ValueError,TypeError): sys.exit(1)
PY
    then return 0; fi
    sleep 5
  done
  printf 'Timed out waiting for fresh %s health\n' "$1" >&2
  return 1
}
wait_condition empty
for target in supabase local; do
  replace_config "$target"
  docker compose up -d --no-build --force-recreate ingestor
  phase_started="$(utc_now)"
  wait_condition "$target"
  docker compose exec -T ingestor node scripts/queue-snapshot.ts "$target-outage"
  docker compose restart ingestor
  phase_started="$(utc_now)"
  wait_condition "$target"
  docker compose exec -T ingestor node scripts/queue-snapshot.ts "$target-after-restart"
  python3 - "$target" <<'PY'
import json,sys
p='data/evidence/'+sys.argv[1]
a=json.load(open(p+'-outage.json'))['pending']; b=json.load(open(p+'-after-restart.json'))['pending']
target=sys.argv[1]; other='local' if target=='supabase' else 'supabase'
stable=[r for r in a if r[target+'_done']==0 and r[other+'_done']==1]
byid={r['id']:r for r in b}; assert stable, 'Need an independently completed baseline'
for r in stable:
 actual=byid.get(r['id'])
 assert actual and actual['hash']==r['hash'] and actual[target+'_done']==0 and actual[other+'_done']==1
print(target+' stable pending IDs and completion flags survived restart')
PY
  restore
  wait_condition empty
  docker compose exec -T ingestor node scripts/queue-snapshot.ts "$target-recovered"
done
docker compose stop ingestor
mqtt_stopped="$(utc_now)"
sleep 75
mqtt_resumed="$(utc_now)"
docker compose start ingestor
phase_started="$(utc_now)"
wait_condition empty
docker compose exec -T ingestor node scripts/queue-snapshot.ts mqtt-recovered
# PG fault checks are independent of the optional archive sinks.
if [[ "${WAIT_FOR_ARCHIVES:-1}" == 1 ]]; then
  phase_started="$(utc_now)"
  wait_condition archives
fi
cmp -s "$backup" config/local.json
# Fixed current-run window: at least three new records with lineage in both databases.
docker compose exec -T -e "VERIFY_AFTER=$test_started" -e "VERIFY_BEFORE=$mqtt_resumed" \
  -e VERIFY_MIN_ROWS=3 -e VERIFY_REQUIRE_LINEAGE=1 -e VERIFY_LIMIT=1000 \
  -e VERIFY_SQLITE=/app/data/inbox.sqlite ingestor node scripts/verify.ts
python3 - "$mqtt_stopped" "$mqtt_resumed" <<'PY'
import json,sys
from datetime import datetime
def stamp(v): return datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()
v=json.load(open('data/evidence/layered-verification.json')); assert v['verification_passed']
baseline=[]
for target in ('local','supabase'):
 other='local' if target=='supabase' else 'supabase'
 rows=json.load(open('data/evidence/'+target+'-outage.json'))['pending']
 baseline.extend(r for r in rows if r[target+'_done']==0 and r[other+'_done']==1)
buffered_ids=None
for report in v['reports']:
 rows={r['message_id']:r for r in report['samples']}
 for row in baseline: assert row['id'] in rows and rows[row['id']]['payload_sha256']==row['hash'], 'Baseline pending write missing from database'
 buffered={r['message_id'] for r in rows.values() if r['sample_time_utc'] is not None and stamp(sys.argv[1])<=stamp(r['sample_time_utc'])<stamp(sys.argv[2])}
 assert buffered, 'No real measurement from the MQTT stopped interval recovered'
 assert buffered_ids is None or buffered_ids==buffered, 'MQTT recovery IDs differ'
 buffered_ids=buffered
print(json.dumps({'mqtt_recovered_ids':sorted(buffered_ids),'mqtt_stop_time_utc':sys.argv[1],'mqtt_resume_time_utc':sys.argv[2]}))
PY
phase_started="$(utc_now)"
wait_condition empty
# No unverified EXIT restart is allowed after reporting success.
trap - EXIT INT TERM
printf 'RECOVERY_CHECK_PASSED\n'
