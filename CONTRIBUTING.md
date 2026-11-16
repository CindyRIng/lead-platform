# 贡献指南（Contributing to LeadPlatform）

感谢你关注并愿意参与 LeadPlatform。本项目是一个**本机常驻的线索聚合平台**：以区域 Goal 为输入，从 Boss 直聘、智联招聘、阿里巴巴国际站、中国制造网四个本机 REST client 采集线索，经探迹匹配/工商补全、额度感知解锁、平台档案/岗位刷新与 fuma 海关画像，最终通过 REST / CLI / MCP / Webhook / SSE 对外提供查询与事件订阅。

我们欢迎代码、测试、文档、区域基线、mock 上游与问题报告等各类贡献。提交前请阅读本指南；涉及契约、数据模型或安全边界的改动，请先在 Issue 中讨论。

> 适用版本：**0.1.x**。项目处于实现并行开发阶段，部分目录/命令可能尚未落地；本指南中的命令以 [package.json](package.json) 为准，目录规划以 [02-架构与数据模型](docs/02-架构与数据模型.md) §4 为准，实际代码以仓库当前状态为准。

## 1. 项目定位与贡献边界

**定位**

- 单机、单用户、单进程：Fastify 5 + SQLite/WAL，默认仅监听 `127.0.0.1:8793`。
- 数据来源是本机已有的六个上游服务（四个采集 client + tanji-client + fuma-platform），平台本身**不持有浏览器登录态**，也不绕过上游风控。
- 对外提供 REST、CLI、MCP、Webhook、SSE；不替下游做 CRM 写入或业务编排。
- 中文文档为主；仓库使用 MIT License；版本从 `0.1.0` 起按 SemVer 管理。

**一期不做（除非先修改需求文档）**

- 自动登录、扫码/短信登录、验证码识别或任何绕过上游限制的能力。
- 公网多租户 SaaS、RBAC、分布式部署、跨机 SQLite 复制。
- 向 Twenty CRM / fuma-platform 等下游写入业务数据（事件订阅与只读查询除外）。
- 全量历史数据的按龄删除；历史数据按 Q7 决策永久保留（压缩 + 冷归档）。
- 未授权的真实探迹解锁或真实额度消耗。

如果你的改动会扩大上述边界，请先提交 Issue 说明动机、风险与对 [01-需求规格](docs/01-需求规格.md) 的影响，获得维护者确认后再实现。

## 2. 行为准则

本项目采用 **[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)**（贡献者公约）作为社区行为准则。本仓库不复制全文，请以官方版本为准。

摘要：

- 以尊重、专业、包容的方式参与讨论；对不同经验、背景与观点保持耐心。
- 禁止人身攻击、骚扰、歧视、威胁、泄露他人隐私或发布真实个人信息/凭据。
- 尊重维护者的时间：提问前先搜索 Issue 与文档，提供可复现的信息。
- 维护者有权删除不当内容、关闭偏离范围的讨论，或拒绝不符合准则的贡献。

如遇行为问题，请私下联系维护者；**安全漏洞请勿公开 Issue**，按 [SECURITY.md](SECURITY.md) 的私密渠道报告。

## 3. 开发环境

### 3.1 前置要求

| 项目 | 要求 | 说明 |
|---|---|---|
| Node.js | **>= 22.5.0** | 与现有客户端一致；使用内置 `node:sqlite`，启动脚本带 `--experimental-sqlite` |
| npm | 随 Node 提供，使用仓库 `package-lock.json` | 统一用 `npm ci`，避免锁文件漂移 |
| 操作系统 | Linux（开发机可为 NixOS/主流发行版）；macOS 可用于纯逻辑开发 | 生产以 systemd user service 常驻 |
| 上游客户端 | 可选 | 不启动也可跑单测/mock 集成测；真实采集需六个本机服务 |
| 磁盘 | 建议 ≥50 GB 空闲（开发）；生产建议 ≥500 GB | 历史数据永久保留 + 冷归档 |

### 3.2 首次安装

