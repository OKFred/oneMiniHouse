-- 修复已执行旧版 005 的本地看板权限；由视图所有者执行，可重复运行。
-- 不修改数据、外层安全屏障、对象所有者或任何 GRANT；无兼容视图的库直接跳过。
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='15s';
DO $repair$
BEGIN
  IF to_regclass('iot.telemetry_observation_compat') IS NULL THEN RETURN; END IF;
  ALTER VIEW iot.telemetry_observation_compat SET (security_invoker=false);
END $repair$;
COMMIT;
