# Linux 本机温度 MQTT 上报

每台 Linux 主机自己读取 sysfs，通过 MQTT 5 + TLS + QoS 1 上报；采集服务器订阅并沿用现有原始层、双 PostgreSQL 和 Grafana 链路。MQTT 代理无需 SSH 采集账号、SSH 密钥、sudo、Docker 或入站服务。可选的 SATA SMART 和 NVIDIA GPU 温度由独立 helper 读取固定白名单设备，代理只消费其缓存。

使用发行版的 Python 3、`python3-paho-mqtt` 2.x 和 systemd。服务通过 DynamicUser 运行，凭据由 systemd LoadCredential 交付，不能访问用户目录或原始磁盘设备。主机维护各自的 MQTT 账号，只允许发布自己的主题；禁止订阅及跨主机发布。入库账号单独增加这些主题的订阅权限。

## 配置与部署

实际站点、账号、设备选择器及密码保存在未提交的本地文件。复制 `config.example.json` 配置每台主机，先运行 `../host-temperature/read-temperatures.sh` 确认选择器。最多 64 个通道，启动时立即读取一轮，之后默认每 60 秒读取一次。多块 NVMe 使用 PCI 插槽别名，不能按 hwmon 或 nvme 数字序号绑定。主板未知通道和 NVMe Sensor 1/2 不猜测物理用途。

安装发行版的 `python3-paho-mqtt` 2.x 后，将本目录的程序、unit、`install.sh` 和 `../host-temperature/read-temperatures.sh` 放到同一个临时目录，另行准备私有配置和 MQTT 密码文件。先核验配置与实际读数：

```sh
python3 agent.py --config /path/to/private-config.json --check
python3 agent.py --config /path/to/private-config.json --read-once
sh install.sh /path/to/private-config.json /path/to/mqtt-password
```

安装脚本重复运行前会备份原程序、配置和 unit；程序安装到 `/opt/one-minihouse-temperature/`，root 所有、文件 0644；配置和密码放到 `/etc/one-minihouse-temperature/`，目录 0700、文件 0600。脚本不自动启动，先配置 MQTT 权限及入库订阅，再执行：

```sh
systemctl daemon-reload
systemctl enable --now one-minihouse-temperature.service
systemctl status one-minihouse-temperature.service
journalctl -u one-minihouse-temperature.service -n 30
```

服务运行时读取 systemd 的 `mqtt_password` credential；直接运行测试使用配置中的绝对密码路径。MQTT TLS 使用系统 CA 且校验证书和主机名。

发布账号只允许发布 `iot/v1/<site>/<host>/#`，随后用 `#` 拒绝其余发布和全部订阅。入库账号允许订阅 `iot/v1/<site>/<host>/devices/+/telemetry`，并在 ingestor 私有配置的 `mqtt.topicPrefixes` 增加 `iot/v1/<site>/<host>`。只重建入库容器即可使用现有通用信封处理器；展示视图要对应配置设备、网关和温度指标，不能用示例 SQL 覆盖线上定义。

## 可选 SATA SMART 温度

没有 `smart` 配置时，代理保留原有 sysfs 行为。需要 SATA SSD 或 SATA HDD 温度时，使用本目录的 `smart_reader.py`、`install-smart.sh` 和独立 service/timer；不修改 MQTT 服务的 `DynamicUser=yes`、`PrivateDevices=yes` 或空 `CapabilityBoundingSet`，不把 MQTT 账号加入磁盘组，也不授予它 sudo、原始设备或 SMART 命令权限。

helper 每 60 秒运行一轮，最多 8 个设备，每个设备超时 5 秒；与 sysfs/MQTT 服务独立调度。白名单必须使用已核实的 `/dev/disk/by-id/ata-...` 或 `/dev/disk/by-id/usb-...` 整盘链接，并填写预期型号、序列号、`rotation`（`ssd` 或 `hdd`）和固定的 `device_type`（`ata`、`sat`、`sat,12` 或 `sat,16`）。每次读取都检查块设备、介质类型和返回身份；不按 `/dev/sdX` 编号绑定，也不扫描或自动猜测设备协议。参见只含合成标识的 [smart.example.json](smart.example.json)；真实路径和身份写入忽略的本地配置，不能提交。