```bash
git clone <repository-url> lead-platform   # 远程地址以仓库实际配置为准
cd lead-platform
npm ci
node scripts/bootstrap-env.mjs             # 生成 .env（0600）；或 cp .env.example .env
npm run dev
```

- `scripts/bootstrap-env.mjs` 会从本机 boss/zhilian/ali/tanji/fuma 的配置读取 Token，并生成随机 `LEAD_API_TOKEN`；文件权限固定为 `0600`。若上游未配置，服务仍可启动，但对应来源不可用。
- 开发环境的数据目录默认是 `~/.lead-platform/`（`LEAD_DB`、`LEAD_ARCHIVE_DIR` 可覆盖），请确保目录权限 `0700`。
- **不要提交 `.env`、真实 Token、真实公司清单或联系人数据。** `.env` 已被 [.gitignore](.gitignore) 排除。

### 3.3 常用命令

| 命令 | 作用 | 备注 |
|---|---|---|
| `npm run dev` | 以 tsx 直接运行 `src/main.ts` | 带 `--experimental-sqlite`；入口实现后可用 |
| `npm run build` | TypeScript 编译到 `dist/` | 目标产物为 `dist/main.js`、`dist/cli.js`（以实际构建为准） |
| `npm start` | 运行 `dist/main.js` | 先执行 `npm run build` |
| `npm run typecheck` | `tsc --noEmit` | CI 必过 |
| `npm test` | `vitest run` | 测试文件匹配 `tests/**/*.test.ts` |
| `npm run test:watch` | vitest 监听模式 | 本地开发用 |
| `npm run gen` | 生成 OpenAPI / MCP 工具清单 / 文档等契约产物 | 以最终脚本为准 |
| `npm run gen:check` | 校验生成物与实现一致 | CI 必过，防契约漂移 |
| `npm run accept` | 本地验收脚本 | `scripts/acceptance.ts`，实现落地后可用 |

CLI 安装后可执行 `lead status`、`lead quota`、`lead company list` 等；开发期也可用 `node --experimental-sqlite dist/cli.js ...`。所有命令支持 `--json` 与 `--base-url`，默认 `http://127.0.0.1:8793`。

## 4. 分支与提交规范

### 4.1 分支

- 从 `main` 切出短生命周期分支；建议命名：`feat/<scope>-<short>`、`fix/<scope>-<short>`、`docs/<topic>`、`test/<topic>`、`chore/<topic>`、`refactor/<scope>`。
- 一个 PR 只解决一个主题；大改动拆分为若干可独立 review 的 PR。
- 保持分支与 `main` 同步；合并前解决冲突，不提交 `dist/`、`.env`、`node_modules/`、日志或真实数据。
- 实际分支保护与合并方式（squash/rebase）以仓库设置为准；本指南建议 squash merge，保持 `main` 历史可读。

### 4.2 Conventional Commits

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```text
<type>(<scope>): <subject>

<body>

<footer>
```

允许的 `type`：

| type | 用途 |
|---|---|
| `feat` | 新功能（对应 CHANGELOG 的 Added/Changed） |
| `fix` | 缺陷修复（对应 Fixed） |
| `docs` | 仅文档变更 |
| `test` | 测试、fixtures、mock 上游 |
| `chore` | 构建、依赖、脚本、配置等非功能变更 |
| `refactor` | 不改变外部行为的重构 |

必要时可使用 `perf`、`build`、`ci`、`revert`；`security` 类修复请使用 `fix` 并在 PR 中标注安全影响，不要写入公开细节。

示例（数据均为合成）：

```text
feat(region): 增加河北省地级市到四平台的映射回退
fix(unlock): 额度恢复后按原顺序唤醒 waiting_quota 任务
docs(security): 补充 webhook 时间戳校验说明
test(adapters): 为 ali 限频与空结果补充 mock 用例
```

要求：

