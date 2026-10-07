# Modbus 电表与光照

下表是 [配置模板](../../gateway/config/modbus.example.json) 中的合成设备，地址使用文档保留网段。实际端点、设备地址和部署信息放在忽略的私有配置中。

| 示例设备 | ID | TCP 串口透传 | RTU 地址 | 周期 / 超时 |
|---|---|---|---|---|
| 主电表 | `meter-main` | `192.0.2.1:8899` | `0x01` | 60 秒 / 8 秒 |
| 分电表 | `meter-secondary` | `192.0.2.1:8899` | `0x02` | 60 秒 / 8 秒 |
| 光照 | `light-example` | `192.0.2.101:8899` | `0x03` | 60 秒 / 8 秒 |

同一 RS485 总线只运行一个主站，设备串行轮询；示例两只电表共用一个端点，光照使用另一端点。DDSU666 与 B-RS-L30 驱动、CRC 校验及测试位于 `gateway/`。BLE 与 Modbus 可使用独立 Compose、MQTT 账号及主题前缀。

## 常用命令

在自己的网关部署目录执行：

```sh
docker compose -f compose.modbus.yaml ps
docker compose -f compose.modbus.yaml logs --tail 100 gateway
cat data-modbus/health.json
```

启动：`docker compose -f compose.modbus.yaml up -d --no-build`。
停止：`docker compose -f compose.modbus.yaml stop gateway`。
更新前保存现有镜像、配置和一致的数据副本，构建并校验候选镜像后执行 `docker compose -f compose.modbus.yaml up -d --no-build --force-recreate gateway`。

回退使用该服务之前验证过的镜像及兼容配置，保留 `data-modbus/` 和入库 `data/`。不得同时启动旧采集器和新采集器作为两个 RTU 主站。

## 诊断与核验

- 从当前私有配置核对 TCP 端点、串口参数和 RTU 地址；只读检查健康文件、连接状态及已有日志。
- 独占总线探测需要先停用同总线采集器，保存原配置，并在探测后恢复；不要向运行中的总线并行发送请求。
- 使用 MQTT 5 / TLS 和独立观察账号，订阅 `iot/v1/example-home/example-modbus/devices/+/telemetry` 及同级 `frames` 的实际私有主题。核对权限、最新采样和 `collection_id` 关联。
- `ingestor/scripts/verify-mqtt-evidence.ts` 使用观察结果核验两端 PostgreSQL、SQLite 原文和报文。按脚本要求设置私有 `MQTT_EVIDENCE_FILE`、`CONFIG_FILE`、`DATA_DIR`、`OUTPUT_FILE`；数据库查询只读。

现场诊断记录与一次性脚本留在本地私有归档。通用看板与单位说明见 [Grafana](../grafana/README.md)，入库层与保留期见 [入库说明](../../ingestor/README.md)。
