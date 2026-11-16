/**
 * 变更事件查询服务（/v1/changes、单公司 changes、事件 envelope 构造）。
 *
 * 依赖 EventsStore 端口；HTTP/CLI/MCP 层直接调用本文件的函数。
 */
import { LeadError } from '../shared/errors.js';
import type { EventEnvelope } from '../shared/domain.js';
import { buildEventEnvelope } from '../events/envelope.js';
import type { ChangeEventRecord, ChangesPage, EventsStore } from '../events/types.js';
import { clampLimit } from '../events/subscriptions.js';

export interface EventServiceDeps {
  store: EventsStore;
  now?: () => Date;
}

export interface ListChangesQuery {
  sinceSeq?: number;
  types?: string[];
  companyId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListCompanyChangesQuery {
  sinceVersion?: number;
  sinceSeq?: number;
  limit?: number;
  cursor?: string | null;
}

export interface CompanyChangesPage {
  items: EventEnvelope[];
  nextSeq: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/** `/v1/changes` 游标 = 已返回的最后 seq（base64url JSON） */
export function encodeSeqCursor(seq: number): string {
  return Buffer.from(JSON.stringify({ seq: Math.max(0, Math.floor(seq)) }), 'utf8').toString('base64url');
}

export function decodeSeqCursor(cursor: string | null | undefined): number | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { seq?: number };
    const seq = Number(parsed.seq);
    return Number.isFinite(seq) && seq >= 0 ? Math.floor(seq) : null;
  } catch {
    throw new LeadError('VALIDATION_ERROR', '无效的 cursor');
  }
}

/** 解析 `?types=a,b` / 数组（兼容 query string 传入的逗号分隔） */
export function parseTypesFilter(input: unknown): string[] | undefined {
  if (input === undefined || input === null || input === '') return undefined;
  const list = Array.isArray(input) ? input.map(String) : String(input).split(',');
  const types = list.map((t) => t.trim()).filter(Boolean);
  return types.length > 0 ? types : undefined;
}

function toEnvelopeList(records: ChangeEventRecord[]): EventEnvelope[] {
  return records.map(buildEventEnvelope);
}

/** 全局增量：sinceSeq（不含）之后按 seq 升序返回；cursor 优先于 sinceSeq */
export async function listChanges(query: ListChangesQuery = {}, deps?: EventServiceDeps): Promise<ChangesPage> {
  const store = await resolveStore(deps);
  const limit = clampLimit(query.limit, 100, 500);
  const cursorSeq = decodeSeqCursor(query.cursor);
  const sinceSeq = Math.max(0, Math.floor(cursorSeq ?? query.sinceSeq ?? 0));
  const records = store.changeEvents.listAfter(sinceSeq, {
    limit: limit + 1,
    types: parseTypesFilter(query.types),
    companyId: query.companyId,
  });
  const hasMore = records.length > limit;
  const page = hasMore ? records.slice(0, limit) : records;
  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : sinceSeq;
  return {
    items: toEnvelopeList(page),
    nextSeq: lastSeq,
    nextCursor: hasMore ? encodeSeqCursor(lastSeq) : null,
    hasMore,
  };
}

/** 单公司变更历史（可按 sinceVersion / sinceSeq 增量） */
export async function listCompanyChanges(
  companyId: string,
  query: ListCompanyChangesQuery = {},
  deps?: EventServiceDeps,
): Promise<CompanyChangesPage> {
  if (!companyId) throw new LeadError('VALIDATION_ERROR', 'companyId 不能为空');
  const store = await resolveStore(deps);
  const limit = clampLimit(query.limit, 100, 500);
  const cursorSeq = decodeSeqCursor(query.cursor);
  const afterSeq = Math.max(0, Math.floor(cursorSeq ?? query.sinceSeq ?? 0));
  // F2 listByCompany 支持 afterSeq 增量；版本过滤在应用层完成（version 为公司内单调递增）
  const records = store.changeEvents.listByCompany(companyId, { limit: limit + 1, sinceSeq: afterSeq });
  const filtered = query.sinceVersion === undefined
    ? records
    : records.filter((r) => r.version > (query.sinceVersion as number));
  const hasMore = filtered.length > limit;
  const page = hasMore ? filtered.slice(0, limit) : filtered;
  const lastSeq = page.length > 0 ? page[page.length - 1]!.seq : afterSeq;
  return {
    items: toEnvelopeList(page),
    nextSeq: lastSeq,
    nextCursor: hasMore ? encodeSeqCursor(lastSeq) : null,
    hasMore,
  };
}

/** 按 seq 取单条事件（webhook replay / 调试） */
export async function getChangeEvent(seq: number, deps?: EventServiceDeps): Promise<EventEnvelope | null> {
  if (!Number.isFinite(seq) || seq < 0) throw new LeadError('VALIDATION_ERROR', 'seq 必须是非负整数');
  const store = await resolveStore(deps);
  const record = store.changeEvents.getBySeq(Math.floor(seq));
  return record ? buildEventEnvelope(record) : null;
}

/** 事件总数/最大 seq（/v1/status 等可复用） */
export async function getChangeFeedState(deps?: EventServiceDeps): Promise<{ maxSeq: number }> {
  const store = await resolveStore(deps);
  return { maxSeq: store.changeEvents.maxSeq() };
}

/**
 * 解析 EventsStore：
 * - 显式注入（单测/其他服务）优先；
 * - 否则使用全局 F2 repositories（main.ts 启动时 initRepositories）。
 */
export async function resolveStore(deps?: EventServiceDeps): Promise<EventsStore> {
  if (deps?.store) return deps.store;
  const { getDefaultEventsStore } = await import('../events/f2Store.js');
  return getDefaultEventsStore();
}
