/** 统一 envelope（冻结，与现有五件套一致） */
import type { ErrorCode } from './errors.js';
import { LeadError } from './errors.js';
import { nowIso } from './time.js';

export interface ResponseMeta {
  schemaVersion: string;
  requestId: string;
  timestamp: string;
  tookMs: number;
  warnings?: string[];
  cached?: boolean;
  [k: string]: unknown;
}

export interface ApiErrorBody {
  code: ErrorCode | string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type OkEnvelope<T> = { ok: true; data: T; meta: ResponseMeta; error: null };
export type ErrEnvelope = { ok: false; data: null; meta: ResponseMeta; error: ApiErrorBody };
export type Envelope<T> = OkEnvelope<T> | ErrEnvelope;

export const SCHEMA_VERSION = '1.0';

export function metaBase(requestId: string, startedMs = Date.now(), extra?: Partial<ResponseMeta>): ResponseMeta {
  return {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    timestamp: nowIso(),
    tookMs: Math.max(0, Date.now() - startedMs),
    warnings: [],
    ...extra,
  };
}

export function ok<T>(data: T, requestId: string, opts?: { startedMs?: number; meta?: Partial<ResponseMeta> }): OkEnvelope<T> {
  return { ok: true, data, meta: metaBase(requestId, opts?.startedMs, opts?.meta), error: null };
}

export function fail(err: unknown, requestId: string, startedMs = Date.now()): ErrEnvelope {
  const e = err instanceof LeadError ? err : new LeadError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
  return {
    ok: false,
    data: null,
    meta: metaBase(requestId, startedMs),
    error: { code: e.code, message: e.message, retryable: e.retryable, ...(e.details ? { details: e.details } : {}) },
  };
}

export type Paginated<T> = { items: T[]; nextCursor: string | null; hasMore: boolean };
