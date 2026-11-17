/**
 * 公司主档服务：公司 upsert / 去重归并 / 字段级 diff + change_events / 查询 / 任务入队。
 *
 * 设计（docs/02 §8、§9、§10；docs/03 §4）：
 * - 本模块只依赖「窄仓库端口」（与 F2 `src/repositories/*` 方法命名/签名对齐，结构化兼容），
 *   运行期由 main.ts 调用 `configureCompaniesService(...)` 注入；单测可注入内存 fake。
 * - `upsertSourceCompany`：来源公司 → 主档；USCC 精确 > tanji_company_id > 归一化名称+省市
 *   （决策复用 src/domain/dedupe.ts），来源记录写 company_sources，来源数刷新。
 * - `applyCompanyFields`：传入字段与主档逐字段 diff；有变化才 version+1，并按字段写
 *   change_events（entity_type=company，事件类型默认 company.updated）。
 * - `mergeCompanies`：探测到 tanji_company_id 已存在时合并两条公司记录（保留较完整字段 +
 *   全部来源），被合并方软删除（merged_into），写 company.merged 事件。
 * - `createRematchJob` / `createUnlockJob`：只入队 pipeline_jobs（async worker 消费），
 *   **绝不直接调用探迹 unlock**。
 *
 * API 导出（供 REST/CLI/MCP/流水线使用）：见文件末尾 `companiesServiceApi` 汇总。
 */
import { tryGetRepositories, type Repositories } from '../repositories/index.js';
import type {
  ChangeEventInput,
  Company,
  CompanySource,
  Contact,
  EnrichmentStatus,
  MatchMeta,
  Platform,
  Stage,
  UnlockStatus,
} from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { normalizeCompanyName } from '../domain/normalize.js';
import type {
  ChangeEventRecord,
  CompanyListOptions,
  CompanyPatch,
  CompanyUpdateOptions,
  CursorPage,
  EnqueueResult,
  FailJobOptions,
  NewCompany,
  NewCompanySource,
  NewContact,
  NewPipelineJob,
  PipelineJob,
  RawSnapshot,
  SnapshotListOptions,
} from '../repositories/types.js';
import {
  buildMatchMeta,
  mergeCompanyViews,
  normalizeUsccKey,
  planCompanyAttach,
  planFieldPatch,
  type DedupePlan,
  type ExistingCompanyView,
} from '../domain/dedupe.js';

// ---------------------------------------------------------------------------
// 窄仓库端口（与 F2 repositories 结构化兼容）
// ---------------------------------------------------------------------------

export interface CompaniesRepoPort {
  create(input: NewCompany): Company;
  getById(id: string, opts?: { includeMerged?: boolean }): Company | null;
  findByUscc(uscc: string): Company | null;
  findByTanjiId(tanjiCompanyId: string): Company | null;
  findByNormalizedName(normalizedName: string, opts?: { province?: string; city?: string }): Company[];
  update(id: string, patch: CompanyPatch, opts?: CompanyUpdateOptions): Company;
  listKeyset(opts?: CompanyListOptions): CursorPage<Company>;
  count?(filter?: Omit<CompanyListOptions, 'limit' | 'cursor'>): number;
}

export interface CompanySourcesRepoPort {
  upsert(input: NewCompanySource): { source: CompanySource; created: boolean };
  listByCompany(companyId: string): CompanySource[];
  countByCompany?(companyId: string): number;
}

export interface ContactsRepoPort {
  upsert?(input: NewContact): Contact;
  upsertMany?(inputs: NewContact[]): Contact[];
  listByCompany(companyId: string, opts?: { type?: Contact['type']; limit?: number }): Contact[];
  countByCompany?(companyId: string): number;
  summarizeByCompany?(companyId: string): { total: number; types: Record<string, number>; unlockedAt: string | null };
}

export interface PipelineJobsRepoPort {
  enqueue(input: NewPipelineJob & { resetExisting?: boolean }): EnqueueResult;
  getById(id: string): PipelineJob | null;
  findByIdentity?(companyId: string, stage: Stage, platform?: Platform | null): PipelineJob | null;
  claimNext(opts: {
    workerId: string;
    leaseSec?: number;
    stages?: Stage[];
    stage?: Stage;
    platform?: Platform | null;
    runId?: string;
    reclaimExpired?: boolean;
    now?: Date;
  }): PipelineJob | null;
  complete(id: string): PipelineJob | null;
  fail(id: string, opts: FailJobOptions): PipelineJob | null;
  listByCompany?(companyId: string): PipelineJob[];
}

export interface ChangeEventsRepoPort {
  append(input: ChangeEventInput): ChangeEventRecord;
  appendMany(inputs: ChangeEventInput[]): ChangeEventRecord[];
  listByCompany?(companyId: string, opts?: { limit?: number; afterSeq?: number; maxVersion?: number }): ChangeEventRecord[];
}

export interface SnapshotsRepoPort {
  listSnapshots(opts?: SnapshotListOptions): RawSnapshot[];
  getSnapshot?(id: number): RawSnapshot | null;
  writeText?(input: {
    kind: string;
    payload: unknown;
    platform?: string | null;
    runId?: string | null;
    refType?: string | null;
    refId?: string | null;
    url?: string | null;
    fetchedAt?: string;
  }): { snapshot: RawSnapshot; blobCreated: boolean };
}