- subject 用祈使句、简洁明确，建议 ≤72 字符；中文可接受。
- body 说明「为什么」与影响面，而不是逐行复述 diff；footer 关联 Issue（如 `Refs #123`）。
- 不提交 Token、Cookie、手机号、邮箱、真实公司名/统一社会信用代码；示例统一使用合成数据。
- 生成物（如 `spec/openapi.json`）若被跟踪，需与源码同一次提交，并保证 `npm run gen:check` 通过。

### 4.3 PR 模板要点

PR 描述建议包含：

1. **变更摘要**：做了什么、为什么、对应用户场景/Issue。
2. **契约影响**：REST/CLI/MCP/事件/DB 是否变化；是否更新 [03-接口草案](docs/03-接口草案.md) 与 CHANGELOG。
3. **测试证据**：执行的命令与结果（如 `npm run typecheck`、`npm test`、`npm run gen:check`），必要时附脱敏日志。
4. **安全与隐私**：是否接触真实上游、是否含 PII、日志是否打码、是否新增出站请求。
5. **风险与回滚**：数据迁移、兼容性、失败模式；能否安全回退。
6. **文档**：更新了哪些文档/图示；索引是否同步。
7. **License**：确认贡献可按 MIT 授权（见第 11 节）。

## 5. 代码规范

### 5.1 语言与类型

- TypeScript **strict**（[tsconfig.json](tsconfig.json)），`module`/`moduleResolution` 为 `NodeNext`，目标 ES2022；新增代码必须通过 `npm run typecheck`。
- 避免 `any`；无法避免时限定在边界并写明原因。外部输入先视为 `unknown`，用 zod 解析后再使用。
- HTTP 请求/响应、上游响应、环境变量、配置文件必须在边界做 zod 校验；不要信任上游字段形状。
- 领域逻辑（名称归一化、匹配打分、diff、状态机、额度判断、海关分类）尽量写成纯函数，便于单测；不要在纯函数中做网络/DB IO。

### 5.2 契约与错误

- 对外响应统一 envelope：`{ ok, data, meta, error }`，`meta.schemaVersion` 为 `1.0`；实现见 [src/shared/envelope.ts](src/shared/envelope.ts)。
- 错误码统一走 [src/shared/errors.ts](src/shared/errors.ts) 的 `ERROR_CODES` / `LeadError`，禁止在路由中临时拼错误 JSON 或自造 code；HTTP 状态映射与 `retryable` 由错误层统一决定。
- 分页、幂等、鉴权、请求 ID 遵循 [03-接口草案](docs/03-接口草案.md) §1；新增接口先更新契约文档，再由 zod schema 生成 OpenAPI。
- 不破坏已冻结的 `/v1` 字段语义；新增字段保持向后兼容，破坏性变更升 `/v2` 并写迁移说明。

### 5.3 数据访问与并发

- 所有 SQL 放在 repository/DB 层，路由与领域层不直接拼 SQL；写操作使用短事务，事务边界清晰。
- 迁移只增不改（字段可加、表可加），启动时执行；不要删除历史列或重命名已上线字段。
- 任务领取使用租约（`LEAD_JOB_LEASE_SEC`），解锁使用幂等键与台账；任何重试路径都要考虑「已经扣过点」「已经入库」的情况。
- 时间统一存 ISO 8601 UTC，展示层按 `LEAD_TZ`（默认 `Asia/Shanghai`）转换；ID 使用 ULID 文本。
- 上游调用必须经过按来源令牌桶/串行器，禁止在业务代码中直接 `fetch` 上游。

### 5.4 日志与隐私

- 使用结构化 JSON 日志，固定字段：`level, ts, module, event, companyId?, runId?, platform?, errorCode?, durationMs?`。
- **禁止在日志、错误信息、事件 payload 中输出联系人明文、手机号、邮箱、Token、Cookie、Webhook secret。** 手机号/邮箱按 `138****1234` 形式打码；上游原始错误若含 PII，只记录归一化后的 code/message。
- `contact.unlocked` 事件只带数量/类型摘要，联系人明文仅通过 Bearer API 返回。
- 不引入外部遥测/分析 SDK；出站请求仅限本机上游与用户配置的 webhook URL。

### 5.5 红线

