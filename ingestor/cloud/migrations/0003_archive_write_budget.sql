-- 云端原始副本仅通过 raw_id 去重、expire_time_utc 清理。
-- 删除当前 API 未使用的二级索引，减少每条 INSERT 的维护写入；
-- 不改变数据、主键、不可变字段校验及到期清理索引。
-- https://developers.cloudflare.com/d1/platform/pricing/
DROP INDEX IF EXISTS raw_message_device_time;
