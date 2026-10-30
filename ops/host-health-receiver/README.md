# 主机健康 MQTT 接收器

可选的轻量接收容器，订阅配置中明确的主机健康主题，将小型快照交给现有监督程序；不连接业务 PostgreSQL、Supabase 或原始采集队列，不持有 Docker socket，不执行主机命令。

## 输入与持久化

只订阅精确的 `iot/v1/<site_id>/<host_id>/host-health`，每连接最多十项。使用 MQTT 5、QoS 1、TLS 公共 CA 和独立的只读订阅账号；拒绝 retained 快照，主动订阅不索取旧 retained 消息，实时保留 retain 标志用于校验。新密码只通过受限文件传入，既不写命令行，也不写日志。

协议版本1的固定字段为 `schema_version`、`message_id`、`site_id`、`host_id`、`boot_id`、`sequence`、`read_time_utc`、`uptime_seconds`、`metrics`、`conditions`、`actions`。四个条件固定为内存压力、I/O 压力、温度、存储；状态为 good/bad/unknown。坏状态需提供稳定 incident UUID。动作只允许 `restart_proxy`，目标为逻辑标识 `proxy`，不携带真实路径、容器名称或任意命令。每条最多8个动作阶段，每阶段使用独立 `event_id`，同一次动作复用 `action_id`。

可选 `diagnostics.memory_top_process` 保留采集端已脱敏的 RSS 最大进程，字段限于 `name_masked`、`rss_bytes` 和可选 `path_masked`。新发布端最多隐藏中间 1 字符。接收格式兼容中间一段连续 1–3 个 `*`，前后均有 ASCII 安全字符；名称最多 64 字符，长度 1–2 时按采集策略保留原样。兼容早期最多两个字符加固定 `***` 的名称，供积压报文补报。RSS 为 `0..2^53-1` 的整数。可执行路径必须是最多 512 字符的绝对 POSIX 路径，目录限安全 ASCII 字符且不得有空段、`.`、`..`；文件名采用中间脱敏规则（兼容读取 2–3 字符隐藏），不能借用旧 `no***` 尾部隐藏格式。路径可与 comm 名称不同，采集端从该 PID 的 `/proc/exe` 链接获得；不接收 PID、命令参数、环境变量或任意附加字段。

完整长名称/文件名、换行注入、非法路径或数值均拒收，不能因诊断格式错误覆盖最新快照。合法诊断随原报文持久化、导出，原始字节哈希及先持久化后 PUBACK 保持不变；无此字段的旧版报文继续接收。发布端仅在完整、有界的进程扫描成功时提供诊断，路径缺失时回退到名称，整体诊断缺失时不能显示虚构的进程或零占用。升级时先更新本接收器及入库端，最后更新发布端。

接收器验证完整身份、字段白名单、数值范围、UTC 时间及容量，先提交自身 SQLite，再原子导出，最后才确认 PUBACK。重复消息的原始字节 SHA256 必须相同；原ID不同内容不会替换现有快照。进程在持久化后、导出前退出时，重复投递会修复导出。SQLite 使用 FULL 同步、短 WAL、内存临时空间，默认最多10,000条消息指纹、保留7天，主数据库最多32MiB；去重指纹淘汰不允许旧时间或回退序列覆盖当前状态。

资源快照只有在来源时间未过期、未超前且水位前进时才更新。导出包含原 `read_time_utc`、最初 `receive_time_utc` 和 MQTT 原文字节 `payload_sha256`，旧补报或重复投递不会刷新这些水位，文件修改时间不能作为主机新鲜度。新 boot 可重置序列，但来源时间仍须前进。缺失 PSI 指标保持缺失，不补零。

动作审计与当前资源状态分开处理：延迟不超过7天的合法动作可在旧资源快照中接收，但不能刷新资源水位。动作事件原文不可变，按来源最多256项、保留7天，导出最近128项；监督程序须按稳定事件ID去重，通知另限6小时，历史审计不能生成新的故障或恢复。达到动作容量上限会停止确认并失败退出，不静默丢弃未见事件。首次收到的只有旧资源和有效动作时，导出该旧信封及原始采样、接收时间，保持 stale 分类；监督程序可读取动作，不能将它视为当前资源恢复。后续新鲜资源正常替换；仅有过期动作时不生成伪造的主机健康文件。

## 导出与隔离

整个 `data/monitor/` 目录只读绑定给监督容器；不要绑定单个原子替换的JSON文件。每台来源导出 `<host_id>.json`，使用原协议扁平字段，动作合并为上述审计集合，再增加 `receive_time_utc` 与 `payload_sha256`。`health.json` 独立显示真实接收器 `connected`、`subscribed`、`last_error`、心跳和计数；不伪装为原 ingestor 的连接。

默认 UID/GID10001、只读根目录、capabilities清空、64MiB内存、0.10CPU、无入站端口，配置和密码只读挂载。持久目录预先由相同UID拥有。一个状态目录只允许一个接收器持有锁。

模板仅使用合成身份和保留域名；实际MQTT地址、账号、来源标识和部署路径放在被忽略的本地配置。此模块不创建账号或权限，发布账号仅发布自己的精确主题，接收账号仅订阅列出的精确主题。

```sh
docker compose -f compose.example.yaml --env-file .env config --quiet
docker compose -f compose.example.yaml --env-file .env up -d --build host-health-receiver
docker compose -f compose.example.yaml --env-file .env exec host-health-receiver cat /app/data/monitor/health.json
```

停止或回退只处理本接收器，保留状态目录、消息指纹和动作审计；不停止原采集、ingestor 或监督程序。健康检查仅确认接收循环心跳，MQTT失联是业务降级，不能把容器healthy解释为来源主机正常。实际MQTT、ACL和飞书通知均需现场验收；本地单元测试不能替代它们。

本地测试：`python -m unittest discover -s ops/host-health-receiver -p 'test_*.py' -v`。

实际MQTT协议验收使用自行创建的隔离Docker网络、临时卷和一次性自签测试CA，未开放宿主机端口，不需要Windows目录共享。它覆盖TLS、真实Paho2.1、持久化后PUBACK、重复投递、接收器重启、retained拒绝和延迟动作不刷新资源水位。先构建仅供测试的Python/Paho/OpenSSL镜像，再明确启用；`HOST_HEALTH_TEST_PYTHON_IMAGE` 可指向具有相同依赖的现有测试镜像。可选 `HOST_HEALTH_TEST_RECEIVER_IMAGE` 指向本模块已构建镜像，此时直接运行镜像内 `/app/receiver.py` 并核对源码SHA256。测试不是正式EMQX或飞书验收。

```sh
docker build -f ops/host-health-receiver/test/Dockerfile -t one-minihouse-host-health-fixture:local ops/host-health-receiver
RUN_MQTT_INTEGRATION=1 python -m unittest discover -s ops/host-health-receiver -p test_mqtt_integration.py -v
```

MQTT库采用 Paho 2.1.0；手动确认和回调接口参见 [Paho Client 文档](https://eclipse.dev/paho/files/paho.mqtt.python/html/client.html)。
