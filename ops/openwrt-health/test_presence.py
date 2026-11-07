import json
import sys
from types import ModuleType
import unittest
from unittest.mock import Mock, patch

# Transport-only tests do not exercise Linux file locks.
with patch.dict(sys.modules, {'fcntl': ModuleType('fcntl')} if sys.platform == 'win32' else {}):
    import agent as presence_agent


class PresenceTests(unittest.TestCase):
    def publisher(self, accepted=True):
        client = Mock()
        info = Mock(rc=0, mid=5)
        info.is_published.return_value = True
        def publish(*args, **kwargs):
            client.on_publish(client, None, 5, Mock(is_failure=not accepted), None)
            return info
        client.publish.side_effect = publish
        cfg = {'site_id': 'example-site', 'host_id': 'example-host', 'mqtt': {
            'client_id': 'example-publisher', 'url': 'mqtts://mqtt.example.net:8883',
            'username': 'example-writer', 'password_file': '/example/password'}}
        with patch.object(presence_agent, 'private_file', return_value='synthetic-password'):
            p = presence_agent.Publisher(cfg, lambda: client)
        p.on_connect(client, None, None, 0, None)
        return p, client

    def test_birth_will_heartbeat_and_graceful_offline_share_connection_without_outbox(self):
        p, client = self.publisher()
        will = json.loads(client.will_set.call_args.args[1])
        self.assertIsNone(will['source_time_utc'])
        self.assertIsNone(will['sequence'])
        self.assertTrue(p.tick_presence(progress=False))
        birth = json.loads(client.publish.call_args.args[1])
        self.assertEqual(birth['event'], 'online')
        self.assertEqual(birth['session_id'], will['session_id'])
        p.last_presence_at -= 61
        self.assertFalse(p.tick_presence(progress=False))
        self.assertTrue(p.tick_presence(progress=True))
        self.assertEqual(json.loads(client.publish.call_args.args[1])['event'], 'heartbeat')
        p.close()
        shutdown = json.loads(client.publish.call_args.args[1])
        self.assertEqual(shutdown['reason'], 'shutdown')
        self.assertFalse(shutdown['online'])
        client.disconnect.assert_called_once()

    def test_disconnect_does_not_cache_heartbeats_and_new_connect_rotates_session(self):
        p, client = self.publisher()
        self.assertTrue(p.tick_presence())
        old = json.loads(client.publish.call_args.args[1])
        client.on_disconnect(client, None, None, None, None)
        p.last_presence_at -= 61
        self.assertFalse(p.tick_presence())
        client.publish.reset_mock()
        p.prepare_presence(client, None)
        p.on_connect(client, None, None, 0, None)
        self.assertTrue(p.tick_presence())
        client.publish.assert_called_once()
        new = json.loads(client.publish.call_args.args[1])
        self.assertEqual(new['event'], 'online')
        self.assertNotEqual(new['session_id'], old['session_id'])

    def test_negative_puback_does_not_advance_presence_watermark(self):
        p, client = self.publisher(accepted=False)
        self.assertFalse(p.tick_presence())
        self.assertTrue(p.presence_birth_pending)
        self.assertEqual(p.last_presence_at, 0)
        self.assertFalse(p.tick_presence())
        client.publish.assert_called_once()


if __name__ == '__main__':
    unittest.main()
