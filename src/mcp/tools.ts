/**
 * MCP 工具清单（与 REST 同源映射）。
 *
 * 工具只代理 REST（MCP 进程不持有 DB/浏览器）；REST 未启动时返回 SERVICE_UNAVAILABLE。
 * scripts/gen.ts 由此生成 spec/mcp-tools.json；src/mcp/server.ts 由此注册工具。
 */
import { z } from 'zod';

export type McpHttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  /** MCP 工具入参（zod raw shape） */
  inputSchema: Record<string, z.ZodTypeAny>;
  /** 对应 REST 端点；:param 为路径参数 */
  rest: { method: McpHttpMethod; path: string };
  /** 入参中作为路径参数的 key（默认从 rest.path 解析） */
  pathParams?: string[];
  /** 入参中作为 query 的 key（其余非路径参数作为 body） */
  queryParams?: string[];
  /** SSE 工具：GET text/event-stream，服务端截断窗口后返回事件数组 */
  sse?: { timeoutKey: string; maxEventsKey: string; defaultTimeoutSec: number; defaultMaxEvents: number };
}

const platform = z.enum(['boss', 'zhilian', 'ali', 'mic']);
const limit = (max = 200) => z.number().int().min(1).max(max).optional();
const cursor = z.string().optional();
const id = z.string().min(1).describe('业务 ID（如 cmp_xxx / goal_xxx / run_xxx）');

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'lead_status',
    title: '服务运行状态',
    description:
      'LeadPlatform 运行态总览：版本、DB、队列积压、调度、上游健康、额度、告警。对应 GET /v1/status。',
    inputSchema: {},
    rest: { method: 'GET', path: '/v1/status' },
  },
  {
    name: 'lead_quota',
    title: '探迹额度',
    description:
      '探迹三层额度（日用/月用/企业月）、结算日、最近 7 天解锁数与最近观测时间。对应 GET /v1/quota。',
    inputSchema: {},
    rest: { method: 'GET', path: '/v1/quota' },
  },
  {
    name: 'lead_sources',
    title: '上游来源健康',
    description:
      '五个上游（boss/zhilian/ali/mic/tanji/fuma）健康、登录态、限频与最近错误。对应 GET /v1/sources。',
    inputSchema: {},
    rest: { method: 'GET', path: '/v1/sources' },
  },
  {
    name: 'lead_goals_list',
    title: 'Goal 列表',
    description: '列出区域目标 Goal；可按 enabled 过滤。对应 GET /v1/goals。',
    inputSchema: {
      enabled: z.boolean().optional().describe('true=仅启用，false=仅停用'),
      limit: limit(),
      offset: z.number().int().min(0).optional(),
    },
    queryParams: ['enabled', 'limit', 'offset'],
    rest: { method: 'GET', path: '/v1/goals' },
  },
  {
    name: 'lead_goal_get',
    title: 'Goal 详情',
    description: 'Goal 详情：区域、平台、关键词、resolvedCities、最近 runs。对应 GET /v1/goals/{id}。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/goals/:id' },
  },
  {
    name: 'lead_goal_create',
    title: '创建 Goal',
    description:
      '创建区域目标（省 + 可选城市/平台/关键词/上限/频率）。返回含 resolvedCities 的 Goal。对应 POST /v1/goals；校验失败返回 VALIDATION_ERROR。',
    inputSchema: {
      name: z.string().min(1),
      region: z.object({
        province: z.string().min(1).describe('省名（河北省）或 GB code（130000）'),
        provinceCode: z.string().optional(),
        cityCodes: z.array(z.string()).optional().describe('缺省=全省地级市'),
      }),
      platforms: z.array(platform).min(1).optional(),
      keywords: z.record(platform, z.array(z.string())).optional(),
      maxLeadsPerRun: z.number().int().positive().nullable().optional(),
      dailyLeadLimit: z.number().int().positive().nullable().optional(),
      schedule: z
        .object({
          cron: z.string().optional(),
          timeZone: z.string().optional(),
          timeWindow: z.string().nullable().optional(),
        })
        .optional(),
      priority: z.number().int().min(0).optional(),
      unlockPolicy: z.object({ mode: z.literal('priority').optional(), order: z.array(z.string()).optional() }).optional(),
      enabled: z.boolean().optional(),
    },
    rest: { method: 'POST', path: '/v1/goals' },
  },
  {
    name: 'lead_goal_update',
    title: '更新 Goal',
    description:
      '更新 Goal 字段（name/region/platforms/keywords/limits/schedule/priority/enabled）。可用 expectedVersion 乐观锁；冲突返回 CONFLICT。对应 PATCH /v1/goals/{id}。',
    inputSchema: {
      id,
      name: z.string().min(1).optional(),
      region: z
        .object({
          province: z.string().optional(),
          provinceCode: z.string().optional(),
          cityCodes: z.array(z.string()).optional(),
        })
        .optional(),
      platforms: z.array(platform).min(1).optional(),
      keywords: z.record(platform, z.array(z.string())).optional(),
      maxLeadsPerRun: z.number().int().positive().nullable().optional(),
      dailyLeadLimit: z.number().int().positive().nullable().optional(),
      schedule: z
        .object({ cron: z.string().optional(), timeZone: z.string().optional(), timeWindow: z.string().nullable().optional() })
        .optional(),
      priority: z.number().int().min(0).optional(),
      enabled: z.boolean().optional(),
      expectedVersion: z.number().int().positive().optional(),
    },
    pathParams: ['id'],
    rest: { method: 'PATCH', path: '/v1/goals/:id' },
  },
  {
    name: 'lead_goal_run',
    title: '手动触发 Run',
    description:
      '手动触发一次采集 Run（202）。同一 Goal 已有运行中 Run 时返回 RUN_IN_PROGRESS。对应 POST /v1/goals/{id}/run。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/goals/:id/run' },
  },
  {
    name: 'lead_runs_list',
    title: 'Run 列表',
    description: '运行历史列表，可按 goalId/status 过滤。对应 GET /v1/runs。',
    inputSchema: {
      goalId: z.string().optional(),
      status: z.enum(['pending', 'running', 'completed', 'partial', 'failed', 'cancelled']).optional(),
      limit: limit(),
      offset: z.number().int().min(0).optional(),
    },
    queryParams: ['goalId', 'status', 'limit', 'offset'],
    rest: { method: 'GET', path: '/v1/runs' },
  },
  {
    name: 'lead_run_get',
    title: 'Run 详情',
    description: 'Run 状态 + 平台/城市/关键词级进度。对应 GET /v1/runs/{id}。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/runs/:id' },
  },
  {
    name: 'lead_run_cancel',
    title: '取消 Run',
    description: '取消运行中的 Run（在飞请求结束后停止）。对应 POST /v1/runs/{id}/cancel。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/runs/:id/cancel' },
  },
  {
    name: 'lead_companies_list',
    title: '公司列表（线索检索）',
    description:
      '按省/市/平台/解锁状态/补全状态/关键词检索公司；游标分页（meta.nextCursor）。对应 GET /v1/companies。',
    inputSchema: {
      province: z.string().optional(),
      city: z.string().optional(),
      platform: platform.optional(),
      unlockStatus: z.enum(['none', 'pending', 'waiting_quota', 'unlocked', 'failed']).optional(),
      enrichmentStatus: z
        .enum(['discovered', 'source_detailed', 'tanji_matched', 'tanji_enriched', 'unmatched', 'failed'])
        .optional(),
      q: z.string().min(2).optional(),
      updatedSince: z.string().optional(),
      limit: limit(),
      cursor,
    },
    queryParams: ['province', 'city', 'platform', 'unlockStatus', 'enrichmentStatus', 'q', 'updatedSince', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/companies' },
  },
  {
    name: 'lead_company_get',
    title: '公司详情',
    description:
      '公司主档 + 来源 + 联系人摘要 + 最近变更；include=platforms,customs 可追加平台卡片/海关画像。对应 GET /v1/companies/{id}。',
    inputSchema: { id, include: z.string().optional().describe('逗号分隔：platforms,customs,contacts,sources,changes') },
    pathParams: ['id'],
    queryParams: ['include'],
    rest: { method: 'GET', path: '/v1/companies/:id' },
  },
  {
    name: 'lead_company_sources',
    title: '公司来源证据',
    description: '公司出现在各平台/关键词/城市的来源证据。对应 GET /v1/companies/{id}/sources。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/companies/:id/sources' },
  },
  {
    name: 'lead_company_contacts',
    title: '公司联系人',
    description: '探迹联系人（明文，需 Bearer）。对应 GET /v1/companies/{id}/contacts。',
    inputSchema: {
      id,
      type: z.enum(['mobile', 'phone', 'email']).optional(),
      unlockedOnly: z.boolean().optional(),
      limit: limit(500),
    },
    pathParams: ['id'],
    queryParams: ['type', 'unlockedOnly', 'limit'],
    rest: { method: 'GET', path: '/v1/companies/:id/contacts' },
  },
  {
    name: 'lead_company_changes',
    title: '公司变更历史',
    description: '公司字段级变更历史（含平台字段路径、老值/新值/来源/run/版本）。对应 GET /v1/companies/{id}/changes。',
    inputSchema: {
      id,
      sinceVersion: z.number().int().min(0).optional(),
      limit: limit(500),
      cursor,
    },
    pathParams: ['id'],
    queryParams: ['sinceVersion', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/companies/:id/changes' },
  },
  {
    name: 'lead_company_platforms',
    title: '公司平台档案卡片',
    description: '各平台最新档案摘要（状态/岗位数/招聘者/店铺摘要/最近刷新时间）。对应 GET /v1/companies/{id}/platforms。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms' },
  },
  {
    name: 'lead_company_platform',
    title: '单平台完整档案',
    description: '单平台完整档案：Boss/智联含档案与招聘；Ali/Mic 含店铺 JSON。对应 GET /v1/companies/{id}/platforms/{platform}。',
    inputSchema: { id, platform },
    pathParams: ['id', 'platform'],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms/:platform' },
  },
  {
    name: 'lead_company_jobs',
    title: '公司在招/下线岗位',
    description:
      'Boss/智联岗位列表 + 历史（active/closed）。其它平台返回 UNSUPPORTED。对应 GET /v1/companies/{id}/platforms/{platform}/jobs。',
    inputSchema: {
      id,
      platform: z.enum(['boss', 'zhilian']),
      status: z.enum(['active', 'closed']).optional(),
      limit: limit(),
      cursor,
    },
    pathParams: ['id', 'platform'],
    queryParams: ['status', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/companies/:id/platforms/:platform/jobs' },
  },
  {
    name: 'lead_company_refresh',
    title: '手动刷新平台档案/岗位',
    description: '手动刷新平台档案/岗位（202 + job，可指定 platforms/kinds）。对应 POST /v1/companies/{id}/refresh。',
    inputSchema: {
      id,
      platforms: z.array(platform).optional(),
      kinds: z.array(z.enum(['profile', 'jobs', 'store', 'customs'])).optional(),
    },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/companies/:id/refresh' },
  },
  {
    name: 'lead_company_customs',
    title: '公司海关画像',
    description:
      'Ali/Mic 公司海关画像：出口/进口记录、目的国、HS、产品、买家、置信度（sampled=true）。其它公司返回 NOT_FOUND。对应 GET /v1/companies/{id}/customs。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/companies/:id/customs' },
  },
  {
    name: 'lead_company_customs_refresh',
    title: '手动刷新海关画像',
    description: '手动刷新海关画像（202 + job）。对应 POST /v1/companies/{id}/customs/refresh。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/companies/:id/customs/refresh' },
  },
  {
    name: 'lead_company_rematch',
    title: '重新匹配探迹主体',
    description: '手工重新匹配探迹主体（202 + job；保留纠正历史）。对应 POST /v1/companies/{id}/rematch。',
    inputSchema: { id, force: z.boolean().optional(), note: z.string().optional() },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/companies/:id/rematch' },
  },
  {
    name: 'lead_company_unlock',
    title: '手动优先解锁',
    description:
      '把公司提到解锁队列之前（202 + job）；idempotencyKey 缺省 <companyId>:<yyyy-mm-dd>。会消耗探迹额度。对应 POST /v1/companies/{id}/unlock。',
    inputSchema: { id, idempotencyKey: z.string().optional() },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/companies/:id/unlock' },
  },
  {
    name: 'lead_company_snapshots',
    title: '公司原始快照列表',
    description: '公司原始抓取快照元数据（不含 payload）。对应 GET /v1/companies/{id}/snapshots。',
    inputSchema: {
      id,
      kind: z.string().optional(),
      platform: z.string().optional(),
      limit: limit(),
      cursor,
    },
    pathParams: ['id'],
    queryParams: ['kind', 'platform', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/companies/:id/snapshots' },
  },
  {
    name: 'lead_changes',
    title: '全局增量变更',
    description:
      '按 sinceSeq 增量拉取变更（不漏不重），可按事件类型/公司过滤。对应 GET /v1/changes。',
    inputSchema: {
      sinceSeq: z.number().int().min(0).optional(),
      types: z.string().optional().describe('逗号分隔事件类型'),
      companyId: z.string().optional(),
      limit: limit(500),
      cursor,
    },
    queryParams: ['sinceSeq', 'types', 'companyId', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/changes' },
  },
  {
    name: 'lead_events_tail',
    title: '事件实时流（SSE 截断窗口）',
    description:
      '订阅 SSE 事件流并在窗口内收集事件（默认 5s / 50 条后返回数组）；可用 sinceSeq 续传。对应 GET /v1/events/stream。',
    inputSchema: {
      types: z.string().optional(),
      sinceSeq: z.number().int().min(0).optional(),
      companyId: z.string().optional(),
      timeoutSec: z.number().int().min(1).max(120).optional(),
      maxEvents: z.number().int().min(1).max(1000).optional(),
    },
    queryParams: ['types', 'sinceSeq', 'companyId'],
    sse: { timeoutKey: 'timeoutSec', maxEventsKey: 'maxEvents', defaultTimeoutSec: 5, defaultMaxEvents: 50 },
    rest: { method: 'GET', path: '/v1/events/stream' },
  },
  {
    name: 'lead_jobs_list',
    title: '流水线任务列表',
    description: '队列任务（status/stage/companyId 过滤；dead 死信可查）。对应 GET /v1/jobs。',
    inputSchema: {
      status: z.enum(['pending', 'running', 'waiting_quota', 'done', 'failed', 'dead', 'cancelled']).optional(),
      stage: z
        .enum([
          'source_detail',
          'tanji_match',
          'tanji_detail',
          'unlock',
          'contact_sync',
          'platform_profile',
          'platform_jobs',
          'customs',
        ])
        .optional(),
      companyId: z.string().optional(),
      limit: limit(),
      cursor,
    },
    queryParams: ['status', 'stage', 'companyId', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/jobs' },
  },
  {
    name: 'lead_job_get',
    title: '任务详情',
    description: '任务详情（attempts、lastError、lease）。对应 GET /v1/jobs/{id}。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'GET', path: '/v1/jobs/:id' },
  },
  {
    name: 'lead_job_retry',
    title: '重试任务',
    description: '重试失败/死信任务。对应 POST /v1/jobs/{id}/retry。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'POST', path: '/v1/jobs/:id/retry' },
  },
  {
    name: 'lead_webhooks_list',
    title: 'Webhook 订阅列表',
    description: 'webhook 订阅列表（secret 脱敏）。对应 GET /v1/webhooks。',
    inputSchema: {},
    rest: { method: 'GET', path: '/v1/webhooks' },
  },
  {
    name: 'lead_webhooks_create',
    title: '创建 Webhook 订阅',
    description: '创建 webhook 订阅（secret 仅创建时返回明文）。对应 POST /v1/webhooks。',
    inputSchema: {
      url: z.string().url(),
      eventTypes: z.array(z.string()).min(1),
      secret: z.string().min(8).optional(),
      description: z.string().optional(),
    },
    rest: { method: 'POST', path: '/v1/webhooks' },
  },
  {
    name: 'lead_webhooks_delete',
    title: '删除 Webhook 订阅',
    description: '删除订阅。对应 DELETE /v1/webhooks/{id}。',
    inputSchema: { id },
    pathParams: ['id'],
    rest: { method: 'DELETE', path: '/v1/webhooks/:id' },
  },
  {
    name: 'lead_webhook_deliveries',
    title: 'Webhook 投递记录',
    description: '投递记录（status 过滤，dead 死信可查）。对应 GET /v1/webhooks/{id}/deliveries。',
    inputSchema: { id, status: z.string().optional(), limit: limit(), cursor },
    pathParams: ['id'],
    queryParams: ['status', 'limit', 'cursor'],
    rest: { method: 'GET', path: '/v1/webhooks/:id/deliveries' },
  },
  {
    name: 'lead_webhook_replay',
    title: '重放 Webhook 投递',
    description: '重放一条投递记录。对应 POST /v1/webhooks/{id}/deliveries/{deliveryId}/replay。',
    inputSchema: { id, deliveryId: z.string().min(1) },
    pathParams: ['id', 'deliveryId'],
    rest: { method: 'POST', path: '/v1/webhooks/:id/deliveries/:deliveryId/replay' },
  },
  {
    name: 'lead_stats',
    title: '统计与覆盖度',
    description: '采集/补全/解锁/事件统计；kind=coverage 返回覆盖度指标。对应 GET /v1/stats。',
    inputSchema: {
      from: z.string().optional(),
      to: z.string().optional(),
      kind: z.enum(['summary', 'coverage', 'unlocks']).optional(),
      runId: z.string().optional(),
    },
    queryParams: ['from', 'to', 'kind', 'runId'],
    rest: { method: 'GET', path: '/v1/stats' },
  },
];

export const MCP_TOOLS_BY_NAME: Record<string, McpToolDef> = Object.fromEntries(MCP_TOOLS.map((t) => [t.name, t]));

/** 路径参数名（从 rest.path 解析 :xxx） */
export function toolPathParams(tool: McpToolDef): string[] {
  if (tool.pathParams) return tool.pathParams;
  return Array.from(tool.rest.path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);
}