以下行为会导致 PR 被拒绝，情节严重的按安全事件处理：

- 在测试、CI 或本地脚本中**直连真实上游做自动化测试**（只读冒烟需维护者明确授权，且不得写入/消耗额度）。
- **真实调用 tanji unlock**，或以任何方式消耗探迹额度；单测/集成测必须走 mock。
- 提交真实 Token、Cookie、账号、手机号、邮箱、公司清单、联系人、海关提单原始数据。
- 使用真实公司/个人信息作为 fixtures；必须使用合成数据并标注「示例」。
- 关闭鉴权、放宽为 `0.0.0.0` 监听、启用 CORS、在日志中输出 PII，或绕过限频/租约/幂等。
- 将真实抓取产物提交到仓库。`.gitignore` 已忽略部分路径、`scripts/check-no-secrets.mjs` 可做基础扫描，但 **发布前必须人工审计 `exploration/`**：真实公司清单 / 联系方式 / 原始响应只能留在维护者本机，或脱敏后仅保留聚合统计结论。

## 6. 模块边界与目录

### 6.1 目标结构（规划）

[02-架构与数据模型](docs/02-架构与数据模型.md) §4 给出目标结构，摘要如下：

```text
src/
├─ main.ts                 # config → db → scheduler → workers → http
├─ config.ts               # env/config 解析 + zod 校验
├─ db/                     # 连接、WAL、迁移、repositories
├─ domain/                 # 纯业务：去重、匹配、diff、状态机
├─ adapters/upstream/      # boss/zhilian/ali/mic/tanji REST 客户端
├─ region/                 # 区域注册表 + 平台映射
├─ pipeline/               # orchestrator / enrichment / unlock / refresh / customs / scheduler
├─ events/                 # change_events → webhook / SSE
├─ api/rest/               # Fastify 路由（zod schema）
├─ api/cli.ts              # commander
├─ api/mcp.ts              # MCP server（代理 REST）
├─ data/                   # 内置区域基线、默认关键词、抓取上限
└─ utils/                  # logger、令牌桶、retry、ULID、hash
tests/                     # unit + integration（mock upstream）
scripts/                   # gen、acceptance、bootstrap、部署
docs/                      # 00–19 文档
```

依赖方向：`api/* → pipeline/adapters/domain → db`；`domain` 不依赖 Fastify、DB 实现或上游 SDK。禁止循环依赖；跨层共享类型放 `src/shared/`。

### 6.2 当前落地情况（撰写时快照）

实现正在并行推进，**不要把规划目录当作最终交付**。截至 2026-11-16，`src/` 已出现以下模块（文件级清单以 `find src -type f` 为准）：

| 路径 | 当前职责 |
|---|---|
| `src/shared/`、`src/utils/`、`src/logger.ts`、`src/config.ts` | envelope/错误码/领域类型、压缩、日志、配置 |
| `src/db/`、`src/repositories/` | schema、连接/迁移、数据访问 |
| `src/domain/`、`src/region/`、`src/data/` | 归一化/去重/匹配、区域注册表、内置区域基线 |
| `src/adapters/`、`src/pipeline/`、`src/services/` | 上游 adapter、调度/解锁/刷新/海关、用例服务 |
| `src/events/`、`src/http/`、`src/cli/`、`src/mcp/` | 事件/Webhook/SSE、REST 服务、CLI、MCP |
| `tests/` | fixtures、helpers、unit/integration/mock-upstreams（持续补充） |

`src/main.ts` 等入口已出现；`docs/02 §4` 中的 `src/api/` 等规划路径与当前代码可能不同，**以代码为准**。新增模块时请同步更新 [02-架构与数据模型](docs/02-架构与数据模型.md) §4 与 [docs/README.md](docs/README.md) 索引；如需调整依赖方向，先在 Issue 说明。

## 7. 测试策略

### 7.1 分层

