/**
 * Mock 上游公共设施：统一 envelope、请求门（失败注入/会话失效/延迟）、
 * `/__mock/*` 控制端点。
 *
 * envelope 形状对齐 LeadPlatform 五件套：`{ok,data,meta,error}`。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  type MockPlatform,
  type MockWorld,
  countRequests,
  scenarioSummary,
  resetWorld,
  injectFailure,
  exhaustTanjiQuota,
  restoreTanjiQuota,
  setFumaPermission,
  setSessionInvalid,
  setForceEmpty,
  setJobsRound,
} from './state.js';

export const MOCK_SCHEMA_VERSION = '1.0-mock';

export interface MockMeta {
  schemaVersion?: string;
  requestId?: string;
  timestamp?: string;
  tookMs?: number;
  warnings?: string[];
  [k: string]: unknown;
}

let requestSeq = 0;
export function mockRequestId(): string {
  requestSeq += 1;
  return `req_mock_${requestSeq}`;
}

export function okEnvelope(data: unknown, meta: MockMeta = {}): Record<string, unknown> {
  return {
    ok: true,
    data,
    meta: {
      schemaVersion: MOCK_SCHEMA_VERSION,
      requestId: mockRequestId(),
      timestamp: new Date().toISOString(),
      tookMs: 1,
      warnings: [],
      ...meta,
    },
    error: null,
  };
}

export interface MockErrorOptions {
  retryable?: boolean;
  details?: Record<string, unknown>;
  httpStatus?: number;
}

export function errEnvelope(code: string, message: string, opts: MockErrorOptions = {}): Record<string, unknown> {
  return {
    ok: false,
    data: null,
    meta: {
      schemaVersion: MOCK_SCHEMA_VERSION,
      requestId: mockRequestId(),
      timestamp: new Date().toISOString(),
      tookMs: 1,
      warnings: [],
    },
    error: {
      code,
      message,
      retryable: opts.retryable ?? false,
      ...(opts.details ? { details: opts.details } : {}),
    },
  };
}

export function sendOk(reply: FastifyReply, data: unknown, meta?: MockMeta): FastifyReply {
  return reply.code(200).type('application/json; charset=utf-8').send(okEnvelope(data, meta));
}

export function sendErr(
  reply: FastifyReply,
  httpStatus: number,
  code: string,
  message: string,
  opts: MockErrorOptions = {},
): FastifyReply {
  return reply.code(httpStatus).type('application/json; charset=utf-8').send(errEnvelope(code, message, { ...opts, httpStatus }));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GateOutcome {
  /** 非空表示请求应直接以该失败响应结束 */
  fail?: { status: number; body: unknown };
  /** 命中的注入失败（便于日志/调试） */
  failure?: unknown;
}

function pathOf(req: FastifyRequest): string {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q >= 0 ? url.slice(0, q) : url;
}

function isStatusLikePath(path: string): boolean {
  return path.endsWith('/status') || path.endsWith('/version') || path.endsWith('/accounts');
}

/**
 * 请求门：计数/日志 → 失败注入 → 延迟 → 会话失效。
 * 所有 mock 的每个业务 handler 开头都调用它。
 */
export async function beforeRequest(world: MockWorld, platform: MockPlatform, req: FastifyRequest): Promise<GateOutcome> {
  const ctl = world.platforms[platform];
  const path = pathOf(req);
  const key = `${req.method ?? 'GET'} ${path}`;
  ctl.counts[key] = (ctl.counts[key] ?? 0) + 1;
  ctl.requests.push({
    at: new Date().toISOString(),
    method: req.method ?? 'GET',
    path,
    query: (req.query ?? {}) as Record<string, unknown>,
    ...(req.body !== undefined && req.body !== null ? { body: req.body } : {}),
  });
  if (ctl.requests.length > 500) ctl.requests.splice(0, ctl.requests.length - 500);

  // 失败注入（FIFO，match 不匹配的保留）
  let failure: (typeof ctl.failures)[number] | undefined;
  const idx = ctl.failures.findIndex((f) => !f.match || path.includes(f.match));
  if (idx >= 0) {
    failure = ctl.failures[idx];
    const times = failure?.times ?? 1;
    if (times === Number.POSITIVE_INFINITY) {
      // 持久失败：保留
    } else if (times <= 1) {
      ctl.failures.splice(idx, 1);
    } else {
      failure!.times = times - 1;
    }
  }

  if (failure?.latencyMs && failure.latencyMs > 0) {
    await delay(failure.latencyMs);
  } else if (ctl.latencyMs > 0) {
    await delay(ctl.latencyMs);
  }

  if (failure && (failure.status !== undefined || failure.code !== undefined)) {
    return {
      failure,
      fail: {
        status: failure.status ?? 500,
        body: errEnvelope(failure.code ?? 'SOURCE_UNAVAILABLE', failure.message ?? 'injected upstream failure', {
          retryable: failure.retryable ?? false,
          details: { injected: true },
        }),
      },
    };
  }

  if (ctl.sessionInvalid && !isStatusLikePath(path)) {
    return {
      fail: {
        status: 401,
        body: errEnvelope('UNAUTHORIZED', 'upstream session invalid (mock injection)', { retryable: false }),
      },
    };
  }

  return { ...(failure ? { failure } : {}) };
}

/** 在 handler 开头调用：若返回非空则已发送失败响应，直接 `return reply`。 */
export async function applyGate(
  world: MockWorld,
  platform: MockPlatform,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | null> {
  const outcome = await beforeRequest(world, platform, req);
  if (outcome.fail) {
    return reply
      .code(outcome.fail.status)
      .type('application/json; charset=utf-8')
      .send(outcome.fail.body);
  }
  return null;
}

export function isForceEmpty(world: MockWorld, platform: MockPlatform): boolean {
  return world.platforms[platform].forceEmpty;
}

export function bearerToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m?.[1] ?? null;
}

