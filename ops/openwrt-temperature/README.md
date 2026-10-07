# OpenWrt 主动 MQTT 温度上报

路由器每 60 秒读取 CPU/GPU 温度并主动发布；ingestor 订阅后保存 SQLite/D1 原始层，分别投递本地 PostgreSQL 和 Supabase。设备温度在 Grafana 的单张汇总图展示；室温、湿度在环境页展示。路由器不需要接受采集器的 SSH 连接。

## collectd / LuCI

安装兼容版本的 luci-app-statistics、collectd-mod-thermal、collectd-mod-mqtt。若发行版没有 MQTT 表单，使用本目录 [luci-mqtt](luci-mqtt/README.md) 的独立 IPK，默认不上报，服务器及凭据不打包。

通过 LuCI 填写私有 broker、账号、TLS 和 topic；专用账号仅允许发布自己的主题。入库端 `collectdTemperatures` 配置精确 CPU/GPU 主题及指标名，参考 ingestor 配置模板。collectd 原文末尾 NUL 也保留在原始层和 SHA256 中，通道独立去重。read_time_utc 为读取时间，硬件未提供的 sample_time_utc 保持 NULL。

collectd 5.12 的 MQTT 在写入回调中推进网络循环。可使用 `91-temperature-publish.conf` 只发送 thermal 数据和每 20 秒的 uptime 保活事件，温度仍为每分钟；ingestor 不订阅 uptime。该文件需 collectd-mod-match-regex、collectd-mod-uptime；其他指标仍写 rrdtool。配置中的写入器名称必须与本机一致，添加其他输出插件时同步路由。

应用前备份实际配置，通过 `collectd -t` 检查再重启 collectd。回退只撤销本次新增过滤，不删除 RRD、凭据或现有配置。实际部署版本、验收和备份位置只保存在本地忽略目录。

`observe-collectd.mjs` 使用 ingestor 的 MQTT.js，只订阅不发布。连接由 MQTT_URL、MQTT_USERNAME、MQTT_PASSWORD_FILE、MQTT_TOPIC、MQTT_EVIDENCE_FILE、可选 MQTT_CAPTURE_SECONDS 提供；默认核验两个温度通道各至少 3 条非 retained 消息。凭据和捕获文件不得提交。

## LuCI 统计页 502 排查

部分旧 uHTTPd CGI 下载同时返回 Content-Length 和 Transfer-Encoding，Nginx 会拒绝响应。先检查实际日志，只有确认此错误才在对应代理的精确路径应用兼容项：

```nginx
location = /cgi-bin/cgi-download {
    proxy_http_version 1.0;
    proxy_set_header Connection "";
    proxy_set_header Upgrade "";
    include conf.d/include/proxy.conf;
}
```

保持其他路径的 WebSocket、TLS、权限和代理目标。由 NPM 正常保存，通过 nginx -t 后检查实际请求；不直接编辑自动生成文件。撤销时仅移除本次片段。

## 备选轻量采集器

`r4s-temperature.sh` 通过两个 procd 实例分离采集、发送。执行 install.sh 只安装程序，不启动、不写凭据。先将下面两个模板复制到私有目录并填写实际值，再放到设备的 `/etc/one-minihouse-temperature/`：

- identity.example → identity：三行依次为站点 ID、网关 ID、设备 ID，保留结尾换行。只允许字母、数字、下划线、连字符；不是 shell 脚本。
- mosquitto_pub.example → mosquitto_pub：实际 broker、发布账号和密码，文件 0600、目录 0700。

identity 不存在或非法时服务拒绝启动；topic 从身份文件生成，JSON 身份与其保持一致。修改身份前先停止服务并处理旧身份队列，避免不同站点共用积压目录。

每 60 秒读取稳定通道，重复、缺失或错误不生成零值。MQTT 5 / TLS / QoS 1，telemetry 不 retained。内存队列最多 360 条 / 6 小时，重启会丢失未发送数据；淘汰计数保留在同一临时目录。只在成功 PUBACK 后删除，重试保留 ID；该确认不代表双库已提交。

mosquitto_pub 2.0 对负 PUBACK 可能返回 0，脚本另外校验 ACK 及 stderr，不记录原始认证输出。该队列保证不适用于 collectd 原生插件。

```sh
docker run --rm --network none --user 0 \
  --mount type=bind,source="$PWD/ops/openwrt-temperature",target=/source,readonly \
  --entrypoint sh eclipse-mosquitto:2.0 /source/test.sh
```

隔离测试覆盖身份校验、错误传感器、真实 broker ACL 拒绝、重复投递和缓存上限，不替代现场验收。
