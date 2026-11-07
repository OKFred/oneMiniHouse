# Temperature query optimization

Take a fresh private snapshot of the deployed view definitions, owners, options,
grants and column comments, plus the current dashboard resource. Do not commit
those files or replace the dashboard with an old export.

`optimize-temperature-view.py` rewrites the supported host-source disjunction
into disjoint exact-identity branches. It retains the indexed identity predicates,
specializes known device conditions and replaces the finite channel-key pattern
with its equivalent key set. Other projections, numeric filters and security
barriers remain intact. The generated candidate and rollback use `CREATE OR
REPLACE VIEW`, preserving the object and its existing metadata.

`temperature-query-late-labels.py` generates the panel query from that same
snapshot and the original panel SQL. It aggregates each restricted source view
before combining sources. Server labels are evaluated once per distinct source
identity and joined back with a NULL-safe name check. Only those intermediate
server identity keys use C collation; the resulting metric explicitly restores
the default collation before the unchanged final grouping and ordering. A final weighted mean
preserves aliases, null values and unequal sample counts. The Grafana query keeps
the original time-group macro and null-fill behavior. An unsupported projection,
ambiguous identity or missing security barrier is an error, not a guessed mapping.

Generation now requires `--collation-evidence`: first use the actual target
database's read-only catalog to save this JSON result in a private file:

```sql
SELECT json_build_object('deterministic_default_collation',collisdeterministic)
FROM pg_catalog.pg_collation WHERE oid='pg_catalog.default'::regcollation;
```

The field must be the boolean `true`; unverified/false/string values are rejected.
Programmatic `render(...)` callers must likewise pass
`deterministic_default_collation=True` only after that verification. No runtime
catalog query, role change or collation setting is injected into the panel SQL.

For example, generate new files using the approved reference view and original
panel-expression snapshots:

```sh
python -B ops/grafana/temperature-query-late-labels.py \
  --snapshot .local/reference-views.private.json \
  --dashboard .local/reference-panel.private.json \
  --collation-evidence .local/collation.private.json \
  --candidate .local/temperature-query-candidate.private.sql \
  --benchmark .local/temperature-query-reference-300s.private.sql \
  --interval-seconds 300
```

The optional benchmark uses the generator's fixed reference window; also test
the actual compiled Grafana request's interval and timestamps. If views/panel SQL
are already rewritten, retain the approved original reference snapshots for the
supported expression extractor, and separately take fresh live backups. Do not
feed an unsupported rewritten shape to the parser or deploy the old dashboard
resource: apply only the generated SQL to a fresh current resource.

Local checks use the standard library and an isolated cached PostgreSQL 17 image:

```sh
python -B -m unittest discover -s ops/grafana -p 'test_optimize_temperature_view*.py'
python -B ops/grafana/temperature-query-late-labels-test.py
```

Set `LATE_LABELS_POSTGRES=1` when running the second command to include the guarded
local PostgreSQL alias/NULL/zero/empty comparison at both 300s and 600s, including
verification that the final metric still has default collation.

Before deployment, use the actual reader role to compare complete results from
all three source views at one fixed snapshot. Check one hour, one day, seven days,
an empty window and every category. Raw rows must match exactly; floating-point
averages may differ only by roundoff. Run both read-only semantic SQL checks and
three complete seven-day queries, including result transfer; each must finish
within five seconds without increasing the existing statement timeout. Confirm
restricted views remain readable and base tables remain denied.

Compare metadata under the same session timezone: `pg_get_viewdef` renders
timestamp constants using that timezone. Keep the generated SQL, hashes, private
results and the rollback point. Update only the current temperature panel query;
rollback must also target only that query and the changed view. Existing tabs,
asset mappings and public electricity panels need separate browser regression.
