# Grafana 模板与维护

仓库保存脱敏模板；真实导出、账号、数据源 UID、分享 URL、设备对应关系和安装基准留在被忽略的 `.local/` 或 `evidence/`。模板不能直接覆盖或恢复线上看板。

| 模板 | 用途 |
|---|---|
| [home-overview.example.json](home-overview.example.json) | 登录后的完整总览，含用电、环境、设备 |
| [home-electricity.example.json](home-electricity.example.json) | 仅用电的公开展示模板 |
| [010-temperature-view.example.sql](010-temperature-view.example.sql) | 温湿度限定只读视图示例 |
| [011-server-temperature-view.example.sql](011-server-temperature-view.example.sql) | 主机温度限定只读视图示例 |

JSON 是 Grafana V2 Resource，使用合成数据源 `example-postgres` 和设备 ID。导入前在私有副本中替换实际数据源和标识；SQL 中 `example_grafana` 也需替换。示例不创建账号，不插入虚构安装基准，不改变 Supabase 保留策略。

001–009 的 `*.example.sql` 演示限定视图、历史来源筛选、安装基准和展示名称迁移。其 UUID、日期、行号阈值及设备均为虚构样例，执行前必须核对自己的历史来源与现有视图；这些示例不是新实例一键初始化入口。010/011 为当前温度视图模板。

旧示例按文件编号逐步扩展同一视图，两个 005 文件分别处理电量和光照。单个步骤可在对应结构阶段重复执行；执行 008 增加列后，不能再从 001 重放整条链，PostgreSQL 会拒绝删除已有视图列。应记录已应用步骤，并基于当前视图选择后续迁移。

在独立测试库验证这组示例时，需要先应用 `ingestor/sql/001` 至 `004`，明确设置 `one_min_house.ingestor_role`，并准备以下前置条件：

- 预先建立示例只读角色 `example_grafana`，授予 `iot` schema 的 `USAGE`；不授予底表或内部兼容视图权限。
- 001 创建电量视图后，由所有者明确执行 `GRANT SELECT ON iot.home_electricity_samples TO example_grafana`。005 光照示例自行授予其限定视图查询权限。
- 006 内使用 `SET LOCAL ROLE example_grafana` 回查安装基准，执行迁移的管理员或所有者必须具有切换到该角色的权限。不要为通过检查把 Grafana 角色提升为超级用户或底表所有者。
- 006 要求匹配其合成 UUID、日期、零点指标和来源字段的安装基准记录。在隔离测试中构造这些虚构记录；部署时使用已核实的私有基准，不能删除预检或把示例零点写入生产。

验证时同时加入站点、网关、设备和历史行号越界的负例，确认限定视图排除这些行、原始表不能直读，且重复执行不产生重复基准。

## 展示口径

- 完整总览的“用电概览”显示今日、本月、每日已计用电及当前功率；“用电明细”显示时段用电、累计表底和电气参数。
- 环境显示光照、室温和湿度；设备页把主机温度放在一张图中，区分设备和通道。
- 设备温度支持“温度分类”单选，默认全部，可切换 CPU/GPU、主板、内存、硬盘、其他；控件是“设备”标签下的局部变量，只在该页显示，曲线与表格同步筛选。按稳定 `sensor_id` 分类，CPU 仅展示整颗 CPU 的温度，不保留各核心展示指标；内存包含 DDR、硬盘包含 NVMe，未确认物理用途的 ACPI 通道归入其他。筛选只作用于设备温度面板，无数据不补零、不回退全部。
- 各路电表独立，不直接相加。功率 W，电能度（kWh），光照 lux，温度 °C。
- 当前值只显示最近 5 分钟成功读取；缺失、过期不补零，趋势缺口不连线。
- 已计电量只累加不超过 15 分钟的有效相邻增量，跳过负值和长缺口；跨午夜按时长分摊。
- 首末读数差可以跨缺口，与已计电量口径不同。今日、本月不是完整账单。
- 米家数据是网关缓存；read_time_utc 不代表测量时间，未知测量时间保持 NULL。
- 安装基准由用户确认并私有保存，安装到首条采样间不补造每日用电。
- 无功和功率因数保留正负号；视在功率标明计算所得，无风扇设备不产生风扇读数。

## 维护与回归

1. 从线上导出最新资源到 evidence/，以它为基线，保留用户修改及当前分享链接。
2. 保存视图定义、所有者和授权；回滚使用该备份或 Grafana 版本历史。
3. 用 Grafana 实际只读账号核验所有标签页及外部分享，不能用管理员查询成功代替。
4. 只读账号仅能查询四个 home_*_samples 限定视图，不能查询底表或内部兼容视图；不能通过开放底表修复权限错误。
5. 修改后刷新线上页面再导出；原件留在忽略目录，可复用改动脱敏同步到模板。

完整要求见 [AGENTS.md](../../AGENTS.md)。实际 PostgreSQL 回归见 `ingestor/test/grafana-view-permissions.test.ts`，覆盖重复迁移、数值及底表隔离。

设备温度分类在面板查询中使用 `${temperature_category:sqlstring}`，由 Grafana 转义 SQL 字符串；不能替换为 `raw`。变量格式参考 [Grafana 官方说明](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/variable-syntax/#sqlstring)。回归需确认“全部”与修改前一致，各分类互斥且合计覆盖全部通道，空时段仍为空；保存后的默认值为“全部”，保留底部表格及其高度设置。

局部变量存于设备标签的 `spec.variables`，不是看板根 `spec.variables`；参见 [Grafana 标签页局部变量](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard/dashboard-groupings/#section-level-variables-and-filters)。回归还需确认其他标签不出现温度筛选，切回设备页保留当前选择，刷新后筛选仍有效。

## 外部分享

分享以整张看板为范围，隐藏标签不能隔离数据。完整总览和用电看板独立保存，公开版只查询 iot.home_electricity_samples；新增环境和设备温度只进入登录后的总览。保留原分享链接，不暂停或更换；真实 URL 不提交。

反向代理后的域名由部署环境配置，例如：

```yaml
environment:
  GF_SERVER_ROOT_URL: https://grafana.example.com/
  GF_SERVER_DOMAIN: grafana.example.com
```

公开 SQL 使用 `$__timeFrom()::timestamptz` / `$__timeTo()::timestamptz`，避免依赖前端 `${__from}` / `${__to}`。回归同时检查匿名可访问用电、完整总览要求登录、公开接口无法读取环境或设备面板。
