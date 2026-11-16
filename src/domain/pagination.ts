/**
 * 游标分页（opaque cursor = base64url(JSON)）
 *
 * 对外的 cursor 只承诺「不透明」，内部通常编码 keyset 字段，
 * 例如 companies: {updatedAt, id}、changes: {seq}。
 */
import { LeadError } from '../shared/errors.js';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

const MAX_CURSOR_LENGTH = 4096;

/** 编码游标（base64url JSON） */
export function encodeCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** 解码游标；非法游标抛 VALIDATION_ERROR */
export function decodeCursor<T = Record<string, unknown>>(cursor: string): T {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH) {
    throw new LeadError('VALIDATION_ERROR', 'invalid cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new LeadError('VALIDATION_ERROR', 'invalid cursor');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LeadError('VALIDATION_ERROR', 'invalid cursor');
  }
  return parsed as T;
}

export interface ParseLimitOptions {
  default?: number;
  max?: number;
  min?: number;
}

/** 解析 limit（接受 string | number；越界收敛） */
export function parseLimit(raw: unknown, opts: ParseLimitOptions = {}): number {
  const def = opts.default ?? 20;
  const max = opts.max ?? 200;
  const min = opts.min ?? 1;
  if (raw === null || raw === undefined || raw === '') return def;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new LeadError('VALIDATION_ERROR', `invalid limit: ${String(raw)}`);
  }
  return Math.min(Math.max(n, min), max);
}

/** 解析 offset */
export function parseOffset(raw: unknown, def = 0, max = 100_000): number {
  if (raw === null || raw === undefined || raw === '') return def;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new LeadError('VALIDATION_ERROR', `invalid offset: ${String(raw)}`);
  }
  return Math.min(n, max);
}

/** 解析非负整数（如 sinceSeq / afterId） */
export function parseNonNegativeInt(raw: unknown, field: string, def: number | null = null): number | null {
  if (raw === null || raw === undefined || raw === '') return def;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new LeadError('VALIDATION_ERROR', `invalid ${field}: ${String(raw)}`);
  }
  return n;
}

/**
 * 由「多取一条」的行数组构造游标页：
 * @param rows 查询结果（limit + 1 条）
 * @param limit 客户端请求的条数
 * @param cursorOf 由最后一条有效行生成 nextCursor
 */
export function buildCursorPage<T>(
  rows: readonly T[],
  limit: number,
  cursorOf: (last: T) => Record<string, unknown>,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : [...rows];
  const last = pageRows[pageRows.length - 1];
  const nextCursor = hasMore && last !== undefined ? encodeCursor(cursorOf(last)) : null;
  return { items: pageRows, nextCursor, hasMore };
}

// ---------------------------------------------------------------------------
// 常用 keyset：updated_at DESC, id DESC（companies / platform jobs 等）
// ---------------------------------------------------------------------------

export interface UpdatedAtKeyset {
  updatedAt: string;
  id: string;
}

export function encodeUpdatedAtCursor(updatedAt: string, id: string): string {
  return encodeCursor({ updatedAt, id });
}

export function decodeUpdatedAtCursor(cursor: string): UpdatedAtKeyset {
  const value = decodeCursor<Partial<UpdatedAtKeyset>>(cursor);
  if (typeof value.updatedAt !== 'string' || typeof value.id !== 'string') {
    throw new LeadError('VALIDATION_ERROR', 'invalid keyset cursor');
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

// ---------------------------------------------------------------------------
// 常用 keyset：change_events.seq ASC
// ---------------------------------------------------------------------------

export function encodeSeqCursor(seq: number): string {
  return encodeCursor({ seq });
}

export function decodeSeqCursor(cursor: string): number {
  const value = decodeCursor<{ seq?: number }>(cursor);
  if (typeof value.seq !== 'number' || !Number.isInteger(value.seq) || value.seq < 0) {
    throw new LeadError('VALIDATION_ERROR', 'invalid seq cursor');
  }
  return value.seq;
}
