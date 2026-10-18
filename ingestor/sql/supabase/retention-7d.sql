-- Supabase owner only; supersedes retention-30d.sql without rewriting it.
-- Review retention-7d-preview.sql first. Apply A, B and C as SEPARATE submissions.
-- Configure the ingestor's Supabase retentionDays=7 as well; local PG stays full.
-- No credential/role changes. No other jobs, tables or global timezone changes.
-- References: https://supabase.com/docs/guides/cron/quickstart
--             https://github.com/citusdata/pg_cron

-- A: Verify the cloud target and install only the provider's pg_cron extension.
DO $guard$
BEGIN
  IF current_database() <> 'postgres'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE EXCEPTION 'Supabase-only maintenance: verify the intended cloud database';
  END IF;
END $guard$;
CREATE EXTENSION IF NOT EXISTS pg_cron;
SHOW cron.timezone;

-- B: Run ALONE, outside an explicit transaction. Reuse the existing index name:
-- "30d" is historical naming; its expression is independent of retention days.
-- IF NOT EXISTS avoids a second equivalent index on the existing installation.
CREATE INDEX CONCURRENTLY IF NOT EXISTS telemetry_retention_30d_time_v2
ON iot.telemetry (
  (COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)),
  message_id
);

-- C: Validate the index and known job contents, then replace the old named job
-- atomically. 1,000 rows every 15 minutes => at most 96,000 rows/day, not a
-- guarantee: locks, statement timeout, failures or outages can reduce throughput.
DO $retention$
DECLARE
  old_job record;
  existing_job record;
  command_7d text := $cleanup$
    SET timezone = 'UTC';
    SET lock_timeout = '2s';
    SET statement_timeout = '30s';
    WITH expired AS MATERIALIZED (
      SELECT message_id
      FROM iot.telemetry
      WHERE COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)
            < now() - interval '7 days'
      ORDER BY COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc),
               message_id
      LIMIT 1000
      FOR UPDATE SKIP LOCKED
    )
    DELETE FROM iot.telemetry AS target
    USING expired
    WHERE target.message_id = expired.message_id;
  $cleanup$;
  command_30d text;
  normalized_7d text;
  normalized_30d text;
BEGIN
  IF current_database() <> 'postgres'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE EXCEPTION 'Supabase-only maintenance: verify the intended cloud database';
  END IF;
  IF COALESCE(current_setting('cron.timezone', true), 'GMT') NOT IN ('GMT', 'UTC', 'Etc/UTC') THEN
    RAISE EXCEPTION 'Unexpected cron.timezone; inspect it without changing global settings';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('one-minihouse-iot-telemetry-retention'));

  -- A pre-existing name is not enough: fail closed on a wrong/invalid index.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index AS i
    JOIN pg_class AS c ON c.oid = i.indexrelid
    JOIN pg_am AS am ON am.oid = c.relam
    WHERE i.indexrelid = to_regclass('iot.telemetry_retention_30d_time_v2')
      AND i.indrelid = 'iot.telemetry'::regclass
      AND i.indisvalid AND i.indisready AND i.indpred IS NULL
      AND am.amname = 'btree' AND i.indnkeyatts = 2 AND i.indnatts = 2
      AND i.indkey[0] = 0
      AND i.indkey[1] = (SELECT attnum FROM pg_attribute
                         WHERE attrelid = 'iot.telemetry'::regclass AND attname = 'message_id')
      AND lower(regexp_replace(pg_get_expr(i.indexprs, i.indrelid), '[[:space:]]+', '', 'g'))
          = 'coalesce(sample_time_utc,read_time_utc,source_receive_time_utc,receive_time_utc)'
  ) THEN
    RAISE EXCEPTION 'Missing, invalid or unexpected telemetry retention index; inspect before scheduling';
  END IF;

  command_30d := replace(command_7d, $interval$interval '7 days'$interval$, $interval$interval '30 days'$interval$);
  normalized_7d := lower(regexp_replace(command_7d, '[[:space:]]+', '', 'g'));
  normalized_30d := lower(regexp_replace(command_30d, '[[:space:]]+', '', 'g'));
  FOR existing_job IN
    SELECT * FROM cron.job
    WHERE jobname = 'one-minihouse-iot-telemetry-7d'
  LOOP
    IF existing_job.username <> current_user OR existing_job.database <> current_database()
       OR lower(regexp_replace(existing_job.command, '[[:space:]]+', '', 'g')) <> normalized_7d THEN
      RAISE EXCEPTION 'Unexpected existing seven-day job; no scheduling changes made';
    END IF;
  END LOOP;
  FOR old_job IN
    SELECT * FROM cron.job
    WHERE jobname = 'one-minihouse-iot-telemetry-30d'
  LOOP
    IF old_job.username <> current_user OR old_job.database <> current_database()
       OR lower(regexp_replace(old_job.command, '[[:space:]]+', '', 'g')) <> normalized_30d THEN
      RAISE EXCEPTION 'Unexpected legacy job; inspect its owner and command before replacement';
    END IF;
  END LOOP;

  -- Validation above completes before either scheduling mutation is attempted.
  FOR old_job IN
    SELECT jobid FROM cron.job
    WHERE jobname = 'one-minihouse-iot-telemetry-30d' AND username = current_user
  LOOP
    IF NOT cron.unschedule(old_job.jobid) THEN
      RAISE EXCEPTION 'Legacy retention job could not be unscheduled';
    END IF;
  END LOOP;
  PERFORM cron.schedule('one-minihouse-iot-telemetry-7d', '*/15 * * * *', command_7d);
END $retention$;

-- Readback only: inspect this job and subsequent runs, not unrelated jobs.
SELECT jobid, jobname, schedule, database, username, active
FROM cron.job
WHERE jobname IN ('one-minihouse-iot-telemetry-30d', 'one-minihouse-iot-telemetry-7d');
SELECT d.status, d.return_message, d.start_time, d.end_time
FROM cron.job_run_details AS d
JOIN cron.job AS j USING (jobid)
WHERE j.jobname = 'one-minihouse-iot-telemetry-7d'
ORDER BY d.start_time DESC
LIMIT 12;

-- Stop ONLY this job if needed; deleted rows cannot be restored by unscheduling.
-- SELECT cron.unschedule(jobid) FROM cron.job
-- WHERE jobname='one-minihouse-iot-telemetry-7d' AND username=current_user;
-- Do not drop pg_cron, the shared index, or restore the old 30-day job blindly.
