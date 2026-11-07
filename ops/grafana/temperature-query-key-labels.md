# Evaluate server labels once per source identity

The existing query keeps three independently materialized source aggregates.
Previously the server branch evaluated its device/sensor label CASE and regular
expressions again for every time bucket. A small materialized DISTINCT identity
set now precedes the label projection, and the original buckets join those labels
back by device/sensor identity with a NULL-safe device-name check.

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

On 2026-11-08 a same-snapshot read-only comparison used the actual Grafana reader,
the actual seven-day 300-second request and the existing 15-second statement
timeout. The original CSV copy took 6.315 seconds. Candidate copies took 4.830,
4.954 and 4.848 seconds. All 84,290 `(time,metric)` rows and NULL states matched;
the maximum absolute floating-point difference was `1.421e-14` against the
`1e-10` tolerance. Different CSV bit hashes are not treated as value differences.
Instrumented EXPLAIN took 5.816 seconds; it is separate from COPY wall time.

These measurements show a database improvement with limited headroom. They do
not prove a five-second Grafana request, which also includes time-series frame
conversion and transport. Browser acceptance at the actual interval remains a
separate check. A 600-second benchmark cannot establish the 300-second budget.

With intermediate C grouping and the same default-collation labels, a further
same-snapshot comparison copied all 84,290 rows in 4.709, 4.577 and 4.565 seconds
(baseline 6.224 seconds); the verified default collation was deterministic and
all values/NULLs matched within the same tolerance. Instrumented EXPLAIN was
5.631 seconds. This establishes the database COPY budget, while the Grafana
format/transport/browser budget remains unverified.

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
