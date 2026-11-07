"""Opt-in real-broker checks. Run only against a disposable anonymous broker."""
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest.mock import patch

import agent as linux


def wait_until(predicate, seconds=12):
    deadline = time.monotonic() + seconds
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError('Synthetic MQTT condition timed out')
        time.sleep(.02)


class AckProxy:
    """A real TCP relay which can drop PUBACK, leaving the real SDK in-flight."""
    def __init__(self, upstream):
        self.upstream, self.drop_acks, self.reject_acks, self.disconnects = upstream, False, False, 0
        self.sockets, self.stopped = [], threading.Event()
        self.listener = socket.create_server(('127.0.0.1', 0))
        self.listener.settimeout(.2)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self.accept, daemon=True)
        self.thread.start()

    def accept(self):
        while not self.stopped.is_set():
            try:
                client, _ = self.listener.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            server = socket.create_connection(self.upstream)
            self.sockets.extend((client, server))
            threading.Thread(target=self.relay, args=(client, server), daemon=True).start()

    def relay(self, client, server):
        buffers = {client: bytearray(), server: bytearray()}
        try:
            while not self.stopped.is_set():
                ready, _, _ = select.select((client, server), (), (), .2)
                for origin in ready:
                    data = origin.recv(65536)
                    if not data:
                        return
                    pending = buffers[origin]
                    pending.extend(data)
                    while len(pending) >= 2:
                        length, factor, offset = 0, 1, 1
                        while offset < len(pending):
                            digit = pending[offset]
                            length += (digit & 127) * factor
                            offset += 1
                            if digit < 128:
                                break
                            factor *= 128
                        else:
                            break
                        if len(pending) < offset + length:
                            break
                        frame = bytes(pending[:offset + length])
                        del pending[:offset + length]
                        command = frame[0] >> 4
                        if origin is client and command == 14:
                            self.disconnects += 1
                        if origin is server and command == 4 and self.reject_acks:
                            frame = b'\x40\x04' + frame[offset:offset + 2] + b'\x80\x00'
                        if not (origin is server and command == 4 and self.drop_acks):
                            (server if origin is client else client).sendall(frame)
        except OSError:
            pass
        finally:
            client.close()
            server.close()

    def break_connection(self):
        for sock in self.sockets:
            try:
                sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def close(self):
        self.stopped.set()
        self.break_connection()
        self.listener.close()
        self.thread.join(2)


