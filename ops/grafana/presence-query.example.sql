-- Global Grafana time range only; independent of temperature_category and temperature metrics.
SELECT start_time_utc AS time,end_time_utc AS time_end,device_name AS metric,state,
  basis,last_heartbeat_time_utc,last_heartbeat_source_time_utc,last_observed_time_utc,
  reporter_id,boot_id,session_id,observer_client_id,observer_session_id,parent_id
FROM iot.home_presence_timeline($__timeFrom()::timestamptz,$__timeTo()::timestamptz)
ORDER BY start_time_utc,device_name;
