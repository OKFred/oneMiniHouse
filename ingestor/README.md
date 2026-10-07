# oneMiniHouse 分层入库服务

独立的 Node.js 24 / TypeScript / pnpm 服务，承接蓝牙插座和 Modbus 电表的 MQTT 数据。原始层保留来源内容，加工层提供统一指标，派生层按查询需要计算。域名、数据库 TLS 改造和 PG 主备集群不在这次变更中。

本文说明代码具备的行为和部署步骤，**不代表已经完成生产切换、历史数据全量双写或 SLS 验收**。运行状态以部署记录、健康文件及对应目标的实际查询结果为准。

现场网络恢复和双库核验记录应放入私有 evidence/，公共文档不包含真实实例状态。

## 数据路径与表职责

```text
采集网关 → EMQX
               ├─ telemetry → 本地 SQLite 原始层 → D1 原始副本
               │                       ↓ 版本化处理
               │                SQLite 加工结果与投递任务
               │                    ├─ 本地 PostgreSQL
               │                    └─ Supabase PostgreSQL
               │                          ↓
               │                     查询时派生视图
               └─ frames → 本地协议帧表 → SLS
```

| 层 | 存储及主要表 | 内容与边界 |
|---|---|---|
| 原始层 | SQLite `raw_message`；D1 原始副本 | MQTT 首次接收的完整 UTF-8 文本，包括空白、键顺序和 BOM；原始文本哈希与语义哈希分开保存 |
| 处理调度 | SQLite `processing_job` | 以 `raw_id + processor_id + processor_version` 标识任务，保留处理状态、重试次数和错误原因 |
| 加工结果缓存 | SQLite `processed_result` | 保存可重试的统一结果，处理成功与结果、投递任务在同一事务中提交 |
| 目标投递 | SQLite `delivery_job` | 每个加工结果独立投递本地 PG、Supabase；原始记录投递 D1，协议帧投递 SLS，各自确认和重试 |
| 加工层 | 两端 PG 的 `iot.telemetry` | 数值指标、单位、采样时间、质量及来源信息；新记录不重复保存完整原始文本 |
| 派生层 | `iot.measured_metrics`、`iot.derived_electrical` | 当前采用查询视图；视在功率由电压乘电流计算，单独列为派生量，不冒充原始测量值 |
| 协议诊断 | SQLite `protocol_frame`；可选 SLS | `tx/rx`、`wire_hex`、CRC 标记、`frame_id`、`collection_id`；不写入 D1 或 PG 遥测表 |

原始记录使用 `data_kind = inline | object_ref`、真实 MIME `content_type` 和 TEXT `raw_data`。`object_ref` 预留为对象存储描述 JSON，包含稳定对象位置及文件哈希；本版只接入 IoT 文本消息，不实现图片上传、OCR 或 HTML 采集。

MQTT 接口保持兼容：订阅配置前缀下的 `devices/+/telemetry` 和 `devices/+/frames`，不把 retained 的 `state` 或 `status` 当历史采样。协议帧与业务消息通过 `collection_id` 关联，允许分别到达。

`mqtt.topicPrefixes` 控制遥测订阅；可选 `mqtt.frameTopicPrefixes` 只列出需要协议报文的前缀，必须是前者的无重复子集。省略时沿用全部前缀，设为 `[]` 时不订阅报文。只有温度遥测的主机无需占用报文订阅；总订阅数为遥测前缀数 + 报文前缀数 + collectd 精确主题数，部署前核对 broker 的订阅额度。重连时先取消被排除的精确报文订阅，再建立所需订阅；保留持久会话及其待投递消息。

可选 `mqtt.telemetryClients` 将新增温度前缀交给同一进程中的独立 MQTT 连接：每项为 `{ "clientId": "example-ingestor-temperatures", "topicPrefixes": ["iot/v1/example-home/example-host-a"] }`。全局 `mqtt.topicPrefixes` 仍是设备身份白名单，每个附加前缀必须属于该白名单且只能分配一次。主连接保留未分配的遥测、全部已配置报文和 collectd 主题；附加连接只订阅各自的遥测。每个连接最多 10 条订阅，客户端 ID 必须各不相同，并在重启后保持稳定。附加连接共用入库只读订阅账号、TLS 配置、SQLite 队列、告警状态和双库投递任务，不创建第二份数据库写入流程。合成配置片段见 [MQTT 多连接示例](config/mqtt-telemetry-clients.example.json)，需合并到现有配置，不能直接替换生产配置。

