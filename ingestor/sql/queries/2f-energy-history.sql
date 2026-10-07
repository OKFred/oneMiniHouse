-- 2F 累计电能统一查询：历史接收时间、实时采样时间和用户提供的安装基准分别标注。
-- 此文件仅 SELECT；不改变表、视图或 Grafana 当前统计口径。
SELECT message_id,
       coalesce(sample_time_utc, source_receive_time_utc) AS record_time_utc,
       sample_time_utc,
       source_receive_time_utc,
       (metrics->>'energy_kwh')::double precision AS energy_kwh,
       CASE WHEN processor_id='user-meter-reference' THEN '用户提供的安装基准'
            WHEN processor_id='legacy-ddsu666' THEN '旧系统接收时间'
            ELSE '设备采样时间' END AS time_basis,
       quality,
       lineage->>'source_row_id' AS source_row_id
FROM iot.telemetry
WHERE site_id='example-home'
  AND gateway_id='example-modbus'
  AND device_id='meter-main'
  AND metrics ? 'energy_kwh'
ORDER BY coalesce(sample_time_utc, source_receive_time_utc), message_id;

-- 不将跨月/跨年的缺口分摊为每日用电；原始累计值有倒退时需在派生层独立处理。