| 层级 | 建议位置 | 覆盖内容 | 命令 |
|---|---|---|---|
| 单元测试 | `tests/unit/` | 名称归一化、匹配打分、字段 diff、状态机、额度恢复、签名、区域映射、海关过滤/角色分类 | `npm test` |
| 集成测试 | `tests/integration/` | Fastify 路由 + 临时 SQLite + 队列/事件链路 | `npm test` |
| mock 上游 | `tests/mock-upstreams/` | 模拟五个 client + fuma 的成功、429、401、额度耗尽、权限拒绝、空数据 | `npm test` |
| fixtures | `tests/fixtures/` | 合成公司/岗位/联系人/提单/响应样例 | `npm test` |
| 本地验收 | `scripts/acceptance.ts` | 采集 → 补全 → 档案/岗位 → 海关 → 解锁 → 事件主链路（mock） | `npm run accept` |
| 真实冒烟 | 人工、授权后 | 五源 health/区域字典/单条只读详情；**不消耗额度** | 见 [09-上游接口与流水线验证报告](docs/09-上游接口与流水线验证报告.md) |

### 7.2 规则

- 测试必须**离线、可重复、可并行/可单 fork**；固定时间与随机种子，不依赖真实网络、真实账号或真实时钟。
- 断言外部契约时使用 mock 响应与 zod schema；不要把真实上游返回直接固化为 fixture。
- 新增/修改行为必须带测试；修复 bug 先补回归用例。
- CI 会执行 `npm ci → npm run typecheck → npm run build → npm test → npm run gen:check`（[.github/workflows/ci.yml](.github/workflows/ci.yml)）。本地提交前至少跑 `typecheck`、相关测试与 `gen:check`。
- 真实环境验收（P7）必须由维护者书面授权额度上限，并记录消耗；贡献者不得自行触发。
- 测试输出与失败日志需脱敏，不得包含 PII/Token。

## 8. 文档规范

- 文档编号使用 `docs/00`–`docs/19` 的两位编号 + 中文短标题，例如 `docs/13-数据口径与质量说明.md`；新增文档先确认编号不冲突，并更新 [docs/README.md](docs/README.md) 索引。
- 每篇文档建议包含：一级标题（编号 + 主题 + 版本/状态）、状态行、关联文档链接、变更记录；示例参考 [01-需求规格](docs/01-需求规格.md)、[08-海关数据补全](docs/08-海关数据补全.md)。
- 文档中的命令、路径、配置项必须来自仓库真实文件（`package.json`、[.env.example](.env.example)、[systemd/lead-platform.service](systemd/lead-platform.service)），规划中的内容要明确标注「计划/待实现」。
- 示例数据一律合成，禁止真实公司名、联系人、手机号、邮箱、Token、统一社会信用代码。
- Mermaid 图源文件统一放 `docs/assets/*.mmd`，并导出同名 `.png` 一并提交；文档内引用 PNG，保证离线/渲染器兼容。当前架构草图为 `docs/assets/lead-platform-sketch.png`。
- 相对链接只指向仓库内真实存在的文件；新增验收标准请延续 `AC-n` 编号，新增决策请同步 [10-需求确认清单](docs/10-需求确认清单.md)。
- 行为变化同步更新 [CHANGELOG.md](CHANGELOG.md)：开发中写入 `[Unreleased]`，发布时整理到对应版本。

## 9. Issue 与 PR 流程

### 9.1 Issue

- 先搜索已有 Issue 与文档，避免重复；一个 Issue 只描述一个问题。
- Bug 报告请提供：版本/commit、Node 版本、操作系统、启动命令、期望/实际、最小复现、脱敏日志、是否使用 mock。
- 功能请求请说明使用场景、与现有 Goal/额度/事件模型的关系、对契约的影响、是否愿意提交 PR。
- **安全漏洞不要公开提交 Issue**；按 [SECURITY.md](SECURITY.md) 私密报告，且不要在 Issue 中粘贴 PII、Token、真实数据。
- 维护者会标注优先级与范围；超出 [01-需求规格](docs/01-需求规格.md) 的请求可能进入后续版本。

### 9.2 PR

