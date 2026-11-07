-- Owner-run after the private fixed policy/source seed. Additive; no changes to new-only presence.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $validate$
BEGIN
  IF (SELECT count(*)<>1 OR NOT bool_and(coalesce(isfinite(cutover_utc),false)) FROM iot.home_presence_history_policy) THEN
    RAISE EXCEPTION 'Historical presence requires exactly one finite fixed cutover';
  END IF;
  IF EXISTS(SELECT 1 FROM iot.home_presence_history_sources s LEFT JOIN iot.home_presence_registry r
    ON s.physical_device_id=r.physical_device_id AND s.site_id=r.site_id
    WHERE r.physical_device_id IS NULL OR NOT r.visible OR r.kind='cached' OR r.freshness_seconds IS NULL
      OR s.freshness_seconds IS DISTINCT FROM r.freshness_seconds OR s.freshness_seconds NOT BETWEEN 1 AND 259200
      OR s.processor_id NOT IN('iot-telemetry','host-health-temperature')
      OR (s.required_source_integrity IS NOT NULL AND s.required_source_driver IS NULL)
      OR s.site_id IS NULL OR s.gateway_id IS NULL OR s.device_id IS NULL OR s.processor_id IS NULL) THEN
    RAISE EXCEPTION 'Historical source must match an approved visible direct device and known TTL';
  END IF;
  IF EXISTS(SELECT 1 FROM iot.home_presence_history_sources
    GROUP BY site_id,gateway_id,device_id,processor_id,required_source_driver,required_source_integrity
    HAVING count(*)<>1) THEN
    RAISE EXCEPTION 'Historical source identities must be unique and cannot map to multiple physical devices';
  END IF;
END $validate$;
CREATE OR REPLACE VIEW iot.home_presence_history_evidence WITH(security_barrier=true,security_invoker=false) AS
SELECT s.physical_device_id,s.site_id,t.read_time_utc,t.receive_time_utc,s.freshness_seconds,p.cutover_utc,
  least(t.read_time_utc+make_interval(secs=>s.freshness_seconds),p.cutover_utc) AS valid_until_utc
FROM iot.home_presence_history_sources s JOIN iot.home_presence_registry r
  ON r.physical_device_id=s.physical_device_id AND r.site_id=s.site_id
