# Physical-device presence timeline

This is an additive SQL reader for the dedicated presence pipeline, independent
of temperature metrics, temperature categories and their seven-day aggregations.
It produces half-open UTC intervals `[start_time_utc,end_time_utc)` for the global
Grafana range. All visible registry entries have complete range coverage,
including a single unknown interval when they have never reported.

## Deploy as owner

1. Back up current definitions, owners and ACLs for the new objects if any exist,
   and the latest dashboard. Preserve all current unrelated panels and queries.
2. Apply `ingestor/sql/007-device-presence.sql` using the explicitly configured
   ingestion role. Generate a **private** copy of `presence-registry.example.sql`
   from the approved physical-device map. Its synthetic rows are not deployable.
3. Apply the private registry, then `presence-reader-views.sql`. Include hidden
   logical reporter dependencies in the registry; visible=false is evaluated
   before filtering the final physical rows. Never infer physical devices from
   VM/container names, a gateway ID, a cached poll, GPU or disk channels.
4. Set `one_min_house.grafana_role` to the actual existing read role and apply
   `presence-timeline.sql`. It grants only schema usage, three restricted views
   and EXECUTE on the read-only function. It does **not** grant the base table,
   raw archive, processing state, credential files or write access.
5. Use `presence-query.example.sql` in a new state-timeline panel before device
   temperature. Keep the global time range; do not include a temperature-category
   variable or pass temperature data through this query. Verify with the actual
   read role, including direct base-table denial and public denial.

The function is SECURITY INVOKER with a fixed search_path. Source access goes
through the exact registry-scoped security-barrier views; there is no privileged
Node API or public endpoint. Registry visibility and dependencies are deployment
configuration, not a second editable asset master. Change them only with the
corresponding approved publisher/observer mapping.

## State and tooltip

- `online` means fresh affirmative presence evidence while its observer coverage
  and configured parents are known healthy. It is not a proof that every sensor
  or application is healthy.
- `offline` means an observed current-session Will/shutdown/read failure, or
  heartbeat expiry while coverage is known healthy. It does not prove lost power.
- `unknown` covers no events, parent gaps, observer outages, coverage expiry,
  pending/unknown frozen decisions and cached-only evidence. Keep it visible.

`basis` explains the rule (`fresh_heartbeat`, `fresh_direct_read`,
`heartbeat_expired`, `lwt_observed`, `shutdown_observed`, `read_failed`,
`no_observation`, `observer_unknown`, `cached_only`, `parent_unknown`,
`parent_session_changed`, `dependency_cycle`, or a frozen unknown decision).
Tooltip fields preserve the last known affirmative heartbeat's server/source UTC,
last device-event observation before the interval end, reporter boot/session, observer session and parent
identity. Unknown/offline tooltips are explicitly last-known evidence, not a claim
that a historical process is currently running.

Only frozen applied, non-retained device events may affect state. The SQL does
not reinterpret wire.online=true, old Will, retained snapshots, stale sequences
or replays. Both event types sort by server first-observed UTC and durable
observation_order for same-millisecond ordering. A coverage pulse leases 90s;
known end closes coverage immediately. A later pulse cannot fill an earlier
expired gap. Reconnection requires device and observer session equality; parent
and child sharing a reporter must also share the publisher session. A new parent
birth cannot revive old child observations.

The reader walks event/online-expiry/coverage-expiry boundaries and merges equal
state, basis and instance intervals. There is no minute grid, zero-filled metric,
temperature scan or averaging of states. A proxy's online expiry comes from its
actual configured cadence; cached entries have no effective online expiry.
Before the small state reducer, SQL window functions compress continuous
heartbeats and coverage within one instance. They preserve TTL holes, observer
gaps and frozen unknown decisions. Last-heartbeat tooltips use a dedicated partial
time index, so a long offline history does not require repeated history scans.

Source databases retain independent histories. In a 48-hour cloud mirror, the
part of a seven-day range older than available events is unknown; the reader
never copies a newer state backward or fabricates a predecessor. Local full
history remains independent. The function reads whatever has actually arrived
in that datasource, so PG/delivery failures and query errors must be shown as
datasource problems, not device-offline findings.

## Rollback and checks

For first installation, remove only the added panel/query, then execute
`presence-rollback.example.sql`. Existing installations restore their saved new
object definitions/ACLs instead. Keep the presence event table, raw archive,
queues, cursor, independent sink progress and existing retention jobs. Do not
restore an old full dashboard over later user changes.

Run `node ops/grafana/presence-test.mjs` with the installed Node24 runtime. It
uses only a guarded local Docker Desktop PostgreSQL17 container with no network,
ports or persistent mounts, creates two synthetic databases and cross-checks
every event/lease boundary against the TypeScript reference reducer, including
the cloud cutoff. It also verifies actual reader login, RLS/base/public denial,
hidden parents, unseen rows and repeated SQL installation. It is not a production
or browser acceptance check.

Add `--scale` for ten synthetic physical devices over seven days: 100,800 minute
heartbeats and 20,160 coverage pulses, with a 15-second statement timeout and a
five-second timeline-query budget. The scale fixture uses one CPU and 768 MiB;
its PostgreSQL data and temporary files are also isolated in memory. Normal
correctness fixtures use 256 MiB. No production identities or database are used.
