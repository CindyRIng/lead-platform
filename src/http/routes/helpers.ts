/**
 * 路由层通用工具：envelope 包装、zod 校验、分页归一、requestId/耗时、兜底鉴权。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeAny, ZodIssue } from 'zod';
import { ZodError } from 'zod';
import { LeadError } from '../../shared/errors.js';
import { fail, ok } from '../../shared/envelope.js';
import { safeEqual } from '../../shared/crypto.js';
import type { ApiRoute } from './manifest.js';
import { getRouteServices } from './services.js';
import type { RouteServices } from './services.js';

export interface HandlerContext {
  req: FastifyRequest;
  reply: FastifyReply;
  services: RouteServices;
  requestId: string;
  startedMs: number;
  params: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
}

export interface RouteResult {
  data: unknown;
  meta?: Record<string, unknown>;
  status?: number;
}

export type RouteHandler = (ctx: HandlerContext) => Promise<RouteResult | void>;

/* ------------------------------------------------------------------ */
/* requestId / startedMs（兼容 foundation 的 requestContext 插件）        */
/* ------------------------------------------------------------------ */

export function getRequestId(req: FastifyRequest): string {
  const rec = req as unknown as Record<string, unknown>;
  for (const key of ['leadRequestId', 'requestId']) {
    const id = rec[key];
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return req.id ?? 'req_unknown';
}

export function getStartedMs(req: FastifyRequest): number {
  const rec = req as unknown as Record<string, unknown>;
  const v = rec.startTimeMs;
  return typeof v === 'number' ? v : Date.now();
}

/* ------------------------------------------------------------------ */
/* zod 校验                                                            */
/* ------------------------------------------------------------------ */

function issueField(prefix: string, issue: ZodIssue): string {
  const path = issue.path.map((p) => String(p)).join('.');
  return path ? `${prefix}.${path}` : prefix;
}

export function parseInput<T>(schema: ZodTypeAny | undefined, value: unknown, prefix: string): T {
  if (!schema) return (value ?? {}) as T;
  try {
    return schema.parse(value ?? {}) as T;
  } catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const field = first ? issueField(prefix === 'body' ? '' : prefix, first).replace(/^\./, '') || prefix : prefix;
      const message = first ? `${field}: ${first.message}` : `${prefix}: invalid input`;
      throw new LeadError('VALIDATION_ERROR', message, {
        details: {
          field,
          issues: err.issues.slice(0, 10).map((i) => ({ path: i.path, message: i.message, code: i.code })),
        },
      });
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 分页归一                                                             */
/* ------------------------------------------------------------------ */

export interface PageLike<T = unknown> {
  items: T[];
  nextCursor?: string | null;
  hasMore?: boolean;
  total?: number;
}

/** 游标分页：data.items + meta.nextCursor（同时保留 data.nextCursor 便于消费） */
export function paged(result: unknown): RouteResult {
  const rec = (result ?? {}) as Record<string, unknown>;
  const items = Array.isArray(rec.items) ? rec.items : Array.isArray(result) ? (result as unknown[]) : [];
  const nextCursor = (rec.nextCursor as string | null | undefined) ?? null;
  const hasMore = typeof rec.hasMore === 'boolean' ? rec.hasMore : nextCursor !== null;
  const data: Record<string, unknown> = { items, hasMore };
  if (nextCursor !== null) data.nextCursor = nextCursor;
  if (typeof rec.total === 'number') data.total = rec.total;
  return { data, meta: { nextCursor } };
}

/** offset 分页（goals/runs 等小集合）：data.items + data.total */
export function offsetPaged(result: unknown): RouteResult {
  if (Array.isArray(result)) return { data: { items: result, total: result.length } };
  const rec = (result ?? {}) as Record<string, unknown>;
  const items = Array.isArray(rec.items) ? rec.items : [];
  const total = typeof rec.total === 'number' ? rec.total : items.length;
  return { data: { items, total } };
}

/* ------------------------------------------------------------------ */
/* 路由包装：校验 → handler → envelope / LeadError                      */
/* ------------------------------------------------------------------ */

export type HandlerRegistry = Record<string, RouteHandler>;

export function buildRouteHandler(
  def: ApiRoute,
  registry: HandlerRegistry,
): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> {
  const handlerKey = def.handler;
  if (!handlerKey) {
    throw new Error(`route has no handler key: ${def.method} ${def.path}`);
  }
  const handler = registry[handlerKey];
  if (!handler) {
    throw new Error(`route handler not registered: ${handlerKey} (${def.method} ${def.path})`);
  }
  return async (req, reply) => {
    const requestId = getRequestId(req);
    const startedMs = getStartedMs(req);
    try {
      const params = parseInput<Record<string, unknown>>(def.params, req.params, 'params');
      const query = parseInput<Record<string, unknown>>(def.query, req.query, 'query');
      const rawBody = req.body as unknown;
      const body = def.body ? parseInput<unknown>(def.body, rawBody ?? {}, 'body') : rawBody;
      const services = (req as unknown as { routeServices?: RouteServices }).routeServices ?? getServices(req);
      const result = await handler({ req, reply, services, requestId, startedMs, params, query, body });
      if (!result) {
        // handler 已 hijack / 自行响应（SSE）
        return reply;
      }
      const meta = { ...(result.meta ?? {}) };
      const status = result.status ?? def.successStatus ?? 200;
      return reply.code(status).send(ok(result.data, requestId, { startedMs, meta }));
    } catch (err) {
      return sendError(reply, err, requestId, startedMs);
    }
  };
}

export function sendError(reply: FastifyReply, err: unknown, requestId: string, startedMs: number): unknown {
  const e =
    err instanceof LeadError
      ? err
      : new LeadError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err), { cause: err });
  return reply.code(e.httpStatus).send(fail(e, requestId, startedMs));
}

