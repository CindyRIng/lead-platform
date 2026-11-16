# SKILL · lead-platform Agent 操作手册

> LeadPlatform：河北外贸线索聚合平台。Goal 驱动四源采集 → 探迹工商/联系人补全 → 海关画像 → 变更事件/Webhook/SSE。
> 本 SKILL 面向 Agent/自动化：优先 REST/MCP，其次 CLI。**不要直接读写 SQLite**。

## 0. 连接与鉴权

```bash
# 服务默认仅监听 loopback
BASE=http://127.0.0.1:8793
TOKEN=$(jq -r '.apiToken // .token' ~/.lead-platform/config.json 2>/dev/null || echo "$LEAD_API_TOKEN")

curl -s "$BASE/v1/health"                  # 免鉴权，毫秒探针
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/status"
```

- 除 `/v1/health`、`/docs`、`/openapi.json`、`/mcp-tools.json` 外均需 `Authorization: Bearer <LEAD_API_TOKEN>`。
- 统一 envelope：`{ ok, data, meta, error }`；分页列表在 `data.items`，游标在 `meta.nextCursor`。
- 错误：`error.code` ∈ `VALIDATION_ERROR(400)`、`UNAUTHORIZED(401)`、`NOT_FOUND(404)`、
  `CONFLICT/RUN_IN_PROGRESS/QUOTA_EXHAUSTED/SOURCE_SESSION_INVALID(409)`、`UNSUPPORTED(400)`、
  `UPSTREAM_RATE_LIMITED(429)`、`SOURCE_UNAVAILABLE(503)`、`INTERNAL_ERROR(500)`。
- CLI 安装：`npm run build && npm link`（或 `node dist/cli.js`）；`lead <cmd> --json` 输出与 REST `data` 一致。
- MCP：`node dist/mcp/server.js`（stdio）；工具名 `lead_*`，只代理 REST。

## 1. 先看运行态（每次任务开始必做）

```bash
lead status --json          # 或 GET /v1/status：db/queue/scheduler/upstream/quota/alerts
lead sources --json         # 上游登录态：boss/zhilian/ali/mic/tanji/fuma
lead quota --json           # 探迹额度：daily/monthly/enterpriseMonthly、settlementDay
```

判断要点：

| 现象 | 含义 / 动作 |
|---|---|
| `sources[].state=session_invalid` | 上游登录失效：该来源采集中会跳过，等待人工在 client 侧重新登录；不要重试轰击 |
| `quota.monthly.remaining` 很低 | 解锁会很快进入 `waiting_quota`；优先解锁 P0 招聘在招/P1 认证会员 |
| `queue.waiting_quota > 0` | 额度耗尽；恢复额度后自动续跑，无需手工重排 |
| `alerts` 非空 | 按提示处理；不要把告警当成断言失败 |

## 2. Goal：区域目标 CRUD 与手动触发

```bash
# 创建「河北省」四平台 Goal（默认关键词；cron 每日 02:00 Asia/Shanghai）
lead goal create \
  --name 河北省-外贸线索 --province 河北省 \
  --platforms boss,zhilian,ali,mic \
  --keywords-boss 外贸,外贸业务员,外贸经理,外贸单证员,国际贸易 \
  --max-leads 2000 --cron "0 2 * * *"

lead goal list --enabled --json
lead goal show <goalId> --json         # 含 resolvedCities（各平台实际检索值）
lead goal update <goalId> --disable --version 2
lead goal run <goalId> --wait          # 手动触发并轮询到终态
```

REST 等价：

```bash
curl -s -X POST "$BASE/v1/goals" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{
  "name":"河北省-外贸线索","region":{"province":"河北省"},
  "platforms":["boss","zhilian","ali","mic"],
  "keywords":{"boss":["外贸","外贸业务员"],"zhilian":["外贸"],"ali":["machinery"],"mic":[]},
  "schedule":{"cron":"0 2 * * *","timeZone":"Asia/Shanghai"},"priority":100,"enabled":true
}'
curl -s -X POST "$BASE/v1/goals/<goalId>/run" -H "Authorization: Bearer $TOKEN"
```

