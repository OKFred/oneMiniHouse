# MQTT presence v1

Presence is independent of temperature sampling and uses its own exact-topic MQTT
subscriptions, processor and PostgreSQL table. It never creates temperature rows
or changes a physical device's collection interval.

## Publisher contract

All fields below are required. Use a new `session_id` UUID for **every successful
MQTT connection**, including a reconnect in the same process. `boot_id` identifies
the reporting process/MCU boot, not a proxy child's boot. A new event uses a new
UUID; a QoS 1 retransmission retains its bytes and ID. `reporter_id` is the
configured logical reporter identity, usually the publishing MQTT client ID. The
phone uses its opaque health device ID while retaining its legacy MQTT client ID.

```json
{
  "schema_version": 1,
  "event_id": "11111111-1111-4111-8111-111111111111",
  "site_id": "example-home",
  "gateway_id": "example-host",
  "device_id": "physical-host",
  "reporter_id": "example-host-publisher",
  "boot_id": "example-process-boot",
  "session_id": "22222222-2222-4222-8222-222222222222",
  "sequence": 0,
  "event": "online",
  "online": true,
  "reason": "connected",
  "source_time_utc": "2026-01-02T03:04:05.000Z",
  "uptime_ms": 0
}
```

| Event | online | reason | Sequence / source time / uptime |
|---|---|---|---|
| online | true | connected | Nonnegative safe integer / UTC or null / safe integer |
| heartbeat | true | heartbeat | Increasing sequence / UTC or null / monotonic uptime |
| offline | false | shutdown | Increasing sequence / UTC or null / monotonic uptime |
| offline | false | lwt | **All three null**; no CONNECT-time timestamp is an offline occurrence |
| observation | true / false / null | read_ok / read_failed / upstream_unknown | Increasing reporter sequence, original observation UTC or null, reporter uptime |

Direct-device heartbeat interval is 60 seconds. Proxy observations follow their
actual successful/failed collection cadence, not an invented heartbeat. QoS 1, verified TLS, exact publish ACL and a
matching CONNECT Will are required. Existing retained status topics can remain
retained: the live observer uses MQTT 5 Retain As Published=false and Retain
Handling=0. Broker-delivered subscription snapshots are archived with retain=true;
normal live deliveries arrive with retain=false. Retained snapshots never create
an online/offline transition or coverage history.

If a connection birth was missed, a snapshot or first unknown-session heartbeat
only records a pending candidate. A later live heartbeat must advance its sequence
and uptime, and its source UTC must exceed both the first candidate receipt and
the current observer coverage start by more than 500 ms before it can establish
online. A new live birth retires any different pending session.

With unknown source UTC, publish null and keep diagnostics; it cannot establish
online. Source UTC more than 500 ms ahead of first receipt and observations older than their configured freshness window are archived
without advancing state. The 500 ms clock allowance never changes original time;
online TTL starts from min(source time, first receipt). Old session wills, closed sessions, nonincreasing
sequence numbers and regressed clocks/uptime cannot reopen a current session.
After a closed MQTT session the publisher must reconnect with a new session UUID.

Finite compatibility fields allowed on existing status topics are optional and
never affect presence state or time: `quality` (ok/degraded/offline),
`read_time_utc` / `captured_at` (UTC or null), `mqtt_connected` (boolean),
`queued` / `pending` / `dropped` (nonnegative safe integers),
`frames` (exactly archived/pending/dropped_pending nonnegative safe integers),
`devices` (at most 128 syntactically valid device IDs mapped to pending/ok/error),
`message_id` (must equal event_id), and mobile's `protocolVersion`, `timestamp`
(nonnegative safe integers), `deviceId` (valid opaque ID), `status` (ONLINE/OFFLINE).
Other properties, duplicate JSON keys, malformed UTF-8 and messages over 16 KiB
are rejected and durably quarantined.

## Config and identities

`presence` is optional. It adds connections without moving existing subscriptions
or changing their client IDs, persistent sessions, credentials or source routes.
Each client has at most ten exact topics. Each topic and physical ID is assigned
once; publisher/observer client IDs cannot collide, and parent cycles are invalid.
Topic/identity is matched to this server-side mapping, never a physical asset ID
supplied by a publisher. Private topics can retain their legacy naming.

```json
{
  "presence": {
    "devices": [{
      "id": "example-host", "label": "示例主机",
      "topic": "iot/v1/example-home/host/status",
      "siteId": "example-home", "gatewayId": "host", "deviceId": "physical-host",
      "reporterId": "example-host-publisher", "kind": "direct",
    "intervalSeconds": 60, "freshnessSeconds": 300
    }],
    "clients": [{"clientId": "example-presence-reader", "topics": ["iot/v1/example-home/host/status"]}]
  }
}
```

