# tests/mock-upstreams — 六上游本地 mock

用途：为单元/集成/验收测试提供**完全离线**的六个上游（boss / zhilian / ali / mic / tanji / fuma），
响应形状对齐 [docs/04-上游对接与区域映射](../../docs/04-上游对接与区域映射.md) 与 exploration 实测样例。

> 原则：**不访问真实上游、不调用真实 tanji unlock、不消耗额度、不使用真实公司/PII**。
> 所有数据来自 [tests/fixtures](../fixtures)。

## 快速使用（vitest）

```ts
import { startMockUpstreams, injectFailure, exhaustTanjiQuota } from '../mock-upstreams/index.js';

const mocks = await startMockUpstreams();          // 默认随机空闲端口（127.0.0.1:0），不会和真实 client 冲突
process.env.BOSS_CLIENT_URL = mocks.url('boss');   // 或一次性拿全部 env：mocks.env()
process.env.TANJI_CLIENT_URL = mocks.url('tanji');
// ... 启动 LeadPlatform（env 必须在 import src 之前设置）...
await mocks.stop();
```

固定端口（acceptance / 子进程模式）：

```ts
const mocks = await startMockUpstreams({ ports: { boss: 8790, zhilian: 8791 } });
```

## 测试控制能力

| 能力 | 进程内 API | HTTP 控制端点 |
|---|---|---|
| 注入失败（401/429/5xx/超时/业务错误码） | `injectFailure(world, 'boss', { status: 429, code: 'RATE_LIMITED', times: 2 })` | `POST /__mock/failure` |
| 会话失效（status loggedIn=false + 业务 401） | `setSessionInvalid(world, 'zhilian', true)` | `POST /__mock/config {"sessionInvalid":true}` |
| 空结果 | `setForceEmpty(world, 'ali', true)` | `POST /__mock/config {"forceEmpty":true}` |
| 岗位刷新轮次（新增/下线场景） | `setJobsRound(world, 'boss', 2)` | `POST /__mock/config {"jobsRound":2}` |
| 探迹额度耗尽 / 恢复 | `exhaustTanjiQuota(world)` / `restoreTanjiQuota(world)` | `POST /__mock/quota {"exhausted":true}` / `{"restore":true}` |
| fuma 无权限（CUSTOMS_PERMISSION_DENIED） | `setFumaPermission(world, true)` | `POST /__mock/fuma-permission {"denied":true}` |
| 重置场景/请求日志 | `resetWorld(world)` / `resetRequestLog(world)` | `POST /__mock/reset` |
| 查看请求日志（断言调用次数/幂等） | `recentRequests(world, 'tanji', '/unlock')`、`countRequests(...)` | `GET /__mock/requests?limit=100&path=/unlock` |

`injectFailure` 的 `match` 可以只命中某条路径，例如：
`injectFailure(world, 'tanji', { status: 409, code: 'QUOTA_EXHAUSTED', match: '/unlock' })`。

## 支持的端点

| mock | 端点 |
|---|---|
| boss | `GET /v1/status`、`GET /v1/cities`、`POST /v1/search/jobs`、`GET /v1/jobs?queryId`、`GET /v1/companies?queryId`、`GET /v1/companies/{id}`、`GET /v1/companies/{id}/jobs` |
| zhilian | `GET /v1/status`、`GET /v1/cities`、`POST /v1/search/jobs`、`GET /v1/jobs?queryId`、`GET /v1/companies?queryId`、`GET /v1/companies/{number}`、`GET /v1/companies/{number}/jobs` |
| ali | `GET /v1/status`、`GET /v1/regions`、`POST /v1/search/suppliers`、`GET /v1/suppliers?queryId`、`GET /v1/suppliers/{id}` |
| mic | `GET /api/version`、`GET /api/regions[?province=]`、`GET /api/search/factories`、`GET /api/companies/{account}?include=`、`GET /api/cache/stats` |
| tanji | `GET /v1/status`、`GET /v1/accounts`、`POST /v1/search/name`、`GET /v1/companies/{id}`、`GET /v1/companies/{id}/contacts`、`POST /v1/companies/{id}/unlock`、`GET /v1/filters/registry` |
| fuma | `GET /v1/status`、`POST /v1/customs/query`（flag 1/2、24h 缓存、`forceRefresh`）、`GET /v1/customs/dictionaries`、`GET /v1/customs/cache/stats` |

## fixture 场景一览

| company key | 平台来源 | 探迹 | 海关 |
|---|---|---|---|
| `chenxing` 河北辰星机械 | boss + ali | 已解锁（alreadyUnlocked，不扣额度）；USCC/名称/英文名均可匹配 | high（9 条命中，exporter+importer） |
| `yunfan` 河北云帆进出口 | zhilian + mic | 未解锁 → 需 unlock（扣 1 点）；名称匹配 | medium（4 条命中） |
| `hengyue` 石家庄恒岳金属 | ali | **unmatched**（搜索为空，不消耗额度） | no_data（totalNum=0） |
| `lanjing` 唐山蓝鲸重工 | boss | USCC 精确匹配；未解锁 | —（仅中文名，一期不做） |
| `huaxi` 保定华曦新能源 | mic | 英文抬头匹配（score 较低） | low（2 条命中 + 噪声） |
| `haichuan` 沧州海川管道 | ali + mic | 已解锁 | high（5 条命中） |

其他场景：Boss/智联岗位轮次（`round1 → round2`）可验证岗位新增/下线/重新上线；`zhilian` 搜索响应故意保留 `count=0`（上游字段不可靠）。

## 注意

- mock 默认**不校验 Bearer token**（配置层要求 token 非空时随便填即可）；`401` 场景用 `injectFailure` / `setSessionInvalid` 模拟；
- 每个 mock 都是独立 Fastify 实例、0 延迟；`beforeAll` 启动、`afterAll` 关闭即可；
- 修改 fixture/响应形状时同步更新自检测试：[tests/integration/mock-upstreams.test.ts](../integration/mock-upstreams.test.ts)。
