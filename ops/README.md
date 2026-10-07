# 运维入口

| 工作 | 入口 |
|---|---|
| 类型检查、单元测试、Python 语法 | `pwsh -File ops/check.ps1` |
| 网关与入库源码打包 | `pwsh -File ops/package.ps1` |
| 采集部署与配置 | [网关](../gateway/README.md) |
| 数据接收和持久化 | [入库](../ingestor/README.md) |
| Linux 服务器本机 MQTT 温度上报 | [Linux 温度](linux-temperature/README.md) |
| sysfs 温度只读命令 | [主机温度](host-temperature/README.md) |
| OpenWrt 主动 MQTT | [路由器温度](openwrt-temperature/README.md) |
| SLS 健康日志 | [服务器健康](server-health/README.md) |
| Grafana 脱敏模板与回归 | [Grafana](grafana/README.md) |
| 采集、展示权限边界 | [PostgreSQL](postgresql-permissions.md) |

GitHub Actions 执行类型检查、协议及队列测试、健康代理测试、Worker dry-run、源码打包及 amd64 镜像构建；不发布、不部署，不使用生产凭据。根目录 uni-app 单独维护。

`backup-before-upgrade.sh` 仅供手动升级备份，不包含定时调度。执行前显式设置 `DEPLOYMENT_ROOT` 和 `BACKUP_ROOT`，核对容器名及暂停范围。SQLite 备份必须包括 WAL，不拿旧快照覆盖新数据。

真实部署记录、连接信息、Grafana 导出、授权快照及截图只保存到被忽略的 `.local/`、`evidence/` 或本地配置。不要清空这些目录来完成 Git 清理；先确认是否仍承担运行或回滚用途。共享文档记录通用行为和方法，不写线上账号、设备归属或分享地址。

运行配置和密码不随源码打包。模板使用合成标识，部署时复制为私有配置；不能将脱敏模板覆盖现有生产配置或线上看板。
