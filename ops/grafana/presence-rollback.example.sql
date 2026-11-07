-- Initial-install rollback only. For an existing installation restore the saved definitions and ACLs instead.
-- Remove the new panel/query from the current dashboard first; never import an old complete dashboard.
BEGIN;
SET LOCAL lock_timeout='5s';
DROP FUNCTION IF EXISTS iot.home_presence_timeline(timestamptz,timestamptz);
DROP VIEW IF EXISTS iot.home_device_presence_events;
DROP VIEW IF EXISTS iot.home_presence_observer_coverage;
DROP VIEW IF EXISTS iot.home_presence_registry;
DROP INDEX IF EXISTS iot.device_presence_last_affirmative;
COMMIT;
-- Preserve iot.device_presence_events, SQLite raw/cursor/jobs, delivery state, all existing views and retention jobs.