扩容时保留主连接的原 `clientId` 和 `frameTopicPrefixes` 显式列表，只把新主机分配给新客户端 ID。连接建立后会取消当前白名单内已知但不再属于该连接的过滤器；不会清空持久会话。若调整已有连接的前缀归属，应先排空旧连接的积压并核对 broker 订阅列表。旧会话可能仍投递取消订阅前排队的消息；不符合当前连接分配的消息会先持久隔离，不会跨身份入库。对于已经从全局配置完全移除的旧过滤器，需在 broker 另行核实清理，客户端无法枚举服务端历史订阅。

任一连接断线或订阅被拒绝，不会停止其他连接和数据库投递。SUBACK/UNSUBACK 失败按 30、60、120、240、300 秒退避重试，上限 300 秒；不会为订阅拒绝反复重建传输连接。原始消息及告警状态提交成功后才允许 QoS 1 PUBACK；容量或存储错误时仅断开该接收连接，保留未确认消息，待队列恢复后由持久会话重投。隔离失败同样不确认消息。

`health.json` 保留 `mqtt_connected`、`subscribed`、`intake_paused` 汇总字段，另增加 `mqtt_connections`，逐连接记录 `client_id`、连接/订阅状态、配置订阅数和错误代码。所有连接均可用时汇总才健康，任一连接不可用时服务降级；主连接及其他目标仍继续处理。正常停止时关闭全部连接并保留其服务端会话，不删除共享队列。

## 时间、标识与一致性

新持久化时间字段统一使用 `*_time_utc`：SQLite / D1 为 Unix 毫秒整数；PG 为 `timestamptz`。

| 字段 | 含义 |
|---|---|
| `generate_time_utc` | 原始内容生成方提供的时间；未知则为 NULL |
| `sample_time_utc` | 设备提供的真实测量时间；来源未提供时为 NULL |
| `read_time_utc` | 采集端读取完成时间；旧实时 MQTT `captured_at` 在处理时映射到这里 |
| `source_receive_time_utc` | 历史来源系统记录的接收时间；不能当成设备采样时间 |
| `receive_time_utc` | 本入库服务首次收到该原始事件的时间 |
| `store_time_utc` | 对应存储层保存记录时生成的时间；不同副本可以不同 |
| `expire_time_utc` | 原始消息或协议帧计划清理的时间 |
| `frame_time_utc` | 采集端记录的协议帧收发时间 |

早期 PG 迁移将 `captured_at` 政名为 `sample_time_utc`；`005-observation-times.sql` 进一步修正旧实时数据，把实际属于采集端读取时间的值移入 `read_time_utc`。MQTT v2 明确携带两种时间、`observation_kind`，其中小米网关缓存读数使用 `gateway_cached_state`。历史人工基准及来源接收时间保留原有语义；旧 payload、消息 ID 和 v1 哈希不重写。

已执行旧版 `005` 且出现 Grafana `permission denied for table telemetry` 的本地库，
由对象所有者单独执行 `sql/006-grafana-compat-permissions.sql`。它仅将内部兼容视图
恢复为按视图所有者检查权限；外层安全屏障、设备过滤、既有授权和数据保持原样。
无兼容视图的数据库直接跳过。正常 `pnpm migrate` 也包含此修复。
`measured_metrics` / `derived_electrical` 仍使用调用者权限，不要一并改变。

权限回归测试使用真实 PostgreSQL 的普通 Grafana 角色，覆盖旧故障复现、数值和时间保持、
限定视图访问、底表拒绝访问、重复迁移及无看板库的跳过行为。准备一个没有生产数据的
PostgreSQL 17 Docker 容器（可用容器内 `postgres` 用户执行 psql，名称必须为
`one-minihouse-…-test`），在项目根目录运行：

```powershell
$env:PG_TEST_CONTAINER='one-minihouse-p0-pg-test'
pnpm --dir ingestor test
Remove-Item Env:PG_TEST_CONTAINER
```

测试只创建、删除该容器内随机命名的临时数据库；不读取运行环境凭据。不设置变量时
此集成测试明确显示为跳过，不能以此宣称数据库权限回归通过。展示变更须遵守
[项目回归规则](../AGENTS.md)。

升级顺序：先迁移本地 PG 和 Supabase，再升级支持 v1/v2 的入库服务，最后启用 v2 发布端。数据库兼容触发器允许旧 v1 服务过渡运行；仅完成数据库迁移不代表旧入库程序已能解析 v2。