/** 服务依赖（main.ts 注入 F2 repositories；单测注入 fake） */
export interface CompaniesServiceDeps {
  companies: CompaniesRepoPort;
  companySources?: CompanySourcesRepoPort;
  contacts?: ContactsRepoPort;
  jobs?: PipelineJobsRepoPort;
  changeEvents?: ChangeEventsRepoPort;
  snapshots?: SnapshotsRepoPort;
  /** 事务包装（F2：repos.transaction）；缺省时各写入顺序执行 */
  transaction?: <T>(fn: () => T) => T;
  /** 可注入时钟（测试） */
  now?: () => string;
}

// ---------------------------------------------------------------------------
// 默认依赖（main.ts 启动时 configure；避免服务层 import DB 单例）
// ---------------------------------------------------------------------------

let defaultDeps: CompaniesServiceDeps | null = null;

/** main.ts 启动（或在路由注册前）调用：注入 F2 repositories 子集 */
export function configureCompaniesService(deps: CompaniesServiceDeps | null): void {
  defaultDeps = deps;
}

/**
 * 由 F2 `Repositories` 聚合直接构造服务依赖（wiring 便捷入口）：
 * `configureCompaniesService(companiesDepsFromRepositories(repos))`。
 */
export function companiesDepsFromRepositories(repos: Repositories): CompaniesServiceDeps {
  return {
    companies: repos.companies,
    companySources: repos.companySources,
    contacts: repos.contacts,
    jobs: repos.jobs,
    changeEvents: repos.changeEvents,
    snapshots: repos.snapshots,
    transaction: <T>(fn: () => T): T => repos.transaction(fn),
  };
}

export function getCompaniesServiceDeps(): CompaniesServiceDeps {
  if (defaultDeps) return defaultDeps;
  // 未显式注入时回退到全局 repositories 单例（main.ts initRepositories 后可用）
  const repos = tryGetRepositories();
  if (repos) {
    defaultDeps = companiesDepsFromRepositories(repos);
    return defaultDeps;
  }
  throw new LeadError(
    'INTERNAL_ERROR',
    'companies 服务未配置：启动时请 initRepositories(db) 或调用 configureCompaniesService(companiesDepsFromRepositories(repos))',
    { details: { integrationPoints: ['src/services/companies.ts#configureCompaniesService', 'src/repositories/index.ts#initRepositories'] } },
  );
}

function resolveDeps(deps?: CompaniesServiceDeps | null): CompaniesServiceDeps {
  return deps ?? getCompaniesServiceDeps();
}

function timestamp(deps: CompaniesServiceDeps): string {
  return deps.now ? deps.now() : nowIso();
}

function runTx<T>(deps: CompaniesServiceDeps, fn: () => T): T {
  return deps.transaction ? deps.transaction(fn) : fn();
}

// ---------------------------------------------------------------------------
// 查询参数解析
// ---------------------------------------------------------------------------

type QueryValue = string | number | boolean | null | undefined | string[];

function asText(value: QueryValue): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value[0] ? String(value[0]) : undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

function asInt(value: QueryValue, name: string, def: number, min: number, max: number): number {
  const text = asText(value);
  if (text === undefined) return def;
  const n = Number(text);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new LeadError('VALIDATION_ERROR', `${name} 必须是整数：${text}`);
  }
  return Math.min(Math.max(n, min), max);
}

function asEnumList<T extends string>(value: QueryValue): T[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const items = list.map((v) => String(v).trim()).filter(Boolean) as T[];
  return items.length > 0 ? items : undefined;
}