@unittest.skipUnless(os.environ.get('MQTT_PRESENCE_TEST') == '1', 'requires a disposable real MQTT broker')
class BrokerTests(unittest.TestCase):
    def setUp(self):
        import paho.mqtt.client as mqtt
        self.mqtt = mqtt
        self.endpoint = (os.environ.get('MQTT_PRESENCE_TEST_HOST', '127.0.0.1'), int(os.environ.get('MQTT_PRESENCE_TEST_PORT', '1883')))
        directory = Path(__file__).resolve().parents[1] / 'openwrt-health'
        sys.path.insert(0, str(directory))
        try:
            spec = importlib.util.spec_from_file_location('presence_openwrt_agent', directory / 'agent.py')
            self.openwrt = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(self.openwrt)
        finally:
            sys.path.pop(0)
        self.messages = []
        self.observer = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id='synthetic-observer-' + uuid.uuid4().hex, protocol=mqtt.MQTTv5)
        ready = threading.Event()
        self.observer.on_connect = lambda client, *_: client.subscribe('iot/v1/synthetic/#', qos=1)
        self.observer.on_subscribe = lambda *_: ready.set()
        self.observer.on_message = lambda client, userdata, message: self.messages.append((message.topic, json.loads(message.payload)))
        self.observer.connect(*self.endpoint)
        self.observer.loop_start()
        self.assertTrue(ready.wait(5))
        self.tls_patch = patch.object(mqtt.Client, 'tls_set_context', lambda *args: None)
        self.tls_patch.start()

    def tearDown(self):
        self.tls_patch.stop()
        self.observer.disconnect()
        self.observer.loop_stop()

    def publisher(self, kind, root, proxy):
        device = 'synthetic-' + uuid.uuid4().hex
        password = root / 'password'
        password.write_text('synthetic-only')
        password.chmod(0o600)
        cfg = {'site_id': 'synthetic', 'host_id': device, 'gateway_id': device, 'device_id': device,
               'mqtt': {'client_id': device, 'username': 'synthetic', 'password_file': str(password),
                        'url': 'mqtts://127.0.0.1:' + str(proxy.port)}}
        if kind == 'linux':
            value = linux.Transport(cfg, 'iot/v1/synthetic/' + device)
            tick = value.presence_tick
        else:
            value = self.openwrt.Publisher(cfg)
            tick = value.tick_presence
        wait_until(value.client.is_connected)
        self.assertTrue(tick())
        return value, tick

    def test_reconnect_discards_old_status_and_keeps_durable_telemetry(self):
        for kind in ('linux', 'openwrt'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                root, proxy = Path(directory), AckProxy(self.endpoint)
                value = None
                try:
                    value, tick = self.publisher(kind, root, proxy)
                    previous_client, previous_session = value.client, value.presence.session_id
                    payload = {'message_id': str(uuid.uuid4()), 'metrics': {'synthetic': 1}}
                    if kind == 'linux':
                        queue = linux.Outbox(root / 'outbox.sqlite', {'max_age_days': 1, 'max_rows': 100})
                        queue.save(payload, payload)
                    else:
                        queue = self.openwrt.RamQueue(root / 'queue')
                        queue.put(payload, time.time())
                    proxy.drop_acks = True
                    value.last_presence_at -= 61
                    errors = []
                    def pending_tick():
                        try:
                            tick()
                        except ConnectionError as error:
                            errors.append(str(error))
                    worker = threading.Thread(target=pending_tick)
                    worker.start()
                    wait_until(lambda: any(item.get('session_id') == previous_session and item.get('event') == 'heartbeat' for _, item in self.messages))
                    proxy.break_connection()
                    wait_until(value.reconnect_requested.is_set)
                    mark = len(self.messages)
                    proxy.drop_acks = False
                    value.ensure_connection()
                    wait_until(value.client.is_connected)
                    worker.join(12)
                    self.assertFalse(worker.is_alive())
                    self.assertIsNot(value.client, previous_client)
                    self.assertNotEqual(value.presence.session_id, previous_session)
                    self.assertTrue(tick())
                    wait_until(lambda: any(item.get('session_id') == value.presence.session_id and item.get('event') == 'online' for _, item in self.messages[mark:]))
                    time.sleep(.2)
                    self.assertFalse(any(item.get('session_id') == previous_session and item.get('event') == 'heartbeat' for _, item in self.messages[mark:]))
                    if kind == 'linux':
                        queued = queue.first()
                        self.assertIsNotNone(queued)
                        queue.ack(queued[0], value.publish('iot/v1/synthetic/telemetry', queued[1]))
                        self.assertIsNone(queue.first())
                        queue.close()
                    else:
                        records = list(queue.records(time.time()))
                        self.assertEqual(len(records), 1)
                        self.assertTrue(value.send(records[0][1]))
                        records[0][0].unlink()
                finally:
                    if value:
                        value.close()
                    proxy.close()

    def test_shutdown_without_puback_closes_socket_and_broker_emits_lwt(self):
        for kind in ('linux', 'openwrt'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                proxy = AckProxy(self.endpoint)
                try:
                    value, _ = self.publisher(kind, Path(directory), proxy)
                    session = value.presence.session_id
                    proxy.drop_acks = True
                    started = time.monotonic()
                    value.close()
                    self.assertLess(time.monotonic() - started, 12)
                    wait_until(lambda: any(item.get('session_id') == session and item.get('reason') == 'lwt' for _, item in self.messages))
                    self.assertEqual(proxy.disconnects, 0)
                finally:
                    proxy.close()

    def test_shutdown_acknowledgement_and_negative_reason_are_distinguished(self):
        for kind in ('linux', 'openwrt'):
            for accepted in (True, False):
                with self.subTest(kind=kind, accepted=accepted), tempfile.TemporaryDirectory() as directory:
                    proxy = AckProxy(self.endpoint)
                    try:
                        value, _ = self.publisher(kind, Path(directory), proxy)
                        session = value.presence.session_id
                        proxy.reject_acks = not accepted
                        value.close()
                        if accepted:
                            wait_until(lambda: proxy.disconnects == 1)
                            self.assertFalse(any(item.get('session_id') == session and item.get('reason') == 'lwt' for _, item in self.messages))
                        else:
                            wait_until(lambda: any(item.get('session_id') == session and item.get('reason') == 'lwt' for _, item in self.messages))
                            self.assertEqual(proxy.disconnects, 0)
                    finally:
                        proxy.close()


if __name__ == '__main__':
    unittest.main()