R4S 使用原生 collectd 文本，不使用通用 JSON telemetry 主题。通过配置
`collectdTemperatures` 指定 `topic`、`deviceId`、`metric`；示例配置包含 CPU/GPU
两个精确主题，部署时追加到原有订阅，不将 R4S 加入通用 `topicPrefixes`。
适配器保存原始文本（含末尾 NUL）后，用 `collectd-temperature` v1 处理器生成 v2 结果。
源 Unix 时间是 collectd 的读取时间，`sample_time_utc=NULL`，`observation_kind=direct_read`。
通道和读取时间确定原始 ID，同通道同时间不同值被隔离；重试和重启不生成新的结果 ID。
原始记录的 `source_id` 保存通道映射，重放不依赖后来更改的运行时配置。
无效值被隔离，不补零；容量不足保留未发记录并暂停接收。
上线和保活调整见 [R4S 接入记录](../ops/openwrt-temperature/README.md)。

- SQLite 使用 WAL、FULL 同步；原始内容及初始任务提交成功后，才释放 MQTT QoS 1 确认。MQTT ACK 只表示本地已持久接管，**不表示 D1 或双 PG 均已成功**。
- 本地处理不等待 D1。每个目标独立补写；一端离线时其他目标继续工作。这是最终一致的多目标投递，不是跨库原子事务。
- PG 主键为 `message_id`。当前 v1 保持已有消息 ID；新处理器或新版本按原始 ID、处理器、版本和输出键生成独立确定性结果 ID，原生产方 ID 留在来源信息中。
- `raw_data_sha256` 对原始 UTF-8 文本计算；`payload_sha256` 延续旧服务的规范化信封语义哈希；`result_sha256` 校验版本化加工结果。重试必须匹配哈希，不能用同 ID 静默覆盖不同数据。
- 连接失败按任务退避重试。永久数据错误进入 `failed`；批量投递遇到坏记录时逐条隔离，不让一个坏记录长期阻塞后续记录。正常情况下按接收顺序发送，失败记录退避时后续记录可以先完成。
- 无效业务文本保留原始层和失败处理状态；不能解码的字节进入有容量限制的隔离表。无效协议帧留在诊断隔离范围，不送入 D1。
- 每个入库实例必须使用唯一而稳定的 MQTT 客户端 ID。持久会话仍受 EMQX 套餐、离线队列和过期时间限制；首次订阅前的数据、长时间未进入本地 SQLite 的消息不属于本地重试保证范围。

PG 的 `raw_id` 没有指向短期原始层的外键，原始清理不会级联删除加工历史。旧 PG 行保留原有 `payload` 和哈希，并标记 `legacy_pg`；没有原始字节证据的历史行不会凭空补造原始档案。

## CPU 温度的 PostgreSQL 投影

两端 PostgreSQL 的 `metrics` 排除精确匹配 `^cpu_core_[0-9]+_temperature_c$` 的单核心温度，保留采集器实际提供的 `cpu_package_temperature_c`、`cpu_temperature_c` 以及其他指标。不会取核心均值、最大值或零值充当整颗 CPU 的温度。只含核心温度的记录保留空 `metrics` 与消息标识，作为重复投递校验的回执。

过滤只在 PG sink 执行：MQTT 原消息、本地 SQLite 原文与加工结果、D1 原始副本都保留核心读数，仍可用于持续高温告警。SQLite 中升级前尚未完成的任务也在投递时执行相同过滤，无需重写队列或生成新消息标识。

`payload_sha256` 保持来源信封语义哈希；受过滤记录的 `lineage.pg_metric_projection` 保存投影版本、被排除的指标名及原结果哈希，`result_sha256` 则校验版本化投影结果。原值不会复制到这份血缘元数据。历史清理必须使用相同的纯函数 `projectMetricsForPostgres()`，保留原消息 ID、来源及时间，以便旧队列重试和历史记录仍匹配。

上线顺序是先部署 PG 过滤，再由数据库所有者清理历史核心字段，最后验收两端核心字段数量均为零。运行账号不增加 UPDATE / DELETE 权限。清理期间，旧任务重试只在原 payload/result 哈希、完整指标和血缘全部相同时确认已有旧行，不会修改该行；历史清理仍是必须完成的独立步骤。缺失原结果哈希、已带投影标记却残留核心字段或部分清理导致指标与哈希不一致时停止处理，不能猜测或清空哈希规避冲突。

## 保留、容量与重放

