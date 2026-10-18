# Linux 温度采集 Docker 部署

一个支持 Linux amd64/arm64 的源码镜像运行两个隔离服务：`mqtt` 读取系统温度并上报，`smart` 只读取指定硬盘的 SMART 数据。镜像不包含主机配置、密码、设备身份或 SQLite。原生 systemd 部署仍可使用。

## 构建

在仓库根目录执行：

```sh
docker build -f ops/linux-temperature/Dockerfile -t one-minihouse-temperature:local .
```

Dockerfile 专用忽略文件只允许四个程序源文件及构建文件进入上下文，`COPY` 也采用显式清单。镜像使用 Debian Trixie 官方包中的 Python、Paho MQTT 2.x、smartmontools 和 CA 证书，不安装额外 pip 包。多架构发布可使用已配置的 Buildx 构建器：

```sh
docker buildx build --platform linux/amd64,linux/arm64 \
  -f ops/linux-temperature/Dockerfile \
  -t registry.example.com/example/temperature:VERSION --push .
```

这是发布命令示例，需替换受控镜像仓库及固定版本。生产环境建议用经过验收的镜像 digest。

## 集中目录与权限

推荐一个正式目录，例如 `/srv/one-minihouse/temperature/`：

```text
compose.yaml
config/temperature.json
config/smart.json
secrets/mqtt_password
data/                       # outbox.sqlite、WAL/SHM、health.json
runtime/smart/readings.json  # 当前 SMART 缓存，可重新生成
```

将 `compose.example.yaml` 作为私有部署文件，两个现有 JSON 配置和原密码作为配置文件。`CREDENTIALS_DIRECTORY=/run/secrets` 让采集器使用挂载密码，无需改动旧配置中的 `mqtt.password_file`；站点、设备、客户端 ID、账号、采集周期及队列策略保持原值。

目录需要先创建；Compose 的 `create_host_path: false` 会在缺少文件时拒绝启动，避免意外生成空目录。权限如下：

| 路径 | 所有者 | 权限 |
|---|---|---|
| 正式目录、`config/`、`secrets/` | root:root | 0700 |
| `config/temperature.json`、`secrets/mqtt_password` | root:10001 | 0640 |
| `config/smart.json` | root:root | 0600 |
| `data/` 及已有数据库文件 | 10001:10001 | 目录 0700，文件 0600 |
| `runtime/`、`runtime/smart/` | root:root | 0755 |
| SMART 缓存文件 | root:root | 0644（helper 自动创建） |

宿主机目录权限限制主机上的其他用户；Docker 挂载后的文件权限允许容器内 UID/GID 10001 读取所需文件。不要把密码放进环境变量、构建参数或 Compose 文本。保留原文件时可单独设置部署副本的读权限，无需修改原凭据文件权限。

## 硬件访问

- `mqtt` 使用普通桥接网络，无入站端口、无额外 capabilities，非 root、只读根文件系统；将 `/sys` 只读挂载以保留 thermal/hwmon 符号链接的实际目标。
- `smart` 无网络，以 root 运行，只增加 `SYS_RAWIO`；使用逐台核实的 `devices` 白名单和只读 by-id、sysfs 挂载，不使用 privileged、全 `/dev` 挂载或 `SYS_ADMIN`。
- `config/smart.json` 继续按稳定 by-id 路径、型号、序列号匹配设备。模板的 `/dev/sdb` 仅示例，必须核实对应盘；容器内设备名与 by-id 链接解析目标一致。设备名在重启后可能改变，需要重新核实并更新映射后重建 `smart` 服务。
- by-id 目录可见不等于能读取所有盘，实际访问受设备白名单限制。只读设备节点也不能过滤所有 ioctl；边界还包括受控程序、固定命令及不可变配置。
- 沿用 `smartctl -n standby,3,5`。休眠、身份无法验证或设备不支持安全读取时跳过，不唤醒重试、不补零、不启用 SMART 或执行自检。
- 该模板不接入 NVIDIA GPU；GPU 需要独立核实驱动、设备及运行时，不能以放宽整个容器权限代替。

如果主机没有 SMART 设备或不需要硬盘温度，可删除 `smart` 服务及相关挂载，并从采集配置中移除 `smart` 部分。

## 从现有 systemd 迁移

迁移需要短暂停止本机采集，不能让旧服务和容器同时用同一 MQTT 客户端 ID 或写同一个 SQLite。

1. 记录原服务状态、配置及真实数据目录所有者。预先构建镜像、准备文件权限和设备映射；先用 `agent.py --check`、`smart_reader.py --check` 校验私有配置。`--check` 不发布 MQTT 消息。
2. 停止旧温度服务及 SMART timer/oneshot，确认进程退出。保留原账号、JSON 配置及密码。
3. 在停机状态迁移整个真实数据目录，保留 SQLite 主文件、WAL、SHM 和批次去重元数据；DynamicUser 的实际目录可能在 `/var/lib/private/`。调整新数据目录为 UID/GID 10001。不要只复制数据库主文件、删除队列或重新初始化数据库。
4. 使用原配置和身份启动 Compose。核对新容器读取的 SQLite 与迁移文件一致，并观察真实指标、原始时间、消息确认和双库入库。
5. 至少验证连续 10 个周期，检查异常读数/缺失值处理、MQTT 恢复及容器重启后的队列补报；对照已有 Grafana 类别及分享页，确认没有新增掉线或重复身份。健康检查通过仅说明调度仍在推进，不能替代业务验收。
6. 正常后再禁用、移除旧的温度 service 和 SMART timer/service、专属程序配置目录。删除前核对没有其他服务复用，并确认正式 Compose 配置、凭据和采集数据均保留。

不需要制作完整历史目录备份。迁移期间保留尚未清理的旧服务定义和程序作为回退路径；如果验证失败，先停容器，将同一份完整队列恢复为原所有者/原路径，再恢复原服务。回退不能丢弃容器期间新采集的数据。

## 日常操作与健康检查

在正式目录执行：

```sh
docker compose up -d
docker compose ps
docker compose logs --tail 100 mqtt smart
docker compose restart mqtt
docker compose stop
```

更新时先准备并验收新镜像，修改私有 `.env` 中的 `TEMPERATURE_IMAGE`，再 `docker compose up -d`。不要执行清理数据目录的操作。两服务日志轮转，每服务保留至多约 6 MiB 日志。

`mqtt` 健康检查只检查 `health.json` 的 UTC 心跳新鲜度，默认允许 180 秒；调高采集周期时也需设置 `TEMPERATURE_HEALTH_MAX_AGE_SECONDS`，应大于采集周期及允许的采集耗时。`smart` 检查缓存生成时间，硬盘休眠时生成空指标缓存也属调度正常。MQTT 短时断网、正常休眠或个别传感器缺失由业务状态及现有监督服务处理，不用容器反复重启掩盖问题。Docker 的 `restart` 策略不会自动重启仅被标记为 unhealthy 的容器。

参考：[Docker bind mount](https://docs.docker.com/engine/storage/bind-mounts/)、[Compose services](https://docs.docker.com/reference/compose-file/services/)、[Linux runtime capabilities 和 devices](https://docs.docker.com/engine/containers/run/#runtime-privilege-and-linux-capabilities)。
