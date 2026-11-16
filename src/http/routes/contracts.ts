/**
 * REST 契约（zod）—— 对外接口的唯一契约源之一（与 manifest.ts 配合）。
 *
 * 约定：请求参数使用 zod 校验（路由层统一转 VALIDATION_ERROR）；
 * 响应 schema 只用于生成 OpenAPI / docs / mcp-tools，不做运行期严格校验
 * （服务层返回额外字段时透传，保证向前兼容）。
 */
import { z } from 'zod';
import {
  DEFAULT_UNLOCK_POLICY,
  EVENT_TYPES,
  PLATFORMS,
  STAGES,
} from '../../shared/constants.js';

/* ------------------------------------------------------------------ */
/* 基础枚举                                                             */
/* ------------------------------------------------------------------ */

export const platformEnum = z.enum(['boss', 'zhilian', 'ali', 'mic']);
export const allPlatformEnum = z.enum(['boss', 'zhilian', 'ali', 'mic', 'tanji', 'fuma']);
export const goalRunStatusEnum = z.enum(['pending', 'running', 'completed', 'partial', 'failed', 'cancelled']);
export const unlockStatusEnum = z.enum(['none', 'pending', 'waiting_quota', 'unlocked', 'failed']);
export const enrichmentStatusEnum = z.enum([
  'discovered',
  'source_detailed',
  'tanji_matched',
  'tanji_enriched',
  'unmatched',
  'failed',
]);
export const jobStatusEnum = z.enum(['pending', 'running', 'waiting_quota', 'done', 'failed', 'dead', 'cancelled']);
export const stageEnum = z.enum([
  'source_detail',
  'tanji_match',
  'tanji_detail',
  'unlock',
  'contact_sync',
  'platform_profile',
  'platform_jobs',
  'customs',
]);
export const eventTypeEnum = z.enum(EVENT_TYPES as [string, ...string[]]);
export const platformStatusEnum = z.enum(['active', 'stale', 'lost']);
export const jobLifecycleEnum = z.enum(['active', 'closed']);

const isoDateTime = z
  .string()
  .min(4)
  .refine((v) => Number.isFinite(Date.parse(v)), { message: 'must be an ISO 8601 date-time' });

const csvString = z
  .string()
  .min(1)
  .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean));

const idParam = z.string().min(1).max(128);

/* ------------------------------------------------------------------ */
/* 通用响应片段                                                         */
/* ------------------------------------------------------------------ */

export const metaView = z
  .object({
    schemaVersion: z.string(),
    requestId: z.string(),
    timestamp: z.string(),
    tookMs: z.number(),
    warnings: z.array(z.string()).optional(),
    nextCursor: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

export const errorView = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const envelopeView = <T extends z.ZodTypeAny>(data: T) =>
  z.object({
    ok: z.boolean(),
    data: z.union([data, z.null()]),
    meta: metaView,
    error: z.union([errorView, z.null()]),
  });

export const paginatedView = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    nextCursor: z.union([z.string(), z.null()]).optional(),
  });

/** 透传对象：OpenAPI 里退化为 object {}，字段以服务实现为准 */
export const opaqueObject = z.record(z.string(), z.unknown());

/* ------------------------------------------------------------------ */
/* Goals                                                               */
/* ------------------------------------------------------------------ */

export const goalRegionView = z
  .object({
    province: z.string().min(1).describe('省名（如 河北省）或 GB/T 2260 省 code'),
    provinceCode: z.string().regex(/^\d{6}$/).optional(),
    cityCodes: z.array(z.string().regex(/^\d{6}$/)).max(50).optional().describe('缺省=全省所有地级市'),
  })
  .strict();

export const goalScheduleView = z
  .object({
    cron: z
      .string()
      .regex(/^\S+(\s+\S+){4}$/, 'must be a 5-field cron expression')
      .default('0 2 * * *')
      .describe('5 段 cron，默认 0 2 * * *'),
    timeZone: z.string().min(1).default('Asia/Shanghai'),
    timeWindow: z.string().nullable().optional(),
  })
  .strict();

export const goalUnlockPolicyView = z
  .object({
    mode: z.literal('priority').default('priority'),
    order: z
      .array(z.string().min(1))
      .min(1)
      .default([...DEFAULT_UNLOCK_POLICY.order]),
  })
  .strict();