默认业务原始层在本地和 D1 保留 **180 天**，按保存时间滚动清理；本地每天分批执行，不是每半年一次性清空。协议帧本地及 SLS 目标保留 **30 天**，SLS Logstore 需要在服务端配置对应 TTL。本地 PG 保留完整加工历史，不跟随原始层清理。Supabase 目标单独设置 `retentionDays: 30`，保留滚动 **30 × 24 小时**的加工数据；派生视图只查询各自数据库仍保留的数据。

Supabase 写入前以 `coalesce(sample_time_utc, read_time_utc, source_receive_time_utc, receive_time_utc)` 判断年龄。旧实时 MQTT 的 `captured_at` 在新版处理器中对应 `read_time_utc`。严格早于截止时刻的记录跳过，恰好位于边界的记录仍可写入；采样时间未知的历史记录使用已知来源接收时间，不伪造采样时间。补发、历史导入和手工重放均执行同一规则，不能把已过期历史重新灌入 Supabase。

过期只结束 Supabase 的投递任务：`delivery_job.status='done'`、`outcome='expired'`，增加持久计数 `supabase_retention_skipped` 并记录 `retention_skipped` 日志；不会冒充数据库确认或更新 `last_success_time_utc`。数据库确认的结果为 `outcome='confirmed'`，包括哈希一致的幂等重复。旧版已完成任务的 `outcome=NULL` 表示未分类的既有记录。重复完成不会重复计数，显式重新激活任务后再次跳过会计为一次新的跳过处理。SQLite 原文、本地 PG 和 D1 任务均不受 Supabase 过期影响，未完成的本地任务继续重试。

写入过滤不能清除已经存入 Supabase、随后变旧的记录。由 Supabase 管理员单独安装定时清理；运行账号继续仅有 SELECT / INSERT，无需 DELETE 权限。[管理员清理脚本](sql/supabase/retention-30d.sql) 使用 `pg_cron`、UTC 会话及相同时间判断，每天分 8 次小事务、每次最多删除 1,000 条。此脚本仅用于 Supabase，不会被 `pnpm migrate` 自动执行；实际安装与验收需在自己的实例上单独完成。删除发生于下一次定时执行，云端可能暂存超过 30 天的行；超过每日 8,000 条的淘汰量需调整管理员任务。回退定时任务使用脚本末尾的 `cron.unschedule`，不删除扩展或其他任务；被清理的数据应从本地 PG 或独立备份恢复，且恢复写入仍受当前 Supabase 窗口限制。

待处理任务或未确认投递会暂时保住对应业务原始记录。`maxPending` 默认 100,000，按尚有依赖的原始记录计数；达到上限后暂停业务接收，保留待发记录。永久失败也需要检查处理，不能靠扩大上限长期掩盖故障。

协议帧另有默认 250,000 条容量上限。达到容量时淘汰最旧诊断帧并增加 `frames_dropped_capacity`，即使其 SLS 投递尚未完成；这样诊断流量不会阻断同一 MQTT 连接上的业务数据。监控该计数及 SLS 积压，必要时调整诊断容量。隔离索引默认保留 1,000 条并记录清理计数。

SQLite 删除后通常复用空闲页，不保证文件立即缩小。备份与磁盘整理应作为维护操作执行，不能直接删除仍在使用的数据库、WAL 或 SHM 文件。

重放命令在容器内只调度持久任务；由正常入库进程继续执行：

```sh
# 重试当前处理版本；RAW_UUID 替换为实际原始 ID
node scripts/replay.ts processing RAW_UUID iot-telemetry 1
# 历史电表来源使用已注册的历史处理器
node scripts/replay.ts processing RAW_UUID legacy-ddsu666 1
# R4S collectd 原始温度
node scripts/replay.ts processing RAW_UUID collectd-temperature 1
# 修复目标或数据问题后，重新激活失败投递
node scripts/replay.ts delivery ARTIFACT_UUID local
node scripts/replay.ts delivery ARTIFACT_UUID supabase
node scripts/replay.ts delivery RAW_UUID d1
node scripts/replay.ts delivery FRAME_UUID sls
```

同版本重放得到相同结果会去重；改处理规则必须注册新版本。不存在的处理器版本会被拒绝。原始数据超过保留期后不能依靠这套本地重放恢复；30 天内可追溯原始协议帧，180 天内可重新处理业务原始内容。

## 配置与初始化

