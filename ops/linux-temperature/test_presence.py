import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from presence import Presence
from agent import Transport


class PresenceTests(unittest.TestCase):
    def test_session_will_has_no_fabricated_time_and_reconnect_retires_old_session(self):
        now = [5.0]
        p = Presence('example', 'host', 'temperature-host', 'collector', now=lambda: now[0])
        will = p.begin()
        self.assertIsNone(will['source_time_utc'])
        self.assertIsNone(will['uptime_ms'])
        self.assertIsNone(will['sequence'])
        birth = p.message('online', True, 'connected')
        self.assertEqual(birth['session_id'], will['session_id'])
        self.assertEqual(birth['sequence'], 1)
        now[0] = 66.0
        heartbeat = p.message('heartbeat', True, 'heartbeat')
        self.assertEqual(heartbeat['uptime_ms'], 61000)
        self.assertEqual(heartbeat['sequence'], 2)
        self.assertNotEqual(p.begin()['session_id'], birth['session_id'])
        self.assertLess(len(json.dumps(heartbeat).encode()), 1024)

    def test_only_live_main_tick_sends_heartbeat_and_degraded_sensor_does_not_hide_online(self):
        t = Transport.__new__(Transport)
        import threading
        t.presence = Presence('example', 'host', 'temperature-host', 'collector')
        t.presence.begin()
        t.presence_topic, t.presence_lock = 'example/status', threading.Lock()
        t.presence_birth_pending, t.last_presence_at, t.generation = True, 0, 1
        connected = [True]
        t.client = SimpleNamespace(is_connected=lambda: connected[0])
        t.publish = Mock()
        self.assertTrue(t.presence_tick('degraded'))
        birth = json.loads(t.publish.call_args.args[1])
        self.assertTrue(birth['online'])
        self.assertEqual(birth['quality'], 'degraded')
        t.last_presence_at -= 61
        self.assertFalse(t.presence_tick(birth_only=True))
        self.assertTrue(t.presence_tick('degraded'))
        self.assertEqual(json.loads(t.publish.call_args.args[1])['event'], 'heartbeat')
        connected[0] = False
        t.last_presence_at -= 61
        count = t.publish.call_count
        self.assertFalse(t.presence_tick())
        self.assertEqual(t.publish.call_count, count)
        will_client = SimpleNamespace(will_set=Mock())
        t.prepare_presence(will_client, None)
        t.presence_birth_pending = True
        connected[0] = True
        self.assertTrue(t.presence_tick())
        self.assertNotEqual(json.loads(t.publish.call_args.args[1])['session_id'], birth['session_id'])


if __name__ == '__main__':
    unittest.main()