1. Fork/切分支 → 实现 + 测试 + 文档 → 本地检查 → 提交 PR。
2. 关联 Issue（`Closes #...` / `Refs #...`），填写 PR 模板（见 §4.3）。
3. 保持 CI 绿；review 期间避免无关 force-push，按反馈增量提交或 squash。
4. 至少一名维护者 approve 后合并；涉及契约/安全/迁移的改动需要额外 review；合并后删除分支，发布由维护者按 §10 执行。

## 10. 发布流程

1. **确定版本**：按 SemVer 判断 `MAJOR/MINOR/PATCH`；0.x 阶段的破坏性变更也需在 CHANGELOG 显著说明。
2. **整理 CHANGELOG**：把 `[Unreleased]` 条目移入新版本，写日期与「以最终代码为准」说明；补全 Added/Changed/Fixed/Security。
3. **更新版本号**：[package.json](package.json) 的 `version` 与 `package-lock.json` 保持一致（如 `npm version <version> --no-git-tag-version`）。
4. **发布前验证**：
   ```bash
   npm ci && npm run typecheck
   npm run build && npm test
   npm run gen:check && npm run accept   # accept 在实现落地后
   ```
5. **打标签**：`git tag -a v0.1.0 -m "lead-platform v0.1.0"`；有远程时推送标签。
6. **部署**：优先使用 [scripts/deploy.sh](scripts/deploy.sh)；或手动 `npm run build` → `systemctl --user restart lead-platform.service` → 执行迁移（启动时自动执行，幂等）。
7. **验收**：`curl -fsS http://127.0.0.1:8793/v1/health`、`lead status`、`/v1/sources`、`/docs`；确认 systemd `active (running)` 且 24h 无异常重启。
8. **回滚**：保留上一版本 tag 与数据库备份；迁移只增不改，回滚代码前先确认 schema 兼容，禁止删除历史数据。

真实探迹解锁与真实上游全量采集属于 P7 验收，必须单独授权并记录额度消耗，不包含在常规发布脚本中。

## 11. License 与贡献者授权

- 本项目使用 **MIT License**，全文见 [LICENSE](LICENSE)（Copyright (c) 2026 CindyRIng）。
- 采用 **inbound = outbound**：你提交的贡献按 MIT 授权给本项目及下游使用者；本项目不要求签署独立 CLA。
- 提交 PR 即表示你确认：拥有该代码/文档的版权或已获得授权，内容不侵犯第三方权利，且不包含真实个人信息、商业秘密或未授权的上游数据。
- 引用第三方代码/数据时请注明来源与许可证，并确保与 MIT 兼容；新增依赖需说明用途、体积与安全影响。
- 发布前请同步 README 的 License 段落与 `LICENSE`（当前 README 中仍为历史占位，以根目录 `LICENSE` 为准）。

## 12. 参考文档

| 文档 | 用途 |
|---|---|
| [README.md](README.md) | 项目概览、架构草图、上游端口 |
| [01-需求规格](docs/01-需求规格.md) | FR/NFR、业务规则、AC-1..AC-18 |
| [02-架构与数据模型](docs/02-架构与数据模型.md) | 代码结构、数据表、状态机、额度/事件设计 |
| [03-接口草案](docs/03-接口草案.md) | REST/CLI/MCP/Webhook/SSE 契约 |
| [05-部署与运维](docs/05-部署与运维.md) | 配置、systemd、巡检、Runbook |
| [06-实施计划](docs/06-实施计划.md) | 阶段、测试策略、工程约定 |
| [09-上游接口与流水线验证报告](docs/09-上游接口与流水线验证报告.md) | 实测矩阵与设计校正 |
| [10-需求确认清单](docs/10-需求确认清单.md) | 44 项决策与开放项 |
| [SECURITY.md](SECURITY.md) | 漏洞报告、威胁模型、部署安全清单 |
| [CHANGELOG.md](CHANGELOG.md) | 版本变更记录 |

再次感谢你的贡献。若不确定某项改动是否合适，欢迎先开 Issue 讨论，或在 PR 中标注 `Draft` 征求意见。
