# Evaluate server labels once per source identity

The existing query keeps three independently materialized source aggregates.
Previously the server branch evaluated its device/sensor label CASE and regular
expressions again for every time bucket. A small materialized DISTINCT identity
set now precedes the label projection, and the original buckets join those labels
back by device/sensor identity with a NULL-safe device-name check.

The server category predicate is also evaluated in that materialized identity
lookup. It depends only on sensor ID and the category selector, so it filters
the small identity set before the bucket join. The phone and host-health category
predicates remain unchanged. NULL selectors, aliases across categories and NULL
labels retain the original SQL filtering and weighted-mean behavior.

Only the server's intermediate identity grouping uses `COLLATE "C"`. Generation
requires private evidence that the target database's default collation is
deterministic, and rejects source snapshots with an explicit collation. Labels
are explicitly restored to `COLLATE "default"` before the unchanged final
grouping/sorting, so user-visible equality and ordering do not become C-ordered.
No runtime catalog InitPlan or database setting is added to the panel query.

The final weighted sum/count aggregation remains: different raw identities and
sensors can share a display label. Final ordering, interval, inclusive global
time filter, category filter, NULL groups and missing-data behavior are unchanged.
Device IDs are non-NULL in the approved exact source branches; sensor identity
must be a JSON object key or a non-NULL literal. Unsupported nullable sensor
projections fail closed instead of silently losing rows in the equality join.

The generator still reads only the three existing restricted temperature views.
No source view, role, database object, dependency, plugin or server setting is
added or changed by this query optimization. Real identities, datasource details,
SQL, frame exports and execution plans remain private.

## Verification

On 2026-11-08 same-snapshot read-only comparisons used the actual Grafana reader,
the complete seven-day 300-second query and the existing 15-second statement
timeout. The adopted label lookup with intermediate C grouping copied all
84,290 `(time,metric)` rows in **4.709, 4.577 and 4.565 seconds**, including CSV
transfer (baseline 6.224 seconds). All values and NULL states matched within
`1e-10`; different CSV bit hashes are not treated as value differences. The
default collation was verified deterministic. Instrumented EXPLAIN took 5.631
seconds and is recorded separately from complete-query COPY wall time.

The complete database query therefore met the five-second budget in all three
measured runs. Before the category-predicate move, Grafana took **5.06 seconds**, including
time-series frame conversion and transport. Its result retained **42 numeric
series and 2,017 time points**. That browser request remains slightly above five
seconds; that database result does not establish a five-second end-to-end request.
A 600-second benchmark cannot establish the actual 300-second budget.

After moving the server category predicate into the identity lookup, same-snapshot
comparisons at the same seven-day window and 300-second interval produced:

| Selection | Complete result rows | Three COPY wall times |
| --- | ---: | --- |
| Memory | 8,068 | 3.305, 3.304, 3.360 seconds |
| All | 84,290 | 4.604, 4.683, 4.683 seconds |

Each result matched its corresponding baseline, including values and NULL
states, within the same `1e-10` tolerance. The category-predicate move is deployed.
All six browser selections rendered the expected series; All retained 42 numeric
series and 2,017 points. Latest Grafana request times were 5.02 seconds for All
and 3.43 seconds for Memory. The complete database query passed five seconds;
the All browser request, including conversion and transport, remains slightly above it.

The four existing dashboard tabs rendered their existing data. Public electricity
remained electricity-only, but concurrent public-panel queries intermittently failed
with PostgreSQL SQLSTATE 53100 (POSIX shared-memory exhaustion). The container
had a 64 MiB shared-memory limit; after the burst, usage returned below 2 MiB.
The affected panels query the unchanged electricity view; the failure moved to
different panels on refresh. The extra regression tab has automatic refresh off.
No PostgreSQL restart or container/resource setting was performed. Public-page
regression therefore remains a known operational failure, not an all-passed check.

Two subsequent private experiments were not adopted: an exact count-state guard
with numeric fallback took 4.815, 4.767 and 4.879 seconds; an integer metric-label
dictionary took 4.936, 4.997 and 4.895 seconds. Both matched every result, but
neither improved on the adopted query enough to justify its added complexity.
The deployed query keeps the original numeric sum/count aggregation.

The statement timeout, database settings, time resolution and existing reader
permissions were not increased. Complete raw-result and aggregate comparisons
preserved values across the three restricted source views; the actual reader
could still read the permitted views and could not read the telemetry base table.
Private SQL, execution plans and frame exports remain outside version control.

This record covers the temperature query. Presence cloud ACL approval and quota
verification remain pending, and the presence publisher rollout to the 17
physical devices has not been deployed. These measurements do not establish
completion of the presence rollout or all dashboard regression checks.

The generator requires `--collation-evidence .local/collation.private.json`.
The JSON must contain the boolean `deterministic_default_collation: true` from
read-only catalog verification for that target database. A saved successful
comparison report with that field is also accepted. The minimal preflight is:

```sql
SELECT json_build_object('deterministic_default_collation',collisdeterministic)
FROM pg_catalog.pg_collation WHERE oid='pg_catalog.default'::regcollation;
```

Do not manufacture the evidence flag or assume one datasource's result applies
to another database. Recheck before generating for a different target.

Run `python ops/grafana/temperature-query-late-labels-test.py -v` for generator and
semantic checks. Set `LATE_LABELS_POSTGRES=1` for a guarded, network-isolated local
PostgreSQL 17 comparison covering aliases, unequal weights, NULL names/labels,
all-NULL values, real zero, empty windows and actual-reader base-table denial.
The eight-test suite also checks that the server predicate exists only in the
materialized lookup, all five categories plus All, absent/NULL selectors, and
same-label aliases whose means differ when their categories are selected.
