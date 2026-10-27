# 采集链路监督容器

Python 标准库程序，每 60 秒读取入库服务导出的健康快照，通过现有飞书机器人通知故障和恢复。可选读取独立 MQTT 接收器导出的主机健康文件。独立于入库进程运行；不连接 MQTT 或数据库，不重启采集服务、不修改队列，不需要 Docker socket、额外 capabilities 或入站端口。

默认 Docker 限额为 64 MiB、0.25 CPU、32 个进程；运行 UID/GID 10001、只读根目录。实际内存和通知到达情况须在目标主机验收。这与 ingestor 同处一台主机，无法单独覆盖整台主机或 Docker 停止；外部心跳告警仍须另行配置和验证，源码模板不能证明 SLS 告警已经启用。

## 检查与通知

| 检查 | 默认阈值 |
|---|---|
| 入库心跳 | 超过 90 秒、缺失、无法解析或比当前时间提前超过 60 秒 |
| 每条 MQTT 连接及订阅 | 连续不可用 180 秒 |
| 设备读取 | 距最近采集时间超过 300 秒；新部署等待首条数据 300 秒 |
| 数据有效性 | 连续 3 条无效或越界读数；采样时钟异常持续 60 秒 |
| 投递目标 | 存在待发记录且 300 秒没有写入成功 |
| 积压 | 最老待发超过 600 秒告警、1800 秒升级 |
| 处理失败／永久投递失败／暂停接收 | 持续 60 秒 |
| 事件循环 | 延迟超过 1 秒并持续 60 秒 |
| 运行反复重启 | 10 分钟内观察到至少 3 次启动时间变化 |
| SQLite 实际临时目录 | 与指定持久目录不符立即告警；剩余空间不足 20% 持续 60 秒 |
| 数据盘及 inode | 使用配置中的最低剩余空间和 inode 比例 |
| WAL | 健康元数据大小或增量达到配置阈值，持续 300 秒 |
| 故障恢复 | 已激活故障须持续获得新鲜且有效的正常证据至少 180 秒 |

故障状态、待发通知、重试和请求预算保存在自己的 `supervisor.sqlite`。同类故障合并；HTTP 成功且飞书业务 `code=0` 后才确认发送。每次请求最多合并 20 个事件，文本限制 16 KiB。包括重试和验收测试在内，每小时最多 30 次、滚动 24 小时最多 120 次发送尝试；预算在网络请求前持久化，时钟倒退暂停发送。待发通知最多 500 条、保留 6 小时、每条最多尝试 10 次，失败从 60 秒退避到 1 小时；达到上限后仍保留故障状态并在后续允许时提醒。

## 抑制抖动与提醒周期

每次故障持续到确认恢复为同一个 incident，通知区分四类：首次告警、严重升级、持续提醒、恢复。已成功送达 warning 后，第一次达到 critical 可以立即升级；此后 critical 降到 warning 再回到 critical，只更新当前状态，不再次升级，也不发送降级通知。最高已通知等级仅在成功确认后推进，失败或超时不视为成功。尚未成功送达的通知更新等级时保留事件 ID、重试次数和退避时间，避免等级往返重置重试。

`recovery_seconds` 默认 180。一条正常快照不会立即清警：正常窗口必须连续满足配置时长；bad、unknown、缺失故障观察项、过期或畸形快照都会打断该窗口。窗口保存在 SQLite，短暂重启后可以继续；两次有效观察间隔超过 `max(heartbeat_max_age_seconds, 2 × check_interval_seconds)` 则重新计时，不能用停机前的一次正常观察和停机后的新快照拼出恢复。未成功送达的故障在出现正常证据时暂停发送，持久保留原事件 ID、尝试次数和退避时间，保持激活状态直到确认恢复。unknown 或缺失观察不能恢复暂停发送；再次明确异常才恢复原待发，同属原 incident。尚未送达的升级在等级降回已通知等级时同样暂停，之后再次升级继续原重试。

