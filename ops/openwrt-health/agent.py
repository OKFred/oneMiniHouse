#!/usr/bin/env python3
"""Native OpenWrt health publisher and narrowly scoped local proxy guard."""
import argparse
import contextlib
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import subprocess
import sys
import threading
import time
import uuid
from urllib.parse import urlparse

VENDOR = Path(__file__).resolve().parent / 'vendor'
if VENDOR.is_dir():
    sys.path.insert(0, str(VENDOR))

from health_core import (ActionLedger, CONDITIONS, Decisions, MIB, Sampler,
                         atomic_json, encode, memory_top_process, read_small, utc, valid_uuid, validate_diagnostics, validate_metrics)


def private_file(path, maximum=65536):
    path = Path(path)
    info = path.lstat()
    if path.resolve() != path or not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != 0:
        raise ValueError('PRIVATE_FILE_REQUIRED')
    return read_small(path, maximum)


def config(path):
    cfg = json.loads(private_file(path))
    for key in ('site_id', 'host_id'):
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', cfg.get(key, '')):
            raise ValueError('INVALID_IDENTITY')
    cfg.setdefault('state_directory', '/tmp/one-minihouse-host-health')
    cfg.setdefault('persistent_directory', '/root/.local/share/one-minihouse-host-health')
    for key in ('state_directory', 'persistent_directory'):
        p = Path(cfg[key])
        if not p.is_absolute() or '..' in p.parts or p.resolve() != p:
            raise ValueError('INVALID_STATE_DIRECTORY')
    if not Path(cfg['state_directory']).is_relative_to('/tmp') or cfg['state_directory'] == '/tmp':
        raise ValueError('RAM_STATE_REQUIRED')
    if Path(cfg['persistent_directory']).is_relative_to(Path('/tmp')):
        raise ValueError('DURABLE_LEDGER_REQUIRED')
    m = cfg['mqtt']
    url = urlparse(m['url'])
    if url.scheme != 'mqtts' or not url.hostname or url.username or url.password or url.path not in ('', '/') or url.query or url.fragment:
        raise ValueError('MQTT_TLS_REQUIRED')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', m['client_id']) or not isinstance(m['username'], str) or not m['username']:
        raise ValueError('INVALID_MQTT_IDENTITY')
    if not Path(m['password_file']).is_absolute():
        raise ValueError('PASSWORD_FILE_REQUIRED')
    cfg.setdefault('mounts', {})
    if set(cfg['mounts']) - {'rootfs', 'datafs'} or any(not Path(v).is_absolute() for v in cfg['mounts'].values()):
        raise ValueError('INVALID_MOUNTS')
    mitigation = cfg.setdefault('mitigation', {'enabled': False})
    if type(mitigation.get('enabled')) is not bool:
        raise ValueError('INVALID_MITIGATION')
    if mitigation['enabled'] or 'proxy' in mitigation:
        target = mitigation['proxy']
        if set(target) != {'container_id', 'image_id', 'compose_project', 'compose_service', 'memory_cgroup_path'}:
            raise ValueError('INVALID_PROXY_PIN')
        if not re.fullmatch(r'[0-9a-f]{64}', target['container_id']) or not re.fullmatch(r'sha256:[0-9a-f]{64}', target['image_id']):
            raise ValueError('FULL_PROXY_ID_REQUIRED')
        if any(not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,100}', target[k]) for k in ('compose_project', 'compose_service')):
            raise ValueError('INVALID_COMPOSE_PIN')
        cg = Path(target['memory_cgroup_path'])
        if not cg.is_relative_to('/sys/fs/cgroup/memory') or cg.name != target['container_id'] or cg.resolve() != cg:
            raise ValueError('PINNED_CGROUP_V1_REQUIRED')
    return cfg


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self):
        super().__init__('localhost', timeout=2)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(2)
        self.sock.connect('/var/run/docker.sock')


def docker_request(method, path):
    connection = UnixHTTP()
    try:
        connection.request(method, path, headers={'Host': 'localhost', 'Content-Length': '0'})
        response = connection.getresponse()
        raw = response.read(1048577)
        if len(raw) > 1048576:
            raise ValueError('DOCKER_RESPONSE_LIMIT')
        return response.status, raw
    finally:
        connection.close()