function asStringList(value: QueryValue): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const items = list.map((v) => String(v).trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** 公司列表查询（REST 参数名与 docs/03 §4 对齐） */
export interface ListCompaniesQuery {
  province?: string;
  city?: string;
  platform?: string;
  unlockStatus?: string;
  enrichmentStatus?: string;
  q?: string;
  updatedSince?: string;
  limit?: number;
  cursor?: string;
  includeMerged?: boolean;
}

export interface CompanySummaryView extends Company {
  /** 来源平台列表（公司主档摘要用；按 company_sources 汇总） */
  sourcePlatforms: Platform[];
}

export interface CompanyListPage {
  items: CompanySummaryView[];
  nextCursor: string | null;
  hasMore: boolean;
  total?: number;
}

export interface CompanyDetailView {
  company: Company;
  sources: CompanySource[];
  contacts: {
    total: number;
    unlocked: number;
    items: Contact[];
  };
  recentChanges: Array<Pick<ChangeEventRecord, 'seq' | 'version' | 'eventType' | 'field' | 'occurredAt'> & { field: string | null }>;
}

// ---------------------------------------------------------------------------
// 1. 公司列表 / 详情 / 来源 / 快照 / 联系人 / 变更
// ---------------------------------------------------------------------------

function toSummary(company: Company, deps: CompaniesServiceDeps): CompanySummaryView {
  let platforms: Platform[] = [];
  if (deps.companySources) {
    try {
      platforms = [...new Set(deps.companySources.listByCompany(company.id).map((s) => s.platform))];
    } catch {
      platforms = [];
    }
  }
  return { ...company, sourcePlatforms: platforms };
}

/** GET /v1/companies */
export async function listCompanies(
  query: ListCompaniesQuery | Record<string, unknown> = {},
  deps?: CompaniesServiceDeps,
): Promise<CompanyListPage> {
  const d = resolveDeps(deps);
  const q = query as Record<string, QueryValue>;
  const limit = asInt(q.limit, 'limit', 20, 1, 200);
  const filter: CompanyListOptions = {
    limit,
    // 对外公司列表只返回探迹确认公司；内部草稿需显式 includeLeads=true
    verified: !['true', '1', 'yes'].includes(String(q.includeLeads ?? '').toLowerCase()),
    cursor: asText(q.cursor) ?? null,
    ...(asText(q.province) ? { province: asText(q.province) } : {}),
    ...(asText(q.city) ? { city: asText(q.city) } : {}),
    ...(asText(q.q) ? { q: asText(q.q) } : {}),
    ...(asText(q.platform) ? { sourcePlatform: asText(q.platform) as Platform } : {}),
    ...(asEnumList<UnlockStatus>(q.unlockStatus) ? { unlockStatus: asEnumList<UnlockStatus>(q.unlockStatus) } : {}),
    ...(asEnumList<EnrichmentStatus>(q.enrichmentStatus) ? { enrichmentStatus: asEnumList<EnrichmentStatus>(q.enrichmentStatus) } : {}),
    includeMerged: q.includeMerged === true || q.includeMerged === 'true',
  };
  const page = d.companies.listKeyset(filter);
  let total: number | undefined;
  if (d.companies.count) {
    const { limit: _limit, cursor: _cursor, ...countFilter } = filter;
    total = d.companies.count(countFilter);
  }
  return {
    items: page.items.map((company) => toSummary(company, d)),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    ...(total !== undefined ? { total } : {}),
  };
}

/** GET /v1/companies/{id}（?include=sources,contacts,changes 控制子资源） */
export async function getCompanyDetail(
  id: string,
  query: { include?: string[] | string } = {},
  deps?: CompaniesServiceDeps,
): Promise<CompanyDetailView> {
  const d = resolveDeps(deps);
  if (!id?.trim()) throw new LeadError('VALIDATION_ERROR', 'companyId 不能为空');
  const company = d.companies.getById(id);
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${id}`);
  // include 是「额外包含」，默认 sources/contacts/changes 始终返回（docs/03 §4）
  const include = new Set(['sources', 'contacts', 'changes', ...(asStringList(query.include as QueryValue) ?? [])]);
  const all = include.has('all');

  const sources = all || include.has('sources') ? (d.companySources?.listByCompany(company.id) ?? []) : [];

  let contacts: CompanyDetailView['contacts'] = { total: 0, unlocked: 0, items: [] };
  if (all || include.has('contacts')) {
    if (d.contacts) {
      const items = d.contacts.listByCompany(company.id);
      const summary = d.contacts.summarizeByCompany?.(company.id);
      contacts = {
        total: summary?.total ?? items.length,
        unlocked: items.filter((c) => !c.masked || Boolean(c.unlockedAt)).length,
        items,
      };
    }
  }

  let recentChanges: CompanyDetailView['recentChanges'] = [];
  if ((all || include.has('changes')) && d.changeEvents?.listByCompany) {
    recentChanges = d.changeEvents.listByCompany(company.id, { limit: 10 }).map((event) => ({
      seq: event.seq,
      version: event.version,
      eventType: event.eventType,
      field: event.field,
      occurredAt: event.occurredAt,
    }));
  }

  return { company, sources, contacts, recentChanges };
}

/** GET /v1/companies/{id}/sources */
export async function listCompanySources(id: string, deps?: CompaniesServiceDeps): Promise<CompanySource[]> {
  const d = resolveDeps(deps);
  requirePort(d.companySources, 'companySources');
  return d.companySources.listByCompany(id);
}

/** GET /v1/companies/{id}/snapshots（仅元数据；payload 需调试开关，本服务不返回） */
export async function listCompanySnapshots(
  id: string,
  query: Record<string, unknown> = {},
  deps?: CompaniesServiceDeps,
): Promise<{ items: RawSnapshot[]; nextCursor: string | null; hasMore: boolean }> {
  const d = resolveDeps(deps);
  requirePort(d.snapshots, 'snapshots');
  const limit = asInt(query.limit as QueryValue, 'limit', 20, 1, 200);
  const kind = asText(query.kind as QueryValue);
  const platform = asText(query.platform as QueryValue);
  const cursor = asText(query.cursor as QueryValue);
  let afterId: number | undefined;
  if (cursor) {
    const parsed = decodeSnapshotCursor(cursor);
    afterId = parsed.afterId;
  }
  const items = d.snapshots.listSnapshots({
    refType: 'company',
    refId: id,
    ...(kind ? { kind } : {}),
    ...(platform ? { platform } : {}),
    ...(afterId !== undefined ? { afterId } : {}),
    limit: limit + 1,
  });
  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: hasMore && last ? encodeSnapshotCursor({ afterId: last.id }) : null,
    hasMore,
  };
}

function encodeSnapshotCursor(payload: { afterId: number }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeSnapshotCursor(cursor: string): { afterId: number } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { afterId?: unknown };
    const afterId = Number(parsed.afterId);
    if (!Number.isFinite(afterId) || afterId < 0) throw new Error('bad afterId');
    return { afterId: Math.floor(afterId) };
  } catch {
    throw new LeadError('VALIDATION_ERROR', '无效的 snapshots cursor');
  }
}

/** GET /v1/companies/{id}/contacts（明文由路由层鉴权后决定是否脱敏） */
export async function listCompanyContacts(
  id: string,
  query: { type?: string; unlockedOnly?: boolean | string } = {},
  deps?: CompaniesServiceDeps,
): Promise<{ companyId: string; total: number; unlocked: number; items: Contact[] }> {
  const d = resolveDeps(deps);
  requirePort(d.contacts, 'contacts');
  const company = d.companies.getById(id);
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${id}`);
  const type = query.type && ['mobile', 'phone', 'email'].includes(query.type) ? (query.type as Contact['type']) : undefined;
  let items = d.contacts.listByCompany(id, type ? { type } : {});
  if (query.unlockedOnly === true || query.unlockedOnly === 'true') {
    items = items.filter((c) => Boolean(c.unlockedAt) || !c.masked);
  }
  const summary = d.contacts.summarizeByCompany?.(id);
  return {
    companyId: id,
    total: summary?.total ?? items.length,
    unlocked: items.filter((c) => Boolean(c.unlockedAt) || !c.masked).length,
    items,
  };
}

