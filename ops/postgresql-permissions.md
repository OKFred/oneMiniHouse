# PostgreSQL 采集账号权限边界

本文是通用检查方法；真实账号、地址、所有者、会话和授权快照存入被忽略的 `.local/` 或 `evidence/`。本项目检查不包含爬虫业务表。

| 用途 | 需要 | 不应具有 |
|---|---|---|
| 遥测入库 | schema USAGE、遥测 INSERT、幂等核对所需 SELECT、限定站点的 RLS | UPDATE、DELETE、TRUNCATE、DDL、转授权 |
| Grafana | 指定展示视图 SELECT | 底表、内部兼容视图访问及写入 |
| 迁移、保留清理 | 管理员单独执行 | 凭据注入采集容器 |

`ingestor/src/database.ts` 使用 ON CONFLICT DO NOTHING。重复投递需读取 message_id、payload_sha256、result_sha256 核对幂等性，不能直接撤销所有 SELECT。收紧到列级查询前要核对验收、诊断脚本，并用实际角色回归。

检查有效权限时同时检查继承与 SET ROLE、对象所有权、PUBLIC 和列级授权、RLS、schema CREATE、序列 UPDATE、可调用 SECURITY DEFINER 函数。只看一条 GRANT 不足以证明无法删改。

在 READ ONLY 事务中使用不带 ANALYZE 的 EXPLAIN 验证 UPDATE、DELETE 拒绝，不实际改动数据。TRUNCATE、DROP 等用权限和所有权目录检查，不拿生产数据试删。展示变更遵循 [项目回归规则](../AGENTS.md)，必须用真实 Grafana 账号读取限定视图，同时确认底表及内部兼容视图不可读。

仅允许新增仍不能阻止伪造数据或占用存储，它保护已有记录免受直接覆盖、删除，不能替代账号隔离、日志和备份。授权或函数变化后应重新检查，保存私有快照。
