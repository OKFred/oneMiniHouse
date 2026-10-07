# 公开源码导出

公开源码与私人运行配置分开管理。当前文件脱敏不会抹掉旧 Git 提交中的部署信息；原仓库应继续私有，公开仓库使用不携带旧历史的新快照。导出脚本不创建仓库、不提交、不推送，也不操作运行服务。

## 先检查

需要 Python 3.10+、Git、Node.js 24、pnpm 11.5 和 PowerShell 7。完整 PostgreSQL 回归需要本机 Docker；脚本拒绝远程 Docker endpoint。

```powershell
python -X utf8 ops/public_source.py scan
pwsh -NoProfile -File ops/check.ps1 -Postgres
```

通用扫描检查 Git 候选文件，包括已跟踪文件和未忽略的新文件。它会阻止私有目录、运行数据、私钥、部分令牌格式、私人网段和非示例小程序标识。空的 secrets/.gitkeep 可保留，运行凭据不会导出。配置、旧模板、图片和第三方素材仍需人工复核；零命中不等于安全审计保证。

## 私有规则与导出

在已忽略的 `.local/public-export/private-rules.json` 中列出当前部署特有的域名、MAC、设备 ID、账号名、项目 ID 等。不要提交这个文件，也不要把真实值写进公开的测试或规则文件。

```json
{"literals":["your-private-site-marker","your-private-host-marker"]}
```

文件不存在、格式错误、规则为空或扫描命中时，公开导出失败。示例值不能代替实际私有清单；仅运行通用扫描不足以导出。扫描同时检查路径和文件内容，报告只显示规则序号与位置。

```powershell
python -X utf8 ops/public_source.py scan --private-rules .local/public-export/private-rules.json
pwsh -NoProfile -File ops/export-public.ps1 `
  -PrivateRules .local/public-export/private-rules.json `
  -OutputDirectory .local/public-source-candidate
```

目标目录必须不存在，旧导出不会被覆盖。成功目录包含 `EXPORT-MANIFEST.json`（逐文件 SHA-256），没有 `.git`。检查源码和素材后，在这个独立目录初始化新 Git 仓库、形成首个提交；原仓库历史、远端和本地原件不变。后续公开更新也从审核后的文件同步，不能把私人仓库的分支或提交合并过去。

原工作树中已删除的私有文件可能仍存在于 Git 索引或 HEAD。提交前必须检查暂存区删除是否完整；`.gitignore` 不能移除已跟踪内容。本轮保留的原件和部署记录位于本地忽略目录，不属于公开产物。

## 部署源码包

```powershell
pwsh -NoProfile -File ops/package.ps1 -PrivateRules .local/public-export/private-rules.json
```

gateway/ingestor 源码包包含各自所有公开配置示例、测试及根许可证。文件先冻结为同一份字节，经扫描再打包，并校验归档内容；不会递归夹带忽略的运行配置、凭据、队列或 evidence。输出默认在 `ingestor/evidence/release/`。包内单元测试可独立运行；需要相邻 ops/grafana 示例的 PostgreSQL 测试在完整源码树中执行。

实际部署时另行提供自己的配置和 secret。Worker 正式部署使用已忽略的 `wrangler.local.jsonc`；公开 `wrangler.jsonc` 的全零 D1 ID 只供本地检查。Grafana 的 `.example.sql` 和 JSON 都是合成模板，不是当前线上资源的备份。
