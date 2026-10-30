# OpenWrt 主机告警与有限缓解

Python 3.10+ 原生 procd 服务，两个实例分别负责本机采样和 MQTT 发布；不新增 Docker 容器，不由远端 SSH 采集。每 10 秒读取内核资源，每 60 秒发布，条件或动作事件改变时立即排队。Docker、容量和证据操作使用独立有期限 worker；超时后仍存活的 worker（包括 D 状态）阻止同类替代进程启动。

## 采集与判定

- `/proc/meminfo` 使用 MemAvailable，保留匿名内存、Slab、不可回收 Slab、Shmem、Dirty、Writeback；CPU iowait 使用相邻 `/proc/stat` 差分，排除重复统计的 guest 字段。第一轮/计数器倒退不造零值。
- 每次发布（通常每 60 秒，条件/动作变化时提前）附带 RSS 最大进程的诊断快照，资源指标来自最近的 10 秒采样。读取 `/proc/<pid>/status` 的 `Name`、`VmRSS`，按实际驻留内存 RSS 排序，不使用虚拟地址空间；[Linux proc 文档](https://docs.kernel.org/filesystems/proc.html) 说明了该字段。名称长度至少 3 时，仅隐藏中间 1 个字符并保留其余前后缀，例如 `node` → `n*de`、`daemon` → `da*mon`；长度不超过 2 时没有可隐藏的中间部分，保留原样。名称仅含 ASCII 安全字符且最多 64 字符。
- 仅对 RSS 第一的 PID 读取 `/proc/<pid>/exe` 链接，可选上报真实绝对可执行路径，目录保持、仅文件名按相同规则脱敏，例如 `/usr/bin/n*de`。路径最多 512 字符，不接受空段、`.`、`..`、空白或控制字符。权限不足、已删除的可执行文件或路径不受支持时省略路径，回退到进程名；不读取命令参数或环境变量。仅对初步 RSS 领先者在 `/proc/<pid>/stat` 启动时间前后校验中重读 status，使用这次确认的 RSS 再比较排名；普通非领先进程仅读一次 status，减少内核文件读取。最终第一名的 exe 读取前后再次校验启动时间并复核进程名，避免进程退出/重用后错误关联路径。
- 进程扫描最多 4,096 个进程、8,192 个目录项，status 每次最多 8 KiB、stat 最多 4 KiB，并在循环中检查 200 毫秒预算。权限不足、格式异常、达到上限或预算即省略整个诊断，不将局部排名冒充全机第一；进程退出竞态、无 VmRSS 的内核线程可跳过。顺序读取不是全机原子快照，也不能仅凭 RSS 排名确定内存压力原因。此诊断不改变告警阈值或自动缓解条件。
- 读取 load、procs_blocked、可选 PSI、配置指定的温度、root/data 容量。PSI 缺失时省略相关指标。容量/Docker helper 失败或超过 90 秒失去新鲜度，不能继续作为有效证据。
- CPU 温度是 sysfs 毫摄氏度换算；`-50..150°C` 是输入合理性保护，`85°C/120秒` 是本站可调整前需审查的告警策略，不是厂家物理额定范围。[Linux thermal ABI](https://docs.kernel.org/driver-api/thermal/sysfs-api.html)
- 可用内存 `<256 MiB/120秒` 警告，`<128 MiB/60秒` 严重；iowait `>=20%` 且阻塞任务 `>=3/120秒` 为 I/O 严重；容量 `>=90%/300秒` 警告。load 单独不判定故障原因。
- bad 条件在安全资源连续 300 秒后恢复：内存至少320 MiB、I/O低于10%且阻塞少于3、温度低于80°C、两容量低于85%。缺测、间隔超过25秒、uptime倒退或换 boot 会打断窗口，unknown 不当作正常。

## 有限动作

默认 `mitigation.enabled=false`。启用需要先把真实目标完整 container ID、image ID、Compose 项目/服务标签及 cgroup v1 目录填入私有配置；同名替换、镜像变化、标签变化、未运行/正在重启均拒绝操作，不自动重绑新实例。

唯一允许的动作是重启这一指定代理容器：内存严重持续成立，代理 working set 或 RSS 至少512 MiB持续60秒，同时 PSI avg10至少10%、阻塞任务至少3或iowait至少20%之一提供佐证。boot最初300秒禁止自动动作。cgroup working set=usage-total_inactive_file；缺少/不一致计数不补零。

先 fsync 持久 action claim，再通过本机 Docker Unix socket 调用完整ID的 restart；同 incident 不重复、30分钟冷却、滚动24小时最多2次。请求结果不明确记 uncertain，禁止盲目重试。每个 claimed/terminal phase 有独立 event ID，同一个 action ID。进程退出或超时后的未完成 claim 会记录 uncertain；不以重启监控服务重置预算。配置、队列或账本缺失/损坏/容量满时关闭动作，不重建账本。

没有远程命令订阅，不停止其他容器/网络核心服务，不自动重启主机、drop_caches、清理 Docker 数据或强杀 D 状态进程。停止监控不会撤销已经送达 Docker 的操作。

## 消息和保存

主题为 `iot/v1/<site_id>/<host_id>/host-health`，MQTT5、TLS公共CA校验、QoS1、非retained；专用账号只能发布这一精确主题，禁止订阅/跨主机发布。固定 wire 包含schema_version/message_id/site_id/host_id/boot_id/sequence/read_time_utc/uptime_seconds/metrics/四类conditions/actions；可选 `diagnostics.memory_top_process` 含 `name_masked`、整数 `rss_bytes` 和可选 `path_masked`。旧版无诊断、早期 `no***` 风格名称及中间隐藏 2–3 字符的报文仍可读取；新发布的名称及路径文件名最多隐藏中间 1 字符。没有命令行、环境变量、SN、原始日志或密码。升级应先让接收端及入库端兼容可选诊断，再更新发布端。

`/tmp` 消息队列最多360条/6小时/2 MiB，重启丢失；只有成功PUBACK才删消息，失败保留消息ID和原文。Paho仅一个inflight、最多两个内部排队，避免网络阻塞无限占内存。成功PUBACK不代表远端消费或数据库提交；离线补报也不能证明当前资源恢复。

持久动作账本单独最多2 MiB；已确认事件按7天清理，未确认事件绝不淘汰，满额关闭新动作。事件phase仅在PUBACK后标记已确认。受限故障证据另外最多2 MiB/7天，仅条件改变时采集，最多8个RSS大户和8个阻塞进程的PID/comm/RSS/state；不扫描应用数据或读取命令参数/环境变量。普通10秒采样只写`/tmp`，不持续写闪存。持久目录不能位于 `/tmp`。

## 安装

`config.example.json` 全是合成信息，不能直接覆盖现有线上配置。先核实实际 Python、CA、cgroup v1、thermal 通道、挂载和代理身份。依赖固定 `paho-mqtt==2.1.0`，可从可信 PyPI 在准备机下载 wheel，校验后用离线 pip `--no-index --no-deps --target /opt/one-minihouse-host-health/vendor` 安装，保留下载源和实际 SHA 到私有验收记录。不把 wheel、配置、密钥或现场输出提交仓库。

```sh
sh install.sh
# 将私有配置与密码分别保存到 /etc/one-minihouse-host-health，权限0600。
python3 -B /opt/one-minihouse-host-health/agent.py --config /etc/one-minihouse-host-health/config.json --role check
# 仅首次初始化；已有账本必须保留，不重复运行、不删除后重建。
python3 -B /opt/one-minihouse-host-health/agent.py --config /etc/one-minihouse-host-health/config.json --role initialize-ledger
/etc/init.d/one-minihouse-host-health enable
/etc/init.d/one-minihouse-host-health start
```

install只更新源码，不写凭据、不初始化账本、不启动。升级前只停止本服务，保留私有配置和持久目录。观察模式先验收，再启用经过批准的代理缓解。

```sh
/etc/init.d/one-minihouse-host-health stop
/etc/init.d/one-minihouse-host-health disable
```

回滚只停止新增服务并恢复先前源码；保留账本、证据和账号。更换代理容器或镜像必须人工核验并更新私有 pin，不修改账本预算。实际采集、Broker/远端接收、飞书触发与恢复分别验收；不主动压垮网关或重启真实代理来造测试。

本地Linux测试：`python3 -B -m unittest -v test_health`。不把fixture通过当成现场验收。
