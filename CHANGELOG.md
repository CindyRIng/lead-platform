# Changelog

本文件记录 LeadPlatform 的所有重要变更。

本项目遵循 [Keep a Changelog 1.1.0](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本 2.0.0](https://semver.org/lang/zh-CN/)。版本号格式为 `MAJOR.MINOR.PATCH`：不兼容的对外契约变更升 `MAJOR`，向后兼容的功能新增升 `MINOR`，向后兼容的修复升 `PATCH`。`/v1` REST 契约在 0.x 阶段按「冻结、只增不改」维护；确需破坏性调整时在大版本中说明迁移方式。

变更类型：

- **Added**：新增功能。
- **Changed**：既有行为的调整。
- **Deprecated**：即将移除、仅保留兼容期的能力。
- **Removed**：已移除的能力。
- **Fixed**：缺陷修复。
- **Security**：安全与隐私相关修复或加固。

> 说明：仓库当前尚未配置公开远程与版本对比链接；发布仓库确定后，可在文末补充 `[Unreleased]` / `[0.1.0]` 的 compare 链接。

## [Unreleased]

### Added

- （占位）下一版本新增功能将记录于此。

### Changed

- （占位）行为调整将记录于此。

### Fixed

- （占位）缺陷修复将记录于此。

### Security

- （占位）安全修复将记录于此。

## [0.1.0] - 2026-11-16

首个可运行版本。以下条目按「设计并实现（以最终代码为准）」口径记录 0.1.0 的交付范围；具体行为以最终代码、测试与验收记录为准。

### Added

#### Goal、Run 与调度

- 设计并实现 Goal 管理（创建、查询、更新、启用/停用）：区域（省 → 地级市）、平台集合、分平台关键词、单轮线索上限、定时表达式、优先级、解锁策略等字段；对应 REST 与 CLI（`lead goal ...`）。
- 设计并实现 Run 生命周期：`pending → running → completed | partial | failed | cancelled`，支持 cron 与手动触发；同一 Goal 已有运行中 Run 时拒绝重复触发（`RUN_IN_PROGRESS`）。
- 设计并实现进程内 cron 调度（默认 `0 2 * * *`、`Asia/Shanghai`、30s tick），单轮最长 `LEAD_RUN_MAX_HOURS=6`；超时停止派发新查询并以 `partial` 收尾，已入队补全任务继续执行。
- 设计并实现 Run 统计：按平台、城市、关键词记录查询数、页面数、线索数与新增公司数，并汇总补全、解锁与覆盖度指标，供 `GET /v1/runs/{id}` 与 `/v1/stats` 查询。
- 设计并实现手动干预：Run 取消、公司 rematch、单公司 refresh、手动 unlock；与自动流程共用状态机与事件记录。

#### 四源采集适配

- 设计并实现 Boss 直聘、智联招聘、阿里巴巴国际站、中国制造网四个本机 REST client 的 adapter，统一请求、超时、错误归一与响应快照。
- 设计并实现按来源令牌桶与串行调度：Boss 12 req/min、智联 15 req/min、Ali 10s/页（详情并发 2）、Mic 默认约 1 req/2s；页面级延迟与 429/风控冷却，避免并发轰炸上游。
- 设计并实现来源健康检查与降级：登录态失效（`session_invalid`）、验证码/风控（`verification_pending`）、不可达（`unavailable`）时跳过该来源并记录原因，Run 继续其他来源。
- 设计并实现采集与补全解耦：采集结束不等于补全结束，补全/解锁/刷新仍在后台继续，`/v1/status` 可观察队列积压。
- 设计并实现来源记录级去重入口：以 `(platform, platform_company_id)` 唯一，多平台命中归并为 1 条公司主档 + 多条来源证据。

#### 区域注册表与平台映射

- 设计并实现内置区域基线 `src/data/regions.ts`：GB/T 2260 省级 + 地级市，覆盖河北省 11 个地级市；上游字典不可用时作为回退。
- 设计并实现 `regions` / `region_platform_map` 注册表与启动/每日同步：Boss、智联、Ali、Mic 各平台城市与区域编码映射到统一区域键。
- 设计并实现 Goal 的「省 → 地级市」展开与四平台查询组合；河北映射样例与字段口径见 [04-上游对接与区域映射](docs/04-上游对接与区域映射.md)。
- 设计并实现 Ali 英文地理种子（省/市/县英文名）用于国际站检索；区县不进入 `regions` 表，仅作检索种子。

#### 原始快照与变更日志

- 设计并实现原始快照分层：`raw_blobs` 按内容哈希去重存储字节，`raw_snapshots` 追加每次响应元数据（kind、URL、状态码、时间、关联公司/任务）。
- 设计并实现 brotli 压缩（默认，实测约 10x）、gzip/plain 兼容读取，以及 `sha256:<hex>` 内容哈希去重；解析失败也保留原始 payload，便于回溯与重放。
- 设计并实现历史数据永久保留策略：原始快照、变更事件、岗位、店铺、海关画像不按龄删除；超过 `LEAD_ARCHIVE_AFTER_DAYS=90` 转冷归档（brotli 文件 + manifest，可恢复）。
- 设计并实现字段级变更日志 `change_events`：公司字段 diff、全局递增 `seq`、公司 `version`、`source/runId` 留痕；无变化不产生事件。
- 设计并实现 `GET /v1/changes?sinceSeq=` 增量查询与单公司变更历史，支持按 `seq` 去重与断点续拉。

#### 探迹匹配、工商补全与去重合并

- 设计并实现探迹匹配：优先 USCC 精确匹配；无 USCC 时按归一化名称、省市、相似度与探迹相关度打分（默认阈值 0.55），保存最多 5 个候选与 `confidence`。
- 设计并实现工商补全：匹配成功后拉取探迹公司详情，写入统一社会信用代码、法人、注册资本、成立时间、经营状态、行业、规模、地址、经营范围等主档字段。
- 设计并实现匹配失败处理：`unmatched` 不消耗额度，下一轮 Run 以平台详情中的注册名/英文抬头重试；保留候选供人工核对与 rematch。
- 设计并实现去重合并：USCC 命中、规范化名称 + 同省市、探迹主体命中三级规则；被合并公司软删除并写 `company.merged`，来源与事件改指存活主体。
- 设计并实现人工 rematch：清空匹配信息后重跑匹配/补全，字段变化进入变更日志并产生 `company.rematched` 事件。

#### 额度感知解锁队列与台账

- 设计并实现 `pipeline_jobs(stage=unlock)` 单通道队列：一家公司唯一解锁任务，按优先级（P0 招聘在招 → P1 平台付费/认证会员 → P2 有海关记录 → P3 其余）而非全库 FIFO 消费额度。
- 设计并实现额度感知：执行前读取最近额度观测；日/月余额为 0 时任务置 `waiting_quota`、不计失败次数；Quota Poller 每 `LEAD_QUOTA_POLL_SEC=600` 秒刷新，恢复后按顺序续跑。
- 设计并实现解锁台账 `unlock_ledger`：记录公司、探迹主体、`quota_before/after`、幂等键与结果；`alreadyUnlocked` 按 0 点记账，避免重复扣点。
- 设计并实现幂等解锁：REST 使用 `idempotencyKey`（默认 `<companyId>:<yyyy-mm-dd>`），内部调用透传幂等键，进程崩溃/租约过期后重领不重复扣额度。
- 设计并实现联系人入库：解锁成功后拉取联系人并写 `company_contacts`，公司 `unlock_status=unlocked`，产生 `contact.unlocked` 摘要事件；明文仅经 Bearer API 返回。
- 设计并实现额度可配置项：`LEAD_UNLOCK_DAILY_CAP` 默认空（不限，遵循一期决策），预留每日上限；`GET /v1/quota` 展示余额与近期消耗。

#### 平台档案与岗位刷新

- 设计并实现 `company_platform_profiles`（每公司 × 每平台最新档案）与 `company_platform_jobs`（Boss/智联岗位）：店铺等级/认证/主营、在招岗位数、岗位明细与生命周期。
- 设计并实现新公司即时抓全四平台档案（Boss/智联同时抓岗位），以及存量刷新：招聘每 `LEAD_JOB_REFRESH_DAYS=7` 天、店铺每 `LEAD_STORE_REFRESH_DAYS=30` 天。
- 设计并实现 Refresh Worker 全天涓流：与采集共享按来源限频，优先级为新公司 > 到期刷新 > 手动 refresh（可插队）；`/v1/status.refresh` 暴露 due/running/nextDueAt。
- 设计并实现平台状态判定：`active`（≤8 天）、`stale`（9–45 天）、`lost`（>45 天或连续下架），阈值由 `LEAD_PLATFORM_ACTIVE_DAYS` / `LEAD_PLATFORM_LOST_DAYS` 控制。
- 设计并实现岗位生命周期：新岗位记录 `first_seen_at`，消失岗位置 `closed` 与 `closed_at`，重新上线可恢复；岗位变化按公司聚合成一条事件，避免事件风暴。
- 设计并实现平台档案 diff 与事件：字段路径 `platforms.<platform>.<field>`，聚合事件 `platform.profile.updated` / `platform.jobs.updated` 并入公司变更日志。

#### fuma 海关画像

- 设计并实现 Ali/Mic 英文抬头 → fuma-platform `POST /v1/customs/query` 的海关补全（`companyFlag=1/2`、`pageSize=20`、账号串行），不消耗探迹额度。
- 设计并实现名称 token 过滤、出口/进口角色分类与样本聚合：totals、dateRange、topDestinations、topHs4、topProducts、topBuyers，全部标注 `sampled=true`。
- 设计并实现 `company_customs_profiles` 与 `customs.*` 变更、`customs.updated` 事件；`confidence` 为 low/none 时保留数据但不对外推送。
- 设计并实现刷新与失败语义：新公司即时查询、存量每 `LEAD_CUSTOMS_REFRESH_DAYS=30` 天刷新、手动 refresh；`totalNum=0` 视为 `no_data` 不重试，权限/上游错误退避后跳过且不影响主流程。
- 设计并实现海关只读边界：不回写 fuma、不占客保、不落盘联系人 PII；一期仅 Ali/Mic，Boss/智联不启用。

#### 变更事件、Webhook 与 SSE

- 设计并实现统一事件 envelope（`eventId`、`seq`、`type`、`occurredAt`、`companyId`、`version`、`source`、`runId`、`data`）与 8 类事件：公司创建/更新、联系人解锁、合并、rematch、平台档案/岗位更新、海关更新。
- 设计并实现 Webhook 订阅与投递：`X-Lead-Event`、`X-Lead-Delivery`、`X-Lead-Timestamp`、`X-Lead-Signature: sha256=<hex>`，签名 = `HMAC-SHA256(secret, timestamp + "." + rawBody)`。
- 设计并实现失败重试与死信：指数退避 10s/1m/5m/30m/2h/6h/24h（最多 `LEAD_WEBHOOK_MAX_ATTEMPTS=8` 次），超过后 `dead`；支持投递记录查询与 replay。
- 设计并实现 SSE `GET /v1/events/stream`：按类型过滤、`Last-Event-ID`（= seq）断线续传并从 DB 补发；Webhook 只推聚合摘要，不推联系人明文。

#### REST、CLI、MCP 与 OpenAPI

- 设计并实现 Fastify REST 服务（`127.0.0.1:8793`）：统一 envelope（`ok/data/meta/error`、`schemaVersion=1.0`、`requestId`）、统一错误码、游标/偏移分页与 `idempotencyKey`。
- 设计并实现 Goals、Runs、Companies、平台档案、岗位、海关、Changes、Events、Webhooks、Jobs、Status、Quota、Sources、Stats 等 `/v1` 路由，以及无需鉴权的 `/v1/health`。
- 设计并实现 `lead` CLI（commander）：`status/quota/sources/goal/run/company/changes/events/webhook/job/admin`，全部支持 `--json` 与 `--base-url`，Token 从环境/配置读取。
- 设计并实现 MCP server：`lead_status`、`lead_quota`、`lead_sources`、`lead_goals_*`、`lead_runs_*`、`lead_companies_*`、`lead_company_platforms/jobs/customs/refresh`、`lead_changes`、`lead_events_tail`、`lead_jobs_*`、`lead_webhooks_list` 等工具，代理 REST。
- 设计并实现契约同源生成：zod schema → `/openapi.json`（OpenAPI 3.1）、`/docs`（自包含 HTML，不依赖外部 CDN）、`/mcp-tools.json` 与 CLI 帮助；`npm run gen:check` 防漂移。
- 设计并实现 `.env.example` 配置项与启动校验：端口、DB、时区、限频、刷新周期、归档路径、上游 Token。

#### 运维、备份与归档

- 设计并实现 `lead admin backup`：SQLite 一致性备份到数据目录 `backups/`（权限 0600），备份文件不进入 git。
- 设计并实现冷归档：超过 90 天的快照按月归档为 brotli 文件 + manifest，归档可查询/恢复，不删除历史数据。
- 设计并实现 `systemd/lead-platform.service`（user service、开机自启、`Restart=on-failure`、`TimeoutStopSec=40`）与 `scripts/deploy.sh`（构建、安装 unit、CLI 软链、健康检查）。
- 设计并实现优雅关闭：SIGTERM 停止领取新任务、等待在飞请求（≤30s）、释放租约后退出；崩溃后按租约恢复未完成任务。
- 设计并实现结构化 JSON 日志与 `/v1/status` 运行态：DB/WAL、调度、队列、刷新、上游、额度与告警摘要。

#### 测试与 mock 上游

- 设计并实现 vitest 测试基础（单 fork、30s 超时）与分层策略：领域纯函数单测、Fastify 集成测、mock 上游端到端。
- 设计并实现 mock 上游：模拟 Boss/智联/Ali/Mic/tanji/fuma 的成功、限频、登录失效、额度耗尽、权限拒绝与空数据响应，测试不依赖真实上游。
- 设计并实现合成 fixtures：公司名、联系人、岗位、提单、Token 均为虚构样例；禁止真实 PII 与真实凭据进入仓库。
- 设计并实现 `npm run accept` 本地验收脚本（以最终代码为准），覆盖采集 → 补全 → 档案/岗位 → 海关 → 解锁 → 事件主链路。
- CI 执行 `npm ci → npm run typecheck → npm run build → npm test → npm run gen:check`（[.github/workflows/ci.yml](.github/workflows/ci.yml)）。

#### 文档体系与视觉资产

- 建立中文文档体系 `docs/00`–`docs/19`：需求访谈、需求规格、架构与数据模型、接口草案、上游对接、部署运维、实施计划、平台档案、海关补全、验证报告、确认清单、覆盖度分析、数据口径等；索引见 [docs/README.md](docs/README.md)。
- 建立文档约定：标题编号、状态/关联元信息、Mermaid 图源与 PNG 资产、示例数据合成、验收标准编号（AC-1..AC-18）。
- 提供架构草图 [docs/assets/lead-platform-sketch.png](docs/assets/lead-platform-sketch.png)，并在 README 中引用。
- 覆盖基线文档化：河北四源实测约 9,586 家唯一公司（Mic 5,008 / Ali 2,961 / Boss+智联 2,375；Ali∩Mic 459；招聘↔英文源约 299；区间 9,352–9,821），纳入 Run 覆盖度指标与 AC-18 验收（≥8,500，偏差 ≤15%）。

### Changed

- 以 2026-11-16 河北四源实测校准覆盖、容量与额度规划：全量解锁约需 6.4 个月（月额度 1,500），解锁策略由「全库 FIFO」调整为优先级 P0–P3。
- Ali 采集策略调整为「按省检索为主、关键词本地过滤/补充」；单查询默认 5 页、硬上限 20 页，连续扩展增量递减。
- Ali/Mic 的英文抬头同时用于探迹英文名匹配与 fuma 海关查询；解锁前先检查已解锁联系人，减少无效额度消耗。
- 历史数据保留策略由「按龄清理」调整为「永久保留 + brotli 压缩 + 哈希去重 + 90 天冷归档」；归一化岗位与平台档案永久保留。
- 平台刷新由「全量每日」调整为「招聘每周 / 店铺每月 + 全天涓流」，与 02:00 采集窗口解耦。
- 海关补全范围收敛为一期仅 Ali/Mic；Boss/智联因中文名 → 英文提单名映射噪声暂不启用。
- 文档版本由设计稿校准为 v0.4（数据校准版），实现以 [docs/01-需求规格.md](docs/01-需求规格.md)–[docs/08-海关数据补全.md](docs/08-海关数据补全.md) 的设计契约为准（冻结状态见各文档）。

### Fixed

- 首个版本，无历史修复。
- 实现期如发现缺陷，修复将记录在下一版本的 `Fixed`；发布前发现的阻塞问题在 `[Unreleased]` 中逐条登记。

### Security

- 服务仅监听 `127.0.0.1`，不启用 CORS；除 `/v1/health`、`/docs`、`/openapi.json` 外全部要求 Bearer Token，比较使用常量时间算法。
- `LEAD_API_TOKEN` 等敏感配置存放于权限 0600 的 `.env`；webhook secret 存于受 0700 数据目录保护的数据库；`.env` 被 `.gitignore` 排除，`scripts/check-no-secrets.mjs` 在提交前扫描 Token、私钥与真实数据路径。
- 日志与错误信息对手机号/邮箱打码（如 `138****1234`），不输出联系人明文与上游原始 PII；联系人明文仅通过 Bearer API 返回。
- Webhook 使用每订阅独立 secret 的 HMAC-SHA256 签名并携带时间戳；只允许 http(s) URL，限制未授权内网地址；订阅列表脱敏返回 secret。
- 解锁幂等：`unlock_ledger.idempotency_key` + 探迹业务幂等 + 租约恢复，保证崩溃重试不重复扣点。
- 无外部遥测；运行时依赖保持最小（Fastify、zod、commander、MCP SDK），不引入分析或上报 SDK。
- 原始快照与联系人属于敏感数据：备份文件不入库、不入 git；个人信息删除请求按 P1 流程处理（以最终代码为准）。
