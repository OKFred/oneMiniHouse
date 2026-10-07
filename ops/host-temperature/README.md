# 主机温度采集

本目录提供只读 sysfs 程序，供本机 MQTT 代理及已有的 `linux-temperature-ssh` 驱动使用。SSH 驱动每 60 秒调用固定远端程序，每台主机独立调度，单轮默认 15 秒超时后终止并回收 SSH，不阻塞 BLE、Modbus 或小米网关。Linux 服务器部署优先使用下述本机 MQTT 方式。

示例通道包括 `thermal:cpu-thermal:temp`、`thermal:ddr-thermal:temp`、`hwmon:coretemp:Package id 0`。需按实际内核类型和标签配置；不绑定重启后可能变化的 hwmon 数字序号。同名通道重复时拒绝选择。毫摄氏度转换为 °C，缺失不补零，不读取风扇输入。

多块 NVMe 使用 `hwmon:nvme.pci-0000_01_00.0:Composite` 这类 PCI 插槽选择器，不使用 `nvme0` 或 `hwmon0`；硬盘移到其他插槽时需要重新核实配置。`Sensor 1/2` 和未标注用途的主板通道保持原始通道含义，不猜测为控制器、闪存或某个芯片。固件 ACPI 温度也不能当作室温。

Linux 服务器部署使用[本机 MQTT 上报](../linux-temperature/README.md)，不安装本目录的 SSH 账号或授权。本目录的只读 sysfs 程序也供 MQTT 代理在本机调用。

本目录的 sysfs 读取程序不加载驱动、不访问 SMART 原始设备、不唤醒休眠硬盘。已直通给虚拟机的设备，或内核未暴露的传感器，不会由这个程序生成温度。新增通道后应更新限定 Grafana 视图并回归所有原有展示。

### SATA SSD / HDD 的可选 SMART 来源

没有 sysfs 温度的 SATA 设备可使用[独立 SMART helper 和本机 MQTT 缓存消费](../linux-temperature/README.md#可选-sata-smart-温度)。该能力不加入 SSH 固定命令，也不扩大 SSH 账号或 MQTT 代理的磁盘权限。root helper 每 60 秒按私有白名单读取已经启用 SMART 的设备；使用稳定 by-id、预期型号/序列号和明确的 SSD/HDD 类型绑定，不自动扫描设备。示例指标为 `sata_ssd_a_temperature_c` 和 `sata_hdd_a_temperature_c`。

helper 固定使用带 `-n standby,3,5` 的查询：standby 或不支持电源状态检查时跳过，不尝试唤醒、不启用 SMART、不运行自检。读取结果写入 `/run/one-minihouse-smart-temperature/readings.json`，其中只有温度、UTC 完成时间、批次和通用状态；型号、序列号、真实设备路径留在 root 私有配置中。

MQTT 代理保留 `PrivateDevices=yes`，只读取缓存并生成独立 `source.temperature_source=smartctl` 信封。`read_time_utc` 是 helper 的原始读取完成时间，`sample_time_utc` 仍为 NULL；不以缓存读取时间冒充新测量。过期或失败不补零，不影响 CPU、NVMe 等已有 sysfs 指标；局部失败仍发送其他有效读数。安装、候选配置、NDJSON `--read-once` 输出、持久去重和保留 SQLite 数据的回退步骤见上述链接。

OpenWrt 可主动 MQTT 上报，不配置 SSH 采集授权，见[路由器温度](../openwrt-temperature/README.md)。数据通过现有 MQTT、SQLite/D1、本地 PostgreSQL/Supabase 链路；read_time_utc 为读取完成时间，未提供的 sample_time_utc 保持 NULL。

## 已有 SSH 方式的安装

把两个脚本和专用公钥送到目标主机，由管理员指定系统账号及采集器来源地址。以下均为示例值，实际命令保存在本地私有记录中：

```sh
sh install-reader.sh --authorize collector.pub --account example-temperature --source 192.0.2.31
```

脚本创建专用非特权账号，命令安装到 `/usr/local/libexec/one-minihouse-temperatures`，root 所有、0755。授权位于 `/var/lib/one-minihouse-temperature/.ssh/authorized_keys`，固定命令、限制来源、禁止 PTY、代理/X11/端口转发，不加入集群 root 的授权。

来源 IPv4 同时写入 root 管理的 `/etc/one-minihouse-temperature-reader/allowed-source`。文件缺失或来源不匹配时拒绝远程读取；不内置生产 IP、不扩大访问范围。已有同公钥但不同授权时停止，需人工核对；安装前备份已有文件，不重启 SSH。

采集端私钥和核实过的 known_hosts 放在 gateway/secrets/，权限 0600，禁止关闭主机密钥检查。设备模板见 `gateway/config/temperature.device.example.json`；启动带上 `-f compose.temperature.yaml`。

## 验收与撤销

核验真实读取、其他命令和来源被拒绝、断线超时不造值、每分钟 MQTT、双库同 ID，以及 Grafana 读数、单位、时间。单元测试不替代现场验收。

撤销先移除设备配置并重建采集容器，再精确移除新增的公钥行；不覆盖整个 authorized_keys，不删除其他账号或采集数据。确认无使用者后才移除读取程序和来源配置。
