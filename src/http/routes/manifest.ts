/**
 * REST 路由清单（唯一契约源）。
 *
 * 结构：
 *  - 路由注册：src/http/routes/index.ts 遍历 API_ROUTES；
 *  - OpenAPI/docs：src/api/spec.ts 由本清单生成 spec/openapi.json；
 *  - 校验：params/query/body 的 zod schema 在路由层统一校验（VALIDATION_ERROR）；
 *  - 响应 schema 仅用于契约生成，运行期不做严格校验（向后兼容）。
 *
 * 注意：/v1/health、/v1/status 由 foundation 的 http 层实现，不在此清单内；
 * /docs、/openapi.json、/mcp-tools.json 为非 envelope 的静态/生成物路由，见 docs.ts。
 */
import type { ZodTypeAny } from 'zod';
import * as C from './contracts.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiRoute {
  method: HttpMethod;
  /** Fastify 风格路径（:id）；OpenAPI 生成时转 {id} */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  /** 是否需要 Bearer（默认 true；仅 docs 类为 false，不在此清单） */
  public?: boolean;
  /** 成功状态码，默认 200 */
  successStatus?: number;
  /** 路径参数 zod 对象 */
  params?: ZodTypeAny;
  /** 查询参数 zod 对象 */
  query?: ZodTypeAny;
  /** 请求体 zod */
  body?: ZodTypeAny;
  /** 响应 data 字段 schema（envelope 的 data） */
  response: ZodTypeAny;
  /** server-sent events：响应不是 envelope */
  stream?: boolean;
  /** 由 foundation 的 http 层注册（health/status），本清单只用于契约生成/映射，不重复注册 */
  external?: boolean;
  /** handler 注册键（见 handlers/index.ts；external 路由可省略） */
  handler?: string;
}

// foundation 提供并注册的路由：只进 OpenAPI/docs/MCP/CLI 映射，不在此处重复注册。
export const FOUNDATION_ROUTES: ApiRoute[] = [
  {
    method: 'GET',
    path: '/v1/health',
    operationId: 'getHealth',
    summary: '存活探针（免鉴权，毫秒级）',
    tag: 'Runtime',
    public: true,
    external: true,
    response: C.healthData,
  },
  {
    method: 'GET',
    path: '/v1/status',
    operationId: 'getStatus',
    summary: '运行态总览（版本/DB/调度/队列/刷新/上游/额度/告警）',
    tag: 'Runtime',
    external: true,
    response: C.statusData,
  },
];

