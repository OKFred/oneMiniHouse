-- Supabase owner only. This deletes at most 10,000 already-expired cloud rows.
-- First run retention-7d-preview.sql and confirm the seven-day policy.
-- Repeat separate submissions if needed; never wrap a retry loop around this.
-- Local PostgreSQL, raw archives, schemas, roles and other tables are untouched.
BEGIN;
SET LOCAL timezone = 'UTC';
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
  IF current_database() <> 'postgres'
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_admin') THEN
    RAISE EXCEPTION 'Supabase-only maintenance: verify the intended cloud database';
  END IF;
END $guard$;

WITH expired AS MATERIALIZED (
  SELECT message_id
  FROM iot.telemetry
  WHERE COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)
        < now() - interval '7 days'
  ORDER BY COALESCE(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc), message_id
  LIMIT 10000
  FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM iot.telemetry AS target
  USING expired
  WHERE target.message_id = expired.message_id
  RETURNING target.message_id
)
SELECT count(*) AS deleted_expired_cloud_rows,
       now() - interval '7 days' AS cutoff_time_utc
FROM deleted;
COMMIT;
