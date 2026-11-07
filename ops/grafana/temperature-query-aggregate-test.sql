-- Read-only PostgreSQL proof for weighted aliases, real zero, and all-NULL buckets.
WITH samples(bucket,device_id,metric,temperature_c) AS (VALUES
  (0,'synthetic-a','Example / CPU',10::double precision),
  (0,'synthetic-a','Example / CPU',NULL),
  (0,'synthetic-b','Example / CPU',20),
  (0,'synthetic-b','Example / CPU',30),
  (0,'synthetic-null-a',NULL,NULL),
  (0,'synthetic-null-b',NULL,NULL),
  (600,'synthetic-zero','Example / CPU',0)
), expected AS (
  SELECT bucket,metric,avg(temperature_c) AS value FROM samples GROUP BY 1,2
), partials AS MATERIALIZED (
  SELECT bucket,device_id,metric,sum(temperature_c) AS value_sum,count(temperature_c) AS value_count
  FROM samples GROUP BY 1,2,3
), actual AS (
  SELECT bucket,metric,sum(value_sum)/NULLIF(sum(value_count),0)::double precision AS value
  FROM partials GROUP BY 1,2
)
SELECT count(*) AS checked_groups,
  count(*) FILTER(WHERE a.bucket IS NULL OR e.bucket IS NULL
    OR (a.value IS NULL)<>(e.value IS NULL) OR abs(a.value-e.value)>1e-12) AS mismatched_groups
FROM actual a FULL JOIN expected e ON a.bucket=e.bucket AND a.metric IS NOT DISTINCT FROM e.metric;
