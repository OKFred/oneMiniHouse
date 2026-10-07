# 原始数据云归档

本目录的 `cloud/` 是独立 pnpm Worker 项目。业务原文在本地 SQLite 持久化后，使用专用 bearer secret 向 HTTPS `/v1/raw/batch` 上报；采集服务不持有 Cloudflare 管理 API Token。

公开的 `wrangler.jsonc` 仅含合成站点和全零 D1 ID，用于类型生成、本地测试和构建。真实资源保存在已忽略的 `wrangler.local.jsonc`；正式部署脚本强制使用该文件。可使用部署返回的 workers.dev 地址。启用云副本前，按采集频率、消息体积、180 天原始保留期及清理写入量核对自己的套餐额度。

## D1 部署和验收

在 `ingestor/cloud` 运行 `pnpm install --frozen-lockfile`、`pnpm check`、`pnpm test`、`pnpm build`。部署身份使用自己的 Wrangler 登录。复制 `wrangler.jsonc` 为 `wrangler.local.jsonc`，设置自己的 Worker 名称、站点及 `RAW_DB`；指向专用归档数据库，勿复用无关业务库。

```sh
pnpm exec wrangler d1 migrations apply RAW_DB --remote --config wrangler.local.jsonc
pnpm exec wrangler secret bulk ./secrets/worker-secrets.json --config wrangler.local.jsonc
pnpm deploy
```

未提交的 `worker-secrets.json` 格式为 `{"ARCHIVE_TOKEN":"至少32字符的随机密钥"}`，密钥不能放命令参数、源码或日志。将同一个值保存为 ingestor 独立 secret 文件，配置 `archive.rawMirror.url` 为部署地址加 `/v1/raw/batch`，`tokenFile` 为容器内 secret 路径。服务每批最多 32 条、每条原文最多 64 KiB，请求最多 1 MiB，客户端按实际 JSON 字节数自动拆包；原文 SHA-256 经服务端复算，ID 重复且原文/来源不同则整批返回 409。只有 D1 事务成功后才返回对应 ID 和 hash，本地随后完成该目标的 delivery job。

日清理在 UTC 19:17（北京时间次日 03:17）执行，按本地原始记录 `expire_time_utc` 删除，最多 60,000 条/次；180 天从首次本地保存开始计算，历史来源时间不会导致刚导入的数据立即过期。D1 保存时间另记 `mirror_store_time_utc`。本地仍有处理或投递任务时继续暂存，D1 不承担处理任务锁；归档重试不会延长首次存储时间。协议帧通过单独 SLS 通道，Worker 明确拒绝 `/frames`。

上线时检查真实一条业务消息：SQLite 原文 hash、Worker ACK、D1 行的 ID/hash 一致；检查无认证请求返回 401、冲突请求 409、重复请求无新增行。远端 400/409 不代表丢弃成功，保留本地失败任务并排查。

## 协议帧 SLS

这里说明可选协议帧投递能力。可选 SLS 健康通道用于[服务器健康日志](../ops/server-health/README.md)；未采用的 `protocol-frames` 策略草案已清理，服务器健康日志的独立权限策略继续保留。

`archive.frames` 配置 `endpoint`（例如 `cn-hangzhou.log.aliyuncs.com`，不带 scheme）、`project`、`logstore`、`accessKeyIdFile`、`accessKeySecretFile`，可选 `securityTokenFile` 和 `timeoutMs`。按官方 PutLogs HTTP API，使用 protobuf + gzip + HMAC-SHA1 签名、强制 HTTPS、校验 HTTP 200 后才完成投递；旧 Node SDK 会隐藏 HTTP 状态，因此这里直接发送文档规定的请求。专用 RAM 身份仅允许目标 Logstore 的 `log:PostLogStoreLogs`；不要给采集容器创建、删除日志库的权限。

由管理身份预先创建 Logstore，设置 `ttl=30`、关闭匿名 WebTracking。帧 ID、采集轮次 ID、原文/hash 和毫秒 UTC 时间分别作为日志字段，原始帧时间在 `frame_time_utc` 中；SLS 日志主时间使用投递时间，以便断网后的旧帧仍能被接收。SLS 不提供本实现所依赖的幂等插入，因此网络不确定时允许重复，查询按 `frame_id` 去重。没有 SLS 凭据时不要填占位配置：本地协议帧保留 30 天，之后启用 sink 会为仍在保留期内的帧补建任务。

## 历史电表数据

历史导入要求明确来源身份和安装基准。转换与重放语义见[入库说明](README.md#历史电表数据)；公开模板不附带个人历史数据或迁移结果。

Supabase 默认按滚动 30 天策略保留加工数据，本地 PostgreSQL 保留完整加工历史；不再以全量旧历史双 PG 行数相同为目标。D1 原始副本是否实际接收取决于启用配置和逐条投递确认，不能从本地历史迁移完成推定云端全量回填完成。

参考：[D1 事务批量 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[SLS Protobuf 编码](https://www.alibabacloud.com/help/en/sls/developer-reference/data-encoding)、[SLS 请求签名](https://www.alibabacloud.com/help/en/sls/developer-reference/request-signatures)。

## 独立在线验收脚本

`node scripts/verify-cloud-live.ts` 必须显式提供 `MQTT_URL`、`MQTT_USERNAME`、`MQTT_TOPIC_PREFIX`、`RAW_ARCHIVE_URL`；密码和 token 仍从 secret 文件读取。它会向目标归档服务写入一条真实业务样本并测试去重、拒绝冲突和无认证访问，不能把它当无副作用单元测试运行。
