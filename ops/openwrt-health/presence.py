"""Small live MQTT presence envelopes; never store them in a telemetry outbox."""
import json
import time
import uuid
from datetime import datetime, timezone


class Presence:
    def __init__(self, site_id, gateway_id, device_id, reporter_id, now=time.monotonic):
        self.identity = dict(site_id=site_id, gateway_id=gateway_id, device_id=device_id,
                             reporter_id=reporter_id)
        self.now, self.started = now, now()
        self.boot_id = str(uuid.uuid4())
        self.session_id = None
        self.sequence = 0

    def begin(self):
        self.session_id, self.sequence = str(uuid.uuid4()), 0
        return self.message('offline', False, 'lwt')

    def message(self, event, online, reason):
        if self.session_id is None:
            raise ValueError('PRESENCE_SESSION_REQUIRED')
        will = reason == 'lwt'
        if not will:
            self.sequence += 1
        stamp = datetime.now(timezone.utc)
        value = dict(schema_version=1, event_id=str(uuid.uuid4()), **self.identity,
                     boot_id=self.boot_id, session_id=self.session_id,
                     sequence=None if will else self.sequence, event=event, online=online,
                     reason=reason, source_time_utc=None if will or stamp.year < 2024 else stamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
                     uptime_ms=None if will else max(0, int((self.now() - self.started) * 1000)))
        if len(json.dumps(value, separators=(',', ':')).encode()) > 4096:
            raise ValueError('PRESENCE_TOO_LARGE')
        return value