export const goalKeywordsView = z.record(platformEnum, z.array(z.string().min(1)));

export const goalCreateBody = z
  .object({
    name: z.string().min(1).max(200),
    region: goalRegionView,
    platforms: z.array(platformEnum).min(1).default([...PLATFORMS]),
    keywords: goalKeywordsView.optional(),
    maxLeadsPerRun: z.number().int().positive().nullable().optional(),
    dailyLeadLimit: z.number().int().positive().nullable().optional(),
    schedule: goalScheduleView.optional(),
    priority: z.number().int().min(0).max(10_000).default(100),
    tradeFilter: z.unknown().nullable().optional(),
    unlockPolicy: goalUnlockPolicyView.optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export const goalUpdateBody = goalCreateBody.partial().extend({
  expectedVersion: z.number().int().positive().optional().describe('乐观锁：版本不一致返回 CONFLICT'),
}).strict();

export const resolvedCityView = z.object({
  code: z.string(),
  name: z.string(),
  platformValues: z.record(z.string(), z.string()).describe('各平台实际检索值（Boss cityCode / 智联 code / Ali code / Mic 英文名）'),
});

export const goalView = z
  .object({
    id: z.string(),
    name: z.string(),
    region: goalRegionView,
    platforms: z.array(platformEnum),
    keywords: goalKeywordsView,
    maxLeadsPerRun: z.number().int().nullable(),
    dailyLeadLimit: z.number().int().nullable(),
    schedule: goalScheduleView,
    priority: z.number().int(),
    tradeFilter: z.unknown().nullable(),
    unlockPolicy: goalUnlockPolicyView,
    enabled: z.boolean(),
    version: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
    resolvedCities: z.array(resolvedCityView).optional(),
    latestRun: z.unknown().nullable().optional(),
    recentRuns: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const goalListQuery = z
  .object({
    enabled: z
      .enum(['true', 'false', '1', '0'])
      .optional()
      .describe('是否启用过滤'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const goalIdParams = z.object({ id: idParam }).strict();
export const goalRunsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const goalListData = z.object({
  items: z.array(goalView),
  total: z.number().int().nonnegative(),
});
/** 单 Goal 响应：直接返回 Goal 对象（docs/03 §2） */
export const goalViewData = goalView.passthrough();
export const goalArchivedData = z.object({ id: z.string(), archived: z.boolean() });

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export const runView = z
  .object({
    id: z.string(),
    goalId: z.string(),
    trigger: z.enum(['cron', 'manual']),
    status: goalRunStatusEnum,
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    stats: z.record(z.string(), z.unknown()),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    createdAt: z.string(),
    progress: z.unknown().optional(),
    queries: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const runListQuery = z
  .object({
    goalId: z.string().optional(),
    status: goalRunStatusEnum.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export const runIdParams = z.object({ id: idParam }).strict();
export const runListData = z.object({ items: z.array(runView), total: z.number().int().nonnegative() });
/** 单 Run 响应：直接返回 Run 对象（含 progress/queries） */
export const runViewData = runView.passthrough();
/** POST /v1/goals/{id}/run 的 202 返回：Run 对象 */
export const goalRunData = runView.passthrough();

/* ------------------------------------------------------------------ */
/* Companies                                                           */
/* ------------------------------------------------------------------ */

export const companyListQuery = z
  .object({
    province: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    platform: platformEnum.optional(),
    unlockStatus: unlockStatusEnum.optional(),
    enrichmentStatus: enrichmentStatusEnum.optional(),
    q: z.string().min(2).max(100).optional(),
    updatedSince: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    cursor: z.string().optional(),
  })
  .strict();

export const companySummaryView = z
  .object({
    id: z.string(),
    name: z.string(),
    englishName: z.string().nullable().optional(),
    uscc: z.string().nullable().optional(),
    province: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    scale: z.string().nullable().optional(),
    sourceCount: z.number().int().nonnegative(),
    platforms: z.array(platformEnum),
    enrichmentStatus: enrichmentStatusEnum,
    unlockStatus: unlockStatusEnum,
    contactCount: z.number().int().nullable().optional(),
    tradeTags: z.array(z.string()),
    version: z.number().int().optional(),
    firstSeenAt: z.string().optional(),
    lastSeenAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const companyListData = paginatedView(companySummaryView);

export const companyIdParams = z.object({ id: idParam }).strict();

export const companyDetailQuery = z
  .object({
    include: csvString.optional().describe('额外区块，逗号分隔：platforms,customs,contacts,sources,changes,snapshots'),
  })
  .strict();

export const sourceView = z
  .object({
    id: z.string().optional(),
    platform: platformEnum,
    platformCompanyId: z.string(),
    sourceName: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    cityName: z.string().nullable().optional(),
    evidence: z.record(z.string(), z.unknown()).optional(),
    firstSeenAt: z.string().optional(),
    lastSeenAt: z.string().optional(),
  })
  .passthrough();

export const contactView = z
  .object({
    id: z.string().optional(),
    name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    department: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    type: z.enum(['mobile', 'phone', 'email']),
    value: z.string(),
    masked: z.boolean().optional(),
    source: z.string().nullable().optional(),
    isKey: z.boolean().optional(),
    unlockedAt: z.string().nullable().optional(),
  })
  .passthrough();

export const companyDetailData = z
  .object({
    company: companySummaryView.passthrough(),
    sources: z.array(sourceView).optional(),
    contacts: z
      .union([
        z.array(contactView),
        z.object({
          total: z.number().int().nonnegative(),
          unlocked: z.number().int().nonnegative(),
          items: z.array(contactView),
        }),
      ])
      .optional(),
    recentChanges: z.array(z.unknown()).optional(),
    platforms: z.array(z.unknown()).optional(),
    customs: z.unknown().nullable().optional(),
    snapshots: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const companySourcesData = z.object({ items: z.array(sourceView), total: z.number().int().optional() });

export const snapshotQuery = z
  .object({
    kind: z.string().min(1).optional(),
    platform: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(20),
    cursor: z.string().optional(),
    include: csvString.optional().describe('include=payload 时返回解压后原始载荷（调试用）'),
  })
  .strict();

export const snapshotView = z
  .object({
    id: z.number().int(),
    kind: z.string(),
    platform: z.string().nullable().optional(),
    runId: z.string().nullable().optional(),
    refType: z.string().nullable().optional(),
    refId: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    blobHash: z.string(),
    fetchedAt: z.string(),
    archived: z.boolean().optional(),
    archivePath: z.string().nullable().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();

export const snapshotListData = paginatedView(snapshotView);

export const contactsQuery = z
  .object({
    type: z.enum(['mobile', 'phone', 'email']).optional(),
    unlockedOnly: z.enum(['true', 'false', '1', '0']).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    cursor: z.string().optional(),
  })
  .strict();

export const contactsListData = z.object({
  items: z.array(contactView),
  total: z.number().int().nonnegative(),
  unlocked: z.number().int().nonnegative(),
  nextCursor: z.union([z.string(), z.null()]).optional(),
});

export const companyChangesQuery = z
  .object({
    sinceVersion: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  })
  .strict();

export const changeView = z
  .object({
    seq: z.number().int(),
    eventId: z.string().optional(),
    type: z.string(),
    eventType: z.string().optional(),
    companyId: z.string(),
    version: z.number().int(),
    occurredAt: z.string(),
    source: z.string(),
    runId: z.string().nullable().optional(),
    actor: z.string().nullable().optional(),
    entityType: z.string().optional(),
    entityId: z.string().nullable().optional(),
    field: z.string().nullable().optional(),
    oldValue: z.unknown().optional(),
    newValue: z.unknown().optional(),
    valueType: z.string().nullable().optional(),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const changeListData = z.object({
  items: z.array(changeView),
  nextCursor: z.union([z.string(), z.null()]).optional(),
  hasMore: z.boolean().optional(),
});

export const companyChangesData = z.object({
  items: z.array(changeView),
  nextCursor: z.union([z.string(), z.null()]).optional(),
});

/** 手工干预动作（rematch / unlock / refresh / customs-refresh）的 202 返回 */
export const jobAcceptedData = z
  .object({
    jobId: z.string().optional(),
    id: z.string().optional(),
    status: z.string().optional(),
    accepted: z.boolean().optional(),
    queued: z.boolean().optional(),
    message: z.string().optional(),
  })
  .passthrough();

export const unlockBody = z
  .object({
    idempotencyKey: z.string().min(1).max(200).optional().describe('缺省 <companyId>:<yyyy-mm-dd>'),
    note: z.string().max(500).optional(),
  })
  .strict();

export const rematchBody = z
  .object({
    force: z.boolean().optional(),
    note: z.string().max(500).optional(),
  })
  .strict();

export const emptyBody = z.object({}).strict();

/* ------------------------------------------------------------------ */
/* Platform profiles / jobs                                            */
/* ------------------------------------------------------------------ */

export const platformParam = z.object({ id: idParam, platform: platformEnum }).strict();

export const platformCardView = z
  .object({
    platform: platformEnum,
    platformStatus: platformStatusEnum.optional(),
    displayName: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    cityName: z.string().nullable().optional(),
    industry: z.string().nullable().optional(),
    scale: z.string().nullable().optional(),
    jobCount: z.number().int().nullable().optional(),
    bossCount: z.number().int().nullable().optional(),
    recruiters: z.array(z.unknown()).optional(),
    latestJobs: z.array(z.unknown()).optional(),
    store: z.record(z.string(), z.unknown()).nullable().optional(),
    lastFetchedAt: z.string().optional(),
    nextJobsRefreshAt: z.string().nullable().optional(),
    nextStoreRefreshAt: z.string().nullable().optional(),
  })
  .passthrough();

export const platformListData = z.object({ items: z.array(platformCardView), total: z.number().int().optional() });
export const platformDetailData = platformCardView.passthrough();

export const platformJobsQuery = z
  .object({
    status: jobLifecycleEnum.default('active'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const platformJobView = z
  .object({
    jobId: z.string().optional(),
    id: z.string().optional(),
    title: z.string(),
    salaryText: z.string().nullable().optional(),
    salaryMin: z.number().nullable().optional(),
    salaryMax: z.number().nullable().optional(),
    cityName: z.string().nullable().optional(),
    district: z.string().nullable().optional(),
    degree: z.string().nullable().optional(),
    experience: z.string().nullable().optional(),
    publishTime: z.string().nullable().optional(),
    recruiterName: z.string().nullable().optional(),
    recruiterTitle: z.string().nullable().optional(),
    jobUrl: z.string().nullable().optional(),
    status: z.string().optional(),
    firstSeenAt: z.string().optional(),
    lastSeenAt: z.string().optional(),
    closedAt: z.string().nullable().optional(),
  })
  .passthrough();

export const platformJobListData = paginatedView(platformJobView);

export const platformChangesQuery = z
  .object({
    sinceVersion: z.coerce.number().int().min(0).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  })
  .strict();

export const platformChangesData = z.object({
  items: z.array(changeView),
  nextCursor: z.union([z.string(), z.null()]).optional(),
});

export const refreshBody = z
  .object({
    platforms: z.array(platformEnum).min(1).optional(),
    kinds: z.array(z.enum(['profile', 'jobs', 'store', 'customs'])).min(1).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Customs                                                             */
/* ------------------------------------------------------------------ */

export const customsView = z
  .object({
    status: z.string().optional(),
    confidence: z.enum(['high', 'medium', 'low', 'none']),
    sampled: z.boolean(),
    englishName: z.string().nullable().optional(),
    chineseName: z.string().nullable().optional(),
    queryNames: z.array(z.string()).optional(),
    totals: z.record(z.string(), z.unknown()).optional(),
    sample: z.record(z.string(), z.unknown()).optional(),
    dateRange: z.object({ min: z.string().nullable(), max: z.string().nullable() }).optional(),
    topDestinations: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    topOrigins: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    topHs4: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    topProducts: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    topBuyers: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    topSuppliers: z.array(z.object({ key: z.string(), count: z.number() })).optional(),
    sampleRecords: z.array(z.unknown()).optional(),
    lastFetchedAt: z.string().optional(),
    nextRefreshAt: z.string().nullable().optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Changes / events                                                    */
/* ------------------------------------------------------------------ */

export const changesQuery = z
  .object({
    sinceSeq: z.coerce.number().int().min(0).default(0),
    types: csvString.optional().describe('逗号分隔事件类型过滤'),
    companyId: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().optional(),
  })
  .strict();

export const changesData = z.object({
  items: z.array(changeView),
  nextSeq: z.number().int(),
  hasMore: z.boolean(),
  nextCursor: z.union([z.string(), z.null()]).optional(),
});

export const streamQuery = z
  .object({
    types: csvString.optional(),
    sinceSeq: z.coerce.number().int().min(0).optional(),
    companyId: z.string().optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Webhooks                                                            */
/* ------------------------------------------------------------------ */

export const webhookView = z
  .object({
    id: z.string(),
    url: z.string(),
    eventTypes: z.array(z.string()),
    active: z.boolean(),
    description: z.string().nullable().optional(),
    secret: z.string().optional().describe('仅创建响应返回一次明文；列表接口脱敏'),
    secretMasked: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const webhookCreateBody = z
  .object({
    url: z.string().url(),
    eventTypes: z.array(z.string().min(1)).min(1),
    secret: z.string().min(8).max(256).optional().describe('缺省服务端随机生成'),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

export const webhookUpdateBody = z
  .object({
    url: z.string().url().optional(),
    eventTypes: z.array(z.string().min(1)).min(1).optional(),
    active: z.boolean().optional(),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

export const webhookIdParams = z.object({ id: idParam }).strict();
export const webhookListData = z.object({ items: z.array(webhookView), total: z.number().int().optional() });
export const webhookDeleteData = z.object({ id: z.string(), deleted: z.boolean() });

export const deliveriesQuery = z
  .object({
    status: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const deliveryView = z
  .object({
    id: z.string(),
    subscriptionId: z.string().optional(),
    eventSeq: z.number().int().optional(),
    eventType: z.string().optional(),
    status: z.string(),
    attempts: z.number().int().optional(),
    nextRetryAt: z.string().nullable().optional(),
    responseStatus: z.number().int().nullable().optional(),
    lastError: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    deliveredAt: z.string().nullable().optional(),
  })
  .passthrough();

export const deliveryListData = paginatedView(deliveryView);
export const deliveryReplayParams = z.object({ id: idParam, deliveryId: idParam }).strict();
export const deliveryReplayData = z
  .object({ id: z.string().optional(), deliveryId: z.string().optional(), replayed: z.boolean().optional(), status: z.string().optional() })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Jobs                                                                */
/* ------------------------------------------------------------------ */

export const jobsQuery = z
  .object({
    status: jobStatusEnum.optional(),
    stage: stageEnum.optional(),
    companyId: z.string().optional(),
    platform: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export const jobView = z
  .object({
    id: z.string(),
    companyId: z.string(),
    platform: z.string().nullable().optional(),
    runId: z.string().nullable().optional(),
    stage: z.string(),
    status: z.string(),
    attempts: z.number().int().optional(),
    maxAttempts: z.number().int().optional(),
    nextRetryAt: z.string().nullable().optional(),
    leaseOwner: z.string().nullable().optional(),
    leaseUntil: z.string().nullable().optional(),
    lastError: z.string().nullable().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const jobListData = paginatedView(jobView);
export const jobIdParams = z.object({ id: idParam }).strict();
export const jobDetailData = jobView.passthrough();
export const jobRetryData = jobView.passthrough();

/* ------------------------------------------------------------------ */
/* Sources / quota / stats                                             */
/* ------------------------------------------------------------------ */

export const sourceHealthView = z
  .object({
    platform: allPlatformEnum,
    state: z.enum(['ok', 'degraded', 'session_invalid', 'verification_pending', 'unavailable']),
    loggedIn: z.boolean().nullable(),
    expiresAt: z.string().nullable().optional(),
    checkedAt: z.string().optional(),
    consecutiveFailures: z.number().int().optional(),
    detail: z.record(z.string(), z.unknown()).nullable().optional(),
    recentError: z.string().nullable().optional(),
    rateLimit: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .passthrough();

export const sourcesData = z.object({
  items: z.array(sourceHealthView),
  updatedAt: z.string().optional(),
});

export const quotaLayerView = z.object({
  limit: z.number(),
  used: z.number(),
  remaining: z.number(),
  unit: z.string(),
});

export const quotaData = z
  .object({
    daily: quotaLayerView,
    monthly: quotaLayerView,
    enterpriseMonthly: quotaLayerView.optional(),
    settlementDay: z.number().int().nullable().optional(),
    nearlySevenDayUnlockCount: z.number().int().nullable().optional(),
    observedAt: z.string().nullable().optional(),
    recentUnlockCurve: z.array(z.object({ date: z.string(), count: z.number() })).optional(),
    alerts: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const statsQuery = z
  .object({
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    kind: z.enum(['summary', 'coverage', 'unlocks']).default('summary'),
    runId: z.string().optional(),
  })
  .strict();

export const coverageStatsView = z.object({
  uniqueCompanies: z.number().int(),
  crossSourceOverlap: z.number().int(),
  coverageByCity: z.record(z.string(), z.number()),
  keywordYield: z.record(z.string(), z.number()),
});

export const statsData = z
  .object({
    from: z.string().nullable().optional(),
    to: z.string().nullable().optional(),
    kind: z.string().optional(),
    companies: z.record(z.string(), z.unknown()).optional(),
    enrichment: z.record(z.string(), z.unknown()).optional(),
    unlock: z.record(z.string(), z.unknown()).optional(),
    events: z.record(z.string(), z.unknown()).optional(),
    runs: z.record(z.string(), z.unknown()).optional(),
    coverage: coverageStatsView.optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Health / Status（foundation 实现，契约在此）                          */
/* ------------------------------------------------------------------ */

export const healthData = z
  .object({
    status: z.literal('ok'),
    version: z.string(),
    uptimeSec: z.number(),
    timestamp: z.string(),
  })
  .passthrough();

export const statusData = z
  .object({
    service: z.string(),
    version: z.string(),
    nodeEnv: z.string().optional(),
    uptimeSec: z.number().optional(),
    time: z.string().optional(),
    db: z
      .object({
        ok: z.boolean().optional(),
        sizeBytes: z.number().optional(),
        schemaVersion: z.number().optional(),
        companies: z.number().optional(),
        changes: z.number().optional(),
      })
      .passthrough()
      .optional(),
    scheduler: z.record(z.string(), z.unknown()).optional(),
    queue: z.record(z.string(), z.number()).optional(),
    refresh: z.record(z.string(), z.unknown()).optional(),
    upstream: z.array(z.record(z.string(), z.unknown())).or(z.record(z.string(), z.unknown())).optional(),
    quota: z.unknown().nullable().optional(),
    alerts: z.array(z.string()).optional(),
    coverage: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export const backupData = z
  .object({
    ok: z.boolean().optional(),
    path: z.string(),
    bytes: z.number().int().nonnegative().optional(),
    createdAt: z.string().optional(),
    schemaVersion: z.number().int().optional(),
  })
  .passthrough();

export const archiveBody = z
  .object({
    afterDays: z.number().int().min(1).max(3650).optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const archiveData = z
  .object({
    dryRun: z.boolean(),
    afterDays: z.number().int(),
    cutoff: z.string(),
    snapshotCount: z.number().int(),
    blobCount: z.number().int(),
    bytes: z.number().int(),
    months: z.array(
      z.object({
        month: z.string(),
        dir: z.string(),
        manifestPath: z.string(),
        snapshotCount: z.number().int(),
        blobCount: z.number().int(),
        bytes: z.number().int(),
      }),
    ),
  })
  .passthrough();

export const archiveManifestsData = z.object({
  items: z.array(
    z
      .object({
        month: z.string(),
        path: z.string(),
        snapshotCount: z.number().int(),
        blobCount: z.number().int(),
        bytes: z.number().int(),
        createdAt: z.string().optional(),
        schemaVersion: z.number().int().optional(),
      })
      .passthrough(),
  ),
});

export const verifyQuery = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  })
  .strict();

export const verifyData = z.object({
  ok: z.boolean(),
  months: z.array(
    z
      .object({
        month: z.string(),
        ok: z.boolean(),
        checkedFiles: z.number().int(),
        problems: z.array(z.string()),
      })
      .passthrough(),
  ),
});

export const restoreBody = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe('缺省恢复全部归档月份'),
    dryRun: z.boolean().optional(),
  })
  .strict();

export const restoreData = z
  .object({
    dryRun: z.boolean(),
    months: z.array(z.string()),
    restoredSnapshots: z.number().int(),
    restoredBlobs: z.number().int(),
  })
  .passthrough();

export const dbStatsData = z
  .object({
    dbPath: z.string().optional(),
    sizeBytes: z.number().optional(),
    walBytes: z.number().optional(),
    schemaVersion: z.number().int().optional(),
    tables: z.record(z.string(), z.number()),
    archive: z.record(z.string(), z.unknown()).optional(),
    backups: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
