# oneMiniHouse gateway

Node.js 24 / TypeScript / pnpm 采集服务，支持 YM-S1-BES 蓝牙插座、DDSU666 Modbus 电表、B-RS-L30 光照、米家 Zigbee 温湿度及 Linux 主机温度。MQTT 5 / TLS / QoS 1 上报，SQLite 保存断网队列。只实现已确认的读取命令，不实现开关、清零或写参数。

## 配置与启动

`config/*.example.json` 使用合成标识和文档保留地址。复制到被忽略的 `config/local.json`，再填写实际站点、设备、账号和 broker。真实 MAC、DID、SID 和用户名不提交；密码、miIO token 和 SSH 私钥只放在 `secrets/`，不进入日志或镜像。

```sh
cp -n config/gateway.example.json config/local.json
mkdir -p data secrets
chmod 700 secrets
# 单独创建 secrets/mqtt_password，不把密码写进命令历史。
chmod 600 secrets/mqtt_password
docker compose build
docker compose up -d
docker compose logs --tail 100 -f
```

主题前缀必须为 `iot/v1/<siteId>/<gatewayId>`。发布账号只允许 publish 自己的前缀，其余发布和订阅拒绝；独立验收账号只允许 subscribe 同一前缀。保留无关账号和现有全局授权模式。私有 CA 通过 `mqtt.caFile` 配置，禁止关闭证书校验。

| 后缀 | retained | 内容 |
|---|---|---|
| `devices/<id>/telemetry` | 否 | 成功采样 |
| `devices/<id>/frames` | 否 | 独立报文，以 collection_id 关联采样 |
| `devices/<id>/state` | 是 | 最新成功状态或无 metrics 的错误状态 |
| `status` | 是 | 在线、降级、离线及队列统计 |

## 蓝牙部署前提

宿主机 BlueZ 管理适配器，D-Bus 代理仅允许 `org.bluez`；代理 socket 目录通过非特权 LXC 挂载到 Docker，Compose 中的目录按本机配置核对。代理重启时保持目录 inode，仅替换 socket；权限按 LXC UID 映射设置。

容器内 root 用于匹配 D-Bus EXTERNAL 身份。Docker 使用桥接网络、只读根文件系统、`cap_drop: ALL` 和 `no-new-privileges`；不开放入站端口、不使用 privileged、不暴露完整系统总线。启动校验指定适配器。同一适配器严格串行，超时先回收 worker。每台设备需填写实际 MAC 和已验证的只读参数，不能假定所有设备共用示例参数。

## Modbus

使用 `config/modbus.example.json`、`compose.modbus.yaml`，独立账号、主题和持久目录。驱动通过 TCP 原样转发 RTU 帧，不使用 Modbus TCP MBAP 头。串口服务器地址、从站地址和串口参数必须现场核实。

```sh
cp -n config/modbus.example.json config/modbus.local.json
# 准备 secrets/modbus_mqtt_password 后启动。
docker compose -f compose.modbus.yaml up -d --build
docker compose -f compose.modbus.yaml logs --tail 100 -f
```

DDSU666 用 FC03 读取 `0x4000` 的 2 个寄存器和 `0x2000` 的 16 个寄存器；两组完整且 CRC 正确才生成采样。kW/kvar 转为 W/var，频率用 `0x200E`；不解析保留寄存器，视在功率由下游计算并明确标注。

B-RS-L30 只读 FC03 / `0x0002` / 2 个寄存器，大端无符号计数保留为 `light_raw_count`，`illuminance_lux = light_raw_count / 1000`。source 保留倍率和 `manufacturer_protocol_verified: false`；厂家协议原文仍需核实。

同一串行组设备默认每 60 秒采集，设备之间留 1 秒，电表内部请求间隔 20 ms。周期从本次开始算，不追赶过期轮次。CRC、长度、地址或异常响应失败后关闭连接；拆包/粘包由缓冲区组帧。启用或回滚前确保同总线只有一个主站。

## 米家温湿度

`xiaomi-gateway-v3-temperature` 使用 miIO UDP 54321，读取 `lumi.gateway.v3` 配对的 WSDCGQ01LM（子设备类型 10）。不依赖旧版局域网菜单，不修改设备，日常不登录小米云。

将 `config/xiaomi.device.example.json` 的对象加入本地 devices，实际 token 放在 `secrets/xiaomi_gateway_v3.json`，包含 host、deviceId、model、token，目标必须与配置一致。

```sh
docker compose -f compose.yaml -f compose.xiaomi.yaml up -d --build gateway
```

每 60 秒查询、单轮 10 秒；同一米家网关串行，独立于 BLE/RTU。更新时继续带上扩展 Compose 文件。

指标为 temperature_c、humidity_pct、battery_pct。数据是网关缓存状态；read_time_utc 是查询时间，未知的 sample_time_utc 保持 NULL。重复读值不证明传感器在线或刚刚上报。握手及加密认证包不归档。

## Linux 主机温度

新主机优先部署[本机 MQTT 温度服务](../ops/linux-temperature/README.md)：Linux 自己读取 sysfs 并主动上报，入库端订阅，无需网关通过 SSH 采集。OpenWrt 主动 MQTT 方案见[路由器温度](../ops/openwrt-temperature/README.md)。

`config/temperature.device.example.json` 和 `compose.temperature.yaml` 保留兼容旧的 SSH 拉取方式，仅在明确采用该方式时使用；SSH 用户、地址和来源 IP 必须显式配置，私钥和 known_hosts 走 secrets。固定 sysfs 读取命令见[主机温度](../ops/host-temperature/README.md)。

## 持久化与故障

失败不生成零值、不以旧值冒充新采样。SQLite WAL + FULL 同步，先保存再发送；只有成功 PUBACK 删除待发记录，重试保持 message_id。最新 retained 状态独立保存，历史补报不覆盖它。队列默认 7 天或 100000 条，先达到者生效，淘汰数持久保存。

协议帧独立保存到 frames.sqlite，默认 30 天或 250000 条；PUBACK 标记转发后仍保留到过期。未发帧淘汰单独计数，不影响业务队列。tx 帧不代表设备已收到请求。

健康检查验证进程心跳及调度推进；设备或 MQTT 断线为 degraded。Docker 不因 unhealthy 自动重启，进程退出才触发 restart policy。日志 3 × 10 MiB，初始内存上限 256 MiB。

## 检查、验收和回滚

```sh
pnpm install --frozen-lockfile --ignore-scripts --no-optional
pnpm check
pnpm test
docker compose ps
docker compose exec gateway cat /app/data/health.json
docker compose stop
```

现场至少核验 10 轮 CRC、UTC、单位和独立 MQTT 消息，检查重启、设备断线、MQTT 断线补报及 retained 状态。单元测试不替代现场验收。真实报文、报告和部署导出留在被忽略的 evidence/ 或 .local/。

回滚停止本项目容器，恢复已知可用镜像及私有配置，保留 data 和 secrets。撤销宿主机代理时先备份，只移除实际新增的单元和挂载，不覆盖整份 LXC 配置。SQLite 备份前停止服务并保留 WAL。