- 同一 Goal 已有运行中 Run → `409 RUN_IN_PROGRESS`；不要并发重复触发。
- 单轮最长 6h：超时后 run=`partial`，已入队任务继续跑（正常现象）。
- 归档 = 软删除（`DELETE /v1/goals/{id}`），历史 run/数据保留。

## 3. Run：跟踪进度与覆盖度

```bash
lead run list --goal <goalId> --json
lead run show <runId> --json     # data.status + data.progress(byPlatform/byCity/byKeyword) + data.stats
lead run cancel <runId>
```

`stats.platforms.<platform>`：`queries/pages/leads/companiesNew`；
`stats.coverage`：`uniqueCompanies/crossSourceOverlap/coverageByCity/keywordYield`（AC-17 口径）。
失败来源记录在 `skippedSources[]`（如 `SOURCE_SESSION_INVALID`），不阻塞其他来源。

## 4. 公司：检索、详情、平台卡片、海关画像

```bash
# 列表（游标分页；q 至少 2 字符）
lead company list --province 河北省 --platform boss --unlock-status unlocked --limit 20 --json
# 详情（include 可追加平台卡片/海关画像）
lead company show <companyId> --include platforms,customs --json
lead company sources <companyId> --json
lead company contacts <companyId> --unlocked-only --json     # 明文手机/邮箱：仅本机 Bearer
lead company platforms <companyId> --json                   # 4 平台卡片
lead company platform <companyId> boss --json               # 单平台完整档案
lead company jobs <companyId> boss --status active --json   # 岗位 active/closed 历史
lead company customs <companyId> --json                     # 仅 Ali/Mic，否则 404
```

- 公司详情结构：`{ company, sources[], contacts{total,unlocked,items[]}, recentChanges[] }`
  （`include=platforms` → `platforms[]`；`include=customs` → `customs`）。
- `company.platformStatus`：`active`(≤8d) / `stale`(9–45d) / `lost`(>45d)；`lastFetchedAt`/`next*RefreshAt` 表示「最新」口径。
- `enrichmentStatus`：`discovered → source_detailed → tanji_matched → tanji_enriched | unmatched | failed`。
- `customs.confidence`：high/medium/low/none；榜单基于样本（`sampled=true`），`totalNum` 是上游模糊命中总数，**不是精确提单量**。

## 5. 变更与事件（增量同步标准姿势）

```bash
# 全局增量：持久化 nextSeq；下次带 sinceSeq 续拉（不漏不重）
lead changes --since-seq 0 --types company.created,company.updated --limit 100 --json
# 单公司字段级历史（含平台字段路径 platforms.<platform>.<field>）
lead company changes <companyId> --since-version 0 --json
# 实时流（SSE；Ctrl-C 退出；也可用 curl -N）
lead events tail --types company.created,contact.unlocked --since-seq 12345
curl -N -H "Authorization: Bearer $TOKEN" "$BASE/v1/events/stream?types=company.created" \
     -H "Last-Event-ID: 12345"
```

Agent 增量同步推荐流程：

1. `GET /v1/changes?sinceSeq=<cursor>&limit=200` → 处理 `data.items`，保存 `data.nextSeq`；
2. 对 `type=company.*` / `contact.unlocked`：`GET /v1/companies/{companyId}` 取最新主档；
3. Webhook 下游：订阅 `POST /v1/webhooks`，校验头 `X-Lead-Event/X-Lead-Delivery/X-Lead-Timestamp/X-Lead-Signature`，
   签名 = `HMAC-SHA256(secret, timestamp + "." + body)`（以事件模块实现为准，`sha256=<hex>`）；
