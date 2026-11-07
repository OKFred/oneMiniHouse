-- Remove the new history/display panel query first, or point it back to the new-only function.
-- Initial installation only; otherwise restore saved definitions/ACLs for these new objects.
BEGIN;
SET LOCAL lock_timeout='5s';
DROP FUNCTION IF EXISTS iot.home_presence_display_timeline(timestamptz,timestamptz);
DROP VIEW IF EXISTS iot.home_presence_history_evidence;
DROP VIEW IF EXISTS iot.home_presence_history_sources;
DROP VIEW IF EXISTS iot.home_presence_history_policy;
COMMIT;
-- Preserve the new-only timeline, presence events, telemetry, raw/archive queues and all retention jobs.