待发因容量或年龄上限被清理时，故障行仍保留未完成的通知义务和重试信息；之后明确异常按原退避重建，不依赖正常窗口，也不用等待小时提醒。达到尝试上限后，按该类故障的重复提醒周期冷却，再开启下一轮有限重试；抖动或重启不能绕过冷却，也不清空请求预算。确认持续恢复后才取消对应故障通知；此前从未成功送达的故障不发送恢复消息。`status.json.notification_suspended` 单独显示暂停待发数量，不计作当前可发送积压。

默认 `repeat_seconds=3600`，持续故障在上次成功通知后至少一小时才再次提醒；严重升级独立于该周期。同一 incident 的降级和再次达到已通知等级不会绕过周期。可选 `reminder_seconds_by_category` 只调整重复提醒，不改变采集、故障触发或恢复阈值。例如让持续无效读数每六小时提醒一次：

提醒周期是最短间隔，不保证整点或精确每小时发送。已成功通知 warning，随后 critical 升级发送失败又降回 warning 时，原升级通知暂停并占据该故障的待发位置；warning 重复提醒可能延后到该待发达到 `notifications.max_age_seconds`（默认六小时）。critical 再出现时继续原升级的事件 ID、尝试次数与退避，不为了发一条 warning 提醒而丢弃升级重试。请求预算、退避及合并发送也可能延后提醒。

```json
{
  "recovery_seconds": 180,
  "repeat_seconds": 3600,
  "reminder_seconds_by_category": { "validity": 21600 }
}
```

支持明确类别 `validity`、`freshness`、`clock`、`actual_sample`（这四项对应设备指标）、`mqtt`、`target`、`queue`、`storage`、`heartbeat`、`event_loop`、`collector` 和 `other`；覆盖值须为 3600–604800 秒的整数，未知类别拒绝启动，省略时继续使用统一周期。模板默认不设置覆盖。没有根据关联关系隐藏故障，所有检查与采集阈值保持原样。

只在新鲜且有效的快照提供持续恢复证据后解除故障。待发清空不代表数据库恢复：此前已告警的目标必须有新一次成功写入证据。输入缺失或格式错误不能解除旧故障；已送达的故障才发送恢复通知。飞书没有事务型确认，超时重试可能重复，消息内保留稳定事件 ID 便于识别。

`last_received_time_utc` 表示接收时间，补报不能更新设备采样新鲜度。`last_collect_time_utc` 表示来源提供的采集时间；网关缓存读取可能仍缺少传感器的实际测量时间。默认 `require_actual_sample=false`，只检查读取是否持续；开启后另检查 `last_sample_time_utc`，缺失实际时间显示 unknown，不虚构新鲜度或恢复。连续无效读数与没有新数据分别告警。

## 可选的主机健康与本地缓解记录

`host_health_sources` 默认空列表，不改变原有设备、MQTT 和数据库检查。独立接收器订阅主机专用健康主题，把有界快照和接收器心跳原子写入共享目录；监督程序只读整个目录，不连接该 MQTT 客户端，不执行缓解命令，不需要 Docker socket。即使 ingestor 不可用，这条主机告警输入仍独立判断。仅合成配置示例：

```json
{
  "host_health_sources": [{
    "id": "example-router",
    "site_id": "example-site",
    "host_id": "example-router",
    "label": "示例路由器",
    "path": "/observed/host-health/example-router.json",
    "receiver_health_path": "/observed/host-health/health.json",
    "freshness_seconds": 180,
    "critical_freshness_seconds": 300,
    "receiver_freshness_seconds": 90,
    "receiver_failure_seconds": 180
  }]
}
```

来源文件采用 `schema_version=1` 的平铺主机报文，包含明确站点/主机身份、UUID 消息和启动标识、正整数序号、原始 `read_time_utc`、数值 `uptime_seconds`/`metrics`，以及接收器补充的 `receive_time_utc` 和原报文 `payload_sha256`。不使用文件 mtime 或补报接收时间更新资源新鲜度；资源时间、启动标识、序号和内容水位持久保存，旧资源或同序号变更不能解除新故障。`payload_sha256` 对应原始 wire 字节；接收器会独立合并动作列表，不能把它当作整个导出 JSON 的文件哈希。单个主机文件最多读取 64 KiB，接收器健康文件最多 8 KiB。