/* ------------------------------------------------------------------ */
/* 服务解析                                                             */
/* ------------------------------------------------------------------ */

interface ServicesCarrier {
  routeServices?: RouteServices;
}

function getServices(req: FastifyRequest): RouteServices {
  const app = req.server as unknown as FastifyInstance & ServicesCarrier;
  return app.routeServices ?? getRouteServices();
}

/* ------------------------------------------------------------------ */
/* 兜底鉴权 hook（foundation 的全局 auth 插件为主；此 hook 保证单测/独立可跑） */
/* ------------------------------------------------------------------ */

const PUBLIC_PATHS = ['/v1/health', '/docs', '/openapi.json', '/mcp-tools.json'];

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

interface ConfigLike {
  apiToken?: string;
  token?: string;
  [k: string]: unknown;
}

let expectedTokenPromise: Promise<string | null> | null = null;

export function resolveExpectedToken(): Promise<string | null> {
  if (!expectedTokenPromise) {
    expectedTokenPromise = (async () => {
      const fromEnv = process.env.LEAD_API_TOKEN?.trim();
      if (fromEnv) return fromEnv;
      try {
        const spec = '../../config.js';
        const mod = (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as Record<string, unknown>;
        for (const name of ['tryGetConfig', 'getConfig']) {
          const fn = mod[name];
          if (typeof fn !== 'function') continue;
          try {
            const cfg = (fn as () => ConfigLike | null)();
            const token = cfg?.apiToken ?? cfg?.token;
            if (typeof token === 'string' && token) return token;
          } catch {
            /* config 校验失败（如测试未设置 token）：继续尝试 */
          }
        }
      } catch {
        /* config 模块尚未落地：退回 env */
      }
      return null;
    })();
  }
  return expectedTokenPromise;
}

export function resetExpectedTokenForTests(): void {
  expectedTokenPromise = null;
}

export async function fallbackAuthHook(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  if (isPublicPath(req.url)) return;
  const expected = await resolveExpectedToken();
  // 兜底鉴权：server 层（foundation auth 插件）已鉴权；取不到期望 token 时跳过，
  // 避免与主鉴权双源冲突（单测会显式设置 LEAD_API_TOKEN 来验证 401）。
  if (!expected) return;
  const header = req.headers.authorization;
  const supplied = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!supplied || !safeEqual(supplied, expected)) {
    const err = new LeadError('UNAUTHORIZED', 'missing or invalid bearer token', {
      details: { expected: 'Authorization: Bearer <LEAD_API_TOKEN>' },
    });
    const requestId = getRequestId(req);
    return reply.code(err.httpStatus).send(fail(err, requestId, getStartedMs(req)));
  }
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function csvList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function boolish(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

export function requireRecord(value: unknown, what: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new LeadError('INTERNAL_ERROR', `${what}: service returned non-object response`);
}