`direct` is a physical reporting device. `proxy` is an explicitly mapped child
with `parentId`: only successful **fresh direct reads**, never a cached metric,
can make it online while the parent is online. `cached` also requires a parent
but always produces unknown physical liveness. An absent child is not an extra
host, VM, container, temperature channel or disk. Use stable physical identifiers,
and do not infer parentage from a displayed hostname or gateway string.
Direct configuration is fixed at intervalSeconds=60/freshnessSeconds=300. A proxy
must provide its actual integer intervalSeconds in 1..86400 and exactly
freshnessSeconds=max(300,3*intervalSeconds): 15 seconds means 300, 600 means 1800.
Never substitute 60 seconds for an unknown proxy cadence. An unknown-cadence
entry must be cached with both intervalSeconds and freshnessSeconds explicitly
null. It has no effective online TTL and always remains unknown; even a known
cache polling interval cannot establish the sensor's physical online state.
`visible` defaults to true. Set visible=false for an explicitly configured
logical reporter dependency (for example a gateway process inside a container).
It participates in coverage/parent state, but is never counted or drawn as a
physical device. The pure reference and SQL timeline filter hidden rows only
after evaluating dependencies, not before.

Presence subscribers use clean=true / session expiry=0. They do not consume
historic broker offline backlog as live evidence. A server receipt and session
decision are committed to SQLite with the raw message and processing job before
PUBACK. Invalid/conflicting inputs are quarantined; capacity/storage failures
withhold ACK and close only that observer connection.

## Storage, observer coverage and queries

`device-presence/1/presence` and `presence-observer/1/presence` reuse raw_message,
processing_job, processed_result and independent local/Supabase/D1 delivery jobs.
Cursor/order state is persisted in the same SQLite transaction. Reprocessing uses
the frozen first receipt, mapping and decision; it never creates a new live time.
Raw kind `mqtt_presence` supports legacy topics while requiring the archive's
configured site. Server-generated coverage is explicitly `presence_observer`, not
claimed to be original broker-delivered bytes. Deploy both additive D1 validation
branches before those deliveries.

Both PG targets receive `iot.device_presence_events`, not iot.telemetry. Every
projection field and SHA-256 is read back after an idempotent write. Source time
is separate from `observed_time_utc`; LWT uses the server's first observed time.
Cloud write expiry uses the original observed time. The existing telemetry and
raw retention settings are unchanged. Install the separate Supabase
`sql/supabase/presence-retention-48h.sql` owner job alongside the existing 48-hour
telemetry job; never install it on the local long-term database.

Each observer subscription persists coverage_start only after successful SUBACK,
coverage_heartbeat every 30 seconds and coverage_end on known loss/stop. A pulse
leases coverage for 90 seconds; a crash therefore becomes **unknown**, not an
invented physical offline event. A reconnected observer has a new session and
requires a new live device event before confirming that device again. Parent
gaps make child state unknown. No state is invented before presence was deployed.

The owner-run `007-device-presence.sql` creates indexes, enables RLS and grants
only SELECT/INSERT to the explicitly configured runtime role. Set
MIGRATION_INGESTOR_ROLE when using `scripts/migrate.ts` with presence configured.
An actual private reader whitelist is mandatory; the synthetic `008` example is
not production configuration. Never grant Grafana the base table or raw archive.

For the SQL timeline, use the restricted device events plus observer coverage:

1. Sort each timeline by **observed_time_utc, observation_order**; the second key
   is a durable first-intake order for equal millisecond timestamps.
2. Only applied, non-retained device rows can change state. An online state ends
   at valid_until_utc unless refreshed; no new report while coverage is healthy
   means offline by freshness policy, not proof of lost power.
3. At any point require observer session equality and an unexpired latest
   coverage pulse, with no intervening coverage_end. Otherwise display unknown.
4. A parent's state must be online for a proxy child to be online. Cached stays
   unknown. If parent and child share reporter_id, their session_id must also
   match: a new parent birth cannot revive the previous session's child reads.
   Source quality/temperature availability is not physical liveness.
5. Build intervals at event, TTL and coverage boundaries, seeding with the last
   relevant predecessor within the maximum lease. Never average state values or
   connect missing history as continuously online.
6. Evaluate parent dependencies including visible=false entries, then show only
   visible physical devices. A hidden parent failure still makes children unknown.

`presenceAt(devices,events,atMs)` is the pure TypeScript reference for these
current-state rules. It consumes only trusted normalized events, not public input.
PG/delivery failure can delay visualization and must be shown separately; receipt
coverage cannot claim the Grafana datasource itself was continuously reachable.