def inspect_proxy(target, request=docker_request):
    status, raw = request('GET', '/containers/' + target['container_id'] + '/json')
    if status != 200:
        raise ValueError('PROXY_INSPECT_FAILED')
    v = json.loads(raw)
    labels = v.get('Config', {}).get('Labels') or {}
    if (v.get('Id') != target['container_id'] or v.get('Image') != target['image_id']
            or labels.get('com.docker.compose.project') != target['compose_project']
            or labels.get('com.docker.compose.service') != target['compose_service']
            or v.get('State', {}).get('Running') is not True or v['State'].get('Restarting') is True):
        raise ValueError('PROXY_IDENTITY_CHANGED')
    return v['State']['StartedAt']


def restart_proxy(target, request=docker_request):
    # Inspection never derives a target name, command or new container identity.
    before = inspect_proxy(target, request)
    try:
        status, _ = request('POST', '/containers/' + target['container_id'] + '/restart?t=10')
    except (OSError, ValueError, http.client.HTTPException):
        return 'uncertain'
    if status != 204:
        return 'failed'
    try:
        after = inspect_proxy(target, request)
        return 'succeeded' if after != before else 'uncertain'
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        return 'uncertain'


def probe(cfg):
    metrics = {}
    for name, path in cfg['mounts'].items():
        try:
            v = os.statvfs(path)
            total, free = v.f_blocks * v.f_frsize, v.f_bavail * v.f_frsize
            if total <= 0 or not 0 <= free <= total:
                raise ValueError('FILESYSTEM_PROBE')
            metrics[name + '_free_bytes'] = free
            metrics[name + '_used_pct'] = round(100 * (total - free) / total, 3)
        except (OSError, ValueError):
            pass
    target = cfg.get('mitigation', {}).get('proxy')
    identity_ok = False
    if target:
        try:
            inspect_proxy(target)
            identity_ok = True
        except (OSError, ValueError, KeyError, http.client.HTTPException):
            pass
    return {'metrics': metrics, 'proxy_identity_ok': identity_ok}


def notify(cfg):
    atomic_json(Path(cfg['state_directory']) / 'actions-notify.json', {'nonce': str(uuid.uuid4())})


def action_worker(cfg, incident):
    """One isolated action. Failure after intent claim can never cause a retry."""
    root = Path(cfg['state_directory'])
    latest = json.loads(read_small(root / 'latest.json'))
    elapsed = time.clock_gettime(time.CLOCK_BOOTTIME) - latest['uptime_seconds']
    if (not 0 <= elapsed <= 15 or latest['boot_id'] != read_small('/proc/sys/kernel/random/boot_id', 64).strip()
            or latest['conditions']['memory_pressure']['incident_id'] != incident or not latest.get('_action_eligible')):
        raise ValueError('ACTION_OBSERVATION_STALE')
    # Confirm identity before claiming, then again immediately before POST.
    inspect_proxy(cfg['mitigation']['proxy'])
    ledger = ActionLedger(cfg['persistent_directory'])
    action = ledger.claim(incident, latest['boot_id'], time.time(), latest['uptime_seconds'])
    notify(cfg)
    try:
        result = restart_proxy(cfg['mitigation']['proxy'])
    except (OSError, ValueError, KeyError, http.client.HTTPException):
        result = 'failed'
    ledger.finish(action, result, time.time())
    notify(cfg)


def ledger_worker(cfg):
    """All sampling-side persistent I/O belongs in this bounded helper."""
    root = Path(cfg['state_directory'])
    ledger = ActionLedger(cfg['persistent_directory'])
    request = json.loads(read_small(root / 'ledger-request.json', 4096))
    reconciled = recovered = False
    if request.get('reconcile'):
        for unfinished in ledger.unfinished():
            ledger.finish(unfinished, 'uncertain', time.time())
        reconciled = True
    latest = json.loads(read_small(root / 'latest.json'))
    elapsed = time.clock_gettime(time.CLOCK_BOOTTIME) - latest['uptime_seconds']
    if (request.get('recover') and 0 <= elapsed <= 15 and latest.get('_ledger_recovery') is True
            and latest['metrics'].get('memory_available_bytes', -1) >= 320 * MIB
            and latest['conditions']['memory_pressure']['state'] == 'good'):
        ledger.recovered(latest['boot_id'])
        recovered = True
    atomic_json(root / 'pending-actions.json', {'actions': ledger.pending()})
    return {'ok': True, 'reconciled': reconciled, 'recovered': recovered}


