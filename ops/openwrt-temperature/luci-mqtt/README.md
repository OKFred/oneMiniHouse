# LuCI collectd MQTT 配置插件

适配 OpenWrt 23.05 / collectd 5.12，在 **统计 → MQTT 上报** 增加中文配置页。仅补充 MQTT 输出配置，不覆盖 `stat-genconfig` 或其他官方 LuCI 文件。使用现有 `collectd-mod-mqtt`，没有额外驻留进程。

## 环境信息与凭据

IPK **不包含服务器地址、用户名、密码、客户端 ID、家庭主题或设备地址**。这些字段初始为空，通过 LuCI 配置；只有 TLS 端口 8883、QoS 1、系统 CA 路径等通用默认值。安装后上报关闭。

- 独立配置：`/etc/config/collectd_mqtt_ui`，权限 `0600`。
- 生成配置：`/etc/collectd/conf.d/90-mqtt-ui.conf`，权限 `0600`。
- 本插件只支持带 CA 验证的 TLS 发布，不能关闭证书校验。
- 账号和密码保存在路由器本机配置中，root 可读取；这不是加密保险库。
- 服务器按主机名填写，不带 `mqtts://`；密码由用户在 LuCI 填写。不要把环境配置复制进源码或重新打包。

## 构建与验证

不需要 OpenWrt SDK 或交叉编译：包内只有 LuCI JavaScript、JSON、UCI 配置和 shell，架构为 `all`。依赖由 `opkg` 正常检查，禁止 `--force-depends` / `--force-overwrite`。

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm build
docker build -t one-minihouse-luci-mqtt-test:23.05 -f test/Dockerfile .
docker run --rm --network none one-minihouse-luci-mqtt-test:23.05
```

产物在 `dist/`，同目录附 SHA256 和文件清单；产物不提交 Git。测试使用官方 OpenWrt 23.05.2 根文件系统及官方 collectd MQTT 包，配置解析不连接生产 broker。

隔离容器中的 `test/lifecycle.sh` 检查 opkg 安装、UCI 保存应用触发、无效配置保留原值、权限 0600、卸载及备份。测试子配置路径为 `/etc/collectd/conf.d/*.conf`。实际安装、备份位置、软件包校验值及发布结果保存在私有验收记录中。

## 安装行为

在 LuCI 的“系统 → 软件包 → 上传软件包”选择生成的 IPK，或者在路由器本地执行：

```sh
opkg install /tmp/luci-app-collectd-mqtt_0.1.0-1_all.ipk
```

安装前检查 OpenWrt 版本、现有 collectd Include 和重复 MQTT 配置；不满足条件即停止。先备份现有统计配置和生成器至 `/root/collectd-mqtt-ui-backups/`，再安装独立文件、注册开机生成配置及 UCI 重载触发器，并重载 rpcd 以加载该页面的 UCI 权限。初次安装不会重启 collectd 或开始发布，不修改路由、防火墙、统计间隔及已启用传感器。

启用或修改后“保存并应用”，先验证生成配置，通过后才替换本插件的配置并重启正在运行的 collectd；验证失败保留原 MQTT 配置，系统日志标记失败且不打印密码。

温度采集及 60 秒间隔仍在官方“统计 → 设置”管理。本插件会发布 **collectd 当前启用的全部指标**，并非只发布温度；MQTT 主题为 `前缀/主机名/插件实例/指标`。应先配置限定发布主题的账号授权。

MQTT 使用 collectd 5.12 自身的协议和原生载荷，不是 oneMiniHouse v2 JSON。入库端需要配置 collectd 格式适配；插件安装成功不等于双写已通过验收。collectd 没有本项目备选脚本的 SQLite/6 小时持久补报保证。

## 卸载与回滚

```sh
opkg remove luci-app-collectd-mqtt
```

卸载前将账号配置和生成片段备份到 root 专属目录，再关闭本插件的开机钩子、移除本插件的 MQTT 片段，并重启正在运行的 collectd 以停止发布。官方 LuCI、原采集插件、历史 RRD 数据保持原状。root 备份可能含密码，不要公开分享。

## 依据

- [LuCI 23.05 统计配置生成器](https://github.com/openwrt/luci/blob/openwrt-23.05/applications/luci-app-statistics/root/usr/libexec/stat-genconfig)
- [新版官方 MQTT 配置页](https://github.com/openwrt/luci/blob/master/applications/luci-app-statistics/htdocs/luci-static/resources/view/statistics/plugins/mqtt.js)
- [collectd 5.12 MQTT 参数](https://github.com/collectd/collectd/blob/collectd-5.12/src/collectd.conf.pod#plugin-mqtt)

此包独立实现；不直接复制新版配置生成器，避免跨版本覆盖及 `StoreRates` / `CleanSession` 映射错误。
