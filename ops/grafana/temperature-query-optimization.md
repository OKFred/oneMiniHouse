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
before combining sources and evaluating channel labels. A final weighted mean
preserves aliases, null values and unequal sample counts. The Grafana query keeps
the original time-group macro and null-fill behavior. An unsupported projection,
ambiguous identity or missing security barrier is an error, not a guessed mapping.

Local checks use the standard library and an isolated cached PostgreSQL 17 image:

```sh
python -B -m unittest discover -s ops/grafana -p 'test_optimize_temperature_view*.py'
python -B ops/grafana/temperature-query-late-labels-test.py
```

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
