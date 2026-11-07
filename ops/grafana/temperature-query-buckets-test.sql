-- Read-only self-check: expected Grafana epoch-floor buckets, including negative time.
WITH strides(seconds) AS (VALUES (1),(15),(60),(600),(86400)),
instants(at_time) AS (VALUES
  (TIMESTAMPTZ '1969-12-30T23:59:59.999999Z'),
  (TIMESTAMPTZ '1969-12-31T23:49:59.999999Z'),
  (TIMESTAMPTZ '1969-12-31T23:50:00Z'),
  (TIMESTAMPTZ '1969-12-31T23:59:59.999999Z'),
  (TIMESTAMPTZ '1970-01-01T00:00:00Z'),
  (TIMESTAMPTZ '1970-01-01T00:00:00.000001Z'),
  (TIMESTAMPTZ '1970-01-01T00:09:59.999999Z'),
  (TIMESTAMPTZ '1970-01-01T00:10:00Z'),
  (TIMESTAMPTZ '1970-01-01T00:10:00.000001Z'),
  (TIMESTAMPTZ '2026-10-31T20:16:51Z'),
  (TIMESTAMPTZ '2026-11-07T20:16:51Z')
), comparisons AS (
  SELECT seconds,at_time,
    date_bin(make_interval(secs=>seconds),at_time,TIMESTAMPTZ '1970-01-01T00:00:00Z') AS bucket,
    to_timestamp((floor(extract(epoch FROM at_time)/seconds)*seconds)::double precision) AS expected
  FROM strides CROSS JOIN instants
)
SELECT count(*) AS checked_buckets,
  count(*) FILTER(WHERE bucket IS DISTINCT FROM expected) AS mismatched_buckets,
  count(*) FILTER(WHERE NOT(bucket<=at_time AND at_time<bucket+make_interval(secs=>seconds))) AS invalid_bounds
FROM comparisons;