本地守卫始终提供 `memory_pressure`、`io_pressure`、`temperature`、`storage` 四项 `conditions`；每项带 `state=good/bad/unknown`、`severity=warning/critical`、`incident_id` 和固定 `detail_code`。**本地已确认状态是资源告警依据**，监督程序不从数值再计算另一套阈值。缺项、畸形、未来时间超过允许的 60 秒误差或旧报文都不能证明恢复。故障键保持 `host:<id>:<kind>`，本地事件 ID 改变不绕过去重、严重升级、提醒周期或持续恢复窗口。

主机原始读取时间超过 180 秒告警、超过 300 秒升级；文件缺失从最近有效采样计时，尚未有过采样时从监督进程启动计时。接收器健康文件的 `heartbeat_time_utc` 必须在 90 秒内，且 `connected/subscribed=true`、`last_error=null`；否则连续 180 秒报告接收链路故障。此时主机判断为 unknown，相关既有故障和待发通知暂停，不形成整批主机离线告警，也不据此恢复旧故障。接收链路和新鲜主机状态恢复后，仍须正常连续 180 秒才清警。

`actions` 是接收器合并的动作阶段列表，最多 128 项：每项包含 UUID `event_id/action_id/incident_id`、原始 `action_time_utc`、固定 `kind=restart_proxy`、`target_id=proxy` 和 `result=claimed/succeeded/failed/uncertain`。每个阶段使用新事件 ID，同一次动作保留 action ID；`claimed` 只表示已记录执行意图，不能显示为执行成功。最长迟到 6 小时的有效动作仍可通知，明确展示原始时间，不用它刷新主机心跳。接收器可以持久保留 7 天审计，但监督程序不会把例如 3 天前的旧动作作为新通知，也不据此刷新资源恢复窗口。监督程序只转发这些审计结果，不会重放执行命令。

动作使用独立的 `host-action:<id>:<event_id>` 待发键与“缓解记录”标签，不覆盖同一主机尚未送达的故障通知；通知 ID 从来源事件确定生成，来源事件 ID 也在消息中保留。SQLite 新增可重复建表的去重记录，保留 7 天、最多 4096 项。满额时保留旧记录、暂停接受新动作并告警，不通过驱逐未过期记录制造重复通知。动作通知沿用相同飞书预算、确认、退避、待发年龄与容量限制；去重记录保留不代表飞书一定成功，超时仍可能导致对端收到重复消息。移除来源配置会阻止其旧待发继续发送，故障、去重库和历史不会删除。

共享目录应只读挂载到本容器；不要绑定单个原子替换的 JSON inode。真实设备身份、路径、账号及 Webhook 仍只放私有配置。验收使用合成状态/动作，不停用网关、MQTT、网络核心服务或真实代理来制造故障。此功能不修改生产 ingestor、数据库模式、原始归档或 Grafana。

## 暂停单台设备告警

在私有配置的对应 `devices[]` 项中设置 `alerts_enabled=false`。省略时默认为 true，只接受 JSON 布尔值；按完整 `site_id`、`gateway_id`、`device_id` 身份匹配，不按名称或部分 ID 匹配。合成示例：

```json
{
  "site_id": "example-site",
  "gateway_id": "example-gateway",
  "device_id": "temperature-example",
  "alerts_enabled": false
}
```

这会暂停该设备所有检查及故障、升级、提醒、恢复通知，包括已激活和已排队的通知；暂停不代表恢复，不补发旧恢复消息。采集、入库、其他设备以及全局 MQTT、数据库、心跳、积压检查继续运行。现有故障行、事件 ID、重试信息和发送预算保留；通知仍遵守原有年龄、容量及重试上限。暂停的故障不计入监督程序当前业务降级，`status.json.paused_device_alerts` 列出配置暂停的身份；持久故障行保留 `alerts_paused_time_utc`，不会通过删除状态库实现静默。

改回 true 后，不直接重放旧故障或恢复通知：必须获得新鲜有效观察，按原故障持续阈值重新确认，或连续正常满 `recovery_seconds` 后确认恢复。unknown、缺失或过期健康快照不能解除暂停后的重新验证；重启也不能用未观察到的时间补齐异常确认。尚未确认发送的原通知在再次确认异常后继续原事件与退避；已确认的通知等级和请求预算不因开关被重置。变更配置后使用下文的 `--force-recreate` 命令，仅重建监督服务。

