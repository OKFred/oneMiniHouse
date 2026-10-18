-- Read-only Supabase owner preflight. No deletes, scheduling or credentials.
-- Inspect these results before applying retention-7d.sql or a cleanup batch.
BEGIN READ ONLY;
SET LOCAL timezone = 'UTC';
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

SELECT current_database() AS database_name,
       now() AS inspect_time_utc,
       now() - interval '7 days' AS cutoff_time_utc,
       pg_database_size(current_database()) AS database_bytes,
       pg_total_relation_size('iot.telemetry') AS telemetry_total_bytes,
       pg_table_size('iot.telemetry') AS telemetry_table_and_toast_bytes,
       pg_indexes_size('iot.telemetry') AS telemetry_index_bytes;

SELECT count(*) AS total_rows,
       count(*) FILTER (WHERE COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)
                              < now() - interval '7 days') AS expired_7d_rows,
       count(*) FILTER (WHERE receive_time_utc >= now() - interval '24 hours') AS received_last_24h_rows,
       min(COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)) AS oldest_observation_time_utc,
       max(COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)) AS newest_observation_time_utc,
       max(receive_time_utc) AS newest_receive_time_utc
FROM iot.telemetry;

SELECT indexname, indexdef,
       pg_relation_size(format('%I.%I', schemaname, indexname)::regclass) AS index_bytes
FROM pg_indexes
WHERE schemaname = 'iot' AND tablename = 'telemetry'
ORDER BY indexname;

-- The cron queries require the already-installed pg_cron extension. If absent,
-- the previous read-only results remain useful; install it only during setup.
SELECT jobid, jobname, schedule, database, username, active, command
FROM cron.job
WHERE jobname IN ('one-minihouse-iot-telemetry-30d', 'one-minihouse-iot-telemetry-7d');

SELECT d.status, d.return_message, d.start_time, d.end_time
FROM cron.job_run_details AS d
JOIN cron.job AS j USING (jobid)
WHERE j.jobname IN ('one-minihouse-iot-telemetry-30d', 'one-minihouse-iot-telemetry-7d')
ORDER BY d.start_time DESC
LIMIT 12;
COMMIT;
