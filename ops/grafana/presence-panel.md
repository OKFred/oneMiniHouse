# Native physical-device presence panel

`presence-panel.py` reads a **private current Grafana V2 Dashboard resource** and
writes a new private candidate plus a scope report. It never calls Grafana,
changes database objects, saves a dashboard, edits temperature SQL, or changes
sharing. Refresh/rebase the current resource before any later deployment; do not
overwrite later user changes with an older candidate.

```powershell
python ops/grafana/presence-panel.py `
  --snapshot .local/current-dashboard.private.json `
  --candidate .local/presence-panel-candidate.private.json `
  --scope-diff .local/presence-panel-scope.private.json
```

The helper accepts the known single temperature auto grid and one tab-scoped
`temperature_category` control. It adds one element, keeps every existing element
and all unrelated resource/spec/tab values canonically byte-identical, and wraps
only Devices in two rows. The first contains the presence panel; the second
retains the original temperature layout and the **unchanged** category variable.
Moving that variable into its temperature row puts it below presence and keeps
it out of presence's scope. Unknown layouts/scopes fail closed. The scope report
explicitly includes this tab-variable-to-row-variable move.

The new full-width panel uses 18 grid rows by default (`--height-rows` supports
12..40), no pagination, and the global time range. Its SQL calls only the
restricted `iot.home_presence_display_timeline` function after the history reader
has been installed. Visible registry entries with no evidence remain unknown;
hidden dependencies stay out of the result. Duplicate
friendly names receive their physical ID as a suffix so two devices never become
one partition. No sensor channel, VM or cached poll is promoted to a physical row.

The result contains exactly two time columns, one `device_name` discriminator and
one string `presence` value. Native `partitionByValues` removes the discriminator
and attaches it as a field label. Each resulting frame has one non-time field.
The first/second timestamps are interval start/end. Color-only regex mappings
match 在线/离线/失联/未知, preserve the original evidence string for the native
tooltip, and show no values/legend over the colored bars. Tooltip evidence is
explicitly the last known heartbeat/observation **before the interval end**,
including UTC and reporter/observer instances. Before the fixed installation
cutover, qualifying direct telemetry instead shows **在线（历史推断）** with separate
historical read/receive timestamps and no invented session or heartbeat. History
gaps remain unknown. The panel does not claim a fresh sample at the historical
cursor position. Loss of contact does not prove power-off.

This follows the current official [V2 schema](https://github.com/grafana/grafana/blob/main/apps/dashboard/kinds/v2/dashboard_spec.cue),
[partition transformer](https://github.com/grafana/grafana/blob/main/public/app/features/transformers/partitionByValues/partitionByValues.ts),
[timeline time-field handling](https://github.com/grafana/grafana/blob/main/public/app/core/components/TimelineChart/utils.ts),
and [value mapping](https://github.com/grafana/grafana/blob/main/packages/grafana-data/src/utils/valueMappings.ts)/
[display processor](https://github.com/grafana/grafana/blob/main/packages/grafana-data/src/field/displayProcessor.ts)
implementations. The official [dynamic dashboard documentation](https://grafana.com/whats-new/2026-04-08-dynamic-dashboards-is-now-generally-available/)
also describes row-scoped controls. These sources were checked on 2026-11-08;
the supplied resource's plugin version is preserved.

Run `python ops/grafana/presence-panel-test.py -v` for synthetic scope/native-config
checks. Set `PRESENCE_PANEL_POSTGRES=1` to include the guarded network-isolated
local PostgreSQL 17 fixture: four typed result columns, all four state prefixes,
unknown evidence, duplicate names and actual restricted reader execution.
Browser hover behavior, mobile layout and real datasource acceptance remain
separate deployment checks; source/config tests do not replace them.