export const API_ROUTES: ApiRoute[] = [
  /* ---------------------------- Goals ---------------------------- */
  {
    method: 'POST',
    path: '/v1/goals',
    operationId: 'createGoal',
    summary: '创建 Goal（区域目标）',
    description:
      '创建后返回含 resolvedCities（该省各地级市在四平台的实际检索值）。校验失败返回 VALIDATION_ERROR。',
    tag: 'Goals',
    successStatus: 201,
    body: C.goalCreateBody,
    response: C.goalViewData,
    handler: 'goals.create',
  },
  {
    method: 'GET',
    path: '/v1/goals',
    operationId: 'listGoals',
    summary: 'Goal 列表',
    tag: 'Goals',
    query: C.goalListQuery,
    response: C.goalListData,
    handler: 'goals.list',
  },
  {
    method: 'GET',
    path: '/v1/goals/:id',
    operationId: 'getGoal',
    summary: 'Goal 详情（含 resolvedCities、最近 runs 摘要）',
    tag: 'Goals',
    params: C.goalIdParams,
    response: C.goalViewData,
    handler: 'goals.get',
  },
  {
    method: 'PATCH',
    path: '/v1/goals/:id',
    operationId: 'updateGoal',
    summary: '更新 Goal（乐观锁 version）',
    description: '可传 expectedVersion 做乐观锁；版本不一致返回 CONFLICT。',
    tag: 'Goals',
    params: C.goalIdParams,
    body: C.goalUpdateBody,
    response: C.goalViewData,
    handler: 'goals.update',
  },
  {
    method: 'DELETE',
    path: '/v1/goals/:id',
    operationId: 'archiveGoal',
    summary: '归档 Goal（软删除，保留历史 run/数据）',
    tag: 'Goals',
    params: C.goalIdParams,
    response: C.goalArchivedData,
    handler: 'goals.archive',
  },
  {
    method: 'POST',
    path: '/v1/goals/:id/run',
    operationId: 'runGoal',
    summary: '手动触发一次 Run',
    description: '同一 Goal 已有运行中的 Run 时返回 409 RUN_IN_PROGRESS。',
    tag: 'Goals',
    successStatus: 202,
    params: C.goalIdParams,
    response: C.goalRunData,
    handler: 'goals.run',
  },
  {
    method: 'GET',
    path: '/v1/goals/:id/runs',
    operationId: 'listGoalRuns',
    summary: 'Goal 的运行历史',
    tag: 'Goals',
    params: C.goalIdParams,
    query: C.goalRunsQuery,
    response: C.runListData,
    handler: 'goals.runs',
  },

  /* ---------------------------- Runs ----------------------------- */
  {
    method: 'GET',
    path: '/v1/runs',
    operationId: 'listRuns',
    summary: 'Run 列表（按 goalId/status 过滤）',
    tag: 'Runs',
    query: C.runListQuery,
    response: C.runListData,
    handler: 'runs.list',
  },
  {
    method: 'GET',
    path: '/v1/runs/:id',
    operationId: 'getRun',
    summary: 'Run 详情 + 平台/城市/关键词级进度',
    tag: 'Runs',
    params: C.runIdParams,
    response: C.runViewData,
    handler: 'runs.get',
  },
  {
    method: 'POST',
    path: '/v1/runs/:id/cancel',
    operationId: 'cancelRun',
    summary: '取消运行中的 Run（在飞请求结束后停止）',
    tag: 'Runs',
    params: C.runIdParams,
    response: C.runViewData,
    handler: 'runs.cancel',
  },

  /* -------------------------- Companies -------------------------- */
  {
    method: 'GET',
    path: '/v1/companies',
    operationId: 'listCompanies',
    summary: '公司列表（区域/平台/状态/关键词过滤，游标分页）',
    description:
      'cursor 为不透明游标；meta.nextCursor 为 null 表示结束。默认按 updated_at DESC, id DESC 排序。q 最小 2 字符。',
    tag: 'Companies',
    query: C.companyListQuery,
    response: C.companyListData,
    handler: 'companies.list',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id',
    operationId: 'getCompany',
    summary: '公司详情（主档 + 来源 + 联系人 + 最近变更；include=platforms,customs 追加卡片）',
    tag: 'Companies',
    params: C.companyIdParams,
    query: C.companyDetailQuery,
    response: C.companyDetailData,
    handler: 'companies.get',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/sources',
    operationId: 'listCompanySources',
    summary: '公司全部来源证据',
    tag: 'Companies',
    params: C.companyIdParams,
    response: C.companySourcesData,
    handler: 'companies.sources',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/snapshots',
    operationId: 'listCompanySnapshots',
    summary: '公司快照元数据列表（include=payload 仅调试用）',
    tag: 'Companies',
    params: C.companyIdParams,
    query: C.snapshotQuery,
    response: C.snapshotListData,
    handler: 'companies.snapshots',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/contacts',
    operationId: 'listCompanyContacts',
    summary: '公司联系人（明文，需 Bearer）',
    tag: 'Companies',
    params: C.companyIdParams,
    query: C.contactsQuery,
    response: C.contactsListData,
    handler: 'companies.contacts',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/changes',
    operationId: 'listCompanyChanges',
    summary: '公司字段级变更历史（含平台字段路径）',
    tag: 'Companies',
    params: C.companyIdParams,
    query: C.companyChangesQuery,
    response: C.companyChangesData,
    handler: 'companies.changes',
  },
  {
    method: 'POST',
    path: '/v1/companies/:id/rematch',
    operationId: 'rematchCompany',
    summary: '重新匹配探迹主体（202 + job，异步）',
    tag: 'Companies',
    successStatus: 202,
    params: C.companyIdParams,
    body: C.rematchBody,
    response: C.jobAcceptedData,
    handler: 'companies.rematch',
  },
  {
    method: 'POST',
    path: '/v1/companies/:id/unlock',
    operationId: 'unlockCompany',
    summary: '手动优先解锁联系人（202 + job）',
    description: '使用 idempotencyKey（默认 <companyId>:<yyyy-mm-dd>），重复请求返回同一 job。',
    tag: 'Companies',
    successStatus: 202,
    params: C.companyIdParams,
    body: C.unlockBody,
    response: C.jobAcceptedData,
    handler: 'companies.unlock',
  },

  /* -------------------------- Platforms -------------------------- */
  {
    method: 'GET',
    path: '/v1/companies/:id/platforms',
    operationId: 'listCompanyPlatforms',
    summary: '各平台最新档案卡片',
    tag: 'Platforms',
    params: C.companyIdParams,
    response: C.platformListData,
    handler: 'platforms.list',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/platforms/:platform',
    operationId: 'getCompanyPlatform',
    summary: '单平台完整档案（Boss/智联含招聘；Ali/Mic 含店铺）',
    tag: 'Platforms',
    params: C.platformParam,
    response: C.platformDetailData,
    handler: 'platforms.get',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/platforms/:platform/jobs',
    operationId: 'listCompanyPlatformJobs',
    summary: '岗位列表 + 历史（Boss/智联；其它平台 400 UNSUPPORTED）',
    tag: 'Platforms',
    params: C.platformParam,
    query: C.platformJobsQuery,
    response: C.platformJobListData,
    handler: 'platforms.jobs',
  },
  {
    method: 'GET',
    path: '/v1/companies/:id/platforms/:platform/changes',
    operationId: 'listCompanyPlatformChanges',
    summary: '平台档案变更历史（platforms.<platform>.*）',
    tag: 'Platforms',
    params: C.platformParam,
    query: C.platformChangesQuery,
    response: C.platformChangesData,
    handler: 'platforms.changes',
  },
  {
    method: 'POST',
    path: '/v1/companies/:id/refresh',
    operationId: 'refreshCompanyPlatforms',
    summary: '手动刷新平台档案/岗位（202 + job；可指定 platforms/kinds）',
    tag: 'Platforms',
    successStatus: 202,
    params: C.companyIdParams,
    body: C.refreshBody,
    response: C.jobAcceptedData,
    handler: 'platforms.refresh',
  },

  /* --------------------------- Customs --------------------------- */
  {
    method: 'GET',
    path: '/v1/companies/:id/customs',
    operationId: 'getCompanyCustoms',
    summary: '海关画像（Ali/Mic；其它公司 404）',
    description: 'totalNum 为上游模糊命中总数，榜单基于样本（sampled=true）；低 confidence 不进入 webhook。',
    tag: 'Customs',
    params: C.companyIdParams,
    response: C.customsView,
    handler: 'customs.get',
  },
  {
    method: 'POST',
    path: '/v1/companies/:id/customs/refresh',
    operationId: 'refreshCompanyCustoms',
    summary: '手动刷新海关画像（202 + job）',
    tag: 'Customs',
    successStatus: 202,
    params: C.companyIdParams,
    response: C.jobAcceptedData,
    handler: 'customs.refresh',
  },

  /* ------------------------ Changes / SSE ------------------------ */
  {
    method: 'GET',
    path: '/v1/changes',
    operationId: 'listChanges',
    summary: '全局增量变更（sinceSeq 游标，不漏不重）',
    tag: 'Changes & Events',
    query: C.changesQuery,
    response: C.changesData,
    handler: 'changes.list',
  },
  {
    method: 'GET',
    path: '/v1/events/stream',
    operationId: 'streamEvents',
    summary: 'SSE 事件流（types 过滤；Last-Event-ID 断点续传）',
    description:
      'text/event-stream；每条事件 data 为 ChangeView JSON，id 为 seq。消费者应持久化 seq 并以 Last-Event-ID 续传。',
    tag: 'Changes & Events',
    stream: true,
    query: C.streamQuery,
    response: C.changeView,
    handler: 'events.stream',
  },

  /* --------------------------- Webhooks -------------------------- */
  {
    method: 'POST',
    path: '/v1/webhooks',
    operationId: 'createWebhook',
    summary: '创建 webhook 订阅（secret 仅创建时返回明文）',
    tag: 'Webhooks',
    successStatus: 201,
    body: C.webhookCreateBody,
    response: C.webhookView,
    handler: 'webhooks.create',
  },
  {
    method: 'GET',
    path: '/v1/webhooks',
    operationId: 'listWebhooks',
    summary: 'webhook 订阅列表（secret 脱敏）',
    tag: 'Webhooks',
    response: C.webhookListData,
    handler: 'webhooks.list',
  },
  {
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    operationId: 'updateWebhook',
    summary: '更新订阅 url/eventTypes/active',
    tag: 'Webhooks',
    params: C.webhookIdParams,
    body: C.webhookUpdateBody,
    response: C.webhookView,
    handler: 'webhooks.update',
  },
  {
    method: 'DELETE',
    path: '/v1/webhooks/:id',
    operationId: 'deleteWebhook',
    summary: '删除订阅',
    tag: 'Webhooks',
    params: C.webhookIdParams,
    response: C.webhookDeleteData,
    handler: 'webhooks.delete',
  },
  {
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: '投递记录（status 过滤，游标分页；dead 可查）',
    tag: 'Webhooks',
    params: C.webhookIdParams,
    query: C.deliveriesQuery,
    response: C.deliveryListData,
    handler: 'webhooks.deliveries',
  },
  {
    method: 'POST',
    path: '/v1/webhooks/:id/deliveries/:deliveryId/replay',
    operationId: 'replayWebhookDelivery',
    summary: '重放一条投递记录',
    tag: 'Webhooks',
    successStatus: 202,
    params: C.deliveryReplayParams,
    response: C.deliveryReplayData,
    handler: 'webhooks.replay',
  },

  /* ----------------------------- Jobs ---------------------------- */
  {
    method: 'GET',
    path: '/v1/jobs',
    operationId: 'listJobs',
    summary: '流水线队列任务（status/stage/companyId 过滤；dead 死信可查）',
    tag: 'Jobs',
    query: C.jobsQuery,
    response: C.jobListData,
    handler: 'jobs.list',
  },
  {
    method: 'GET',
    path: '/v1/jobs/:id',
    operationId: 'getJob',
    summary: '任务详情（attempts、lastError、lease）',
    tag: 'Jobs',
    params: C.jobIdParams,
    response: C.jobDetailData,
    handler: 'jobs.get',
  },
  {
    method: 'POST',
    path: '/v1/jobs/:id/retry',
    operationId: 'retryJob',
    summary: '重试失败/死信任务',
    tag: 'Jobs',
    successStatus: 202,
    params: C.jobIdParams,
    response: C.jobRetryData,
    handler: 'jobs.retry',
  },

  /* ---------------------------- Runtime -------------------------- */
  {
    method: 'GET',
    path: '/v1/sources',
    operationId: 'listSources',
    summary: '上游来源健康/登录态/限频/最近错误',
    tag: 'Runtime',
    response: C.sourcesData,
    handler: 'sources.list',
  },
  {
    method: 'GET',
    path: '/v1/quota',
    operationId: 'getQuota',
    summary: '探迹额度详情 + 最近解锁消耗曲线',
    tag: 'Runtime',
    response: C.quotaData,
    handler: 'quota.get',
  },
  {
    method: 'GET',
    path: '/v1/stats',
    operationId: 'getStats',
    summary: '采集/补全/解锁/事件统计；kind=coverage 返回覆盖度指标',
    tag: 'Runtime',
    query: C.statsQuery,
    response: C.statsData,
    handler: 'stats.get',
  },

  /* ----------------------------- Admin --------------------------- */
  {
    method: 'POST',
    path: '/v1/admin/backup',
    operationId: 'adminBackup',
    summary: 'SQLite 在线备份到数据目录 backups/',
    tag: 'Admin',
    response: C.backupData,
    handler: 'admin.backup',
  },
  {
    method: 'POST',
    path: '/v1/admin/archive',
    operationId: 'adminArchive',
    summary: '原始快照冷归档（brotli 文件 + manifest；只归档不删除）',
    tag: 'Admin',
    body: C.archiveBody,
    response: C.archiveData,
    handler: 'admin.archive',
  },
  {
    method: 'GET',
    path: '/v1/admin/archive/manifests',
    operationId: 'adminListManifests',
    summary: '归档清单列表（按月份）',
    tag: 'Admin',
    response: C.archiveManifestsData,
    handler: 'admin.manifests',
  },
  {
    method: 'GET',
    path: '/v1/admin/verify',
    operationId: 'adminVerify',
    summary: '校验归档文件 sha256（可指定 month）',
    tag: 'Admin',
    query: C.verifyQuery,
    response: C.verifyData,
    handler: 'admin.verify',
  },
  {
    method: 'POST',
    path: '/v1/admin/restore',
    operationId: 'adminRestore',
    summary: '按月份恢复归档元数据/文件到 hot 库（幂等，不删除归档）',
    tag: 'Admin',
    body: C.restoreBody,
    response: C.restoreData,
    handler: 'admin.restore',
  },
  {
    method: 'GET',
    path: '/v1/admin/db-stats',
    operationId: 'adminDbStats',
    summary: 'DB 体积 / 表行数 / 归档与备份统计',
    tag: 'Admin',
    response: C.dbStatsData,
    handler: 'admin.dbStats',
  },
];

/** 完整契约清单（含 foundation 路由），用于 OpenAPI/docs/MCP/CLI 生成 */
export const ALL_ROUTES: ApiRoute[] = [...FOUNDATION_ROUTES, ...API_ROUTES];

/** operationId → route 映射（MCP/CLI 契约测试用） */
export const ROUTES_BY_OPERATION: Record<string, ApiRoute> = Object.fromEntries(
  ALL_ROUTES.map((r) => [r.operationId, r]),
);

/** handler key 列表（路由注册与契约测试用） */
export const HANDLER_KEYS: string[] = API_ROUTES.filter((r) => r.handler).map((r) => r.handler as string);
