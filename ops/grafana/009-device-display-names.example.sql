-- Synthetic example only: adapt a private copy; never overwrite a live view with this template.
-- UUIDs, reference dates and history thresholds below are fictitious fixtures, not installation evidence.
-- 只调整展示视图的设备名称；保留设备 ID、历史记录、统计口径及既有权限。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='20s';
DO $migration$
DECLARE
  definition text;
  view_options text[];
  old_names text[] := ARRAY['示例分路用电','示例总用电','示例插座用电'];
  new_names text[] := ARRAY['分电表','主电表','插座'];
  i integer;
BEGIN
  definition := pg_get_viewdef('iot.home_electricity_samples'::regclass, true);
  SELECT reloptions INTO view_options FROM pg_class
    WHERE oid='iot.home_electricity_samples'::regclass;
  FOR i IN 1..array_length(old_names,1) LOOP
    IF position(quote_literal(old_names[i]) IN definition)=0
       AND position(quote_literal(new_names[i]) IN definition)=0 THEN
      RAISE EXCEPTION 'Expected display label missing: %', old_names[i];
    END IF;
    definition := replace(definition, quote_literal(old_names[i]), quote_literal(new_names[i]));
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW iot.home_electricity_samples'
    || CASE WHEN array_length(view_options,1)>0
         THEN ' WITH (' || array_to_string(view_options,',') || ')' ELSE '' END
    || ' AS ' || definition;
  IF (SELECT reloptions FROM pg_class
      WHERE oid='iot.home_electricity_samples'::regclass) IS DISTINCT FROM view_options THEN
    RAISE EXCEPTION 'View security options changed; rolling back';
  END IF;
END
$migration$;
COMMENT ON VIEW iot.home_electricity_samples IS 'Grafana 家庭用电视图：仅开放 example-home 的主电表、分电表与蓝牙插座。包含成功实时采样、已验证历史电能及用户安装零点，保留电气参数；三路独立展示，不相加。原始信封不可见，沿用既有只读权限。';
COMMENT ON COLUMN iot.home_electricity_samples.device_id IS '稳定设备标识：meter-main 对应主电表，meter-secondary 对应分电表，socket-example 对应插座；展示改名不修改标识。';
COMMENT ON COLUMN iot.home_electricity_samples.device_name IS '设备中文展示名称：分电表、主电表、插座；用于看板卡片、图例和表格，不作为历史数据关联键。';
COMMIT;