helper 只调用固定的 `/usr/sbin/smartctl -i -A -j -d <白名单类型> -n standby,3,5 <已解析设备>`。不启用 SMART，不启动自检，不修改电源设置。处于 standby 的设备跳过；不支持电源状态检查时也跳过，不撤掉 `-n` 重试。SMART 必须已经可用且启用，温度不存在、身份不符或读取失败时只记录缺失和通用错误码。有效温度来自 `temperature.current`，或严格校验的 ATA 190/194 温度属性；不把其他 SMART 数字、打包 raw 值或失败结果当作温度。

helper 的程序和私有配置均由 root 管理。其 unit 禁止网络，只允许白名单设备的读取打开权限，并保留 SMART 查询所需的 `CAP_SYS_RAWIO`；`DeviceAllow=... r` 本身不能限制 ioctl 的内容，固定命令以及不可由非 root 修改的程序、配置共同构成只读边界。安装脚本按已验证的稳定 by-id 链接生成 `20-devices.conf`，不能手写宽泛的设备通配授权。

部署时可先核验 `device_type: "sat"` 是否受目标设备支持。Linux 的传统 ATA ioctl 还要求 `CAP_SYS_ADMIN`；此服务不授予该能力，不能因为 root shell 中 `-d ata` 成功就认为受限服务也能成功。某些失败还会被 smartctl 表示为 `SLEEP`，因此 `power_check_failed_or_sleep` 只表示本轮无法安全确认并读取，不断言硬盘确实休眠。实现依据：[Linux ATA ioctl 权限检查](https://github.com/torvalds/linux/blob/master/drivers/ata/libata-scsi.c)、[smartctl 电源状态检查](https://github.com/smartmontools/smartmontools/blob/main/src/ataprint.cpp)。部署时必须验证实际 oneshot 服务的缓存结果，不能只检查退出码。

在 MQTT 私有配置中添加以下字段。指标必须与该主机 helper 白名单完全一致，并与 `sensors` 中的指标互不重叠：

```json
"smart": {
  "cache_file": "/run/one-minihouse-smart-temperature/readings.json",
  "metrics": ["sata_ssd_a_temperature_c", "sata_hdd_a_temperature_c"],
  "max_age_seconds": 120
}
```

`cache_file` 只接受上述固定路径，省略时使用该默认值；`max_age_seconds` 默认 120。缓存目录由 root 创建为 0755，JSON 文件为 0644，原子替换并同步到文件系统；MQTT 服务只能读取。缓存不含磁盘路径、型号、序列号或原始 smartctl 输出，只包含版本、批次 UUID、UTC 读取完成时间、摄氏度指标、缺失指标、通用错误码、逐项读取时间和质量说明。

### 安装和单机核验

先安装发行版的 `smartmontools` 并确认 `/usr/sbin/smartctl` 可用。把私有 helper 配置放在 root:root 所有、不可由其他用户写入的目录中，配置权限为 0600。程序也应置于受信任的 root 管理目录；不要直接使用示例设备标识。以下由管理员执行，路径均为占位示例：

```sh
/usr/bin/python3 -I -B smart_reader.py --config /root/temperature-staging/private-smart.json --check
sh install-smart.sh /root/temperature-staging/private-smart.json
systemctl start one-minihouse-smart-temperature.service
cat /run/one-minihouse-smart-temperature/readings.json
```

`--check` 只验证配置、权限、可执行文件和块设备映射；预期型号、序列号及真实温度仍需实际读取才能验收。安装脚本保存旧程序、私有配置、service/timer 和设备 drop-in 到 `/root/one-minihouse-smart-temperature-backup/`，安装到 `/opt/one-minihouse-smart-temperature/` 和 `/etc/one-minihouse-smart-temperature/`，随后执行 `daemon-reload`；不安装软件包、不启用 SMART、不启动或启用服务。

按前述 `install.sh` 流程更新支持缓存的 MQTT 代理和私有配置，保留原账号、密码、设备身份及全部 sysfs 通道。先用候选配置核验，再启动周期读取和重启代理：

```sh
python3 /opt/one-minihouse-temperature/agent.py --config /root/temperature-staging/private-config.json --check
python3 /opt/one-minihouse-temperature/agent.py --config /root/temperature-staging/private-config.json --read-once
systemctl enable --now one-minihouse-smart-temperature.timer
systemctl restart one-minihouse-temperature.service
systemctl list-timers one-minihouse-smart-temperature.timer
journalctl -u one-minihouse-smart-temperature.service -n 30
```

未启用缓存来源时，`--read-once` 保持单个 JSON 信封输出。启用后输出 NDJSON：第一行为当前状态，随后依次输出存在有效读数的 SMART、GPU 独立遥测信封。任一来源缺失、缓存失败或带质量说明时退出码为 2；standby 跳过也属缺失，不应为消除退出码而唤醒磁盘。该命令不会发布 MQTT。

## 可选 NVIDIA GPU 核心温度

在 NVIDIA 驱动实际管理 GPU 的 Linux 系统中运行 `nvidia_reader.py`。PCI 直通时部署到拥有驱动的虚拟机；不更改宿主机的设备绑定、虚拟机配置或驱动。需要已有 `/usr/bin/nvidia-smi`，不增加 Python 依赖。每 60 秒按白名单读取一轮，最多 8 块 GPU，每块超时 5 秒，整个 service 最长 45 秒。只读取核心温度，不推断显存或热点温度。

私有 helper 配置使用 GPU UUID、精确型号、已核实的 `/dev/nvidiaN` 字符设备和指标名，格式见 [nvidia.example.json](nvidia.example.json)。UUID 用于查询与返回身份校验；设备节点只限制服务的设备访问范围，不把设备数字序号视为稳定身份。安装前核对 NVIDIA 驱动提供的设备信息（例如 `/proc/driver/nvidia/gpus/<PCI>/information` 的 `Device Minor`）与节点一致；`--check` 不声称验证 UUID 和 minor 的对应关系。更换设备或设备节点变化后，重新核对配置及 drop-in；不自动扩大设备权限。

固定命令为 `/usr/bin/nvidia-smi --id=<白名单UUID> --query-gpu=uuid,name,temperature.gpu --format=csv,noheader,nounits`。每次严格检查返回的 UUID、型号和单个有效摄氏度整数；`N/A`、超时、身份不符和命令失败生成缺失，不补零、不沿用旧值。程序不调用 GPU 重置、功率限制、时钟或 persistence-mode 修改命令。查询会访问驱动并可能初始化 GPU；每分钟查询的 CPU 开销较小不代表设备功耗没有变化，也不承诺不影响 GPU 省电状态。依据：[NVIDIA CLI 文档](https://docs.nvidia.com/deploy/nvidia-smi/index.html)、[驱动持久状态说明](https://docs.nvidia.com/deploy/driver-persistence/persistence-daemon.html)。

helper 使用单独的 root oneshot unit，能力集为空、禁止网络，程序和私有配置不可由普通用户修改。安装脚本只为 `/dev/nvidiactl` 及明确配置的 `/dev/nvidiaN` 生成 `DeviceAllow=... rw`，不授权 UVM 或通配设备。NVML/驱动查询需要可读写打开设备；`rw`、只读 `/dev` 挂载和空 capability 都不能限制 ioctl 内容，固定可信查询命令是其只读操作边界。MQTT 服务继续保持 `DynamicUser=yes`、`PrivateDevices=yes` 和空能力集，只读取公开缓存，不获得 NVIDIA 设备权限。

把私有配置放到 root:root 所有、其他用户不可写的目录，文件为 0600，程序放到可信 root 管理目录。管理员先执行以下步骤：

```sh
/usr/bin/python3 -I -B nvidia_reader.py --config /root/temperature-staging/private-nvidia.json --check
sh install-nvidia.sh /root/temperature-staging/private-nvidia.json
systemctl start one-minihouse-nvidia-temperature.service
cat /run/one-minihouse-nvidia-temperature/readings.json
```

安装脚本备份已有专用程序、配置、service/timer 和设备 drop-in 到 `/root/one-minihouse-nvidia-temperature-backup/`，不安装包、不启动或启用服务，不接触 MQTT 凭据或 SQLite。实际受限服务的缓存必须有预期指标才能验收；`--check` 或 service 退出成功都不能替代读数检查。helper 的所有设备读取失败时仍写入包含缺失原因的新快照。

在 MQTT 私有配置中增加 `gpu`，指标必须与 helper 完全一致，且不与 sysfs/SMART 重叠：

```json
"gpu": {
  "cache_file": "/run/one-minihouse-nvidia-temperature/readings.json",
  "metrics": ["gpu_temperature_c"],
  "max_age_seconds": 120
}
```

路径固定，默认有效期 120 秒。没有 sysfs 通道的虚拟机可使用 `sensors: []`，但必须配置有效的 `gpu`；完整合成示例见 [config.gpu.example.json](config.gpu.example.json)。原有主机保留全部 sysfs、SMART 配置及 MQTT 身份和密码。按前述 MQTT 安装流程更新后，以 `--check` 和 `--read-once` 核验，再启用 `one-minihouse-nvidia-temperature.timer` 并重启 MQTT 代理。发行版 paho 低于 2.x 时使用管理员准备好的兼容环境，不能把不兼容版本当作部署成功。

缓存位于 root:root 的 0755 目录，JSON 以 0644 原子替换，`RuntimeDirectoryPreserve=yes` 使其保留到下一轮。版本 1 的字段与 SMART 相同：`batch_id`、批次完成 `read_time_utc`、`sample_time_utc: null`、`metrics`、`missing_metrics`、通用 `errors`、`quality_notes` 和 `per_metric_read_time_utc`；不含 UUID、型号、设备路径或命令原始输出。

GPU 遥测使用 `source.temperature_source=nvidia_smi` 和独立稳定 message_id，沿用缓存原始 UTC 时间，独立批次标记与入队在同一 SQLite 事务中持久化。重复缓存、ACK 后重启及旧批次不会重复入队。坏缓存、过期、未来时间或指标不匹配只使 GPU 缺失，sysfs/SMART 继续；sysfs/SMART 失败也不会丢弃有效 GPU 温度。混合来源主机的 `state.metrics` 仍只含 sysfs，GPU 状态保存在 `source.gpu_*`；GPU-only 主机的状态使用 GPU 原始读数和时间，完全缺失时 `metrics={}`、`read_time_utc=null`，不生成遥测。

只撤销 GPU 时，停用 `one-minihouse-nvidia-temperature.timer` 并停止对应 service，恢复 MQTT 配置后重启代理；保留原 MQTT 凭据、授权、SQLite 和 sysfs/SMART 配置。GPU-only 主机移除 `gpu` 前须配置有效 sysfs 通道，或停用该 MQTT 代理。回退程序和 unit 使用本机备份并执行 `daemon-reload`，不删除队列。

## 数据与失败行为

- `iot/v1/<site>/<host>/devices/<device>/telemetry`：非 retained、v2 信封、UTC `read_time_utc`、未知的 `sample_time_utc=null`、摄氏度指标。没有伪造的设备测量时间。
- `devices/<device>/state`：retained 当前读取状态；`status`：retained 在线信息及离线遗嘱；正常停止也发布离线状态。历史补报不覆盖最新状态。
- 只上报实际读到且范围有效的通道；缺失或歧义的通道列入 `missing_metrics`，当前状态为 degraded，其余有效读数继续入库。全部失败时不生成遥测记录。
- SQLite 先落盘再发布；只有成功 PUBACK 才删除。断网继续采集，重启继续补报，原 message_id 保持不变。允许重复投递，由下游按 ID 去重。
- 待发缓存最多 7 天或 10 万条；到限清理最旧待发记录并记录 dropped。SQLite 状态位于 `/var/lib/one-minihouse-temperature-mqtt/`。

SMART 使用相同主机设备身份和遥测主题，但生成独立信封：`source.temperature_source=smartctl`，`read_time_utc` 沿用 helper 的原始批次读取完成时间，`sample_time_utc=null`，`observation_kind=direct_read`。逐项读取完成时间保留在 `source.per_metric_read_time_utc`；它们不是硬盘内部采样时间。缓存消费或网络补报时不把时间改成本轮 sysfs 时间。

缓存缺失、格式异常、指标不匹配、来自未来或超过有效期时，本轮不生成 SMART 遥测，状态列明 SMART 缺失和错误；CPU、NVMe 等 sysfs 读数继续上报。sysfs 读取超时同样不会丢弃有效 SMART 缓存。单盘失败时其余有效盘继续上报，缺失不补零；真实读到的 0 °C 则保留。SMART 健康警告或 ATA 属性回退说明保留在 `quality_notes`，不抹掉有效温度，当前状态标记 degraded。

retained `state.metrics` 仍只含本轮 sysfs 指标，SMART 状态单独放在 `source.smart_read_time_utc`、`smart_missing_metrics`、`smart_errors`、`smart_quality_notes` 和 `smart_error`，避免把缓存读数展示为新读取的值。SMART 遥测按主机身份和缓存批次 UUID 生成稳定 message_id；入队、记录已消费批次及更新状态在同一个 SQLite 事务中完成。成功 PUBACK 后删除待发记录，持久批次标记仍保留，所以重启或重复读取同一缓存不会再次入队，旧批次也不会倒退重放。

helper 缓存代表最新一轮快照。helper 和代理独立每 60 秒运行，调度错位或代理暂停期间可能跳过已被覆盖的缓存批次；不能据此宣称每一次 helper 读取都有历史记录。已入 SQLite 的遥测仍按原有补报规则持久保存。

## 回归与撤销

暂停用 `systemctl stop one-minihouse-temperature`，撤销用 `systemctl disable --now one-minihouse-temperature`；保留数据目录。更新前保存程序、配置、unit 和 MQTT 授权；先核验单机读数和双写，再回归原有 Grafana 展示。不会修改电表、光照、小米采集配置。

只撤销 SMART 时，先 `systemctl disable --now one-minihouse-smart-temperature.timer`，再 `systemctl stop one-minihouse-smart-temperature.service`，恢复备份的 MQTT 配置以移除 `smart` 段，并重启 MQTT 代理。需要回退程序或 unit 时，从本机该次安装前备份精确恢复相关文件并执行 `systemctl daemon-reload`；保留原 sysfs 配置、MQTT 凭据、授权和 `/var/lib/one-minihouse-temperature-mqtt/`，不要删除 SQLite、待发记录或批次标记。helper 安装文件可以先保留为禁用状态；`/run` 缓存不是历史数据备份。

上线验收需核对实际服务权限、读数、缺失/standby 行为、每分钟更新、成功 PUBACK、双库同 message_id，以及 Grafana 时间和单位。修改展示前先备份线上最新看板、视图定义和授权；使用 Grafana 实际只读账号回归所有标签页及已启用分享页，覆盖电表/插座累计电量、时段和每日用电、电压电流功率、光照、温湿度及全部主机温度，且确认底表和内部兼容视图仍不可读。单元测试、`--check` 和单机读数均不能代替这些线上检查；发现原有展示异常应修复或按备份回退。
