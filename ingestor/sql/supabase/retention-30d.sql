-- Supabase owner-only retention setup. Never run this against local PostgreSQL.
-- Run sections A, B, and C as separate submissions. No grants to the ingestor.

-- A: Install the Supabase-provided pg_cron extension when absent.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Read-only owner preflight. The dedicated ingestion role cannot inspect this.
SHOW cron.timezone;
-- Section C assumes GMT/UTC. If different, adjust only this job's schedule.
-- Do not change the global cron timezone for unrelated jobs.

-- B: Run this statement alone, outside any explicit transaction.
-- PostgreSQL creates this index inside the table's existing iot schema.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telemetry_retention_30d_time_v2
ON iot.telemetry (
  (COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)),
  message_id
);

-- C: Eight independent small transactions per day, up to 8,000 rows total.
-- With GMT/UTC cron time: 19:31-19:38 UTC = next day 03:31-03:38 China time.
-- Named scheduling is repeatable for the same owner and updates this job only.
SELECT cron.schedule(
  'one-minihouse-iot-telemetry-30d',
  '31-38 19 * * *',
  $cleanup$
    SET timezone = 'UTC';
    SET lock_timeout = '2s';
    SET statement_timeout = '30s';
    WITH expired AS MATERIALIZED (
      SELECT message_id
      FROM iot.telemetry
      WHERE COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)
            < now() - interval '30 days'
      ORDER BY COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc),
               message_id
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM iot.telemetry AS target
    USING expired
    WHERE target.message_id = expired.message_id;
  $cleanup$
);

-- After setup, owner-only readback of this job (do not inspect unrelated jobs):
SELECT jobid, jobname, schedule, username, active
FROM cron.job
WHERE jobname = 'one-minihouse-iot-telemetry-30d';

-- After the first scheduled window, owner-only bounded verification:
SELECT d.status, d.return_message, d.start_time, d.end_time
FROM cron.job_run_details AS d
JOIN cron.job AS j USING (jobid)
WHERE j.jobname = 'one-minihouse-iot-telemetry-30d'
ORDER BY d.start_time DESC
LIMIT 8;

-- Rollback scheduling only; never drop the pg_cron extension:
-- SELECT cron.unschedule('one-minihouse-iot-telemetry-30d');
