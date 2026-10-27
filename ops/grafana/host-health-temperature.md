# 主机健康 CPU 温度接入现有设备页

[014-host-health-temperature-view.example.sql](014-host-health-temperature-view.example.sql) 是合成模板，部署前在私有副本替换精确站点、网关、设备、展示名和 Grafana 只读角色。先保存线上最新看板、新视图若已存在时的定义、所有者和授权；不以旧仓库看板覆盖用户布局。

在 ingestor 私有配置中增补可选的 `hostHealthInputs`，原有连接和订阅分配保持。以下只展示增补字段，全部身份和路径均为合成示例：

```json
{
  "hostHealthInputs": [{
    "siteId": "example-home",
    "hostId": "example-router",
    "topic": "iot/v1/example-home/example-router/host-health",
    "deviceId": "temperature-example-router",
    "clientId": "example-host-health-temperature-ingestor",
    "username": "example-host-health-reader",
    "passwordFile": "/run/example-host-health-reader-password"
  }]
}
```

每项建立独立的 MQTT 5 持久客户端，复用 `mqtt.url` 的 TLS Broker，仅读取这一精确主题并要求 QoS 1、非 retained 消息。客户端 ID 不能与任何原连接重复；主题须与配置的站点和主机完全一致。可复用已有仅能订阅该精确主题的消费账号凭据，不给原入库账号增加订阅范围，也不增加发布权限。密码只读挂载到绝对路径文件，不写入源码或 URL。省略该列表时保持原有行为；本处理器只生成整颗 CPU 的 `cpu_temperature_c` 加工结果，不生成单核心温度或内存、动作指标行。

部署前核对容器的实际运行 UID，并确保凭据文件由该 UID 拥有、以 `0600` 可读；启用 `cap_drop: [ALL]` 后，即使进程是 root，也不能绕过其他属主文件的 `0600` 权限。复用账号时保留原凭据文件，为本容器保存同一值的受限副本并只读挂载，不通过放宽原文件权限或增加 capabilities 解决读取失败。新增挂载目标宜使用独立路径；若父目录已经只读挂载，必须先准备好其中的子挂载点，不能假定 Docker 还能在该只读父目录中创建目标文件。

视图只读取 `host-health-temperature` v1 的 `cpu_temperature_c` 结果、精确白名单和 `openwrt-host-health/linux_thermal` 来源。要求 v2、`ok/direct_read`、有限且有序的 UTC 读取/接收时间；该接口没有独立测量时间，`sample_time_utc` 保持 NULL。缺失、非法类型、质量拒绝和范围外的温度不产生行，真实零保留。`-50..150°C` 是与原生采集器相同的合理性保护，不是厂家工作范围或告警阈值。单位已经由生产端从毫摄氏度换算，这里不重复缩放。[Linux thermal ABI](https://docs.kernel.org/driver-api/thermal/sysfs-api.html)

`iot.home_host_health_temperature_samples` 是新增的安全屏障、所有者权限视图；显式撤销 PUBLIC，仅授予配置的只读角色 SELECT，不开放 `iot.telemetry` 或内部兼容视图。原始健康报文、内存指标、动作记录和认证信息不进入该视图，所有新列都有中文注释。

现有「设备」温度查询只增加显式 UNION 分支，保留原分支的聚合、时间筛选、分类、布局和图表/表格高度：

```sql
SELECT read_time_utc,device_name,sensor_name,sensor_id,temperature_c
FROM iot.home_host_health_temperature_samples
```

沿用现有 CPU/GPU 分类；不新增标签页或面板。曲线按 `read_time_utc` 展示，补报不伪装为当前值，缺口不连线。公开分享继续仅展示用电，原链接保持有效。

独立 PostgreSQL 17 回归包含身份/版本/来源/时间过滤、温度值/单位/真实零、缺测不造零、逐指标质量、重复迁移、原有用电/环境/主机/手机/资产视图的定义及结果不变、实际只读账号登录、底表/内部视图拒绝，以及危险 PUBLIC 默认 SELECT 的撤销。只在本地 Docker Desktop 新建的无网络、无端口、tmpfs 数据容器运行：

```sh
node ops/grafana/test-host-health-temperature.mjs
```

本地隔离测试不能替代线上验收。上线后必须用实际 Grafana 数据源账号回归当前所有标签页、温度分类与既有公开用电页，并核对双库真实消息、原始时间、单位和缺失行为。