PostgreSQL 表、派生视图及全部字段的中文注释由 `sql/004-chinese-comments.sql` 维护，`pnpm migrate` 在结构迁移后自动执行。已有两端数据库可由对象所有者单独运行此文件，仅更新注释。Grafana 本地展示视图的注释另见 `../ops/grafana/002-chinese-comments.example.sql`。UTC 时间语义、指标单位、质量和加工血缘均可通过数据库工具的 comment 查看。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
cp config/ingestor.example.json config/local.json
mkdir -p data secrets
chmod 700 secrets
```

在被忽略的 `config/local.json` 设置实际 MQTT 前缀和两个数据库目标。仓库模板只含文档保留地址和示例账号；本地数据库与 Supabase 项目身份不得写回模板。使用 Supabase 控制台提供的 **Session pooler IPv4** 连接参数，启用 TLS 证书校验，必要时通过 `caFile` 指定根证书。运行账号只需 `iot` schema 的 USAGE、遥测表的 SELECT / INSERT 和相应 RLS 策略；不授予运行服务 DDL 或删除权限。

配置模板在 Supabase 目标设置 `"retentionDays": 30`。该字段可选、取 1–3650 的整数天；省略时兼容原版行为，不做写入年龄过滤。只允许 Supabase 目标设置，防止误将本地长期历史排除。现有私有配置需显式增加该值并重建启动新版本，不能仅凭升级源码认为策略已启用；启动日志 `target_retention_days` 显示实际设置。改变窗口时应同步调整 Supabase 管理员清理任务，两者不会互相自动改配置。

原始云副本与 SLS 按配置启用；未配置不代表已云端备份：

```json
{
  "archive": {
    "rawMirror": {
      "url": "https://YOUR_ARCHIVE_WORKER/v1/raw/batch",
      "tokenFile": "/run/secrets/raw_archive_token",
      "timeoutMs": 15000
    },
    "frames": {
      "endpoint": "cn-hangzhou.log.aliyuncs.com",
      "project": "YOUR_SLS_PROJECT",
      "logstore": "YOUR_SLS_LOGSTORE",
      "accessKeyIdFile": "/run/secrets/sls_access_key_id",
      "accessKeySecretFile": "/run/secrets/sls_access_key_secret",
      "timeoutMs": 15000
    }
  }
}
```

`rawMirror.url` 必须填写实际部署的 Worker 接收地址，以上只是格式示例。Worker / D1 的绑定、站点范围与定时清理配置见 [cloud/wrangler.jsonc](cloud/wrangler.jsonc)，表迁移位于 `cloud/migrations/`；部署时还需设置与本地文件一致的 Worker `ARCHIVE_TOKEN` secret。SLS 使用仅可写目标 Logstore 的凭据，临时凭据可增加 `securityTokenFile`。凭据文件不提交仓库、不输出日志；准备后 `chmod 600 secrets/*`。首次启用镜像时，会为仍保留的本地记录补建对应投递任务。

本地配置暂时沿用内网 PG 的现有连接设置，不会自动申请证书、修改 NPM、DNS 或数据库 TLS。以后本地 PG 集群应作为一个稳定的可写逻辑目标，不应把每个主备节点配置成额外业务副本。

## 部署、数据库迁移与验收

在部署主机的私有工作目录放置 ingestor 源码和配置。下面是操作步骤，不是已执行记录。

1. 保存旧源码、Compose、配置、镜像标识和两个 PG 的备份。`scripts/backup-databases.ts` 可用运行账号导出可见遥测行、列定义及 SHA-256 清单，但不代替完整的 `pg_dump` / 数据库备份。
2. 构建新镜像并完成本地检查，随后停止旧入库实例。采集端继续依赖各自持久队列及 MQTT 会话；控制升级窗口，避免超过服务端队列限制。
3. 旧进程停止后，备份整个 `data/` 目录和配置。不要在线只复制单个 `inbox.sqlite` 文件而漏掉 WAL。
4. 由两端数据库管理员执行迁移。首次创建依次执行 `001-telemetry.sql`、`002-layered-storage.sql`、`003-derived-views.sql`；已有遥测表执行后两份。派生视图采用 PG 15+ 的 `security_invoker`，沿用调用者权限与 RLS。
5. 启动新容器。SQLite 自动迁移原有 `pending` 表的未完成记录，保留两端确认状态；原旧表保留作为回退证据。旧队列已规范化的文本标记 `original_bytes_available=false`，不能宣称还原了当初的原始字节。
6. 分别验证实时数据、历史导入和各云目标，再停止旧 Modbus HTTP 上报路径。不可仅凭容器 healthy 就认定全链路验收通过。

```sh
# 构建；正在运行的旧容器不会因为 build 自动切换
# 先将当前镜像另行打标签留存，再构建新版本
docker compose build ingestor

# 可使用新镜像执行行级备份；完整备份仍按数据库运维流程执行
docker compose run --rm --no-deps ingestor node scripts/backup-databases.ts

# 一致的本地目录备份
docker compose stop ingestor
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "backups/$backup_stamp"
chmod 700 "backups/$backup_stamp"
cp -a data config compose.yaml "backups/$backup_stamp/"

# 两端完成管理员迁移之后启动
docker compose up -d --force-recreate ingestor
docker compose ps
docker compose logs --tail 100 -f ingestor
```

管理员已准备好单独的配置文件时，也可在装有 pnpm 的管理环境执行：

```sh
CONFIG_FILE=/secure/iot-admin.json MIGRATION_INGESTOR_ROLE=example_ingestor pnpm migrate local
CONFIG_FILE=/secure/iot-admin.json MIGRATION_INGESTOR_ROLE=example_ingestor pnpm migrate supabase
```

命令按当前表结构选择迁移，并执行时间与权限兼容修复。首次运行 `003` 时必须将
MIGRATION_INGESTOR_ROLE 设为实际运行角色名（不是管理员，也不是 pooler 的项目后缀用户名）。
手动执行 SQL 时先设置 `SET one_min_house.ingestor_role = 'example_ingestor'`，替换示例角色。
不要把管理员配置放进运行容器；运行服务不自动执行 DDL。

`005` 根据来源 observation_kind 或 driver 识别旧网关缓存数据，不包含站点和设备名单。
如果旧记录缺少来源元数据，管理员需在迁移前按私有设备清单确认并标记 observation_kind，
不能仅凭设备名称推断测量语义。

```sh
# 查看健康与待处理任务
docker compose exec ingestor cat /app/data/health.json
docker compose exec ingestor node scripts/queue-snapshot.ts
# 对比两端加工结果，并抽查本地原始文本哈希
docker compose exec -e VERIFY_LIMIT=100 -e VERIFY_SQLITE=/app/data/inbox.sqlite \
  ingestor node scripts/verify-layered.ts
# 可按某台设备检查实时窗口
docker compose exec -e VERIFY_DEVICE=meter-main -e VERIFY_LIMIT=10 \
  ingestor node scripts/verify-layered.ts
```

健康字段包括 `heartbeat_time_utc`、`local_pending`、`supabase_pending`、`d1_pending`、`sls_pending`、`processing_failed`、`delivery_failed`、`oldest_pending_time_utc`、`supabase_retention_skipped` 与诊断丢弃计数。每目标的 `last_retention_skip_time_utc` 与 `last_success_time_utc` 分开记录；过期跳过不是投递失败，累计 `completed` 表示两端任务已得到终结处理，不保证两端都插入了行。外部服务故障为 `degraded`，进程调度心跳停滞才使容器健康检查失败。`archive.*_configured` 只是配置状态，不是云端接收证据。

验收至少覆盖：连续 10 轮真实采集、双 PG 相同结果 ID/指标/哈希、D1 对应原始 ID/哈希、SLS `frame_id` 查询；再验证容器重启、单个目标断线恢复、积压补发、重复投递和保留清理。`verify-layered.ts` 的近期窗口匹配不能代替全量历史迁移核对，也不检查 SLS 服务端保留策略。

双 PG 对比只选择 Supabase 30 天窗口内的共同数据。默认最近 100 条适合实时验收，也可用 `VERIFY_AFTER` 指定近期 UTC 起点、`VERIFY_MIN_ROWS=10` 要求至少 10 条，并用 `VERIFY_REQUIRE_LINEAGE=1` 检查新版来源字段。不要用覆盖全部旧历史的窗口要求两端行数一致：超过云端保留期的数据仅存本地 PG 是预期行为，应另查本地总量、历史清单及过期跳过计数。

## 历史电表数据

`src/history.ts` 保留旧 D1 电表格式转换能力，调用方必须显式传入 `HistorySource`（来源数据库 ID、ownerId、站点、网关、设备）。数据库 ID 参与稳定消息 ID 的生成，迁移已有数据时必须沿用原值，不能为了脱敏重写运行数据。没有默认生产设备。

已注册的 `legacy-ddsu666` 处理器通过保存的来源标识重放保留期内的原始记录；`src/energy-history.ts` 的人工安装基准同样要求显式时间、身份和备注。公共测试使用合成数据；真实安装日期、导出文件、筛选阈值和迁移验收只留在私有目录。

原 `create_time_utc` 是来源服务器接收时间。历史结果使用 `quality='historical'`、`sample_time_utc=NULL`，把已知时间写入 `source_receive_time_utc` 和来源信息；不伪造测量时间或不存在的协议帧。历史功率单位转换为 W / var；未验证的旧频率偏移、保留寄存器所得视在功率不当成可靠测量迁入。源行完整留在原始层供追溯。

配置 Supabase 30 天窗口后，超期历史仍进入本地 SQLite、按配置投递 D1，并完整写入本地 PG；Supabase 的对应任务记录为过期跳过。源历史导入完成不应再以“全量双 PG 行数相同”验收，只核对两端共同的近期窗口。

```sql
SELECT sample_time_utc, source_receive_time_utc, device_id, quality,
       (metrics->>'energy_kwh')::numeric AS energy_kwh,
       (metrics->>'power_w')::numeric AS power_w
FROM iot.telemetry
WHERE site_id = 'example-home'
ORDER BY coalesce(sample_time_utc,source_receive_time_utc,receive_time_utc) DESC
LIMIT 20;
```

上述排序只便于查看已知事件时间，不能把 NULL 采样时间的历史点直接用于声称精确采样间隔的计算。累计电量日/月汇总还需要处理断档、回零、晚到数据以及业务时区；本版不预先生成此类汇总表。

## 常用操作与回退

```sh
# 停止、恢复与重建均不删除 data/
docker compose stop ingestor
docker compose start ingestor
docker compose up -d --build --force-recreate ingestor
# 完全停止新增服务，保留持久数据与两个 PG 的历史
docker compose down
```

遇到问题优先停止新服务、保留现场和队列，修复后重启同版本。**不要通过恢复升级前 SQLite 快照覆盖升级后的 archive**：新收到的原始内容和未确认投递可能只在那里。

如必须退回旧二进制：先确认 `local_pending`、`supabase_pending` 和待处理任务已清空，再停止服务并另存当前整个 `data/`。未清空时应先恢复新版本投递，不能让旧版本忽略新表中的任务。D1/SLS 未完成任务仍需保留在新 archive 中，旧程序不会负责发送。

在两端管理员连接分别执行兼容回退 SQL：

```sh
# 示例使用事先配置好的 libpq 管理员 service；连接凭据不写进命令
psql 'service=iot-local-admin' -v ON_ERROR_STOP=1 -f sql/002-layered-storage-down.sql
psql 'service=iot-supabase-admin' -v ON_ERROR_STOP=1 -f sql/002-layered-storage-down.sql
```

这只恢复旧时间列名及旧写入器需要的默认值，保留新增列、历史数据及旧 payload。随后通过保存的旧镜像和原 Compose 恢复旧服务，使用单独保存的旧队列目录；完整保留新 archive，不能将两份 SQLite 文件直接相互覆盖。再次升级前先排空回退期间的旧队列，并核对这段期间的 PG 数据；回退期间旧程序不能产生本版原始归档，应明确记录这段归档缺口。

SQLite 副本、双 PG 和 D1 都不能代替独立备份。备份保留、PG PITR/完整恢复以及未来 PG 集群切换验收应另行制定。

## CPU 封装温度与单核心告警

PostgreSQL 加工层只保留 CPU 封装温度（如 `cpu_package_temperature_c`）和其他非核心指标，写入本地 PG 与 Supabase 前统一移除 `cpu_core_<编号>_temperature_c`。封装温度使用设备提供的读数，不以各核心平均值、最大值或零值替代。只有核心指标的记录会保留空 `metrics` 作为幂等回执；其他设备与其他指标不受这项投影影响。

原始 MQTT 消息仍含逐核心读数。本地 SQLite 原始层、已启用的 D1 原始副本按既有保留策略保存原始内容；它们不会因 PG 投影而删除核心字段。`payload_sha256` 仍指向完整原始消息，PG 的 `result_sha256` 和 `lineage.pg_metric_projection` 记录裁剪后的加工结果及来源关系。历史 PG 核心字段的清理是单独的管理员迁移，需要两端先备份、再核对非核心指标与哈希；运行入库账号无需获得修改或删除历史行的权限。

一旦开始写入这种投影结果，就不能直接切回不支持投影的旧镜像，否则可能重新写入核心字段并造成幂等哈希冲突。停用告警只需移除 `cpuCoreAlerts` 配置并保留新版 PG 写入逻辑；完整版本回退需要暂停写入、协调两端历史恢复及升级后的新增记录，并保留当前 SQLite 队列。

告警直接消费已验证的原始 MQTT 样本，先持久保存原始消息及告警状态，再确认 QoS 1 消息；不查询 PG，也不新增 MQTT 订阅或要求 Linux 主机保存飞书密钥。只有明确配置的来源、`linux-temperature-mqtt` 驱动和 `linux_sysfs` 直接读取样本参与。SMART、GPU 缓存、网关缓存状态、历史补报不会冒充 CPU 核心采样。

将 [cpu-core-alerts.example.json](config/cpu-core-alerts.example.json) 中的 `cpuCoreAlerts` 合并到私有运行配置即可启用；未配置时不运行告警。示例只包含合成主机，不能直接当作线上清单：

- 来源的 `siteId`、`gatewayId` 必须已对应 `mqtt.topicPrefixes` 中的准确主题前缀，例如 `iot/v1/example-home/example-host`。
- `coreMetrics` 应完整列出该主机实际上报的全部核心字段。CPU 封装、GPU、主板等通道不能放入此列表；仅删除 PG 中的核心字段，不要停止 Linux 采集端的逐核心读取。
- `webhookFile` 指向单独的 secret 文件，例如容器中的 `/run/secrets/feishu_webhook`。文件只含现有飞书机器人 Webhook URL，不含 `FEISHU_WEBHOOK=` 前缀；使用只读挂载、限制文件权限，并确认该文件被 Git 忽略。不要把 URL 写进可提交的 JSON、Compose、日志或命令输出。

默认规则为**同一个核心严格高于 85°C，采样时间连续跨度至少 120 秒**。每 60 秒采集一次，通常需要至少 3 个读数；2 个相隔 60 秒的高温读数不算持续两分钟。恰好 85°C 不算高温，不会将先后变热的两个核心拼接成一次持续高温。

相邻读数间隔超过 90 秒、核心缺失或异常值会中断该核心的计时。超过 90 秒的旧消息、未来时间、乱序和重复消息不参与当前告警，也不能解除告警。应保持采集主机与入库主机的 UTC 时钟同步；这里的“连续”是采样证据，不表示掌握采样间隔内每一瞬间的温度。

同一主机多个核心达标时只产生一个告警事件，消息最多列出 8 个核心；持续高温不会反复通知。只有一份新鲜样本确认全部配置核心均不高于 85°C，才解除该事件并允许下次告警；默认不额外发送恢复消息。失联和缺失数据不是恢复。尚未成功送达的告警如果变旧或不再有达标核心，会取消并重新开始计时，后续需新的完整高温区间才再触发；已经成功通知的事件不会因短暂断流重复发送。

告警状态和通知队列保存在持久目录 `data/cpu-core-alerts.sqlite`，进程重启后恢复计时与去重状态。改变阈值、核心清单等配置会重置旧规则计时并取消旧的待发通知。非活跃事件的通知历史最多保留 7 天或 1,000 条，活跃事件单独保留；不要通过删除这个文件“清理告警”，以免丢失去重状态。

飞书请求需要 HTTP 成功且业务返回 `code=0` 才确认送达；见[飞书自定义机器人文档](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)。每个事件最多尝试 5 次，失败后依次等待 15、30、60、120 秒，每次请求超时 5 秒。数据变旧或告警失效时不继续发送过时通知；重试耗尽的事件保持可见错误，等待实际恢复。Webhook 没有服务端幂等键，远端已接收但响应丢失时可能有限重发，消息内保留相同事件 ID 供辨认。

`health.json` 的 `cpu_core_alerts` 提供 `pending`、`sent`、`failed`、`cancelled`、`active` 与 `notification_error`。只有仍活跃事件的通知失败使服务变为 `degraded`；正常待发、已成功通知的高温事件不会因这一字段导致降级。通知成功或实际恢复后，相关错误清除；健康失败日志不包含 Webhook URL 或响应原文。容器的调度健康检查与业务降级仍分开判断。

```sh
# 本地逻辑和配置回归；均不向真实飞书群发消息
pnpm check
node --test test/cpu-core-alert.test.ts test/cpu-core-alert-config.test.ts
```

上线后还需核对真实主机核心清单、连续新鲜样本、两端 PG 中核心字段已裁剪、原始层仍保留完整指标以及既有 Grafana 类别均正常。通知通道测试应单独注明“测试”，不能伪造生产高温数据或把模拟告警混入遥测历史。
