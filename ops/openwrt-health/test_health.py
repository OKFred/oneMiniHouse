import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from contextlib import nullcontext
from unittest.mock import Mock, patch

from health_core import (ActionLedger, Decisions, MIB, Sampler, mask_process_name, mask_process_path,
                         masked_process_name, masked_process_path, memory_top_process, validate_diagnostics, validate_metrics)
from agent import Publisher, RamQueue, Worker, action_worker, envelope, inspect_proxy, restart_proxy

BOOT = '11111111-1111-4111-8111-111111111111'
NOW = 1800000000


def sample(uptime, available=1024 * MIB, **metrics):
    return {'boot_id': BOOT, 'uptime_seconds': uptime, 'read_time_utc': '2027-01-15T08:00:00.000Z',
            'metrics': {'memory_available_bytes': available, 'memory_total_bytes': 1735 * MIB, **metrics}}


class DecisionsTest(unittest.TestCase):
    def test_sustained_warning_and_critical_not_single_low_sample(self):
        d = Decisions()
        for t in range(300, 360, 10):
            self.assertEqual(d.update(sample(t, 100 * MIB))[0]['memory_pressure']['state'], 'good')
        conditions, eligible = d.update(sample(360, 100 * MIB))
        self.assertEqual(conditions['memory_pressure']['severity'], 'critical')
        self.assertEqual(conditions['memory_pressure']['state'], 'bad')
        self.assertFalse(eligible)
        d = Decisions()
        for t in range(300, 430, 10):
            conditions, _ = d.update(sample(t, 200 * MIB))
        self.assertEqual(conditions['memory_pressure']['severity'], 'warning')

    def test_restart_requires_proxy_growth_and_corroboration(self):
        d = Decisions()
        for t in range(300, 370, 10):
            conditions, eligible = d.update(sample(t, 64 * MIB, proxy_working_set_bytes=600 * MIB, blocked_tasks=3))
        self.assertTrue(eligible)
        incident = conditions['memory_pressure']['incident_id']
        conditions, eligible = d.update(sample(370, 64 * MIB, proxy_working_set_bytes=600 * MIB, blocked_tasks=0, cpu_iowait_pct=0))
        self.assertFalse(eligible)
        self.assertEqual(conditions['memory_pressure']['incident_id'], incident)

    def test_proxy_memory_missing_or_below_threshold_never_restarts(self):
        for metrics in ({'blocked_tasks': 99}, {'blocked_tasks': 99, 'proxy_rss_bytes': 511 * MIB}):
            d = Decisions()
            for t in range(300, 500, 10):
                _, eligible = d.update(sample(t, 10 * MIB, **metrics))
                self.assertFalse(eligible)

    def test_missing_metric_gap_and_reboot_reset_windows(self):
        d = Decisions()
        for t in range(300, 350, 10):
            d.update(sample(t, 64 * MIB))
        missing = sample(350)
        missing['metrics'].pop('memory_available_bytes')
        self.assertEqual(d.update(missing)[0]['memory_pressure']['state'], 'unknown')
        self.assertEqual(d.update(sample(360, 64 * MIB))[0]['memory_pressure']['state'], 'good')
        self.assertEqual(d.update(sample(420, 64 * MIB))[0]['memory_pressure']['state'], 'good')
        changed = sample(430, 64 * MIB)
        changed['boot_id'] = str(uuid.uuid4())
        self.assertEqual(d.update(changed)[0]['memory_pressure']['state'], 'good')

    def test_recovery_requires_full_continuous_safe_window(self):
        d = Decisions()
        for t in range(300, 370, 10):
            old, _ = d.update(sample(t, 64 * MIB))
        for t in range(370, 670, 10):
            current, _ = d.update(sample(t))
            self.assertEqual(current['memory_pressure']['incident_id'], old['memory_pressure']['incident_id'])
        self.assertEqual(d.update(sample(670))[0]['memory_pressure']['state'], 'good')

    def test_io_is_combination_and_missing_psi_is_not_zero(self):
        d = Decisions()
        for t in range(300, 440, 10):
            state, _ = d.update(sample(t, cpu_iowait_pct=90, blocked_tasks=0))
            self.assertEqual(state['io_pressure']['state'], 'good')
        for t in range(440, 570, 10):
            state, _ = d.update(sample(t, cpu_iowait_pct=30, blocked_tasks=4))
        self.assertEqual(state['io_pressure']['state'], 'bad')
        self.assertEqual(state['temperature']['state'], 'unknown')


class SamplerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'sys/kernel/random').mkdir(parents=True)
        (self.root / 'sys/kernel/random/boot_id').write_text(BOOT)
        (self.root / 'uptime').write_text('300.00 1000.00')
        (self.root / 'loadavg').write_text('0.10 0.20 0.30 1/60 100')
        (self.root / 'meminfo').write_text('MemTotal: 1700000 kB\nMemAvailable: 65536 kB\nAnonPages: 1234 kB\nSUnreclaim: 123 kB\n')
        self.cpu('100 100 100 100 100 100 100 100 999999 999999')

    def tearDown(self):
        self.temp.cleanup()

    def cpu(self, row):
        (self.root / 'stat').write_text('cpu ' + row + '\nprocs_blocked 4\n')

    def test_real_proc_format_and_first_delta_missing(self):
        sampler = Sampler(self.root)
        before = sampler.sample(NOW)
        self.assertEqual(before['metrics']['memory_available_bytes'], 64 * MIB)
        self.assertNotIn('cpu_iowait_pct', before['metrics'])
        self.assertNotIn('psi_memory_some_avg10_pct', before['metrics'])
        self.cpu('110 110 110 110 120 110 110 110 999999 999999')
        after = sampler.sample(NOW)
        self.assertAlmostEqual(after['metrics']['cpu_iowait_pct'], 22.222, places=3)

    def test_cgroup_working_set_and_invalid_counter_omitted(self):
        cg = self.root / 'cg'
        cg.mkdir()
        (cg / 'memory.usage_in_bytes').write_text(str(700 * MIB))
        (cg / 'memory.stat').write_text('total_inactive_file ' + str(100 * MIB) + '\ntotal_rss ' + str(500 * MIB) + '\n')
        sampler = Sampler(self.root, memory_cgroup_path=cg)
        self.assertEqual(sampler.sample(NOW)['metrics']['proxy_working_set_bytes'], 600 * MIB)
        (cg / 'memory.stat').write_text('total_inactive_file ' + str(800 * MIB) + '\ntotal_rss 0\n')
        self.assertNotIn('proxy_working_set_bytes', sampler.sample(NOW)['metrics'])

    def test_default_resource_tick_does_not_scan_processes(self):
        sampler = Sampler(self.root)
        with patch('health_core.memory_top_process', return_value={'name_masked': 'ex***', 'rss_bytes': 1024}) as collect:
            self.assertNotIn('diagnostics', sampler.sample(NOW))
            collect.assert_not_called()
            self.assertEqual(sampler.sample(NOW, include_diagnostics=True)['diagnostics']['memory_top_process']['rss_bytes'], 1024)
            collect.assert_called_once_with(self.root)


class ProcessDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def process(self, pid, name='example-worker', rss=123, vsize=999999):
        directory = self.root / str(pid)
        directory.mkdir()
        (directory / 'status').write_text('Name:\t' + name + '\nVmSize:\t' + str(vsize) + ' kB\n'
                                         + ('' if rss is None else 'VmRSS:\t' + str(rss) + ' kB\n'), encoding='utf-8')
        (directory / 'stat').write_text(str(pid) + ' (' + name + ') S ' + '0 ' * 18 + '100\n')
        return directory

    def test_ranking_uses_rss_not_virtual_memory_and_masks_at_source(self):
        self.process(10, 'huge-virtual', rss=10, vsize=9999999)
        self.process(20, 'resident-worker', rss=1000, vsize=1001)
        value = memory_top_process(self.root)
        self.assertEqual(value, {'name_masked': 'residen*-worker', 'rss_bytes': 1000 * 1024})
        self.assertNotIn('resident-worker', json.dumps(value))
        self.assertNotIn('pid', value)

    def test_tiny_names_and_sanitized_unsafe_names_follow_middle_mask_rule(self):
        for index, (name, expected) in enumerate((('x', 'x'), ('xy', 'xy'), ('x/y_token', 'x_y_*oken'), ('温度进程', '_*__'))):
            with self.subTest(name=name):
                directory = self.process(index + 1, name, rss=index + 1)
                self.assertEqual(memory_top_process(self.root)['name_masked'], expected)
                (directory / 'status').unlink(); (directory / 'stat').unlink(); directory.rmdir()

    def test_missing_rss_kernel_thread_is_skipped_and_vanished_process_is_ignored(self):
        self.process(10, 'kernel-worker', rss=None)
        self.process(20, 'example-resident', rss=25)
        (self.root / '30').mkdir()  # Exited after directory enumeration.
        self.assertEqual(memory_top_process(self.root), {'name_masked': 'example*resident', 'rss_bytes': 25 * 1024})

    def test_middle_mask_preserves_remaining_text_with_at_most_one_hidden_character(self):
        for name, expected in (('a', 'a'), ('ab', 'ab'), ('abc', 'a*c'), ('node', 'n*de'),
                               ('nodejs', 'no*ejs'), ('daemon', 'da*mon'), ('example-worker', 'exampl*-worker')):
            with self.subTest(name=name):
                self.assertEqual(mask_process_name(name), expected)
                self.assertEqual(len(expected), len(name))
                self.assertLessEqual(expected.count('*'), 1)
                self.assertTrue(masked_process_name(expected, legacy=False))
        self.assertTrue(masked_process_name('no***'))  # Original wire contract.
        self.assertFalse(masked_process_name('no***', legacy=False))

    def test_executable_path_uses_only_winning_pid_exe_and_can_differ_from_comm(self):
        self.process(10, 'example-service', rss=50)
        self.process(20, 'secondary-worker', rss=10)
        with patch('health_core.os.readlink', return_value='/usr/bin/node') as link:
            value = memory_top_process(self.root)
            self.assertEqual(value['path_masked'], '/usr/bin/n*de')
            self.assertEqual(value['name_masked'], 'example*service')
            link.assert_called_once_with(self.root / '10' / 'exe')
            validate_diagnostics({'memory_top_process': value})

    def test_invalid_deleted_or_unavailable_executable_path_falls_back_to_comm(self):
        self.process(10, 'example-worker', rss=50)
        for path in ('/usr/bin/node (deleted)', '/usr//bin/node', '/usr/../bin/node',
                     '/usr/bin/', 'node', '/usr/private dir/node', '/usr/' + 'x' * 513):
            with self.subTest(path=path[:25]), patch('health_core.os.readlink', return_value=path):
                self.assertNotIn('path_masked', memory_top_process(self.root))
        with patch('health_core.os.readlink', side_effect=PermissionError):
            self.assertNotIn('path_masked', memory_top_process(self.root))

    def test_pid_reuse_or_comm_change_during_executable_read_omits_diagnostics(self):
        directory = self.process(10, 'example-worker', rss=50)
        with patch('health_core.process_start', side_effect=['100', '100', '101']):
            self.assertIsNone(memory_top_process(self.root))
        def changed(_path):
            (directory / 'status').write_text('Name:\tnew-worker\nVmRSS:\t50 kB\n')
            return '/usr/bin/node'
        with patch('health_core.os.readlink', side_effect=changed):
            self.assertIsNone(memory_top_process(self.root))

    def test_non_leaders_do_not_read_stat_or_executable(self):
        import health_core
        self.process(10, 'example-worker', rss=100)
        self.process(20, 'secondary-worker', rss=10)
        with os.scandir(self.root) as directory:
            entries = sorted(directory, key=lambda entry: entry.name)
        with patch('health_core.os.scandir', return_value=nullcontext(entries)), \
             patch('health_core.process_start', wraps=health_core.process_start) as starts, \
             patch('health_core.os.readlink', return_value='/usr/bin/node') as link:
            self.assertEqual(memory_top_process(self.root)['rss_bytes'], 100 * 1024)
            self.assertEqual([call.args[0] for call in starts.call_args_list], [self.root / '10'] * 4)
            link.assert_called_once_with(self.root / '10' / 'exe')

    def test_leader_ranking_uses_identity_bound_reread_not_preliminary_rss(self):
        import health_core
        self.process(10, 'example-worker', rss=100)
        self.process(20, 'secondary-worker', rss=200)
        with os.scandir(self.root) as directory:
            entries = sorted(directory, key=lambda entry: entry.name)
        original_read, seen = health_core.read_small, 0
        def reread(path, maximum=65536):
            nonlocal seen
            if path == self.root / '20' / 'status':
                seen += 1
                if seen > 1:
                    return 'Name:\tsecondary-worker\nVmRSS:\t50 kB\n'
            return original_read(path, maximum)
        with patch('health_core.os.scandir', return_value=nullcontext(entries)), \
             patch('health_core.read_small', side_effect=reread):
            value = memory_top_process(self.root)
            self.assertEqual(value['rss_bytes'], 100 * 1024)
            self.assertEqual(value['name_masked'], 'exampl*-worker')
        self.assertEqual(seen, 2)

    def test_winning_pid_identity_rechecked_after_executable_read(self):
        self.process(10, 'example-worker', rss=50)
        with patch('health_core.process_start', side_effect=['100', '100', '100', '101']):
            self.assertIsNone(memory_top_process(self.root))

    def test_masked_paths_reject_unmasked_or_injected_or_overlong_values(self):
        for raw, expected in (('/usr/bin/node', '/usr/bin/n*de'), ('/x/ab', '/x/ab'),
                              ('/opt/example-daemon', '/opt/exampl*-daemon')):
            with self.subTest(raw=raw):
                self.assertEqual(mask_process_path(raw), expected)
                self.assertTrue(masked_process_path(expected))
        for value in ('/usr/bin/node', '/usr/bin/no***', '/usr/bin/***', '/usr/bin/n****e',
                      '/usr/bin/n**e/../a', '/usr//bin/n**e', 'usr/bin/n**e', '/usr/./n**e',
                      '/usr/bin/n**e\n', '/usr/' + 'a' * 508 + '/n**e', None):
            with self.subTest(value=str(value)[:30]):
                self.assertFalse(masked_process_path(value))

    def test_incomplete_scan_omits_diagnostics_instead_of_claiming_subset_top(self):
        self.process(10, rss=1); self.process(20, rss=1000)
        self.assertIsNone(memory_top_process(self.root, maximum_processes=1))
        self.assertIsNone(memory_top_process(self.root, maximum_entries=1))
        self.assertIsNone(memory_top_process(self.root, clock=Mock(side_effect=[0, 0.21])))
        with patch('health_core.read_small', side_effect=PermissionError):
            self.assertIsNone(memory_top_process(self.root))

    def test_malformed_or_oversize_process_status_omits_all_diagnostics(self):
        directory = self.process(10, rss=1)
        for text in ('Name:\texample-worker\nVmRSS:\tinvalid kB\n', 'VmRSS:\t100 kB\n', 'x' * 8193):
            with self.subTest(text=text[:25]):
                (directory / 'status').write_text(text)
                self.assertIsNone(memory_top_process(self.root))

    def test_optional_wire_diagnostics_validated_and_legacy_wire_unchanged(self):
        s = sample(500); conditions, _ = Decisions().update(s)
        cfg = {'site_id': 'example-site', 'host_id': 'example-host'}
        self.assertNotIn('diagnostics', envelope(cfg, s, conditions, 1, []))
        s['diagnostics'] = {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 1024}}
        value = envelope(cfg, s, conditions, 2, [])
        self.assertEqual(value['diagnostics'], s['diagnostics'])
        validate_diagnostics(value['diagnostics'])
        for bad in (None, {}, {'memory_top_process': {'name_masked': 'example-worker', 'rss_bytes': 1}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': True}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': -1}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 0.5}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 2**53}},
                    {'memory_top_process': {'name_masked': 'ex***', 'rss_bytes': 1, 'pid': 123}},
                    {'memory_top_process': {'name_masked': 'x\n***', 'rss_bytes': 1}},
                    {'memory_top_process': {'name_masked': 'n**e', 'rss_bytes': 1, 'path_masked': '/usr/bin/node'}},
                    {'memory_top_process': {'name_masked': 'n**e', 'rss_bytes': 1, 'path_masked': None}}):
            with self.subTest(bad=bad):
                s['diagnostics'] = bad
                with self.assertRaises(ValueError):
                    envelope(cfg, s, conditions, 3, [])


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.ledger = ActionLedger(self.root / 'ledger')
        self.ledger.initialize()

    def tearDown(self):
        self.temp.cleanup()

    def claim(self, epoch=NOW, incident=None):
        return self.ledger.claim(incident or str(uuid.uuid4()), BOOT, epoch, 500 + epoch - NOW)

    def test_claim_survives_restart_and_is_recorded_before_external_action(self):
        action = self.claim()
        again = ActionLedger(self.root / 'ledger')
        self.assertEqual(again.pending()[0], action)
        with self.assertRaisesRegex(ValueError, 'COOLDOWN'):
            again.claim(str(uuid.uuid4()), BOOT, NOW + 100, 600)
        with self.assertRaisesRegex(ValueError, 'INCIDENT_ALREADY'):
            again.claim(str(uuid.uuid4()), BOOT, NOW + 2000, 2500)

    def test_terminal_event_unique_id_same_action_and_positive_ack_only(self):
        action = self.claim()
        terminal = self.ledger.finish(action, 'uncertain', NOW + 3)
        self.assertNotEqual(action['event_id'], terminal['event_id'])
        self.assertEqual(action['action_id'], terminal['action_id'])
        self.assertEqual(len(self.ledger.pending()), 2)
        self.ledger.acknowledge({action['event_id']})
        self.assertEqual(self.ledger.pending(), [terminal])
        with self.assertRaisesRegex(ValueError, 'TERMINAL'):
            self.ledger.finish(action, 'succeeded', NOW + 4)

    def test_recovered_incidents_still_obey_rolling_two_action_budget(self):
        self.claim()
        self.ledger.recovered(BOOT)
        self.claim(NOW + 1800)
        self.ledger.recovered(BOOT)
        with self.assertRaisesRegex(ValueError, 'DAILY_BUDGET'):
            self.claim(NOW + 3600)

    def test_clock_rollback_and_missing_or_corrupt_ledger_fail_closed(self):
        self.claim()
        with self.assertRaisesRegex(ValueError, 'CLOCK_REGRESSION'):
            self.claim(NOW - 1)
        self.ledger.path.unlink()
        with self.assertRaisesRegex(ValueError, 'LEDGER_MISSING'):
            self.claim()
        self.ledger.path.write_text('{}')
        os.chmod(self.ledger.path, 0o600)
        with self.assertRaisesRegex(ValueError, 'INVALID_LEDGER'):
            self.claim()

    def test_same_boot_uptime_prevents_ntp_forward_cooldown_and_daily_bypass(self):
        self.claim()
        self.ledger.recovered(BOOT)
        with self.assertRaisesRegex(ValueError, 'COOLDOWN'):
            self.ledger.claim(str(uuid.uuid4()), BOOT, NOW + 90000, 600)
        self.ledger.claim(str(uuid.uuid4()), BOOT, NOW + 90000, 2500)
        self.ledger.recovered(BOOT)
        with self.assertRaisesRegex(ValueError, 'DAILY_BUDGET'):
            self.ledger.claim(str(uuid.uuid4()), BOOT, NOW + 180000, 5000)

    def test_reinitialization_never_resets_existing_claim(self):
        self.claim()
        before = self.ledger.path.read_bytes()
        with self.assertRaises(FileExistsError):
            self.ledger.initialize()
        self.assertEqual(before, self.ledger.path.read_bytes())

    def test_capacity_refuses_action_without_overwriting_unacknowledged_event(self):
        self.claim()
        original = self.ledger.path.read_bytes()
        self.ledger.recovered(BOOT)
        original = self.ledger.path.read_bytes()
        self.ledger.maximum = len(original) + 200
        with self.assertRaisesRegex(ValueError, 'CAPACITY'):
            self.claim(NOW + 2000)
        self.assertEqual(self.ledger.path.read_bytes(), original)