监督程序 Docker 健康检查只检查自身轮询是否推进；业务故障保存在 `status.json` 并使 `health.json.quality` 降级。为兼容现有服务器健康采集器，`health.json.mqtt_connected` 复制新鲜入库快照的真实聚合连接状态，`mqtt_connection_source=supervised_ingestor`；它不是监督程序自己建立的连接。可把该小型文件添加到原有主机健康摘要，不增加上传频率或重置 SLS 预算。实际 SLS 规则和通知链路仍需独立验收。

## 输入与隔离

入库服务保留原 `data/health.json`，另向 `data/monitor/health.json` 原子导出相同快照及 `business_health.schema_version=1`：设备新鲜度、无效计数、运行起始时间、事件循环延迟和 SQLite 文件大小／实际临时文件系统元数据。监督容器只绑定整个 `monitor` 目录为只读，不绑定原始数据目录或单个 JSON 文件；单文件绑定会停留在原子替换前的 inode。`monitor` 目录需可被 UID 10001 遍历、导出 JSON 需可读。

另只读绑定指定的持久 `sqlite-tmp` 目录，用于查询所在文件系统的容量和 inode；不读取里面的文件。真正生效的临时目录来自入库元数据，避免误回退到小容量 `/tmp` 时仍误判健康。WAL 仅读取健康元数据，不挂载或打开 `inbox.sqlite`。无需挂载 Docker socket、整个秘密目录或全部采集数据。

## 部署、更新和回退

配置示例只有合成设备和示例身份。先建立私有 `config.json` 和 `.env`，填写预期设备、MQTT 客户端 ID、启用的投递目标和宿主路径；只配置实际启用的设备。 `.env` 使用以下路径变量：

```dotenv
SUPERVISOR_CONFIG=/srv/example-iot/supervisor/config.json
SUPERVISOR_DATA_DIR=/srv/example-iot/supervisor/data
INGESTOR_MONITOR_DIR=/srv/example-iot/ingestor/data/monitor
SQLITE_TEMP_DIR=/srv/example-iot/ingestor/data/sqlite-tmp
FEISHU_WEBHOOK_FILE=/srv/example-iot/supervisor/secrets/feishu-webhook
```

`data` 目录应由 UID/GID 10001 拥有。使用现有机器人地址的独立受限文件副本，由 UID 10001 可读、权限 0400；不改变原入库凭据的权限，不把 URL 放入环境变量、命令行或仓库。私有配置同样限制读取权限。`notifications.enabled` 初始为 false，先验证路径、元数据、身份和阈值，再启用通知。

```sh
docker compose -f compose.example.yaml --env-file .env config --quiet
docker compose -f compose.example.yaml --env-file .env up -d --build
docker compose -f compose.example.yaml --env-file .env logs --tail 20 business-supervisor
docker compose -f compose.example.yaml --env-file .env exec business-supervisor cat /app/data/status.json
```

HTTPS 仅接受配置允许的精确主机，默认 `open.feishu.cn`，使用公共 CA 验证并拒绝重定向、明文协议及带用户信息的 URL。默认总发送期限 5 秒；通过短期子进程限制 DNS、连接与响应的总时长，密钥只经 stdin 传入，不出现在子进程参数或日志中。

明确标记为“非生产故障”的通道验收，先短暂停止监督主容器，再启动单独的 64 MiB 一次性容器，使用相同私有配置、状态目录和持久预算；这不停止 MQTT 采集或入库。不要在运行中的监督容器里 `docker exec` 发送验收通知：主进程、验收 CLI 和 HTTP 子进程叠加可能超过内存限额，也会并发处理同一待发通知。

在本目录执行以下 shell 函数；退出时恢复原监督服务。任选一次通道测试，或一次模拟故障／恢复测试：

```sh
test_supervisor_notification() (
  set -eu
  trap 'docker compose -f compose.example.yaml --env-file .env up -d --no-build business-supervisor' EXIT
  docker compose -f compose.example.yaml --env-file .env stop business-supervisor
  docker compose -f compose.example.yaml --env-file .env run -T --rm --no-deps business-supervisor \
    python /app/supervisor.py --config /app/config.json "$1"
)
test_supervisor_notification --test-notification
# 或：test_supervisor_notification --test-alert-cycle
```

