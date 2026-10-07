# 云端告警示例

在自己配置的 SLS 日志库上运行，独立于被监控服务器。SQL 使用合成标识 `example-host`；实际规则 ID、行动策略、云项目与 Webhook 保存在私有配置中，本目录不声明任何规则已经启用。

| 规则 | 条件 | 连续检查次数 |
|---|---|---|
| 主机心跳中断 | `fresh_count == 0`，见 [heartbeat.sql](heartbeat.sql) | 1 |
| 服务持续降级 | `latest_quality == "degraded"`，见 [degraded.sql](degraded.sql) | 2 |

示例每 5 分钟检查最近 15 分钟，不分组。查询同时按 `generate_time_utc` 过滤并允许 60 秒向前时钟误差；旧补报不能解除心跳中断，降级按生成时间取最新状态。心跳停止通常需 15–20 分钟发现，降级连续两次命中后触发。

可配置恢复通知及 1440 分钟重复等待。降级条件不再满足不等于主机整体恢复，仍需新鲜心跳且质量为 `ok`。SLS 查询失败应单独检查执行历史，不能据此断言服务器离线。

## 通知与验收

在自己的云端行动策略中选择通知渠道。Webhook 存在云端通知对象；本地副本只放忽略目录的 secret 文件，不进入源码、CI、截图或提交说明。查询结果不包含电量、原始报文或凭据。

启用后回读规则、执行历史和 SQL 结果，再验证通知渠道的接收结果。通道测试成功不能证明整条触发/恢复链路通过，也不能证明接收人已阅读。端到端演练使用隔离数据或已批准的维护窗口，不停用共享生产服务来制造故障。

修改阈值、通知对象或行动策略后再次核对实际生效状态。暂停通知时可关闭告警规则并保留健康日志；程序上传预算不能代替云账号总账控制。

参考：[告警规则](https://help.aliyun.com/zh/sls/create-an-alert-monitoring-rule-for-logs)、[通知渠道](https://help.aliyun.com/zh/sls/notification-methods)、[执行历史](https://help.aliyun.com/zh/sls/view-the-evaluation-results-of-alert-rules)。