def process_start(pid):
    text = read_small('/proc/' + str(pid) + '/stat', 4096)
    # comm may contain spaces/parentheses; the final ')' precedes fixed fields.
    return text[text.rfind(')') + 2:].split()[19]


class Worker:
    """A timed-out live/D-state helper blocks replacements instead of respawning."""
    def __init__(self, cfg, config_path, role, deadline):
        self.cfg, self.config_path, self.role, self.deadline = cfg, config_path, role, deadline
        self.state = Path(cfg['state_directory']) / (role + '-worker.json')
        self.process = None
        self.started = None
        self.killed = False

    def busy(self):
        if not self.state.exists():
            return False
        try:
            prior = json.loads(read_small(self.state, 1024))
            if process_start(prior['pid']) == prior['start']:
                return True
        except (OSError, ValueError, KeyError, IndexError):
            pass
        self.state.unlink(missing_ok=True)
        return False

    def launch(self, incident=None):
        if self.process or self.busy():
            return False
        args = [sys.executable, '-B', str(Path(__file__).resolve()), '--config', self.config_path, '--role', self.role]
        if incident:
            args += ['--incident', incident]
        self.process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        self.started, self.killed = time.monotonic(), False
        try:
            atomic_json(self.state, {'pid': self.process.pid, 'start': process_start(self.process.pid)})
        except OSError:
            # An already completed child is handled normally in poll().
            pass
        return True

    def poll(self):
        if not self.process:
            return None
        result = self.process.poll()
        if result is None:
            if not self.killed and time.monotonic() - self.started > self.deadline:
                self.process.kill()
                self.killed = True
            return None
        raw = self.process.stdout.read(65537)
        self.process.stdout.close()
        self.process = None
        self.killed = False
        self.state.unlink(missing_ok=True)
        if result or len(raw) > 65536:
            return {'ok': False}
        try:
            return json.loads(raw)
        except (ValueError, UnicodeError):
            return {'ok': False}


class RamQueue:
    def __init__(self, directory, count=360, maximum=2 * MIB):
        self.root = Path(directory) / 'queue'
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.count, self.maximum = count, maximum

    def prune(self, epoch):
        files = sorted(self.root.glob('*.json'))
        total = sum(p.stat().st_size for p in files)
        remaining = len(files)
        for path in files:
            born = float(path.name.split('-', 1)[0])
            if remaining > self.count or total > self.maximum or epoch - born >= 21600 or born > epoch + 60:
                size = path.stat().st_size
                path.unlink(missing_ok=True)
                total -= size
                remaining -= 1

    def put(self, envelope, epoch):
        if len(encode(envelope).encode()) > 8192:
            raise ValueError('HOST_HEALTH_PAYLOAD_LIMIT')
        atomic_json(self.root / (str(int(epoch)) + '-' + str(envelope.get('sequence', 0)).zfill(12) + '-' + envelope['message_id'] + '.json'), envelope)
        self.prune(epoch)

    def records(self, epoch):
        self.prune(epoch)
        for path in sorted(self.root.glob('*.json')):
            try:
                raw = path.read_bytes()
                if len(raw) <= 8192:
                    yield path, raw
            except FileNotFoundError:
                continue


def envelope(cfg, sample, conditions, sequence, actions):
    value = {'schema_version': 1, 'message_id': str(uuid.uuid4()), 'site_id': cfg['site_id'],
             'host_id': cfg['host_id'], 'boot_id': sample['boot_id'], 'sequence': sequence,
             'read_time_utc': sample['read_time_utc'], 'uptime_seconds': sample['uptime_seconds'],
             'metrics': sample['metrics'], 'conditions': conditions, 'actions': actions}
    if 'diagnostics' in sample:
        validate_diagnostics(sample['diagnostics'])
        value['diagnostics'] = sample['diagnostics']
    return value


