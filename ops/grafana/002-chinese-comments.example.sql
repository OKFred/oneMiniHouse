-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- 仅用于已有家庭用电视图的本地 PostgreSQL；以视图所有者执行。
-- 只修改注释，不重建视图或扩大 Grafana 的查询权限。
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '15s';
COMMENT ON VIEW iot.home_electricity_samples IS 'Grafana 家庭用电查询视图：仅展示 example-home 站点中明确限定的 示例总表和示例插座，且要求 quality=ok、真实采样时间非空；不暴露原始信封。底表访问采用视图所有者权限，以视图条件限定范围。';
COMMENT ON COLUMN iot.home_electricity_samples.message_id IS '对应遥测结果的唯一消息标识，用于追溯底表记录和确定重复采样的排序。';
COMMENT ON COLUMN iot.home_electricity_samples.sample_time_utc IS '设备真实测量时间（UTC，timestamptz）；Grafana 按 Asia/Shanghai 展示，并以此计算趋势、数据新鲜度和用电区间。';
COMMENT ON COLUMN iot.home_electricity_samples.receive_time_utc IS '入库服务首次接收该事件的时间（UTC，timestamptz）；同设备同采样时间存在多条记录时用于选择最新接收记录。';
COMMENT ON COLUMN iot.home_electricity_samples.device_id IS '看板限定的设备标识：meter-main 为 示例总用电，socket-example 为示例插座用电。';
COMMENT ON COLUMN iot.home_electricity_samples.device_name IS '设备的中文展示名称：示例总用电或示例插座用电；两路独立展示，不相加。';
COMMENT ON COLUMN iot.home_electricity_samples.energy_kwh IS '累计有功电能表底（kWh），不是本日或本月用电量；看板以相邻有效表底的非负增量计算区间用电，缺失值为 NULL。';
COMMENT ON COLUMN iot.home_electricity_samples.power_w IS '设备上报的瞬时有功功率（W）；缺失为 NULL，看板超过 5 分钟的旧采样不作为当前功率。';
COMMENT ON COLUMN iot.home_electricity_samples.voltage_v IS '设备上报的电压（V）；来自遥测指标 voltage_v，缺失为 NULL。';
COMMENT ON COLUMN iot.home_electricity_samples.current_a IS '设备上报的电流（A）；来自遥测指标 current_a，缺失为 NULL。';
COMMENT ON COLUMN iot.home_electricity_samples.power_factor IS '设备上报的功率因数（无量纲）；保留设备符号约定，缺失为 NULL。';
COMMIT;