class DockerTest(unittest.TestCase):
    def setUp(self):
        self.target = {'container_id': '1' * 64, 'image_id': 'sha256:' + '2' * 64,
                       'compose_project': 'example-proxy', 'compose_service': 'proxy'}

    def inspect(self, start='before'):
        return {'Id': self.target['container_id'], 'Image': self.target['image_id'],
                'Config': {'Labels': {'com.docker.compose.project': 'example-proxy', 'com.docker.compose.service': 'proxy'}},
                'State': {'Running': True, 'Restarting': False, 'StartedAt': start}}

    def test_only_pinned_id_restarted_with_changed_start_verified(self):
        requests = []
        def request(method, path):
            requests.append((method, path))
            return (204, b'') if method == 'POST' else (200, json.dumps(self.inspect('after' if len(requests) == 3 else 'before')).encode())
        self.assertEqual(restart_proxy(self.target, request), 'succeeded')
        self.assertEqual(requests[1], ('POST', '/containers/' + '1' * 64 + '/restart?t=10'))

    def test_name_reuse_image_label_or_running_drift_never_posts(self):
        for kind in ('Id', 'Image', 'label', 'Running'):
            v = self.inspect()
            if kind == 'label':
                v['Config']['Labels']['com.docker.compose.service'] = 'other'
            elif kind == 'Running':
                v['State']['Running'] = False
            else:
                v[kind] = 'other'
            request = Mock(return_value=(200, json.dumps(v).encode()))
            with self.assertRaisesRegex(ValueError, 'IDENTITY'):
                restart_proxy(self.target, request)
            self.assertEqual(request.call_count, 1)

    def test_timeout_after_post_is_uncertain_and_not_retried(self):
        request = Mock(side_effect=[(200, json.dumps(self.inspect()).encode()), TimeoutError()])
        self.assertEqual(restart_proxy(self.target, request), 'uncertain')
        self.assertEqual(request.call_count, 2)

    def test_action_worker_claim_is_durable_before_restart_then_terminal_phase(self):
        import agent
        from health_core import read_small as real_read, atomic_json
        with tempfile.TemporaryDirectory() as root:
            r = Path(root)
            (r / 'ram').mkdir()
            cfg = {'state_directory': str(r / 'ram'), 'persistent_directory': str(r / 'ledger'),
                   'mitigation': {'enabled': True, 'proxy': self.target}}
            ledger = ActionLedger(r / 'ledger')
            ledger.initialize()
            incident = str(uuid.uuid4())
            atomic_json(r / 'ram/latest.json', dict(sample(590), _action_eligible=True,
                        conditions={'memory_pressure': {'incident_id': incident}}))
            def read(path, maximum=65536):
                return BOOT if str(path) == '/proc/sys/kernel/random/boot_id' else real_read(path, maximum)
            def restart(target):
                self.assertEqual(ledger.pending()[0]['result'], 'claimed')
                self.assertEqual(target, self.target)
                return 'succeeded'
            with patch('agent.read_small', side_effect=read), patch('agent.time.clock_gettime', return_value=600), \
                 patch('agent.inspect_proxy', return_value='before'), patch('agent.restart_proxy', side_effect=restart):
                agent.action_worker(cfg, incident)
            self.assertEqual([e['result'] for e in ledger.pending()], ['claimed', 'succeeded'])