def evidence(cfg, sample, conditions):
    """At most 2 MiB/7 days of already bounded snapshots; no app log/secret reads."""
    root = Path(cfg['persistent_directory']) / 'evidence'
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    now = time.time()
    value = {'read_time_utc': sample['read_time_utc'], 'boot_id': sample['boot_id'],
             'uptime_seconds': sample['uptime_seconds'], 'metrics': sample['metrics'], 'conditions': conditions}
    processes = []
    for path in list(Path('/proc').glob('[0-9]*/status'))[:512]:
        try:
            text = read_small(path, 8192)
            rss = re.search(r'^VmRSS:\s+(\d+)\s+kB$', text, re.M)
            state = re.search(r'^State:\s+(\w)', text, re.M)
            name = re.search(r'^Name:\s+([^\n]+)', text, re.M)
            if rss and state and name:
                processes.append({'pid': int(path.parent.name), 'rss_bytes': int(rss.group(1)) * 1024,
                                  'state': state.group(1), 'comm': re.sub(r'[^A-Za-z0-9_.-]', '_', name.group(1))[:32]})
        except (OSError, ValueError):
            continue
    value['top_rss'] = sorted(processes, key=lambda p: p['rss_bytes'], reverse=True)[:8]
    value['blocked_processes'] = [p for p in processes if p['state'] == 'D'][:8]
    atomic_json(root / (str(int(now)) + '-' + uuid.uuid4().hex + '.json'), value, durable=True)
    files = sorted(root.glob('*.json'))
    total = sum(p.stat().st_size for p in files)
    for path in files:
        if now - path.stat().st_mtime > 7 * 86400 or total > 2 * MIB:
            size = path.stat().st_size
            path.unlink()
            total -= size


