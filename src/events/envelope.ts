/**
 * change_events → 对外 EventEnvelope 映射（纯函数）。
 *
 * 对外契约见 docs/02 §14.1、docs/03 §5：
 * - seq 全局单调递增，是消费方去重/游标主键；
 * - eventId 由 seq 确定性派生（同一 seq 恒等），消费方可按 eventId/seq 去重；
 * - data 为字段级 diff 或摘要对象（不含联系人明文等 PII）。
 */
import type { EventEnvelope } from '../shared/domain.js';
import { safeJsonParse } from '../shared/json.js';
import type { ChangeEventRecord } from './types.js';

/** Crockford Base32：与 src/shared/ids.ts 的 ULID 字符集一致 */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 把 seq 编码为定长 16 位 Base32 后缀，拼成 `evt_<16>`，保证确定性且可排序 */
export function eventIdForSeq(seq: number): string {
  let n = Math.max(0, Math.trunc(seq));
  const chars: string[] = [];
  for (let i = 0; i < 16; i++) {
    chars.unshift(B32[n % 32] ?? '0');
    n = Math.floor(n / 32);
  }
  return `evt_${chars.join('')}`;
}

/** 从 eventId 反解 seq（消费方/测试用）；非法返回 null */
export function seqFromEventId(eventId: string): number | null {
  const m = /^evt_([0-9A-HJKMNP-TV-Z]{16})$/.exec(eventId);
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]!) {
    const idx = B32.indexOf(ch);
    if (idx < 0) return null;
    n = n * 32 + idx;
  }
  return n;
}

/** 从平台字段路径 `platforms.<platform>.<field>` 中解析平台 */
export function platformFromField(field: string | null | undefined): string | null {
  if (!field) return null;
  const m = /^platforms\.(boss|zhilian|ali|mic)\./.exec(field);
  return m ? m[1]! : null;
}

function tryParseJson(raw: string): { ok: boolean; value: unknown } {
  const text = raw.trim();
  if (!(text.startsWith('{') || text.startsWith('[') || text === 'null' || text === 'true' || text === 'false' || /^-?\d+(\.\d+)?$/.test(text))) {
    return { ok: false, value: raw };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, value: raw };
  }
}

function parseStoredValue(raw: unknown, valueType: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  // F2 repositories 已对 JSON 列做解析（JS 值）；字符串兼容旧数据/纯文本字段
  if (typeof raw !== 'string') return raw;
  if (valueType === 'json') return safeJsonParse(raw, raw);
  if (valueType === 'string' || valueType === 'number' || valueType === 'bool') {
    // 显式非 json 类型：保留原始文本（bool/number 由消费方按 valueType 解析）
    return raw;
  }
  const parsed = tryParseJson(raw);
  return parsed.ok ? parsed.value : parsed.value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 快照型事件：newValue 本身是摘要对象时展开到 data */
const SNAPSHOT_EVENT_TYPES = new Set([
  'company.created',
  'company.merged',
  'company.rematched',
  'company.deleted',
  'contact.unlocked',
  'customs.updated',
]);

export function buildEventData(row: ChangeEventRecord): Record<string, unknown> {
  const oldValue = parseStoredValue(row.oldValue, row.valueType);
  const newValue = parseStoredValue(row.newValue, row.valueType);
  const platform = platformFromField(row.field);
  const data: Record<string, unknown> = {};

  if (SNAPSHOT_EVENT_TYPES.has(row.eventType)) {
    if (isPlainRecord(newValue)) {
      Object.assign(data, newValue);
    } else if (newValue !== null) {
      data.value = newValue;
    }
    if (platform) data.platform = platform;
    if (row.field && !('field' in data)) data.field = row.field;
    if (oldValue !== null && !('oldValue' in data)) data.oldValue = oldValue;
    if (row.entityType !== 'company') {
      data.entityType = row.entityType;
      if (row.entityId !== null) data.entityId = row.entityId;
    }
    return data;
  }

  if (row.eventType === 'platform.profile.updated' || row.eventType === 'platform.jobs.updated') {
    if (platform) data.platform = platform;
    if (row.field) data.field = row.field;
    data.oldValue = oldValue;
    data.newValue = newValue;
    if (row.valueType) data.valueType = row.valueType;
    if (row.entityType !== 'company') {
      data.entityType = row.entityType;
      if (row.entityId !== null) data.entityId = row.entityId;
    }
    return data;
  }

  // 默认：字段级 diff（company.updated 及未来扩展事件）
  if (row.field !== null) data.field = row.field;
  if (row.valueType !== null) data.valueType = row.valueType;
  data.oldValue = oldValue;
  data.newValue = newValue;
  if (platform) data.platform = platform;
  if (row.entityType !== 'company') {
    data.entityType = row.entityType;
    if (row.entityId !== null) data.entityId = row.entityId;
  }
  return data;
}

/** change_events 行 → 对外 EventEnvelope（唯一映射入口，dispatcher/SSE/查询共用） */
export function buildEventEnvelope(row: ChangeEventRecord): EventEnvelope {
  return {
    eventId: eventIdForSeq(row.seq),
    seq: row.seq,
    type: row.eventType,
    occurredAt: row.occurredAt,
    companyId: row.companyId,
    version: row.version,
    source: row.source,
    runId: row.runId,
    data: buildEventData(row),
  };
}

/** 事件类型过滤：sub.types 为空或含 `*` 表示全部 */
export function matchesEventTypes(subscribed: string[] | null | undefined, eventType: string): boolean {
  if (!subscribed || subscribed.length === 0) return true;
  return subscribed.includes('*') || subscribed.includes(eventType);
}