/** GET /v1/companies/{id}/changes（字段级变更；按 version/seq 升序） */
export async function listCompanyChanges(
  id: string,
  query: { sinceVersion?: number | string; afterSeq?: number | string; limit?: number | string; cursor?: string } = {},
  deps?: CompaniesServiceDeps,
): Promise<{ items: ChangeEventRecord[]; nextCursor: string | null; hasMore: boolean; nextSeq: number }> {
  const d = resolveDeps(deps);
  requirePort(d.changeEvents?.listByCompany, 'changeEvents.listByCompany');
  const company = d.companies.getById(id, { includeMerged: true });
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${id}`);
  const limit = asInt(query.limit as QueryValue, 'limit', 20, 1, 500);
  const afterSeq = query.afterSeq !== undefined ? asInt(query.afterSeq as QueryValue, 'afterSeq', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
  let cursorSeq: number | undefined;
  if (query.cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { seq?: unknown };
      const seq = Number(parsed.seq);
      if (Number.isFinite(seq) && seq >= 0) cursorSeq = Math.floor(seq);
    } catch {
      throw new LeadError('VALIDATION_ERROR', '无效的 changes cursor');
    }
  }
  const effectiveAfter = cursorSeq ?? afterSeq ?? 0;
  const records = d.changeEvents!.listByCompany!(id, { limit: limit + 1, afterSeq: effectiveAfter });
  const sinceVersion = query.sinceVersion !== undefined ? asInt(query.sinceVersion as QueryValue, 'sinceVersion', 0, 0, Number.MAX_SAFE_INTEGER) : undefined;
  const filtered = sinceVersion === undefined ? records : records.filter((r) => r.version > sinceVersion);
  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;
  const last = page[page.length - 1];
  const nextSeq = last?.seq ?? effectiveAfter;
  return {
    items: page,
    hasMore,
    nextSeq,
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ seq: nextSeq }), 'utf8').toString('base64url') : null,
  };
}

function requirePort<T>(value: T | null | undefined, name: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new LeadError('INTERNAL_ERROR', `companies 服务缺少依赖端口：${name}`, {
      details: { integrationPoints: ['src/services/companies.ts#configureCompaniesService'] },
    });
  }
}

// ---------------------------------------------------------------------------
// 2. 字段级 diff → change_events（docs/02 §10.2）
// ---------------------------------------------------------------------------

/** 参与变更事件的公司字段（entity_type=company） */
export const COMPANY_EVENT_FIELDS = [
  'name',
  'normalizedName',
  'englishName',
  'uscc',
  'tanjiCompanyId',
  'legalRepresentative',
  'regCapital',
  'foundTime',
  'operStatus',
  'industry',
  'scale',
  'province',
  'city',
  'district',
  'address',
  'businessScope',
  'homepage',
  'phoneCount',
  'emailCount',
  'contactCount',
  'tradeTags',
  'sourceCount',
  'enrichmentStatus',
  'unlockStatus',
  'matchMeta',
  'mergedInto',
  'extra',
  'lastSeenAt',
] as const;

export type CompanyEventField = (typeof COMPANY_EVENT_FIELDS)[number];

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function valueTypeOf(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

export interface FieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
  valueType: string;
}

/** 逐字段 diff（undefined = 不参与；仅返回实际变化的字段） */
export function diffCompanyFields(
  existing: Partial<Record<string, unknown>>,
  incoming: Partial<Record<string, unknown>>,
  fields: readonly string[] = COMPANY_EVENT_FIELDS,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field)) continue;
    const next = incoming[field];
    if (next === undefined) continue;
    const current = existing[field];
    if (stableJson(current) === stableJson(next)) continue;
    changes.push({
      field,
      oldValue: current === undefined ? null : current,
      newValue: next,
      valueType: valueTypeOf(next),
    });
  }
  return changes;
}

export interface FieldWriteContext {
  source: string;
  runId?: string | null;
  actor?: string | null;
  /** 事件类型（默认 company.updated；创建用 company.created，rematch 用 company.rematched） */
  eventType?: string;
  occurredAt?: string;
}

function appendFieldEvents(
  deps: CompaniesServiceDeps,
  companyId: string,
  version: number,
  changes: FieldChange[],
  ctx: FieldWriteContext,
): ChangeEventRecord[] {
  if (changes.length === 0) return [];
  requirePort(deps.changeEvents, 'changeEvents');
  const occurredAt = ctx.occurredAt ?? timestamp(deps);
  const events: ChangeEventInput[] = changes.map((change) => ({
    companyId,
    entityType: 'company',
    entityId: companyId,
    version,
    eventType: ctx.eventType ?? 'company.updated',
    field: change.field,
    oldValue: change.oldValue,
    newValue: change.newValue,
    valueType: change.valueType,
    source: ctx.source,
    runId: ctx.runId ?? null,
    actor: ctx.actor ?? undefined,
    occurredAt,
  }));
  if (deps.changeEvents?.appendMany) return deps.changeEvents.appendMany(events);
  return events.map((event) => deps.changeEvents!.append(event));
}

/**
 * 写入公司字段（diff → version+1 → 字段级 change_events，单事务）。
 *
 * @param incoming 部分字段；undefined = 不改；null = 显式置空（会记录变更）
 * @returns 更新后的公司 + 实际变化的字段名
 */
export async function applyCompanyFields(
  companyId: string,
  incoming: Partial<Company>,
  ctx: FieldWriteContext,
  deps?: CompaniesServiceDeps,
): Promise<{ company: Company; changed: FieldChange[] }> {
  const d = resolveDeps(deps);
  const existing = d.companies.getById(companyId);
  if (!existing) throw new LeadError('NOT_FOUND', `公司不存在：${companyId}`);

  // 仅允许 Company 字段（防止把任意对象写进主档）
  const candidate: Partial<Record<string, unknown>> = {};
  for (const field of COMPANY_EVENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(incoming, field)) {
      candidate[field] = (incoming as Record<string, unknown>)[field];
    }
  }
  const changes = diffCompanyFields(existing as unknown as Record<string, unknown>, candidate);
  if (changes.length === 0) return { company: existing, changed: [] };

  const patch: CompanyPatch = {};
  for (const change of changes) {
    (patch as Record<string, unknown>)[change.field] = change.newValue;
  }
  const updated = runTx(d, () => {
    const next = d.companies.update(companyId, patch, { bumpVersion: true, expectedVersion: existing.version });
    appendFieldEvents(d, companyId, next.version, changes, ctx);
    return next;
  });
  return { company: updated, changed: changes };
}

/** 记录 company.created 事件（新公司入库时调用；version=1） */
export function recordCompanyCreated(
  company: Company,
  ctx: FieldWriteContext & { initial?: Record<string, unknown> },
  deps?: CompaniesServiceDeps,
): void {
  const d = resolveDeps(deps);
  if (!d.changeEvents) return;
  const occurredAt = ctx.occurredAt ?? timestamp(d);
  d.changeEvents.append({
    companyId: company.id,
    entityType: 'company',
    entityId: company.id,
    version: company.version,
    eventType: 'company.created',
    field: null,
    oldValue: null,
    newValue: ctx.initial ?? {
      name: company.name,
      uscc: company.uscc,
      province: company.province,
      city: company.city,
      enrichmentStatus: company.enrichmentStatus,
    },
    valueType: 'object',
    source: ctx.source,
    runId: ctx.runId ?? null,
    actor: ctx.actor ?? undefined,
    occurredAt,
  });
}

/** 便捷封装：写公司匹配结果（match_meta + tanji_company_id） */
export async function recordMatchResult(
  companyId: string,
  input: {
    tanjiCompanyId: string;
    method: string;
    confidence: number;
    candidates: MatchMeta['candidates'];
    source?: string;
    runId?: string | null;
    actor?: string | null;
    eventType?: string;
  },
  deps?: CompaniesServiceDeps,
): Promise<{ company: Company; changed: FieldChange[] }> {
  const matchMeta = buildMatchMeta({
    method: input.method,
    confidence: input.confidence,
    candidates: input.candidates,
    matchedAt: timestamp(resolveDeps(deps)),
  });
  return applyCompanyFields(
    companyId,
    { tanjiCompanyId: input.tanjiCompanyId, matchMeta },
    {
      source: input.source ?? 'tanji',
      runId: input.runId,
      actor: input.actor,
      eventType: input.eventType,
    },
    deps,
  );
}

// ---------------------------------------------------------------------------
// 3. 来源公司 upsert / 去重归并（docs/02 §8）
// ---------------------------------------------------------------------------

export interface UpsertSourceCompanyInput {
  platform: Platform;
  platformCompanyId: string;
  /** 平台展示名/公司名 */
  name: string;
  englishName?: string | null;
  uscc?: string | null;
  tanjiCompanyId?: string | null;
  province?: string | null;
  city?: string | null;
  address?: string | null;
  sourceName?: string | null;
  sourceUrl?: string | null;
  cityName?: string | null;
  evidence?: Record<string, unknown>;
  runId?: string | null;
  enrichmentStatus?: EnrichmentStatus;
  /** 公司级初始字段（如英文抬头、行业等，来自来源详情） */
  extraFields?: Partial<Company>;
}

export interface UpsertSourceCompanyResult {
  company: Company;
  /** 新建主档（false = 关联到已有公司） */
  companyCreated: boolean;
  sourceCreated: boolean;
  dedupe: DedupePlan;
}

/** 把已有公司转成去重决策所需的视图 */
function toExistingView(company: Company): ExistingCompanyView {
  return {
    id: company.id,
    name: company.name,
    normalizedName: company.normalizedName,
    englishName: company.englishName,
    uscc: company.uscc,
    tanjiCompanyId: company.tanjiCompanyId,
    province: company.province,
    city: company.city,
    mergedInto: company.mergedInto,
  };
}

/** 汇总可能命中的已有公司（USCC/tanji_id/归一化名称） */
function findExistingCandidates(d: CompaniesServiceDeps, input: UpsertSourceCompanyInput): Company[] {
  const found = new Map<string, Company>();
  const uscc = normalizeUsccKey(input.uscc);
  if (uscc.length >= 8) {
    const hit = d.companies.findByUscc(uscc);
    if (hit) found.set(hit.id, hit);
  }
  if (input.tanjiCompanyId) {
    const hit = d.companies.findByTanjiId(input.tanjiCompanyId);
    if (hit) found.set(hit.id, hit);
  }
  // 归一化名称候选（中文名 + 英文抬头）
  const plan = planCompanyAttach(
    {
      platform: input.platform,
      name: input.name,
      englishName: input.englishName,
      uscc: input.uscc,
      tanjiCompanyId: input.tanjiCompanyId,
      province: input.province,
      city: input.city,
    },
    [...found.values()].map(toExistingView),
  );
  if (plan.action === 'link' && plan.companyId) {
    const hit = d.companies.getById(plan.companyId);
    if (hit) found.set(hit.id, hit);
  }
  // 名称兜底：用归一化 key 直接查（可能命中 province 未知的公司）
  for (const key of [input.name, input.englishName]) {
    const text = (key ?? '').trim();
    if (!text) continue;
    // 避免在服务层重复实现归一化：交给 findByNormalizedName 前先用同规则归一
    const normalized = normalizeCompanyNameSafe(text);
    if (!normalized) continue;
    const hits = d.companies.findByNormalizedName(normalized, {
      ...(input.province ? { province: input.province } : {}),
      ...(input.city ? { city: input.city } : {}),
    });
    for (const hit of hits) found.set(hit.id, hit);
  }
  return [...found.values()];
}

function normalizeCompanyNameSafe(value: string): string {
  return normalizeCompanyName(value);
}

/**
 * 来源公司 → 主档 upsert（USCC > tanji_id > 归一化名称+省市；否则新建）。
 * 同时写 company_sources 并刷新 company.sourceCount。
 */
export async function upsertSourceCompany(
  input: UpsertSourceCompanyInput,
  deps?: CompaniesServiceDeps,
): Promise<UpsertSourceCompanyResult> {
  const d = resolveDeps(deps);
  if (!input.platformCompanyId?.trim()) throw new LeadError('VALIDATION_ERROR', 'platformCompanyId 不能为空');
  if (!input.name?.trim()) throw new LeadError('VALIDATION_ERROR', 'company name 不能为空');

  const now = timestamp(d);
  return runTx(d, () => {
    const existing = findExistingCandidates(d, input);
    const dedupe = planCompanyAttach(
      {
        platform: input.platform,
        name: input.name,
        englishName: input.englishName,
        uscc: input.uscc,
        tanjiCompanyId: input.tanjiCompanyId,
        province: input.province,
        city: input.city,
        address: input.address,
      },
      existing.map(toExistingView),
    );

    let company: Company;
    let companyCreated = false;
    if (dedupe.action === 'link' && dedupe.companyId) {
      const target = d.companies.getById(dedupe.companyId);
      if (!target) throw new LeadError('NOT_FOUND', `去重目标公司不存在：${dedupe.companyId}`);
      // 仅补空字段（来源搜索权威性最低，不覆盖已有值）
      const fill: Partial<Company> = {
        englishName: input.englishName ?? undefined,
        uscc: input.uscc ?? undefined,
        tanjiCompanyId: input.tanjiCompanyId ?? undefined,
        province: input.province ?? undefined,
        city: input.city ?? undefined,
        address: input.address ?? undefined,
        ...(input.extraFields ?? {}),
      };
      const patchCandidate = planFieldPatch(
        target as unknown as Record<string, unknown>,
        fill as Record<string, unknown>,
        'source_search',
      ) as Partial<Company>;
      if (target.enrichmentStatus === 'discovered' && input.enrichmentStatus && input.enrichmentStatus !== 'discovered') {
        patchCandidate.enrichmentStatus = input.enrichmentStatus;
      }
      if (Object.keys(patchCandidate).length > 0) {
        company = d.companies.update(target.id, patchCandidate as CompanyPatch, { bumpVersion: true });
      } else {
        company = target;
      }
    } else {
      companyCreated = true;
      const initial: NewCompany = {
        name: input.name.trim(),
        normalizedName: dedupe.normalizedName,
        englishName: input.englishName ?? null,
        uscc: input.uscc ?? null,
        tanjiCompanyId: input.tanjiCompanyId ?? null,
        province: input.province ?? null,
        city: input.city ?? null,
        address: input.address ?? null,
        enrichmentStatus: input.enrichmentStatus ?? 'discovered',
        firstRunId: input.runId ?? null,
        firstSeenAt: now,
        lastSeenAt: now,
        sourceCount: 0,
        ...(input.extraFields ?? {}),
      };
      company = d.companies.create(initial);
      recordCompanyCreated(company, { source: 'source', runId: input.runId ?? null, initial: { name: company.name } }, d);
    }

    // 来源记录 upsert（收集来源证据；去重方式记入 evidence）
    let sourceCreated = false;
    if (d.companySources) {
      const evidence: Record<string, unknown> = { ...(input.evidence ?? {}) };
      if (dedupe.action === 'link') {
        evidence.merged_by = dedupe.reason;
        evidence.merged_by_confidence = dedupe.confidence;
      }
      const result = d.companySources.upsert({
        companyId: company.id,
        platform: input.platform,
        platformCompanyId: input.platformCompanyId.trim(),
        sourceName: input.sourceName ?? input.name,
        sourceUrl: input.sourceUrl ?? null,
        cityName: input.cityName ?? input.city ?? null,
        evidence,
        firstSeenAt: now,
        lastSeenAt: now,
      });
      sourceCreated = result.created;
      // 刷新来源数（sourceCount 变化也记 company.updated 事件）
      const count = d.companySources.countByCompany?.(company.id) ?? undefined;
      if (count !== undefined && count !== company.sourceCount) {
        const { company: updated } = applyCompanyFieldsSync(d, company.id, { sourceCount: count }, { source: 'source', runId: input.runId ?? null });
        company = updated;
      }
    } else {
      // 无来源端口时至少递增 sourceCount
      if (!companyCreated) {
        const { company: updated } = applyCompanyFieldsSync(
          d,
          company.id,
          { sourceCount: (company.sourceCount ?? 0) + 1 },
          { source: 'source', runId: input.runId ?? null },
        );
        company = updated;
      }
    }

    return { company, companyCreated, sourceCreated, dedupe };
  });
}

/** applyCompanyFields 的同步版本（仅服务内部 transaction 内使用） */
function applyCompanyFieldsSync(
  d: CompaniesServiceDeps,
  companyId: string,
  incoming: Partial<Company>,
  ctx: FieldWriteContext,
): { company: Company; changed: FieldChange[] } {
  const existing = d.companies.getById(companyId);
  if (!existing) throw new LeadError('NOT_FOUND', `公司不存在：${companyId}`);
  const changes = diffCompanyFields(existing as unknown as Record<string, unknown>, incoming as Record<string, unknown>);
  if (changes.length === 0) return { company: existing, changed: [] };
  const patch: CompanyPatch = {};
  for (const change of changes) (patch as Record<string, unknown>)[change.field] = change.newValue;
  const next = d.companies.update(companyId, patch, { bumpVersion: true, expectedVersion: existing.version });
  appendFieldEvents(d, companyId, next.version, changes, ctx);
  return { company: next, changed: changes };
}

/**
 * 合并两条公司记录（docs/02 §8.2c / §8.4）：
 * - 保留较完整字段到 target（source 非空字段补 target 空字段；sourceCount 相加、tags 并集）
 * - company_sources 全部迁移到 target
 * - source 软删除（merged_into=target），写 company.merged 事件
 */
export async function mergeCompanies(
  sourceId: string,
  targetId: string,
  ctx: FieldWriteContext,
  deps?: CompaniesServiceDeps,
): Promise<{ target: Company; source: Company; movedSources: number; changed: FieldChange[] }> {
  const d = resolveDeps(deps);
  if (!sourceId || !targetId) throw new LeadError('VALIDATION_ERROR', 'mergeCompanies 需要 sourceId 与 targetId');
  if (sourceId === targetId) throw new LeadError('VALIDATION_ERROR', '不能合并公司到自身');
  return runTx(d, () => {
    const source = d.companies.getById(sourceId, { includeMerged: true });
    const target = d.companies.getById(targetId);
    if (!source) throw new LeadError('NOT_FOUND', `待合并公司不存在：${sourceId}`);
    if (!target) throw new LeadError('NOT_FOUND', `目标公司不存在：${targetId}`);
    if (source.mergedInto) throw new LeadError('CONFLICT', `公司已合并到 ${source.mergedInto}`);

    // 1) 字段补全 + 来源数/标签合并
    const patch = mergeCompanyViews(source, target);
    let updatedTarget = target;
    const changes: FieldChange[] = [];

    // 1.1) 唯一列（uscc / tanji_company_id）迁移前先从 source 清空，避免 UNIQUE 冲突；
    //      历史值已在合并前的公司快照/事件中留痕，合并后以 target 为准。
    const uniqueFields: Array<'uscc' | 'tanjiCompanyId'> = ['uscc', 'tanjiCompanyId'];
    const clears: CompanyPatch = {};
    for (const field of uniqueFields) {
      const transferring = (patch as Record<string, unknown>)[field];
      if (transferring !== undefined && transferring !== null && source[field]) {
        (clears as Record<string, unknown>)[field] = null;
      }
    }
    if (Object.keys(clears).length > 0) {
      d.companies.update(source.id, clears, { bumpVersion: false, expectedVersion: source.version });
    }

    if (Object.keys(patch).length > 0) {
      const result = applyCompanyFieldsSync(d, target.id, patch, { ...ctx, eventType: ctx.eventType ?? 'company.merged' });
      updatedTarget = result.company;
      changes.push(...result.changed);
    }

    // 2) 迁移来源记录
    let movedSources = 0;
    if (d.companySources) {
      for (const src of d.companySources.listByCompany(source.id)) {
        d.companySources.upsert({
          companyId: target.id,
          platform: src.platform,
          platformCompanyId: src.platformCompanyId,
          sourceName: src.sourceName,
          sourceUrl: src.sourceUrl,
          cityName: src.cityName,
          evidence: { ...src.evidence, merged_from_company_id: source.id },
          firstSeenAt: src.firstSeenAt,
          lastSeenAt: src.lastSeenAt,
        });
        movedSources += 1;
      }
      const count = d.companySources.countByCompany?.(target.id);
      if (count !== undefined && count !== updatedTarget.sourceCount) {
        const result = applyCompanyFieldsSync(d, target.id, { sourceCount: count }, ctx);
        updatedTarget = result.company;
        changes.push(...result.changed);
      }
    }

    // 3) 软删除 source（merged_into）+ company.merged 事件
    const merged = d.companies.update(
      source.id,
      { mergedInto: target.id },
      { bumpVersion: true, expectedVersion: source.version },
    );
    d.changeEvents?.append({
      companyId: target.id,
      entityType: 'company',
      entityId: source.id,
      version: updatedTarget.version,
      eventType: 'company.merged',
      field: 'mergedInto',
      oldValue: null,
      newValue: { sourceCompanyId: source.id, targetCompanyId: target.id, movedSources },
      valueType: 'object',
      source: ctx.source,
      runId: ctx.runId ?? null,
      actor: ctx.actor ?? undefined,
      occurredAt: ctx.occurredAt ?? timestamp(d),
    });

    return { target: updatedTarget, source: merged, movedSources, changed: changes };
  });
}

// ---------------------------------------------------------------------------
// 4. 任务入队（rematch / unlock 前置）
// ---------------------------------------------------------------------------

export interface EnqueueJobResult {
  jobId: string;
  created: boolean;
  stage: Stage;
  status: string;
  companyId: string;
}

/** POST /v1/companies/{id}/rematch：入队 tanji_match（force 时重置已存在任务） */
export async function createRematchJob(
  id: string,
  input: { force?: boolean; note?: string } = {},
  deps?: CompaniesServiceDeps,
): Promise<EnqueueJobResult> {
  const d = resolveDeps(deps);
  requirePort(d.jobs, 'jobs');
  const company = d.companies.getById(id);
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${id}`);
  const result = d.jobs.enqueue({
    companyId: company.id,
    stage: 'tanji_match',
    platform: null,
    resetExisting: input.force === true,
  });
  return {
    jobId: result.job.id,
    created: result.created,
    stage: 'tanji_match',
    status: result.job.status,
    companyId: company.id,
  };
}