CROSS JOIN iot.home_presence_history_policy p
JOIN iot.telemetry t ON t.site_id=s.site_id AND t.gateway_id=s.gateway_id AND t.device_id=s.device_id AND t.processor_id=s.processor_id
WHERE r.visible AND r.kind IN('direct','proxy') AND r.freshness_seconds IS NOT NULL
  AND s.freshness_seconds=r.freshness_seconds AND s.freshness_seconds BETWEEN 1 AND 259200
  AND s.processor_id IN('iot-telemetry','host-health-temperature')
  AND (s.required_source_driver IS NULL OR t.lineage#>>'{source,driver}'=s.required_source_driver)
  AND (s.required_source_integrity IS NULL OR t.lineage#>>'{source,integrity}'=s.required_source_integrity)
  AND t.quality='ok' AND t.observation_kind='direct_read'
  AND t.read_time_utc IS NOT NULL AND isfinite(t.read_time_utc)
  AND t.receive_time_utc IS NOT NULL AND isfinite(t.receive_time_utc)
  AND t.read_time_utc<p.cutover_utc
  AND CASE WHEN isfinite(t.read_time_utc) AND isfinite(t.receive_time_utc) THEN
    t.read_time_utc-t.receive_time_utc<=interval '500 milliseconds'
    AND t.receive_time_utc-t.read_time_utc<=make_interval(secs=>s.freshness_seconds)
    ELSE false END;
REVOKE ALL ON iot.home_presence_history_evidence FROM PUBLIC;
COMMENT ON VIEW iot.home_presence_history_evidence IS '受限历史在线推断证据：精确身份、已知周期、正常直接读取和可信读写时序；不展开温度JSON、不接纳缓存或历史导入，也不把接收时间当新读数。';
COMMENT ON COLUMN iot.home_presence_history_evidence.physical_device_id IS '已确认的可见物理资产身份，不增加虚拟机或温度通道。';
COMMENT ON COLUMN iot.home_presence_history_evidence.site_id IS '精确白名单站点。';
COMMENT ON COLUMN iot.home_presence_history_evidence.read_time_utc IS '历史直接读取的 UTC 源时间，推断区间只向前延伸。';
COMMENT ON COLUMN iot.home_presence_history_evidence.receive_time_utc IS '历史事件首次到达入库端的 UTC 时间；允许期限内晚到，但不刷新切点后的在线状态。';
COMMENT ON COLUMN iot.home_presence_history_evidence.freshness_seconds IS '已确认源周期对应的 TTL，未知周期不提供证据。';
COMMENT ON COLUMN iot.home_presence_history_evidence.cutover_utc IS '私有固定切点，云端48小时清理不会改变。';
COMMENT ON COLUMN iot.home_presence_history_evidence.valid_until_utc IS 'min(读取时间+TTL,固定切点)，只证明之前的正向有限推断区间。';

CREATE OR REPLACE FUNCTION iot.home_presence_display_timeline(p_from timestamptz,p_to timestamptz)
RETURNS TABLE(
  start_time_utc timestamptz,end_time_utc timestamptz,physical_device_id text,device_name text,kind text,state text,basis text,
  last_heartbeat_time_utc timestamptz,last_heartbeat_source_time_utc timestamptz,last_observed_time_utc timestamptz,
  reporter_id text,boot_id text,session_id uuid,observer_client_id text,observer_session_id uuid,parent_id text,
  history_read_time_utc timestamptz,history_receive_time_utc timestamptz
)
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path=pg_catalog,iot AS $function$
DECLARE cutover timestamptz; historical_to timestamptz;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR NOT isfinite(p_from) OR NOT isfinite(p_to) OR p_from>=p_to THEN
    RAISE EXCEPTION 'Presence requires a finite increasing UTC range' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*)<>count(DISTINCT r.physical_device_id) OR count(*)>256 FROM iot.home_presence_registry r) THEN
    RAISE EXCEPTION 'Presence registry identities must be unique and bounded' USING ERRCODE='22023';
  END IF;
  IF (SELECT count(*)<>1 FROM iot.home_presence_history_policy) THEN
    RAISE EXCEPTION 'Historical presence requires one fixed cutover' USING ERRCODE='22023';
  END IF;
  SELECT p.cutover_utc INTO cutover FROM iot.home_presence_history_policy p;
  IF cutover IS NULL OR NOT isfinite(cutover) THEN RAISE EXCEPTION 'Invalid fixed historical cutover';END IF;
  historical_to:=least(p_to,cutover);
  IF p_from<historical_to THEN
    RETURN QUERY
    WITH evidence AS MATERIALIZED(
      SELECT DISTINCT h.physical_device_id,h.read_time_utc,h.receive_time_utc,
        greatest(h.read_time_utc,p_from) AS starts,least(h.valid_until_utc,historical_to) AS ends
      FROM iot.home_presence_history_evidence h
      WHERE h.read_time_utc<historical_to AND h.read_time_utc>p_from-interval '259200 seconds'
        AND h.valid_until_utc>p_from
    ), preceding AS(
      SELECT e.*,max(e.ends) OVER(PARTITION BY e.physical_device_id ORDER BY e.starts,e.ends,e.read_time_utc,e.receive_time_utc
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS previous_end FROM evidence e WHERE e.starts<e.ends
    ), grouped AS(
      SELECT e.*,sum(CASE WHEN e.previous_end IS NULL OR e.starts>e.previous_end THEN 1 ELSE 0 END)
        OVER(PARTITION BY e.physical_device_id ORDER BY e.starts,e.ends,e.read_time_utc,e.receive_time_utc ROWS UNBOUNDED PRECEDING) AS island
      FROM preceding e
    ), islands AS MATERIALIZED(
      SELECT e.physical_device_id,min(e.starts) AS starts,max(e.ends) AS ends,
        max(e.read_time_utc) AS last_read,
        (array_agg(e.receive_time_utc ORDER BY e.read_time_utc DESC,e.receive_time_utc DESC))[1] AS last_receive
      FROM grouped e GROUP BY e.physical_device_id,e.island
    ), covered AS(
      SELECT e.physical_device_id,range_agg(tstzrange(e.starts,e.ends,'[)')) AS ranges FROM islands e GROUP BY e.physical_device_id
    ), segments AS(
      SELECT e.physical_device_id,e.starts,e.ends,'online'::text AS status,'历史上报推断'::text AS why,e.last_read,e.last_receive FROM islands e
      UNION ALL
      SELECT r.physical_device_id,lower(gap),upper(gap),'unknown','历史无直接证据',NULL::timestamptz,NULL::timestamptz
      FROM iot.home_presence_registry r LEFT JOIN covered c ON c.physical_device_id=r.physical_device_id
      CROSS JOIN LATERAL unnest(tstzmultirange(tstzrange(p_from,historical_to,'[)'))-coalesce(c.ranges,'{}'::tstzmultirange)) gap
      WHERE r.visible
    ) SELECT s.starts,s.ends,r.physical_device_id,r.device_name,r.kind,s.status,s.why,
      NULL::timestamptz,NULL::timestamptz,NULL::timestamptz,NULL::text,NULL::text,NULL::uuid,NULL::text,NULL::uuid,r.parent_id,
      s.last_read,s.last_receive
    FROM segments s JOIN iot.home_presence_registry r ON r.physical_device_id=s.physical_device_id WHERE r.visible;
  END IF;
  IF p_to>cutover THEN
    RETURN QUERY SELECT n.*,NULL::timestamptz,NULL::timestamptz
      FROM iot.home_presence_timeline(greatest(p_from,cutover),p_to) n;
  END IF;
END $function$;
REVOKE ALL ON FUNCTION iot.home_presence_display_timeline(timestamptz,timestamptz) FROM PUBLIC;
COMMENT ON FUNCTION iot.home_presence_display_timeline(timestamptz,timestamptz) IS '固定切点前仅显示正常直接上报向前TTL岛及未知补集；无精确离线或旧会话推测。切点后完全沿用实时presence函数，不用历史遥测补观察链路缺口。';
DO $grant$
DECLARE reader text:=nullif(current_setting('one_min_house.grafana_role',true),'');
BEGIN
  IF reader IS NULL THEN RAISE EXCEPTION 'Set one_min_house.grafana_role before historical presence migration';END IF;
  EXECUTE format('GRANT SELECT ON iot.home_presence_history_policy,iot.home_presence_history_evidence TO %I',reader);
  EXECUTE format('GRANT EXECUTE ON FUNCTION iot.home_presence_display_timeline(timestamptz,timestamptz) TO %I',reader);
END $grant$;
COMMIT;