/** mock app 的 Fastify 选项（单测可复用） */
export const MOCK_APP_OPTIONS = { logger: false as const, bodyLimit: 4 * 1024 * 1024 };

/**
 * 注册 `/__mock/*` 控制端点。
 * 外部进程（如 acceptance / 子进程模式的服务）可用 HTTP 控制 mock。
 */
export function installControlRoutes(app: FastifyInstance, world: MockWorld, platform: MockPlatform): void {
  app.get('/__mock/state', async (_req, reply) => {
    return sendOk(reply, {
      platform,
      ...scenarioSummary(world),
      control: controlSnapshot(world, platform),
    });
  });

  app.get('/__mock/requests', async (req, reply) => {
    const q = (req.query ?? {}) as { limit?: string; path?: string };
    const limit = Math.max(1, Math.min(1000, Number(q.limit ?? 100)));
    const ctl = world.platforms[platform];
    let list = ctl.requests;
    if (q.path) list = list.filter((r) => r.path.includes(q.path!));
    return sendOk(reply, { items: list.slice(-limit), total: list.length });
  });

  app.post('/__mock/reset', async (_req, reply) => {
    resetWorld(world);
    return sendOk(reply, { reset: true });
  });

  app.post('/__mock/failure', async (req, reply) => {
    const body = (req.body ?? {}) as {
      status?: number;
      code?: string;
      message?: string;
      retryable?: boolean;
      match?: string;
      times?: number;
      latencyMs?: number;
    };
    if (body.status === undefined && body.code === undefined && body.latencyMs === undefined) {
      return sendErr(reply, 400, 'VALIDATION_ERROR', 'status/code/latencyMs 至少提供一个');
    }
    injectFailure(world, platform, body);
    return sendOk(reply, { injected: true });
  });

  app.post('/__mock/clear-failures', async (_req, reply) => {
    world.platforms[platform].failures = [];
    return sendOk(reply, { cleared: true });
  });

  app.post('/__mock/config', async (req, reply) => {
    const body = (req.body ?? {}) as {
      sessionInvalid?: boolean;
      forceEmpty?: boolean;
      latencyMs?: number;
      jobsRound?: number;
    };
    if (typeof body.sessionInvalid === 'boolean') setSessionInvalid(world, platform, body.sessionInvalid);
    if (typeof body.forceEmpty === 'boolean') setForceEmpty(world, platform, body.forceEmpty);
    if (typeof body.latencyMs === 'number') world.platforms[platform].latencyMs = Math.max(0, body.latencyMs);
    if (typeof body.jobsRound === 'number' && (platform === 'boss' || platform === 'zhilian')) {
      setJobsRound(world, platform, body.jobsRound);
    }
    return sendOk(reply, controlSnapshot(world, platform));
  });

  app.post('/__mock/quota', async (req, reply) => {
    if (platform !== 'tanji') return sendErr(reply, 400, 'UNSUPPORTED', 'quota 仅 tanji mock 支持');
    const body = (req.body ?? {}) as { exhausted?: boolean; restore?: boolean; dailyRemaining?: number };
    if (body.exhausted === true) exhaustTanjiQuota(world);
    else if (body.restore === true) restoreTanjiQuota(world, body.dailyRemaining ?? 500);
    else if (typeof body.dailyRemaining === 'number') {
      world.scenario.tanjiQuota.daily.remaining = body.dailyRemaining;
      world.scenario.tanjiQuota.daily.used = world.scenario.tanjiQuota.daily.limit - body.dailyRemaining;
    }
    return sendOk(reply, scenarioSummary(world));
  });

  app.post('/__mock/fuma-permission', async (req, reply) => {
    if (platform !== 'fuma') return sendErr(reply, 400, 'UNSUPPORTED', 'fuma-permission 仅 fuma mock 支持');
    const body = (req.body ?? {}) as { denied?: boolean };
    setFumaPermission(world, body.denied === true);
    return sendOk(reply, scenarioSummary(world));
  });
}

export function controlSnapshot(world: MockWorld, platform: MockPlatform): Record<string, unknown> {
  const ctl = world.platforms[platform];
  return {
    platform,
    url: ctl.url,
    port: ctl.port,
    sessionInvalid: ctl.sessionInvalid,
    forceEmpty: ctl.forceEmpty,
    latencyMs: ctl.latencyMs,
    pendingFailures: ctl.failures.length,
    requests: countRequests(world, platform),
    counts: { ...ctl.counts },
  };
}

/** 生成 queryId（各 mock 内部用） */
let querySeq = 0;
export function mockQueryId(prefix: string): string {
  querySeq += 1;
  return `q_mock_${prefix}_${String(querySeq).padStart(4, '0')}`;
}

/** 分页 helper：page 从 1 开始，pageSize 默认 20 */
export function paginate<T>(items: T[], page: number, pageSize: number): { items: T[]; page: number; pageSize: number; total: number; totalPage: number; hasMore: boolean } {
  const p = Math.max(1, Math.floor(page) || 1);
  const size = Math.max(1, Math.floor(pageSize) || 20);
  const start = (p - 1) * size;
  const slice = items.slice(start, start + size);
  const totalPage = Math.max(1, Math.ceil(items.length / size));
  return { items: slice, page: p, pageSize: size, total: items.length, totalPage, hasMore: p < totalPage };
}
