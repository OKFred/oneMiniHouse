-- Supabase owner only. Run separately from the local database; runtime keeps SELECT/INSERT only.
-- Complements the existing telemetry job; never replace its command with this one.
SELECT cron.schedule('one-minihouse-device-presence-48h','*/15 * * * *',$$
  DELETE FROM iot.device_presence_events WHERE result_id IN(
    SELECT result_id FROM iot.device_presence_events WHERE observed_time_utc<now()-interval '48 hours'
    ORDER BY observed_time_utc,result_id LIMIT 1000);
$$);
