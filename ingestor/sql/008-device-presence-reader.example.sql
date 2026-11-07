-- Synthetic deployment template. Replace exact site/device/client IDs and role in a private copy.
-- Do not grant the reader access to the base table, raw archive or internal processing views.
BEGIN;
CREATE OR REPLACE VIEW iot.home_device_presence_events WITH(security_barrier=true,security_invoker=false) AS
SELECT e.* FROM iot.device_presence_events e
JOIN (VALUES('example-home'::text,'example-host'::text)) allowed(site_id,device_id)
ON e.site_id=allowed.site_id AND e.physical_device_id=allowed.device_id
WHERE e.record_kind='device' AND e.applied AND NOT e.retained;
CREATE OR REPLACE VIEW iot.home_presence_observer_coverage WITH(security_barrier=true,security_invoker=false) AS
SELECT e.site_id,e.observer_client_id,e.observer_session_id,e.observed_time_utc,e.observation_order,e.event,e.sequence,e.coverage_until_utc
FROM iot.device_presence_events e
JOIN (VALUES('example-home'::text,'example-presence-reader'::text)) allowed(site_id,client_id)
ON e.site_id=allowed.site_id AND e.observer_client_id=allowed.client_id
WHERE e.record_kind='observer';
REVOKE ALL ON iot.home_device_presence_events,iot.home_presence_observer_coverage FROM PUBLIC;
GRANT SELECT ON iot.home_device_presence_events,iot.home_presence_observer_coverage TO example_grafana;
COMMIT;