class QueueAndWireTest(unittest.TestCase):
    def test_ram_queue_hard_count_size_and_ttl(self):
        with tempfile.TemporaryDirectory() as root:
            q = RamQueue(root, count=2, maximum=1024)
            for i in range(4):
                q.put({'message_id': str(uuid.uuid4()), 'metrics': {'load_1m': i}}, NOW + i)
            self.assertEqual(len(list(q.records(NOW + 4))), 2)
            self.assertEqual(len(list(q.records(NOW + 21610))), 0)

    def test_envelope_exact_contract_no_private_identity_or_commands(self):
        s = sample(500)
        c, _ = Decisions().update(s)
        wire = envelope({'site_id': 'example-site', 'host_id': 'example-host'}, s, c, 1, [])
        self.assertEqual(set(wire), {'schema_version', 'message_id', 'site_id', 'host_id', 'boot_id', 'sequence', 'read_time_utc', 'uptime_seconds', 'metrics', 'conditions', 'actions'})
        self.assertEqual(set(wire['conditions']), {'memory_pressure', 'io_pressure', 'temperature', 'storage'})
        self.assertTrue(all(set(v) == {'state', 'severity', 'incident_id', 'detail_code'} for v in c.values()))
        validate_metrics(wire['metrics'])
        self.assertNotIn('/proc', json.dumps(wire))

    def test_unknown_and_nonfinite_metrics_rejected(self):
        for v in ({'unknown': 1}, {'cpu_iowait_pct': float('nan')}, {'memory_total_bytes': -1}, {'cpu_iowait_pct': 101}):
            with self.assertRaises(ValueError):
                validate_metrics(v)