`--test-alert-cycle` 发送模拟故障和模拟恢复两条通知，与正常发送共享持久预算，不修改生产健康文件、设备历史或真实故障状态；测试失败返回非零退出码。失败的 `test*` 待发只保留诊断信息，常驻监督程序不会自动补发，也不以测试待发判定生产通知积压；显式重跑验收才能再次尝试。它不能替代真实设备断连、缓存补报和主机失联的端到端验收。若 shell 被强制终止或主机断电而未执行退出恢复，请手动运行 `docker compose -f compose.example.yaml --env-file .env up -d --no-build business-supervisor` 恢复监督。

更新前保留当前镜像标识和私有配置，使用 `up -d --build` 更新本服务。配置只在启动时读取；仅修改配置或更换秘密文件时须强制重建本服务，原子替换单文件绑定也需要重建才会指向新文件：

```sh
docker compose -f compose.example.yaml --env-file .env up -d --no-deps --force-recreate business-supervisor
```

回退时恢复原配置，并使用与当前状态库兼容的旧逻辑镜像，再执行同样的 `--force-recreate` 命令，保留状态目录。本版给 `outbox` 增加了暂停时间字段：更早版本若使用 `INSERT INTO outbox VALUES (...)`，须先改为显式列名 `INSERT INTO outbox(id,fault_key,kind,severity,detail,create_time_utc,next_attempt_time_utc,attempts) VALUES (...)` 再构建兼容回退镜像，不能直接切回原镜像。这样无需删除新增列或恢复旧 SQLite 快照，请求预算与当前事件仍在；旧逻辑不会解释本版的暂停／恢复窗口字段，其旧通知行为也会恢复。停止新增监督服务：

```sh
docker compose -f compose.example.yaml --env-file .env stop business-supervisor
```

保留 `data`、原采集服务、队列及主机健康预算；若主机摘要已添加监督健康文件，应同时撤销对应观察项，避免计划停止被判为故障。不要通过删状态库或重新建库来绕过通知预算。

撤销主机健康接入时，优先保留支持 `host_health_sources` 的当前兼容镜像，将该列表改为空并重建监督容器。当前逻辑会阻止已移除来源的待发主机通知，保留事件、重试和预算。更早镜像可能不认识 `host:`、`receiver:`、`host-action:` 等通知键，直接切回后仍可能发送遗留通知；精确回退到旧镜像前必须核对这些待发记录，不能通过删除整个状态库处理。确认监督配置已移除来源后，再停止相应接收器和主机服务。

## 测试与边界

```sh
python -m unittest discover -s ops/business-supervisor -p 'test_*.py' -v
```

测试覆盖持久故障和恢复、时钟模拟、独立连接、旧消息补报、缺失及畸形状态、请求预算、HTTP／业务确认、总超时和数据范围。无 Docker socket 时，只能以观察到的运行时间变化推断重启，不能取得 Docker 的精确重启次数或 OOM 标记，也可能漏掉两次轮询之间的短暂故障。主机和 Docker 同时停止须由独立外部监控兜底。

SQLite 中所有 `*_time_utc` 时间列均为 UTC Unix 秒（REAL），导出的时间为带 `Z` 的 ISO 8601。旧状态库以可重复执行的增列迁移补充正常窗口、已通知最高等级、通知暂停标记、设备告警暂停及重新验证状态和故障重试信息，保留 fault、outbox、事件 ID、重试次数及请求预算。旧库缺少等级历史时，以现存已通知故障等级作为迁移基线；若存在未送达的 critical 故障通知，则保守从 warning 开始，避免把未确认的升级当作已发送，可能额外补一条升级。重复迁移不覆盖已记录的成功通知最高等级，无法倒推更早的等级往返。`status.json.active_faults` 展示正常窗口与最高已通知等级，便于区分等待恢复和继续故障。监督程序不接通额外云日志，不改变原日志上传预算；生产入库及告警验收由实际部署记录确认。
