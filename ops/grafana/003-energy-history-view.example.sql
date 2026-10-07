-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- Extend the existing scoped view; preserve its owner, grants and original columns.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE VIEW iot.home_electricity_samples WITH (security_barrier=true) AS
SELECT message_id, sample_time_utc, receive_time_utc, device_id,
       CASE device_id WHEN 'meter-main' THEN '示例总用电'
                      WHEN 'socket-example' THEN '示例插座用电' END AS device_name,
       (metrics->>'energy_kwh')::double precision AS energy_kwh,
       (metrics->>'power_w')::double precision AS power_w,
       (metrics->>'voltage_v')::double precision AS voltage_v,
       (metrics->>'current_a')::double precision AS current_a,
       (metrics->>'power_factor')::double precision AS power_factor,
       coalesce(sample_time_utc,source_receive_time_utc) AS record_time_utc,
       CASE WHEN processor_id='user-meter-reference' THEN '用户安装基准'
            WHEN quality='historical' THEN '旧系统接收时间' ELSE '设备采样时间' END AS time_basis,
       processor_id='user-meter-reference' AS is_installation,
       quality
FROM iot.telemetry
WHERE site_id='example-home'
 AND ((gateway_id='example-modbus' AND device_id='meter-main')
   OR (gateway_id='example-gateway' AND device_id='socket-example'))
 AND ((quality='ok' AND sample_time_utc IS NOT NULL)
   OR (device_id='meter-main' AND quality='historical' AND
      ((processor_id='legacy-ddsu666' AND output_key='electricity_energy'
        AND lineage->>'source_database_id'='00000000-0000-4000-8000-000000000001'
        AND lineage->>'source_owner_id'='1'
        AND CASE WHEN lineage->>'source_row_id' ~ '^[0-9]+$' THEN (lineage->>'source_row_id')::bigint END>=100
        AND source_receive_time_utc IS NOT NULL)
       OR (processor_id='user-meter-reference' AND output_key='installation_energy'
        AND message_id='00000000-0000-4000-8000-000000000002'))));
COMMENT ON VIEW iot.home_electricity_samples IS 'Grafana 家庭用电视图：仅开放 example-home 的 示例总表与示例插座；包含实时采样、ID>=100 的已验证 示例总表电能历史及用户指定安装基准。原始信封与其它设备不可见，沿用既有只读权限。';
COMMENT ON COLUMN iot.home_electricity_samples.sample_time_utc IS '已知采样或用户指定事件时间（UTC）；旧 D1 历史为 NULL，使用 record_time_utc 展示并通过 time_basis 区分。';
COMMENT ON COLUMN iot.home_electricity_samples.record_time_utc IS '展示和电能统计使用的记录时间（UTC）：优先已知采样/安装事件时间，否则使用旧系统接收时间；不代表所有历史都有设备采样时钟。';
COMMENT ON COLUMN iot.home_electricity_samples.time_basis IS '记录时间依据：设备采样时间、旧系统接收时间或用户安装基准。';
COMMENT ON COLUMN iot.home_electricity_samples.is_installation IS '是否用户指定的安装零度基准；可展示为历史起点，但不用于缺失期间的日用电插值。';
COMMENT ON COLUMN iot.home_electricity_samples.quality IS '数据来源质量：ok 为实时采样，historical 为历史来源或用户参考；来源时间语义见 time_basis。';
COMMIT;
