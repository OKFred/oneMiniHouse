# 服务器运行摘要

使用 Debian 的 Python 3 标准库和 systemd timer，每 5 分钟记录资源、系统启动标识、失败的 systemd 单元、配置中允许的容器状态/重启次数及应用心跳。状态改变标记为 `state_change`，其余为 `heartbeat`。不读取应用日志正文、环境变量、设备读数或密码；五分钟轮询可能错过短暂故障。

配置使用合成主机 `example-host` 和云项目 `example-minihouse`。实际容器、路径、服务器标识、云资源及账号写入私有配置，部署与验收记录保存在忽略目录。

## 本地记录与上传预算

- SQLite 保存 7 天、最多 10,000 条、每条最多 8 KiB，自动复用空闲页；不要删除或回退预算库后重新开启上传。
- SLS 默认为关闭。开启后滚动 32 天最多 100,000,000 计数字节、100,000 次发送。计数字节包含 protobuf 原文、deflate 传输数据和每条 2 KiB 预留量；所有重试计入预算。
- 网络发送前将预算写入 SQLite。预算耗尽时继续本地采样；数据库丢失、损坏或时钟倒退不会自动重置预算。
- 每轮最多一个请求、最多 12 条，失败从 5 分钟退避到 1 小时。只有 HTTP 200 确认成功，不确定结果可能重复，按 `event_id` 去重。
- 待发超过 24 小时停止补报。`generate_time_utc` 是原始采样时间，SLS 内置时间是上传时间；旧补报不能作为新鲜心跳。
- 预算仅约束本程序上传，不约束云账号内其他项目、查询、索引、分区或通知费用。云端计费模式、区域额度、保留期和分区数应按实际账号核对。

## 安装和配置

将本目录源码传入目标主机，运行 `sh install.sh`。安装器不会覆盖已有配置或重置预算数据库。先编辑 `/etc/one-minihouse-server-health/config.json` 中的私有路径及标识，仅启用本地记录，再检查：

```sh
systemctl status one-minihouse-server-health.timer
journalctl -u one-minihouse-server-health.service -n 15 --no-pager
python3 /opt/one-minihouse-server-health/health_agent.py --config /etc/one-minihouse-server-health/config.json --status
```

SLS 接通前创建日志库、专用 RAM 身份及仅该库 `PostLogStoreLogs` 权限。按需为 `server_id`、`event_type`、`quality`、`generate_time_utc`、`event_id` 建索引，避免对原始 `details` 建全文索引。示例权限文件和初始化脚本中的目标必须在私有副本里替换。

`bootstrap-ram.py` 默认只预览示例目标；`--prepare` 创建身份和权限但不创建密钥，`--apply` 才创建密钥。脚本拒绝复用不同权限或已有密钥，不创建控制台登录，不授予读取/删除权限。密钥仅写入权限 600 的文件，不在终端显示。脚本保留 Python 3.6 兼容的 subprocess 参数。

已有凭据应通过安全录入方式导入。暂停健康 timer/service 后，将私有化后的凭据元数据与安装配置核对，再运行私有副本中的 `install-credentials.py <凭据文件>`，恢复 timer/service。该安装器保留 SQLite 预算、拒绝隐式替换已有不同密钥；目录权限 700、密钥权限 600。模板的预期元数据需要与私有部署一致。

上传使用 **deflate + zlib 包装**；格式依据见 [SLS 公共请求头](https://help.aliyun.com/zh/sls/developer-reference/common-request-headers)。错误响应只保留受限错误码，不记录任意响应正文。验证 HTTP 200、云端原始 `event_id` 和时间一致、预算连续及后续自动轮次后，才能确认实例接通；单元测试不能替代云端验收。

可选云端心跳与降级告警见 [告警示例](alerts/README.md)。

## 更新和回退

重新传入源码并运行 `sh install.sh`，保留配置、预算和本地日志。停止新增监控时执行：

```sh
systemctl disable --now one-minihouse-server-health.timer
systemctl stop one-minihouse-server-health.service
```

保留 `/var/lib/one-minihouse-server-health`。这不会停止 BLE、MQTT 或入库服务。

本地测试：`python -m unittest discover -s ops/server-health -p 'test_*.py' -v`。

云端计量参考：[计费模式](https://help.aliyun.com/zh/sls/pay-as-you-go)、[计费项](https://help.aliyun.com/zh/sls/billable-items)、[账单说明](https://help.aliyun.com/zh/sls/billing-overview)。