def sample_loop(cfg, config_path, stop):
    root = Path(cfg['state_directory'])
    sampler = Sampler(thermal_path=cfg.get('thermal_path'), memory_cgroup_path=cfg.get('mitigation', {}).get('proxy', {}).get('memory_cgroup_path'))
    decisions, queue = Decisions(), RamQueue(root)
    prober, actor = Worker(cfg, config_path, 'probe', 4), Worker(cfg, config_path, 'action', 20)
    collector = Worker(cfg, config_path, 'evidence', 4)
    keeper = Worker(cfg, config_path, 'ledger', 4)
    last_sample = last_probe = last_publish = -1000
    previous_conditions, probe_result = None, None
    probe_time, sequence, seen_actions, attempted_incidents = None, 0, set(), set()
    try:
        previous = json.loads(read_small(root / 'latest.json'))
        if previous['boot_id'] == read_small('/proc/sys/kernel/random/boot_id', 64).strip():
            sequence = previous.get('sequence', 0)
            decisions.active = {k: {name: v[name] for name in ('incident_id', 'severity', 'detail_code')}
                                for k, v in previous['conditions'].items()
                                if k in CONDITIONS and v['state'] == 'bad' and valid_uuid(v['incident_id'])}
    except (OSError, ValueError):
        pass
    sample, conditions, pending = None, None, []
    notify_version, ledger_recovered = None, False
    needs_reconcile, last_ledger = True, -1000
    while not stop.is_set():
        now = time.monotonic()
        result = prober.poll()
        if result and result.get('ok'):
            probe_result, probe_time = result, now
        action_result = actor.poll()
        collector.poll()
        keeper_result = keeper.poll()
        if keeper_result and keeper_result.get('ok'):
            if keeper_result.get('reconciled'):
                needs_reconcile = False
            if keeper_result.get('recovered'):
                ledger_recovered = True
        if action_result and not action_result.get('ok') or actor.killed:
            needs_reconcile = True
        if now - last_probe >= 60:
            prober.launch()
            last_probe = now
        if now - last_sample >= 10:
            last_sample = now
            try:
                sample = sampler.sample()
                if probe_result and now - probe_time <= 90:
                    sample['metrics'].update(probe_result['metrics'])
                conditions, eligible = decisions.update(sample)
                sequence += 1
                safe = sample['metrics'].get('memory_available_bytes', -1) >= 320 * MIB
                recovered = decisions.windows.holds('ledger_recovery', safe, sample['uptime_seconds'], 300)
                latest = dict(sample, conditions=conditions, sequence=sequence, _action_eligible=eligible, _ledger_recovery=recovered)
                atomic_json(root / 'latest.json', latest)
                changed = conditions != previous_conditions
                if changed and any(v['state'] == 'bad' for v in conditions.values()):
                    collector.launch()
                previous_conditions = conditions
                if not safe:
                    ledger_recovered = False
                if cfg['mitigation']['enabled'] and eligible and probe_result and now - probe_time <= 90 and probe_result['proxy_identity_ok']:
                    incident = conditions['memory_pressure']['incident_id']
                    if incident not in attempted_incidents and actor.launch(incident):
                        attempted_incidents.add(incident)
            except (OSError, ValueError, KeyError):
                sample, conditions, changed = None, None, False
        else:
            changed = False
        if sample and time.time() >= 1704067200:
            try:
                marker = root / 'actions-notify.json'
                version = marker.stat().st_mtime_ns if marker.exists() else 0
                ledger_due = version != notify_version or now - last_ledger >= 60 or recovered and not ledger_recovered or needs_reconcile
                if ledger_due and now - last_ledger >= 2 and not keeper.process and not keeper.busy():
                    atomic_json(root / 'ledger-request.json', {'reconcile': needs_reconcile and (not actor.busy() or actor.killed),
                                                               'recover': recovered and not ledger_recovered})
                    if keeper.launch():
                        last_ledger, notify_version = now, version
                pending = json.loads(read_small(root / 'pending-actions.json', 8192))['actions']
            except (OSError, ValueError):
                pending = []
            new_actions = any(a['event_id'] not in seen_actions for a in pending)
            if changed or new_actions or now - last_publish >= 60:
                # Only scan at publication (normally once/minute), not each 10s
                # resource tick. Metrics are from the most recent resource tick.
                sample.pop('diagnostics', None)
                process = memory_top_process()
                if process is not None:
                    sample['diagnostics'] = {'memory_top_process': process}
                sequence += 1
                record = envelope(cfg, sample, conditions, sequence, pending)
                queue.put(record, time.time())
                latest = dict(sample, conditions=conditions, sequence=sequence, _action_eligible=eligible, _ledger_recovery=recovered)
                atomic_json(root / 'latest.json', latest)
                seen_actions.update(a['event_id'] for a in pending)
                last_publish = now
        atomic_json(root / 'agent-status.json', {'heartbeat_time_utc': utc(), 'quality': 'ok' if sample else 'degraded',
                                                'probe_worker_stalled': prober.busy() and prober.killed,
                                                'action_worker_stalled': actor.busy() and actor.killed,
                                                'evidence_worker_stalled': collector.busy() and collector.killed,
                                                'ledger_worker_stalled': keeper.busy() and keeper.killed})
        stop.wait(1)


