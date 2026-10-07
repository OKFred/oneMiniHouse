# 温湿度指标质量

WSDCGQ01LM 官方检测范围为温度 **−20～50°C**、相对湿度 **10～90% RH（无冷凝）**，含边界；精度分别为 ±0.3°C、±3% RH。依据[小米官方说明书，繁中印刷第 54 页](https://i01.appmifile.com/webfile/globalimg/Global_UG/Mi_Ecosystem/Mi_Temperature_and_Humidity_Sensor/Temperature_Sensor_fr_V1.pdf#page=56)。超规格表示无法按该设备规格信任读数，不等同于环境不可能或设备已损坏。

采集端只校验协议结构、安全整数及单位换算，数值超规格仍上报 MQTT。ingestor 先持久保存原始信封，再将精确匹配 `source.driver=xiaomi-gateway-v3-temperature`、`source.sensor_model=WSDCGQ01LM` 的观测交给 `xiaomi-temperature-quality/1`。其他设备保持原有处理器。

质量结果保存在 `lineage.metric_quality`，包含规则名称、版本和每项指标的 `ok/out_of_spec/missing/invalid`。原始指标和来源 `quality` 不变；来源 `quality=ok` 只表示读取成功，不能替代指标质量判断。质量标签参与新处理器的结果哈希及重放冲突检查，旧处理器的哈希契约保持不变。

Grafana 温湿度视图逐指标将异常投影为 NULL，保留有效的其他指标。旧记录没有标签时按同一官方范围保护展示。最新一条异常时不能退回旧值冒充当前值；均值、最大值等不包含异常值，全异常时间桶为 NULL，趋势图禁止跨缺口连线。范围仅适用于配置为该型号的室温设备，不适用于服务器温度。

历史订正采用原始记录重放到新处理器，追加具有确定 ID 的加工版本，保留旧结果、原始字节、时间和读数。视图按原始记录只选一个加工版本，优先 `xiaomi-temperature-quality/1`，防止重复计数。后续升级规则须同时升级处理器版本及视图优先规则；不可直接改变同版本决策。查询底表进行分析时也必须选择加工版本，不能把版本并存当作多次采样。

上线前备份当前视图定义、权限、列注释与 Compose 配置；在实际 PostgreSQL 上运行 `ingestor/test/metric-quality-view.test.sql`（仅独立测试库）。部署后使用 Grafana 实际只读账号回归所有标签页、安装基准、数据新鲜度、缺失行为及公开分享页，确认底表访问仍被拒绝。回滚恢复旧处理器路由和原视图，保留原始数据及所有加工版本。
