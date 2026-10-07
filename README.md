# oneMiniHouse

家庭 IoT 数据采集与展示：蓝牙 / Modbus → MQTT → 分层存储 → Grafana。

[架构图与采集时序图（Mermaid，高对比度）](docs/architecture.md)

| 目录 | 职责 | 入口 |
|---|---|---|
| `gateway/` | Node.js 24 网关，蓝牙插座、Modbus 电表和光照采集，SQLite 断网队列 | [网关说明](gateway/README.md) |
| `ingestor/` | MQTT 接收、本地 SQLite 原始层、本地 PostgreSQL 与 Supabase 独立投递 | [入库说明](ingestor/README.md) |
| `ingestor/cloud/` | Cloudflare Worker 与 D1 原始数据副本 | [云端说明](ingestor/CLOUD.md) |
| `ops/` | 部署、诊断、服务器健康日志与 Grafana 维护 | [运维入口](ops/README.md) |
| `ops/linux-temperature/` | Linux 本机读取温度，systemd + MQTT 主动上报，SQLite 缓存 | [主机上报](ops/linux-temperature/README.md) |
| `src/`、根目录 `package.json` | 原有 uni-app 小程序；与采集服务分开维护 | 现有 `dev:*` / `build:*` 命令 |

电表、插座、环境传感器和主机温度使用统一采集与入库链路。真实设备对应关系、
连接信息和部署记录应保存在本地忽略目录，新整理的采集配置和看板模板使用示例标识。

## 本地检查

采集服务使用 **Node.js 24、pnpm 11.5.0**；各组件分别维护锁文件。原有 uni-app 继续单独维护，安装和限制见[小程序说明](src/README.md)。

```powershell
pnpm --dir gateway install --frozen-lockfile --ignore-scripts --no-optional
pnpm --dir ingestor install --frozen-lockfile --ignore-scripts
pnpm --dir ingestor/cloud install --frozen-lockfile --ignore-scripts
pwsh -File ops/check.ps1 -Postgres
```

`ops/check.ps1` 执行三个项目的类型检查和单元测试、Python 语法检查、服务器健康
日志和本机温度服务测试。`-Postgres` 使用本机 Docker 创建无网络、无端口的临时 PostgreSQL，验证视图权限、重复迁移和数据质量；CI 必跑。检查不连接真实设备、MQTT、生产数据库或云端，也不部署。Linux 蓝牙和实时双写
需要另行现场验收；单元测试通过不代表现场连接正常。

## 配置与提交范围

- 从各组件 `config/*.example.json` 复制成本地配置；密码通过 `secrets/` 文件注入。
- HAR、第三方小程序包与调试工具、本地配置、凭据、SQLite 数据、验收证据、构建包和
  Python 缓存不提交。Git 忽略规则只排除提交，保留本地文件。
- 通用 SQL 迁移、配置模板、pnpm 锁文件、源码、测试和脱敏 Grafana 模板可提交。
- Grafana 模板为 `ops/grafana/home-overview.example.json`（完整总览）和
  `ops/grafana/home-electricity.example.json`（仅用电）。真实导出放在 `.local/` 或
  `evidence/`，修改线上看板时必须重新导出最新基线，不能用模板覆盖现有面板。
- 真实 IP、MAC、设备 ID、账号、云项目标识和分享 URL 不写入模板、测试或公共文档。
  密码和运行配置仍留在本地；提交前检查暂存区，`.gitignore` 不会排除已跟踪文件。

打包部署源码：`pwsh -File ops/package.ps1`。脚本从 Git 候选文件生成逐文件清单并扫描，输出到忽略的
`ingestor/evidence/release/`，并检查包内没有运行数据或凭据。运行配置和密码单独部署。

## 许可与公开源码

自有源码使用 [MIT](LICENSE)；嵌入组件和素材的来源、原许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。构建依赖仍各自适用其原许可证。

公开前使用[源码导出流程](docs/public-source.md)。它只导出审查后的当前文件，要求加载本地私有标识规则并扫描最终副本，不携带 `.git`、运行配置或数据。不要把包含旧部署记录的原 Git 历史直接改为公开。