4. 失败投递自动指数退避重试，`GET /v1/webhooks/{id}/deliveries?status=dead` 查死信，`POST .../replay` 重放。

## 6. 手工干预（会写数据/消耗额度，谨慎）

```bash
lead company rematch <companyId> --force     # 重新匹配探迹主体（异步 job）
lead company refresh <companyId> --platforms boss,ali --kinds profile,jobs
lead company customs-refresh <companyId>
lead company unlock <companyId> --idempotency-key "<companyId>:2026-11-16"  # 消耗 1 点额度
lead job list --status dead --json           # 死信排查
lead job retry <jobId>
```

- `unlock` 是唯一会消耗探迹额度的操作（1 家 = 1 点，业务幂等）；不要批量盲调。
- `rematch/refresh/customs-refresh` 只入队异步 job，返回 `jobId`，用 `lead job list --stage ...` 跟踪。

## 7. 管理与运维

```bash
lead admin backup                                  # SQLite 在线备份 → dataDir/backups/
lead admin archive --after-days 90                 # 原始快照冷归档（brotli+manifest；只归档不删除）
lead admin manifests --json
lead admin verify --month 2026-08                  # 校验归档 sha256
lead admin restore --month 2026-08                 # 恢复元数据/文件到 hot 库（幂等）
lead admin db-stats --json
lead stats --kind coverage --json                  # 覆盖度指标（AC-17）
```

## 8. MCP 工具（推荐 Agent 直接用）

MCP 配置示例（客户端 `mcpServers`）：

```json
{ "mcpServers": { "lead-platform": { "command": "node", "args": ["/home/songqian/lead-platform/dist/mcp/server.js"] } } }
```

| 场景 | 工具 |
|---|---|
| 运行态 | `lead_status` / `lead_sources` / `lead_quota` |
| Goal | `lead_goals_list` / `lead_goal_get` / `lead_goal_create` / `lead_goal_update` / `lead_goal_run` |
| Run | `lead_runs_list` / `lead_run_get` / `lead_run_cancel` |
| 线索检索 | `lead_companies_list` / `lead_company_get` / `lead_company_sources` |
| 联系人/变更 | `lead_company_contacts` / `lead_company_changes` / `lead_changes` |
| 平台/岗位 | `lead_company_platforms` / `lead_company_platform` / `lead_company_jobs` |
| 海关 | `lead_company_customs` / `lead_company_customs_refresh` |
| 手工干预 | `lead_company_rematch` / `lead_company_unlock` / `lead_company_refresh` |
| 事件 | `lead_events_tail`（SSE 截断窗口，默认 5s/50 条） |
| 队列/Webhook/统计 | `lead_jobs_list` / `lead_job_retry` / `lead_webhooks_list` / `lead_webhook_deliveries` / `lead_stats` |

MCP 服务未启动时工具返回 `SERVICE_UNAVAILABLE`；此时先 `lead status` 检查服务。

## 9. 自包含文档与契约

- `GET /docs`：自包含 HTML（Try it，无外部 CDN；Token 存浏览器 localStorage）。
- `GET /openapi.json`：OpenAPI 3.1（可导入 Postman/Apifox/Swagger UI）。
- `GET /mcp-tools.json`：MCP 工具清单。
- `spec/`：上述契约的生成物；`npm run gen` 重新生成，`npm run gen:check` 校验漂移（CI 用）。

## 10. 安全与合规红线

- 仅本机 loopback + Bearer；不要把 Token 写进日志/仓库/事件。
- 联系人明文只通过 Bearer REST/CLI 获取；不要外传或写入公开渠道。
- 原始快照/变更事件永久保留（仅冷归档，不删除）；不要执行破坏性 DDL。
- 不真实调用上游 `unlock`（除用户明确授权；1 点/家）。
- 测试/演示使用合成数据（如「河北测试机械有限公司 / Test Hebei Machinery Co., Ltd.」）。
