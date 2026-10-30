"""OpenWrt host health: bounded reads, monotonic decisions, durable action claims.

Pure decisions do not contact Docker or MQTT. Public configuration uses examples.
"""
import contextlib
import fcntl
import json
import math
import os
from pathlib import Path
import re
import stat
import time
import uuid
from datetime import datetime, timezone

MIB = 1024 * 1024
METRICS = {
    'memory_total_bytes', 'memory_available_bytes', 'memory_anon_bytes',
    'memory_slab_bytes', 'memory_unreclaimable_slab_bytes', 'memory_shmem_bytes',
    'memory_dirty_bytes', 'memory_writeback_bytes', 'load_1m', 'cpu_iowait_pct',
    'blocked_tasks', 'psi_memory_some_avg10_pct', 'psi_io_some_avg10_pct',
    'cpu_temperature_c', 'rootfs_free_bytes', 'rootfs_used_pct',
    'datafs_free_bytes', 'datafs_used_pct', 'proxy_working_set_bytes', 'proxy_rss_bytes',
}
CONDITIONS = ('memory_pressure', 'io_pressure', 'temperature', 'storage')
DETAILS = {'none', 'metric_unavailable', 'memory_available_low',
           'memory_available_critical', 'io_wait_blocked', 'temperature_high', 'storage_low'}
