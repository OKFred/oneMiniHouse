# Historical direct-report inference

This is an additive display layer. The existing `home_presence_timeline` and its
new-period reducer/coverage semantics are unchanged. Never use legacy telemetry
to fill a new-period heartbeat or observer gap.

As owner, save definitions/owners/ACLs for any existing new objects, generate a
private copy of `presence-history-sources.example.sql`, and then apply
`presence-history-reader.sql` with `one_min_house.grafana_role` set to the actual
restricted Grafana role. The synthetic template must never be deployed as-is.
The existing presence registry, reader views and new-only function must already
be installed. No base-table grants, telemetry writes, queues or retention jobs
are changed.

The private policy has exactly one **fixed first-installation UTC literal**.
Record it once and keep it during retries, redeploys and cloud cleanup. It must
not be `now()`, the first surviving presence event or the oldest retained row.

The private source map has these columns:

```
physical_device_id, site_id, gateway_id, device_id, processor_id,
freshness_seconds, required_source_driver, required_source_integrity
```

Each tuple is an exact approved identity, limited to `iot-telemetry` or
`host-health-temperature`. TTL must equal the visible non-cached registry entry's
known cadence-derived TTL. Unknown cadences and cached sources are omitted, so
their seeded physical rows remain unknown. Multiple confirmed historical aliases
may map to one physical device; a complete source/filter tuple cannot be mapped
twice. No free-form predicates are accepted. Optional filters compare only the
fixed `lineage.source.driver` and `lineage.source.integrity` JSON paths. This lets
a known ESP32 parent accept fresh direct messages while its known SHT20 child
requires `rs485.modbus.sht20` and `crc_verified`; CPU-only messages do not prove
that the child was read. Cached Xiaomi child polls do not prove its hub was online.

The owner-scoped evidence view reads no temperature JSON channels. A proof needs
`quality='ok'`, `observation_kind='direct_read'`, finite read/receive times,
`read <= receive+500ms` and `receive-read <= TTL`. A `CASE` guards arithmetic on
nonfinite timestamps. Legacy import processors, failed reads, cached observations,
wrong identities, stale delivery and larger future skew do not create evidence.

Each proof contributes only `[read,min(read+TTL,cutover))`. Overlapping or adjacent
forward intervals merge into islands; no backward fill or precise historical
offline event is inferred. The complement of these islands is explicitly
unknown for every visible registry entry. Late arrival can prove its original
bounded historical interval, never current/new-period online state. A 48-hour
cloud database naturally has an unknown older prefix when evidence was deleted.

`home_presence_display_timeline(from,to)` returns the original 16 columns plus
`history_read_time_utc` and `history_receive_time_utc`. Before cutover, online rows
have `basis='历史上报推断'`; gaps have `basis='历史无直接证据'`. Historical heartbeat,
observer, reporter, boot and session fields are NULL, rather than fabricated from
old telemetry. The additional read/receive pair identifies the latest contributing
proof at that interval end and may explicitly reveal bounded late arrival. After
cutover the wrapper delegates unchanged to the new-only function, with both new
history fields NULL. Ranges crossing cutover are half-open with no overlap/hole.

Grafana gets SELECT only on the fixed policy and restricted evidence view, plus
EXECUTE on the display function; it does not get the private source-map or base
table. `presence-history-rollback.example.sql` removes only this added layer after
the panel query is removed/restored. Existing installs restore saved definitions
and ACLs instead of dropping later changes.

Run `python ops/grafana/presence-history-test.py -v` for guarded, network-isolated
PostgreSQL 17 fixtures. Set `PRESENCE_HISTORY_SCALE=1` to enforce the full-window
budget of 20 physical devices, seven days and 201,600 direct proofs below five
seconds on one CPU/768 MiB. The fixture has no metrics column, proving that the
history path cannot expand temperature JSON. It covers CRC/driver separation,
TTL holes/adjacency/partial overlap, clock and timestamp boundaries, late delivery,
unknown/cached seeds, cloud deletion, reader denial, repeated installation and
the unchanged new-period observer gap. This is not production or browser acceptance.