class WorkerTest(unittest.TestCase):
    def test_live_worker_marker_blocks_replacement_including_after_parent_restart(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / 'probe-worker.json'
            p.write_text(json.dumps({'pid': 999, 'start': '123'}))
            worker = Worker({'state_directory': root}, '/example/config', 'probe', 4)
            with patch('agent.process_start', return_value='123'), patch('agent.subprocess.Popen') as spawn:
                self.assertFalse(worker.launch())
                spawn.assert_not_called()

    def test_timed_out_uninterruptible_child_killed_only_once_never_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            worker = Worker({'state_directory': root}, '/example/config', 'probe', 4)
            worker.process = Mock()
            worker.process.poll.return_value = None
            worker.started = 0
            with patch('agent.time.monotonic', return_value=100):
                worker.poll()
                worker.poll()
                self.assertFalse(worker.launch())
            worker.process.kill.assert_called_once()


class PublisherTest(unittest.TestCase):
    def publisher(self, reason_failure=False, ready=True):
        client = Mock()
        info = Mock()
        info.rc, info.mid = 0, 9
        info.is_published.return_value = ready
        def publish(*args, **kwargs):
            reason = Mock()
            reason.is_failure = reason_failure
            client.on_publish(client, None, 9, reason, None)
            return info
        client.publish.side_effect = publish
        cfg = {'site_id': 'example-site', 'host_id': 'example-host', 'mqtt': {
            'url': 'mqtts://mqtt.example.net:8883', 'client_id': 'example-publisher',
            'username': 'example-writer', 'password_file': '/example/password'}}
        with patch('agent.private_file', return_value='synthetic-password'):
            publisher = Publisher(cfg, lambda: client)
        publisher.connected.set()
        return publisher, client, info

    def test_positive_puback_required_and_qos1_no_retain_tls_verified(self):
        pub, client, _ = self.publisher()
        self.assertTrue(pub.send(b'{}'))
        client.publish.assert_called_once_with('iot/v1/example-site/example-host/host-health', b'{}', qos=1, retain=False)
        context = client.tls_set_context.call_args.args[0]
        self.assertTrue(context.check_hostname)
        import ssl
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(client.max_queued_messages_set.call_args.args, (2,))

    def test_negative_puback_never_confirms(self):
        pub, _, _ = self.publisher(reason_failure=True)
        self.assertFalse(pub.send(b'{}'))

    def test_timeout_reuses_single_pending_mid_instead_of_unbounded_paho_queue(self):
        pub, client, info = self.publisher(ready=False)
        self.assertFalse(pub.send(b'{}'))
        self.assertFalse(pub.send(b'{}'))
        self.assertFalse(pub.send(b'{"next":1}'))
        client.publish.assert_called_once()
        info.is_published.return_value = True
        self.assertTrue(pub.send(b'{}'))


class IsolationTest(unittest.TestCase):
    def test_sampling_loop_never_constructs_ledger_or_performs_durable_write(self):
        import agent
        from health_core import atomic_json as real_atomic
        with tempfile.TemporaryDirectory() as root:
            cfg = {'site_id': 'example-site', 'host_id': 'example-host', 'state_directory': root,
                   'persistent_directory': '/unavailable-storage', 'mitigation': {'enabled': False}}
            stop = Mock()
            stop.is_set.side_effect = [False, False, True]
            worker = Mock()
            worker.poll.return_value = None
            worker.busy.return_value = False
            worker.process = None
            worker.killed = False
            sampler = Mock()
            sampler.sample.return_value = sample(1000)
            def guarded_atomic(path, value, durable=False):
                self.assertFalse(durable)
                self.assertTrue(Path(path).is_relative_to(root))
                return real_atomic(path, value)
            with patch('agent.Worker', return_value=worker), patch('agent.Sampler', return_value=sampler), \
                 patch('agent.ActionLedger', side_effect=AssertionError('Sampler touched ledger')), \
                 patch('agent.atomic_json', side_effect=guarded_atomic):
                agent.sample_loop(cfg, '/example/config', stop)
            self.assertEqual(len(list((Path(root) / 'queue').glob('*.json'))), 1)


if __name__ == '__main__':
    unittest.main()