class Publisher:
    def __init__(self, cfg, client_factory=None):
        if client_factory is None:
            import paho.mqtt.client as mqtt
            client_factory = lambda: mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=cfg['mqtt']['client_id'], protocol=mqtt.MQTTv5)
        self.cfg, self.client = cfg, client_factory()
        self.acks, self.connected, self.pending = {}, threading.Event(), None
        self.client.max_inflight_messages_set(1)
        self.client.max_queued_messages_set(2)
        self.client.reconnect_delay_set(min_delay=5, max_delay=60)
        self.client.on_connect = self.on_connect
        self.client.on_disconnect = lambda *args: self.connected.clear()
        self.client.on_publish = self.on_publish
        password = private_file(cfg['mqtt']['password_file'], 4096).rstrip('\r\n')
        if not password or '\x00' in password:
            raise ValueError('INVALID_MQTT_PASSWORD')
        self.client.username_pw_set(cfg['mqtt']['username'], password)
        self.client.tls_set_context(ssl.create_default_context())
        url = urlparse(cfg['mqtt']['url'])
        self.client.connect_async(url.hostname, url.port or 8883, keepalive=30)
        self.client.loop_start()

    def on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            self.connected.set()

    def on_publish(self, client, userdata, mid, reason_code, properties):
        self.acks[mid] = not reason_code.is_failure
        if len(self.acks) > 32:
            self.acks.pop(next(iter(self.acks)))

    def send(self, raw):
        if not self.connected.wait(1):
            return False
        topic = 'iot/v1/' + self.cfg['site_id'] + '/' + self.cfg['host_id'] + '/host-health'
        digest = hashlib.sha256(raw).hexdigest()
        if self.pending is None:
            info = self.client.publish(topic, raw, qos=1, retain=False)
            if info.rc != 0:
                return False
            self.pending = digest, info
        else:
            prior_digest, info = self.pending
            if prior_digest != digest:
                if not info.is_published():
                    return False
                self.acks.pop(info.mid, None)
                self.pending = None
                return False
        try:
            info.wait_for_publish(timeout=10)
            if not info.is_published():
                return False
            result = self.acks.pop(info.mid, False)
            self.pending = None
            return result
        except (RuntimeError, ValueError):
            return False

    def close(self):
        self.client.disconnect()
        self.client.loop_stop()


def publish_loop(cfg, stop):
    queue, ledger, publisher = RamQueue(cfg['state_directory']), ActionLedger(cfg['persistent_directory']), Publisher(cfg)
    try:
        while not stop.is_set():
            try:
                for path, raw in queue.records(time.time()):
                    if not publisher.send(raw):
                        break
                    record = json.loads(raw)
                    # Positive PUBACK must precede both event ACK and queue removal.
                    if record['actions']:
                        ledger.acknowledge({a['event_id'] for a in record['actions']})
                        notify(cfg)
                    path.unlink(missing_ok=True)
                    atomic_json(Path(cfg['state_directory']) / 'publisher-status.json', {'last_publish_time_utc': utc()})
            except (OSError, ValueError, KeyError):
                pass
            stop.wait(2)
    finally:
        publisher.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--role', choices=('sample', 'publish', 'probe', 'action', 'evidence', 'ledger', 'once', 'check', 'initialize-ledger'), required=True)
    parser.add_argument('--incident')
    args = parser.parse_args()
    cfg = config(args.config)
    root = Path(cfg['state_directory'])
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.resolve() != root or root.stat().st_mode & 0o077:
        raise ValueError('UNSAFE_RUNTIME_DIRECTORY')
    if args.role == 'check':
        print(encode({'ok': True, 'configuration_valid': True, 'services_started': False}))
        return
    if args.role == 'initialize-ledger':
        ActionLedger(cfg['persistent_directory']).initialize()
        print('{"ok":true,"ledger_initialized":true,"services_started":false}')
        return
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    if args.role == 'probe':
        print(encode(dict(ok=True, **probe(cfg))))
    elif args.role == 'action':
        if not cfg['mitigation']['enabled'] or not valid_uuid(args.incident):
            raise ValueError('ACTION_DISABLED')
        action_worker(cfg, args.incident)
        print('{"ok":true}')
    elif args.role == 'ledger':
        print(encode(ledger_worker(cfg)))
    elif args.role == 'once':
        s = Sampler(thermal_path=cfg.get('thermal_path'), memory_cgroup_path=cfg.get('mitigation', {}).get('proxy', {}).get('memory_cgroup_path')).sample(include_diagnostics=True)
        p = probe(cfg)
        s['metrics'].update(p['metrics'])
        c, _ = Decisions().update(s)
        print(encode(envelope(cfg, s, c, 1, [])))
    elif args.role == 'evidence':
        latest = json.loads(read_small(root / 'latest.json'))
        evidence(cfg, latest, latest['conditions'])
        print('{"ok":true}')
    elif args.role == 'sample':
        sample_loop(cfg, args.config, stop)
    else:
        publish_loop(cfg, stop)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never emit Docker bodies, file contents, secrets or arbitrary exception text.
        print('{"event":"openwrt_host_health_failed"}', file=sys.stderr)
        raise SystemExit(1)
