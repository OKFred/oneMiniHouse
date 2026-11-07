-- Owner-run after installing the approved private registry. No source table grants.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
-- Bound last-heartbeat tooltips even if a device has a long history of unknown/offline observations.
CREATE INDEX IF NOT EXISTS device_presence_last_affirmative
ON iot.device_presence_events(site_id,physical_device_id,observed_time_utc DESC,observation_order DESC)
WHERE record_kind='device' AND applied AND NOT retained AND online AND state_after='online';
COMMENT ON INDEX iot.device_presence_last_affirmative IS '首次有效在线证据的时间索引：区间提示直接查前驱，避免逐段扫描长期离线历史。';
CREATE OR REPLACE VIEW iot.home_device_presence_events WITH(security_barrier=true,security_invoker=false) AS
SELECT e.* FROM iot.device_presence_events e JOIN iot.home_presence_registry r
  ON e.site_id=r.site_id AND e.physical_device_id=r.physical_device_id
WHERE e.record_kind='device' AND e.applied AND NOT e.retained;
CREATE OR REPLACE VIEW iot.home_presence_observer_coverage WITH(security_barrier=true,security_invoker=false) AS
SELECT e.site_id,e.observer_client_id,e.observer_session_id,e.observed_time_utc,e.observation_order,e.event,e.sequence,e.coverage_until_utc
FROM iot.device_presence_events e JOIN(
  SELECT DISTINCT r.site_id,r.observer_client_id FROM iot.home_presence_registry r
) allowed ON e.site_id=allowed.site_id AND e.observer_client_id=allowed.observer_client_id
WHERE e.record_kind='observer';
REVOKE ALL ON iot.home_device_presence_events,iot.home_presence_observer_coverage FROM PUBLIC;
COMMENT ON VIEW iot.home_device_presence_events IS '仅开放物理及隐藏依赖白名单的首次有效状态事件；保留快照、被拒绝事件和完整原始消息不可读。';
COMMENT ON VIEW iot.home_presence_observer_coverage IS '仅开放白名单观察客户端的覆盖事件，用于区分物理无新上报与接收链路未知。';
DO $comments$
DECLARE field record; relation text;
BEGIN
  FOREACH relation IN ARRAY ARRAY['home_device_presence_events','home_presence_observer_coverage'] LOOP
    FOR field IN SELECT a.attname,col_description('iot.device_presence_events'::regclass,b.attnum) AS description
      FROM pg_attribute a JOIN pg_attribute b ON b.attrelid='iot.device_presence_events'::regclass AND b.attname=a.attname
      WHERE a.attrelid=format('iot.%I',relation)::regclass AND a.attnum>0 AND NOT a.attisdropped LOOP
      EXECUTE format('COMMENT ON COLUMN iot.%I.%I IS %L',relation,field.attname,field.description);
    END LOOP;
  END LOOP;
END $comments$;
COMMIT;