/**
 * POST /v1/companies/{id}/unlock：入队 unlock 任务（手动优先）。
 * 前置：公司已匹配探迹主体（tanjiCompanyId 非空）；**不消耗额度、不直接调用探迹**。
 */
export async function createUnlockJob(
  id: string,
  input: { idempotencyKey?: string; note?: string } = {},
  deps?: CompaniesServiceDeps,
): Promise<EnqueueJobResult & { idempotencyKey: string | null }> {
  const d = resolveDeps(deps);
  requirePort(d.jobs, 'jobs');
  const company = d.companies.getById(id);
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${id}`);
  if (!company.tanjiCompanyId) {
    throw new LeadError('VALIDATION_ERROR', '公司尚未匹配探迹主体（缺少 tanjiCompanyId），不能解锁', {
      details: { companyId: id, enrichmentStatus: company.enrichmentStatus },
    });
  }
  const result = d.jobs.enqueue({
    companyId: company.id,
    stage: 'unlock',
    platform: null,
    resetExisting: false,
  });
  return {
    jobId: result.job.id,
    created: result.created,
    stage: 'unlock',
    status: result.job.status,
    companyId: company.id,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

// ---------------------------------------------------------------------------
// 5. 供 wiring/测试使用的聚合导出（api-dev 动态 import 时按名字匹配）
// ---------------------------------------------------------------------------

export const companiesServiceApi = {
  configureCompaniesService,
  companiesDepsFromRepositories,
  listCompanies,
  getCompanyDetail,
  getCompany: getCompanyDetail,
  listCompanySources,
  listCompanySnapshots,
  listCompanyContacts,
  listCompanyChanges,
  createRematchJob,
  rematchCompany: createRematchJob,
  createUnlockJob,
  upsertSourceCompany,
  applyCompanyFields,
  recordMatchResult,
  mergeCompanies,
} as const;