MEMORY_FIELDS = {'MemTotal': 'memory_total_bytes', 'MemAvailable': 'memory_available_bytes',
                 'AnonPages': 'memory_anon_bytes', 'Slab': 'memory_slab_bytes',
                 'SUnreclaim': 'memory_unreclaimable_slab_bytes', 'Shmem': 'memory_shmem_bytes',
                 'Dirty': 'memory_dirty_bytes', 'Writeback': 'memory_writeback_bytes'}


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def utc(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def valid_uuid(value):
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value
    except (ValueError, TypeError, AttributeError):
        return False


def read_small(path, maximum=65536):
    # procfs files report size 0; cap the actual read rather than trusting st_size.
    with open(path, 'rb') as stream:
        value = stream.read(maximum + 1)
    if len(value) > maximum:
        raise ValueError('INPUT_TOO_LARGE')
    return value.decode('utf-8', errors='strict')


def atomic_json(path, value, durable=False):
    path = Path(path)
    raw = (encode(value) + '\n').encode()
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            if durable:
                os.fsync(stream.fileno())
        os.replace(temporary, path)
        if durable:
            descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
    finally:
        if temporary.exists():
            temporary.unlink()


def validate_metrics(metrics):
    if not isinstance(metrics, dict) or set(metrics) - METRICS:
        raise ValueError('INVALID_METRIC_KEYS')
    for key, value in metrics.items():
        if type(value) not in (int, float) or not math.isfinite(value):
            raise ValueError('INVALID_METRIC_VALUE')
        if key == 'cpu_temperature_c':
            valid = -50 <= value <= 150
        elif key.endswith('_pct'):
            valid = 0 <= value <= 100
        elif key == 'load_1m':
            valid = 0 <= value <= 1024
        else:
            valid = type(value) is int and 0 <= value <= 2**53 - 1
        if not valid:
            raise ValueError('INVALID_METRIC_RANGE')


def masked_process_name(value, *, legacy=True):
    if not isinstance(value, str) or not 1 <= len(value) <= 64:
        return False
    return (re.fullmatch(r'[A-Za-z0-9_.-]{1,2}', value) is not None
            or re.fullmatch(r'[A-Za-z0-9_.-]+\*{1,3}[A-Za-z0-9_.-]+', value) is not None
            or legacy and re.fullmatch(r'[A-Za-z0-9_.-]{0,2}\*{3}', value) is not None)


def mask_process_name(value):
    if not isinstance(value, str) or re.fullmatch(r'[A-Za-z0-9_.-]{1,64}', value) is None:
        raise ValueError('INVALID_PROCESS_NAME')
    if len(value) <= 2:
        return value
    hidden = min(1, len(value) - 2)
    start = (len(value) - hidden) // 2
    return value[:start] + '*' * hidden + value[start + hidden:]


def masked_process_path(value):
    if not isinstance(value, str) or not value.startswith('/') or len(value) > 512:
        return False
    parts = value.split('/')[1:]
    return (bool(parts) and all(part not in ('', '.', '..')
                              and re.fullmatch(r'[A-Za-z0-9_.-]+', part) is not None for part in parts[:-1])
            and parts[-1] not in ('', '.', '..') and masked_process_name(parts[-1], legacy=False))


def mask_process_path(value):
    if not isinstance(value, str) or not value.startswith('/') or len(value) > 512:
        return None
    parts = value.split('/')[1:]
    if not parts or any(part in ('', '.', '..') or re.fullmatch(r'[A-Za-z0-9_.-]+', part) is None for part in parts):
        return None
    if len(parts[-1]) > 64:
        return None
    parts[-1] = mask_process_name(parts[-1])
    return '/' + '/'.join(parts)


def validate_diagnostics(value):
    """Only an already masked process label and RSS may cross the MQTT boundary."""
    if not isinstance(value, dict) or set(value) != {'memory_top_process'}:
        raise ValueError('INVALID_DIAGNOSTICS')
    process = value['memory_top_process']
    if (not isinstance(process, dict) or set(process) - {'path_masked'} != {'name_masked', 'rss_bytes'}
            or not masked_process_name(process['name_masked'])
            or type(process['rss_bytes']) is not int or not 0 <= process['rss_bytes'] <= 2**53 - 1):
        raise ValueError('INVALID_DIAGNOSTICS')
    if 'path_masked' in process and not masked_process_path(process['path_masked']):
        raise ValueError('INVALID_DIAGNOSTICS')


def process_start(directory):
    text = read_small(directory / 'stat', 4096)
    closing = text.rfind(')')
    if closing <= 0:
        raise ValueError('INVALID_PROCESS_START')
    fields = text[closing + 2:].split()
    if len(fields) < 20 or not fields[19].isascii() or not fields[19].isdigit():
        raise ValueError('INVALID_PROCESS_START')
    return fields[19]


def memory_top_process(proc=Path('/proc'), *, maximum_processes=4096,
                       maximum_entries=8192, maximum_seconds=0.2, clock=time.monotonic):
    """RSS rank among readable process snapshots; omit incomplete scans.

    /proc/<pid>/status exposes VmRSS in KiB, unlike virtual address space.
    See https://docs.kernel.org/filesystems/proc.html (status/VmRSS).
    This is a sequential snapshot, not an atomic accounting of all processes.
    No command line, environment or PID leaves this function. Executable paths
    come only from the winning PID's /proc/exe link; only its basename is masked.
    """
    started, entries, processes, highest, winning = clock(), 0, 0, None, None
    try:
        with os.scandir(proc) as scan:
            for entry in scan:
                entries += 1
                if entries > maximum_entries or clock() - started > maximum_seconds:
                    return None
                if not entry.name.isascii() or not entry.name.isdigit():
                    continue
                if not entry.is_dir(follow_symlinks=False):
                    return None
                processes += 1
                if processes > maximum_processes:
                    return None
                try:
                    directory = Path(entry.path)
                    text = read_small(directory / 'status', 8192)
                except FileNotFoundError:
                    continue  # A process may exit during the scan.
                name = re.search(r'^Name:[ \t]+([^\n]+)$', text, re.M)
                rss = re.search(r'^VmRSS:[ \t]+(\d+)[ \t]+kB$', text, re.M)
                if not name:
                    return None
                if not rss:
                    # Kernel threads and zombies legitimately have no VmRSS.
                    if re.search(r'^VmRSS:', text, re.M):
                        return None
                    continue
                resident = int(rss.group(1)) * 1024
                if not 0 <= resident <= 2**53 - 1:
                    return None
                if highest is None or resident > highest['rss_bytes']:
                    # Only a possible new leader needs an identity-bound RSS
                    # read. Do not double procfs I/O for every non-leading PID.
                    start = process_start(directory)
                    confirmed = read_small(directory / 'status', 8192)
                    name = re.search(r'^Name:[ \t]+([^\n]+)$', confirmed, re.M)
                    rss = re.search(r'^VmRSS:[ \t]+(\d+)[ \t]+kB$', confirmed, re.M)
                    if name is None or rss is None or process_start(directory) != start:
                        return None
                    resident = int(rss.group(1)) * 1024
                    if not 0 <= resident <= 2**53 - 1:
                        return None
                    if highest is not None and resident <= highest['rss_bytes']:
                        continue  # The preliminary RSS is not authoritative.
                    clean = re.sub(r'[^A-Za-z0-9_.-]', '_', name.group(1))
                    highest = {'name_masked': mask_process_name(clean), 'rss_bytes': resident}
                    winning = directory, start, name.group(1)
        if clock() - started > maximum_seconds:
            return None
        if highest is not None:
            directory, start, original_name = winning
            if process_start(directory) != start:
                return None
            try:
                executable = mask_process_path(os.readlink(directory / 'exe'))
            except OSError:
                executable = None
            current_status = read_small(directory / 'status', 8192)
            current_name = re.search(r'^Name:[ \t]+([^\n]+)$', current_status, re.M)
            if process_start(directory) != start or current_name is None or current_name.group(1) != original_name:
                return None
            if executable is not None:
                highest['path_masked'] = executable
            if clock() - started > maximum_seconds:
                return None
        return highest
    except (OSError, ValueError, UnicodeError):
        return None


class Sampler:
    """Read only kernel pseudo files. Storage and Docker probes run separately."""
    def __init__(self, proc=Path('/proc'), thermal_path=None, memory_cgroup_path=None):
        self.proc = Path(proc)
        self.thermal_path = Path(thermal_path) if thermal_path else None
        self.cgroup = Path(memory_cgroup_path) if memory_cgroup_path else None
        self.previous_cpu = None
        self.previous_boot = None

    def sample(self, epoch=None, *, include_diagnostics=False):
        metrics, errors = {}, []
        boot = read_small(self.proc / 'sys/kernel/random/boot_id', 64).strip()
        uptime = float(read_small(self.proc / 'uptime', 128).split()[0])
        if not valid_uuid(boot) or not math.isfinite(uptime) or uptime < 0:
            raise ValueError('INVALID_KERNEL_CLOCK')
        try:
            memory = dict(re.findall(r'^(\w+):\s+(\d+)\s+kB$', read_small(self.proc / 'meminfo'), re.M))
            for source, target in MEMORY_FIELDS.items():
                if source in memory:
                    metrics[target] = int(memory[source]) * 1024
            if metrics.get('memory_available_bytes', 0) > metrics.get('memory_total_bytes', 0):
                raise ValueError('INVALID_MEMORY')
        except (OSError, ValueError, UnicodeError):
            metrics = {k: v for k, v in metrics.items() if not k.startswith('memory_')}
            errors.append('memory_unavailable')
        try:
            metrics['load_1m'] = float(read_small(self.proc / 'loadavg', 256).split()[0])
            cpu_text = read_small(self.proc / 'stat')
            row = re.search(r'^cpu\s+([\d ]+)$', cpu_text, re.M)
            numbers = tuple(map(int, row.group(1).split()))
            # guest/guest_nice are already included in user/nice. Exclude them.
            numbers = numbers[:8]
            if len(numbers) < 5:
                raise ValueError('CPU_COUNTERS_MISSING')
            if self.previous_boot == boot and self.previous_cpu is not None:
                delta = [a - b for a, b in zip(numbers, self.previous_cpu)]
                if min(delta) >= 0 and sum(delta) > 0:
                    metrics['cpu_iowait_pct'] = round(delta[4] * 100 / sum(delta), 3)
            self.previous_cpu, self.previous_boot = numbers, boot
            blocked = re.search(r'^procs_blocked\s+(\d+)$', cpu_text, re.M)
            if blocked:
                metrics['blocked_tasks'] = int(blocked.group(1))
        except (OSError, ValueError, AttributeError, UnicodeError):
            errors.append('cpu_unavailable')
        for name in ('memory', 'io'):
            try:
                text = read_small(self.proc / 'pressure' / name, 2048)
                value = float(re.search(r'^some\s+avg10=([\d.]+)', text, re.M).group(1))
                metrics['psi_' + name + '_some_avg10_pct'] = value
            except (OSError, ValueError, AttributeError, UnicodeError):
                # Older kernels may not expose PSI. Missing is never zero.
                pass
        if self.thermal_path:
            try:
                value = int(read_small(self.thermal_path, 64).strip()) / 1000
                if not -50 <= value <= 150:
                    raise ValueError('THERMAL_RANGE')
                metrics['cpu_temperature_c'] = value
            except (OSError, ValueError, UnicodeError):
                errors.append('thermal_unavailable')
        if self.cgroup:
            try:
                usage = int(read_small(self.cgroup / 'memory.usage_in_bytes', 64).strip())
                values = dict(line.split() for line in read_small(self.cgroup / 'memory.stat').splitlines())
                inactive = int(values['total_inactive_file'])
                rss = int(values['total_rss'])
                if not 0 <= inactive <= usage or not 0 <= rss <= usage:
                    raise ValueError('CGROUP_INVALID')
                metrics['proxy_working_set_bytes'] = usage - inactive
                metrics['proxy_rss_bytes'] = rss
            except (OSError, ValueError, KeyError, UnicodeError):
                errors.append('proxy_memory_unavailable')
        validate_metrics(metrics)
        sample = {'boot_id': boot, 'uptime_seconds': uptime, 'read_time_utc': utc(epoch),
                  'metrics': metrics, 'probe_errors': sorted(set(errors))}
        if include_diagnostics:
            process = memory_top_process(self.proc)
            if process is not None:
                sample['diagnostics'] = {'memory_top_process': process}
        return sample


class Sustained:
    def __init__(self):
        self.since = {}

    def holds(self, key, value, now, seconds):
        if value is not True:
            self.since.pop(key, None)
            return False
        self.since.setdefault(key, now)
        return now - self.since[key] >= seconds


class Decisions:
    """Sample gaps and reboot reset duration windows; unknown never means good."""
    def __init__(self, recovery_seconds=300):
        self.windows = Sustained()
        self.active = {}
        self.previous = None
        self.recovery_seconds = recovery_seconds

    def update(self, sample):
        now, boot, m = sample['uptime_seconds'], sample['boot_id'], sample['metrics']
        if self.previous and (boot != self.previous[0] or not 0 < now - self.previous[1] <= 25):
            self.windows = Sustained()
            if boot != self.previous[0]:
                self.active = {}
        self.previous = boot, now
        available = m.get('memory_available_bytes')
        memory_known = available is not None
        warning = self.windows.holds('memory_warning', memory_known and available < 256 * MIB, now, 120)
        critical = self.windows.holds('memory_critical', memory_known and available < 128 * MIB, now, 60)
        io_known = 'cpu_iowait_pct' in m and 'blocked_tasks' in m
        io_bad = io_known and m['cpu_iowait_pct'] >= 20 and m['blocked_tasks'] >= 3
        io_bad = self.windows.holds('io_bad', io_bad, now, 120)
        thermal_known = 'cpu_temperature_c' in m
        thermal_bad = self.windows.holds('thermal_bad', thermal_known and m['cpu_temperature_c'] >= 85, now, 120)
        storage_values = [m[k] for k in ('rootfs_used_pct', 'datafs_used_pct') if k in m]
        storage_known = len(storage_values) == 2
        storage_bad = self.windows.holds('storage_bad', storage_known and max(storage_values) >= 90, now, 300)
        candidates = {
            'memory_pressure': (memory_known, critical or warning, 'critical' if critical else 'warning',
                                'memory_available_critical' if critical else 'memory_available_low'),
            'io_pressure': (io_known, io_bad, 'critical', 'io_wait_blocked'),
            'temperature': (thermal_known, thermal_bad, 'warning', 'temperature_high'),
            'storage': (storage_known, storage_bad, 'warning', 'storage_low'),
        }
        output = {}
        for key, (known, bad, severity, detail) in candidates.items():
            if not known:
                self.windows.holds('recover_' + key, False, now, self.recovery_seconds)
                output[key] = {'state': 'unknown', 'severity': severity, 'incident_id': None, 'detail_code': 'metric_unavailable'}
                continue
            if bad:
                incident = self.active.setdefault(key, {'incident_id': str(uuid.uuid4()), 'severity': severity, 'detail_code': detail})
                incident.update(severity=severity, detail_code=detail)
                self.windows.holds('recover_' + key, False, now, self.recovery_seconds)
            elif key in self.active:
                # Hysteresis is on safe resources, not merely "not yet long enough".
                safe = (available >= 320 * MIB if key == 'memory_pressure' else
                        m['cpu_iowait_pct'] < 10 and m['blocked_tasks'] < 3 if key == 'io_pressure' else
                        m['cpu_temperature_c'] < 80 if key == 'temperature' else max(storage_values) < 85)
                if self.windows.holds('recover_' + key, safe, now, self.recovery_seconds):
                    self.active.pop(key)
            if key in self.active:
                output[key] = dict(state='bad', **self.active[key])
            else:
                output[key] = {'state': 'good', 'severity': severity, 'incident_id': None, 'detail_code': 'none'}
        npm_memory = max(m.get('proxy_working_set_bytes', -1), m.get('proxy_rss_bytes', -1))
        high_proxy = self.windows.holds('proxy_high', npm_memory >= 512 * MIB, now, 60)
        corroborated = any(m.get(k, -1) >= 10 for k in ('psi_memory_some_avg10_pct', 'psi_io_some_avg10_pct')) or m.get('blocked_tasks', -1) >= 3 or m.get('cpu_iowait_pct', -1) >= 20
        eligible = (critical and high_proxy and corroborated and now >= 300)
        return output, eligible


class ActionLedger:
    """Only rare transitions write flash. Claimed intent is fsynced before action.

    Unacknowledged events are never evicted, even when older than seven days.
    Full/corrupt/unavailable ledger disables new action instead of resetting it.
    """
    def __init__(self, directory, maximum=2 * MIB):
        self.directory = Path(directory)
        self.path = self.directory / 'actions.json'
        self.maximum = maximum

    def initialize(self):
        """Explicit one-time install action; never called by service startup."""
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.resolve() != self.directory or self.directory.stat().st_mode & 0o077:
            raise ValueError('UNSAFE_LEDGER_DIRECTORY')
        raw = (encode({'version': 1, 'claims': [], 'events': [], 'last_action_epoch': None}) + '\n').encode()
        descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        descriptor = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    @contextlib.contextmanager
    def transaction(self):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.resolve() != self.directory or self.directory.stat().st_mode & 0o077:
            raise ValueError('UNSAFE_LEDGER_DIRECTORY')
        lock = os.open(self.directory / '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                info = self.path.lstat()
                if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
                    raise ValueError('UNSAFE_LEDGER_FILE')
                state = json.loads(read_small(self.path, self.maximum))
                if state.get('version') != 1 or not isinstance(state.get('events'), list) or not isinstance(state.get('claims'), list):
                    raise ValueError('INVALID_LEDGER')
            else:
                raise ValueError('LEDGER_MISSING')
            yield state
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
            os.close(lock)

    def save(self, state):
        if len((encode(state) + '\n').encode()) > self.maximum:
            raise ValueError('LEDGER_CAPACITY')
        atomic_json(self.path, state, durable=True)

    def pending(self):
        with self.transaction() as state:
            return [dict(e['event']) for e in state['events'] if not e['acked']][:8]

    def unfinished(self):
        with self.transaction() as state:
            terminal = {e['event']['action_id'] for e in state['events'] if e['event']['result'] != 'claimed'}
            return [dict(e['event']) for e in state['events'] if e['event']['result'] == 'claimed' and e['event']['action_id'] not in terminal]

    def _prune(self, state, epoch):
        state['events'] = [e for e in state['events'] if not e['acked'] or epoch - e['epoch'] < 7 * 86400]
        state['claims'] = [c for c in state['claims'] if epoch - c['epoch'] < 7 * 86400]

    def claim(self, incident_id, boot_id, epoch, uptime):
        if not valid_uuid(incident_id) or not valid_uuid(boot_id) or epoch < 1704067200:
            raise ValueError('INVALID_ACTION_CLOCK_OR_ID')
        with self.transaction() as state:
            last = state['last_action_epoch']
            if last is not None and (epoch < last or epoch - last < 1800):
                raise ValueError('ACTION_COOLDOWN_OR_CLOCK_REGRESSION')
            same_boot = [c for c in state['claims'] if c['boot_id'] == boot_id]
            if same_boot and uptime - same_boot[-1]['uptime_seconds'] < 1800:
                raise ValueError('ACTION_COOLDOWN_OR_CLOCK_REGRESSION')
            if any(c['incident_id'] == incident_id or c['boot_id'] == boot_id and not c.get('recovered', False) for c in state['claims']):
                raise ValueError('INCIDENT_ALREADY_CLAIMED')
            if sum(c['epoch'] > epoch - 86400 or c['boot_id'] == boot_id and uptime - c['uptime_seconds'] < 86400 for c in state['claims']) >= 2:
                raise ValueError('ACTION_DAILY_BUDGET')
            self._prune(state, epoch)
            action_id = str(uuid.uuid4())
            event = {'event_id': str(uuid.uuid4()), 'action_id': action_id, 'incident_id': incident_id,
                     'action_time_utc': utc(epoch), 'kind': 'restart_proxy', 'result': 'claimed', 'target_id': 'proxy'}
            state['claims'].append({'action_id': action_id, 'incident_id': incident_id, 'boot_id': boot_id,
                                    'epoch': epoch, 'uptime_seconds': uptime, 'recovered': False})
            state['events'].append({'epoch': epoch, 'acked': False, 'event': event})
            state['last_action_epoch'] = epoch
            # Reserve space for one terminal result before authorizing the call.
            if len(encode(state).encode()) + 1024 > self.maximum:
                raise ValueError('LEDGER_CAPACITY')
            self.save(state)
            return event

    def finish(self, action, result, epoch):
        if result not in ('succeeded', 'failed', 'uncertain'):
            raise ValueError('INVALID_ACTION_RESULT')
        with self.transaction() as state:
            if not any(c['action_id'] == action['action_id'] for c in state['claims']):
                raise ValueError('CLAIM_NOT_DURABLE')
            if any(e['event']['action_id'] == action['action_id'] and e['event']['result'] != 'claimed' for e in state['events']):
                raise ValueError('TERMINAL_ACTION_EXISTS')
            event = dict(action, event_id=str(uuid.uuid4()), action_time_utc=utc(epoch), result=result)
            state['events'].append({'epoch': epoch, 'acked': False, 'event': event})
            self.save(state)
            return event

    def acknowledge(self, ids):
        with self.transaction() as state:
            changed = False
            for event in state['events']:
                if event['event']['event_id'] in ids and not event['acked']:
                    event['acked'] = True
                    changed = True
            if changed:
                self.save(state)

    def recovered(self, boot_id):
        with self.transaction() as state:
            changed = False
            for claim in state['claims']:
                if claim['boot_id'] == boot_id and not claim['recovered']:
                    claim['recovered'] = True
                    changed = True
            if changed:
                self.save(state)
