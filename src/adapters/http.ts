/**
 * 上游 HTTP 统一封装（S2/S3 适配器共用；refresh-customs-dev 的 fuma 也可复用）。
 *
 * 职责：
 * - 超时（AbortSignal）+ Bearer 鉴权 + 统一 envelope 解包 `{ok,data,meta,error}`；
 * - 错误归一为 LeadError（SOURCE_SESSION_INVALID / SOURCE_VERIFICATION_PENDING /
 *   UPSTREAM_RATE_LIMITED / SOURCE_UNAVAILABLE / UPSTREAM_BAD_REQUEST / NOT_FOUND）；
 * - 指数退避重试（最多 3 次，仅对可恢复错误）；
 * - 每来源令牌桶限频（Boss 12/min、智联 15/min、Ali 10s/页、Mic 1.5–2.5s）；
 * - 429/风控时记录来源冷却，冷却期内直接抛 UPSTREAM_RATE_LIMITED（不轰上游）。
 *
 * 可测试性：fetchImpl / sleep / now 均可注入，测试不访问真实上游。
 */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';

export interface UpstreamEnvelopeError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown> | null;
}

export interface RateLimitConfig {
  /** 每分钟请求上限（如 Boss 12、智联 15） */
  perMinute?: number | null;
  /** 最小请求间隔（如 Ali 10000ms、Mic 1800ms）；与 perMinute 同时存在时取更严格者 */
  minIntervalMs?: number;
  /** 间隔抖动上限（毫秒），用于智联/随机化 */
  jitterMs?: number;
  /** 令牌桶容量（突发），默认 max(1, ceil(perMinute/4)) */
  burst?: number;
}

export interface RetryConfig {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface HttpClientOptions {
  baseUrl: string;
  token?: string | null;
  /** 来源标识（boss/zhilian/ali/mic/tanji/fuma），用于错误 details 与日志 */
  source: string;
  timeoutMs?: number;
  retry?: RetryConfig;
  rate?: RateLimitConfig;
  fetchImpl?: typeof fetch;
  /** 注入的 sleep（测试用），默认真实 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  defaultHeaders?: Record<string, string>;
  /** 自定义错误映射（fuma 等错误码差异大的来源可用）；返回 null 走默认归一 */
  errorMapper?: (ctx: { status: number; body: unknown; envelopeError: UpstreamEnvelopeError | null }) => LeadError | null;
  /** 额外请求头（如 X-Requested-With） */
  requestHeaders?: Record<string, string>;
}

export interface UpstreamResult<T> {
  data: T;
  meta: Record<string, unknown>;
  status: number;
  requestId: string | null;
  cached: boolean;
  url: string;
}

export const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// 令牌桶限频
// ---------------------------------------------------------------------------

export class RateLimiter {
  private readonly perMinute: number | null;
  private readonly minIntervalMs: number;
  private readonly jitterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** 最近 60s 内的请求时间（滑动窗口，用于 perMinute 限频） */
  private readonly requestTimes: number[] = [];
  private nextAllowedAt = 0;
  private cooldownUntil = 0;

  constructor(rate: RateLimitConfig = {}, deps?: { sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.perMinute = rate.perMinute ?? null;
    this.minIntervalMs = rate.minIntervalMs ?? (this.perMinute ? Math.ceil(60_000 / this.perMinute) : 0);
    this.jitterMs = rate.jitterMs ?? 0;
    this.sleep = deps?.sleep ?? defaultSleep;
    this.now = deps?.now ?? Date.now;
  }

  get isCoolingDown(): boolean {
    return this.now() < this.cooldownUntil;
  }

  get cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.now());
  }

  /** 上游报 429/风控后设置冷却（期间 take() 等待到冷却结束） */
  notifyRateLimited(retryAfterMs?: number | null): void {
    const until = this.now() + Math.max(1_000, retryAfterMs ?? 5_000);
    if (until > this.cooldownUntil) this.cooldownUntil = until;
  }

  /**
   * 等待并消耗 1 个请求配额（调用方保证单来源内部串行）。
   * 约束 = max(每页最小间隔, 每分钟滑动窗口)；冷却期内等待冷却结束。
   */
  async take(): Promise<void> {
    for (;;) {
      const now = this.now();
      let waitMs = 0;
      if (now < this.cooldownUntil) waitMs = Math.max(waitMs, this.cooldownUntil - now);
      if (this.perMinute) {
        while (this.requestTimes.length > 0 && now - (this.requestTimes[0] ?? 0) >= 60_000) this.requestTimes.shift();
        if (this.requestTimes.length >= this.perMinute) {
          waitMs = Math.max(waitMs, (this.requestTimes[0] ?? now) + 60_000 - now);
        }
      }
      if (now < this.nextAllowedAt) waitMs = Math.max(waitMs, this.nextAllowedAt - now);
      if (waitMs > 0) {
        await this.sleep(waitMs);
        continue;
      }
      this.nextAllowedAt = now + this.minIntervalMs + this.jitterMs;
      if (this.perMinute) this.requestTimes.push(now);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// 错误归一
// ---------------------------------------------------------------------------

const SESSION_CODES = new Set([
  'UNAUTHORIZED',
  'UNAUTHENTICATED',
  'AUTH_REQUIRED',
  'SESSION_EXPIRED',
  'LOGIN_REQUIRED',
  'LOGIN_EXPIRED',
  'FORBIDDEN',
  'SOURCE_SESSION_INVALID',
]);

const VERIFICATION_CODES = new Set([
  'CAPTCHA_REQUIRED',
  'CAPTCHA_INVALID',
  'HUMAN_VERIFICATION_REQUIRED',
  'HUMAN_VERIFICATION_FAILED',
  'CAPTCHA_SOLVE_FAILED',
  'NEED_HUMAN_VERIFICATION',
  'RISK_COOLDOWN',
  'UPSTREAM_BLOCKED',
  'VERIFICATION_REQUIRED',
]);

const RATE_CODES = new Set(['RATE_LIMITED', 'SMS_RATE_LIMITED', 'UPSTREAM_RATE_LIMITED', 'TOO_MANY_REQUESTS']);

const UNAVAILABLE_CODES = new Set([
  'TIMEOUT',
  'UPSTREAM_TIMEOUT',
  'UPSTREAM_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
  'UPSTREAM_ERROR',
  'INTERNAL',
  'INTERNAL_ERROR',
  'CONFIG_ERROR',
  'BAD_STATE',
  'ENRICHMENT_PARTIAL',
]);

const BAD_REQUEST_CODES = new Set([
  'INVALID_ARGUMENT',
  'INVALID_PARAM',
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'NOT_IMPLEMENTED',
  'UPSTREAM_CHANGED',
  'PARSE_ERROR',
  'QUERY_EXPIRED',
  'PAGE_NOT_AVAILABLE',
  'ALREADY_RUNNING',
  'CONFLICT',
  'LOGIN_CANCELLED',
]);

export interface NormalizedErrorInput {
  source: string;
  status: number;
  envelopeError: UpstreamEnvelopeError | null;
  retryAfterMs?: number | null;
  url?: string;
  cause?: unknown;
}

function retryAfterFrom(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const err = (body as Record<string, unknown>).error as Record<string, unknown> | undefined;
  const details = (err?.details ?? (body as Record<string, unknown>).details) as Record<string, unknown> | undefined;
  const raw = details?.retryAfterMs ?? details?.retry_after_ms ?? details?.retryAfter;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

/** 上游错误 → LeadError（统一错误码，见 docs/04 §7） */
export function normalizeUpstreamError(input: NormalizedErrorInput): LeadError {
  const { source, status, envelopeError } = input;
  const code = envelopeError?.code ?? '';
  const details: Record<string, unknown> = {
    source,
    upstreamStatus: status,
    upstreamCode: code || null,
    ...(input.url ? { url: input.url } : {}),
    ...(envelopeError?.details ? { upstreamDetails: envelopeError.details } : {}),
  };
  const retryAfterMs = input.retryAfterMs ?? retryAfterFrom({ error: envelopeError }) ?? null;
  if (retryAfterMs != null) details.retryAfterMs = retryAfterMs;

  if (status === 401 || SESSION_CODES.has(code)) {
    return new LeadError('SOURCE_SESSION_INVALID', `${source}: 登录态无效（${code || status}）`, {
      retryable: false,
      details,
      cause: input.cause,
    });
  }
  if (status === 429 || RATE_CODES.has(code)) {
    return new LeadError('UPSTREAM_RATE_LIMITED', `${source}: 上游限频/风控冷却（${code || status}）`, {
      retryable: true,
      details,
      cause: input.cause,
    });
  }
  if (VERIFICATION_CODES.has(code) || (status === 409 && code === '')) {
    return new LeadError('SOURCE_VERIFICATION_PENDING', `${source}: 需要人机验证（${code || status}）`, {
      retryable: true,
      details,
      cause: input.cause,
    });
  }
  if (status === 404 || code === 'NOT_FOUND') {
    return new LeadError('NOT_FOUND', `${source}: 资源不存在（${code || status}）`, {
      retryable: false,
      details,
      cause: input.cause,
    });
  }
  if (status >= 500 || UNAVAILABLE_CODES.has(code) || status === 0) {
    const nonRetryable = code === 'UPSTREAM_CHANGED' || code === 'PARSE_ERROR';
    return new LeadError(nonRetryable ? 'UPSTREAM_BAD_REQUEST' : 'SOURCE_UNAVAILABLE', `${source}: 上游不可用（${code || status}）`, {
      retryable: !nonRetryable,
      details,
      cause: input.cause,
    });
  }
  if (status === 403) {
    return new LeadError('SOURCE_SESSION_INVALID', `${source}: 上游拒绝访问（${code || status}）`, { retryable: false, details });
  }
  return new LeadError('UPSTREAM_BAD_REQUEST', `${source}: 上游请求错误（${code || status}）`, {
    retryable: BAD_REQUEST_CODES.has(code) ? false : status >= 500,
    details,
    cause: input.cause,
  });
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

function buildQuery(query?: Record<string, string | number | boolean | null | undefined>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export interface RequestInitLite {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** 不重试（例如查询翻页外的幂等写请求，当前适配器只读，默认都允许重试） */
  noRetry?: boolean;
}

export class UpstreamHttpClient {
  readonly source: string;
  readonly baseUrl: string;
  readonly rateLimiter: RateLimiter;
  private readonly opts: HttpClientOptions;
  private readonly retry: Required<RetryConfig>;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.source = opts.source;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.retry = {
      maxAttempts: opts.retry?.maxAttempts ?? 3,
      baseDelayMs: opts.retry?.baseDelayMs ?? 1_000,
      maxDelayMs: opts.retry?.maxDelayMs ?? 30_000,
    };
    this.fetchImpl = opts.fetchImpl ?? ((...args) => fetch(...args));
    this.sleep = opts.sleep ?? defaultSleep;
    this.rateLimiter = new RateLimiter(opts.rate, { sleep: this.sleep, now: opts.now });
  }

  get<T>(path: string, query?: RequestInitLite['query']): Promise<UpstreamResult<T>> {
    return this.request<T>(path, { method: 'GET', query });
  }

  post<T>(path: string, body?: unknown, query?: RequestInitLite['query']): Promise<UpstreamResult<T>> {
    return this.request<T>(path, { method: 'POST', body, query });
  }

  async request<T>(path: string, init: RequestInitLite = {}): Promise<UpstreamResult<T>> {
    const method = init.method ?? 'GET';
    const url = `${this.baseUrl}${path}${buildQuery(init.query)}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...(this.opts.defaultHeaders ?? {}),
      ...(this.opts.requestHeaders ?? {}),
      ...(init.headers ?? {}),
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    let bodyText: string | undefined;
    if (init.body !== undefined) {
      bodyText = JSON.stringify(init.body);
      headers['content-type'] = headers['content-type'] ?? 'application/json';
    }

    const maxAttempts = init.noRetry ? 1 : Math.max(1, this.retry.maxAttempts);
    let lastError: LeadError | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.rateLimiter.take();
      let response: Response;
      try {
        const abort = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(this.opts.timeoutMs ?? 30_000) : undefined;
        response = await this.fetchImpl(url, { method, headers, body: bodyText, signal: abort });
      } catch (err) {
        lastError = new LeadError('SOURCE_UNAVAILABLE', `${this.source}: 请求失败 ${url}`, {
          retryable: true,
          details: { source: this.source, url, reason: err instanceof Error ? err.name : String(err) },
          cause: err,
        });
        if (attempt < maxAttempts) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        throw lastError;
      }

      const text = await response.text().catch(() => '');
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      const body = (parsed ?? (text ? { rawText: text.slice(0, 500) } : null)) as Record<string, unknown> | null;
      const okField = body && typeof body === 'object' ? (body as Record<string, unknown>).ok : undefined;
      const envelopeError =
        body && typeof body === 'object' && (body as Record<string, unknown>).error
          ? ((body as Record<string, unknown>).error as UpstreamEnvelopeError)
          : null;
      const requestId =
        (body && typeof body === 'object'
          ? ((body as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.requestId ??
            ((body as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.request_id
          : undefined) ?? response.headers.get('x-request-id') ?? null;
      const cached = Boolean(
        body && typeof body === 'object'
          ? ((body as Record<string, unknown>).meta as Record<string, unknown> | undefined)?.cached
          : false,
      );

      // 成功：HTTP 2xx 且 envelope ok !== false
      if (response.ok && okField !== false && !envelopeError) {
        const data = ((body as Record<string, unknown> | null)?.data ?? null) as T;
        return {
          data,
          meta: ((body as Record<string, unknown> | null)?.meta as Record<string, unknown>) ?? {},
          status: response.status,
          requestId: typeof requestId === 'string' ? requestId : null,
          cached,
          url,
        };
      }

      const retryAfterHeader = response.headers.get('retry-after');
      const retryAfterMs =
        retryAfterFrom(body) ??
        (retryAfterHeader && Number.isFinite(Number(retryAfterHeader)) ? Number(retryAfterHeader) * 1000 : null);

      const mapped =
        this.opts.errorMapper?.({ status: response.status, body, envelopeError }) ??
        normalizeUpstreamError({
          source: this.source,
          status: response.ok ? 502 : response.status,
          envelopeError,
          retryAfterMs,
          url,
        });
      const details = !mapped.details?.requestId && typeof requestId === 'string' ? { ...(mapped.details ?? {}), requestId } : mapped.details;
      lastError = new LeadError(mapped.code, mapped.message, {
        httpStatus: mapped.httpStatus,
        retryable: mapped.retryable,
        details,
        cause: mapped,
      });
      if (mapped.code === 'UPSTREAM_RATE_LIMITED') {
        if (retryAfterMs != null) this.rateLimiter.notifyRateLimited(retryAfterMs);
      }
      if (!mapped.retryable || attempt >= maxAttempts) throw lastError;
      const wait = retryAfterMs != null ? Math.min(retryAfterMs, 60_000) : this.backoff(attempt);
      await this.sleep(wait);
    }
    throw lastError ?? new LeadError('SOURCE_UNAVAILABLE', `${this.source}: 请求失败`, { details: { url } });
  }

  private backoff(attempt: number): number {
    const base = this.retry.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
    return Math.min(this.retry.maxDelayMs, base);
  }
}

export function createHttpClient(opts: HttpClientOptions): UpstreamHttpClient {
  return new UpstreamHttpClient(opts);
}

/** 组装来源状态（供 source_health 写入） */
export function sourceStatus(input: {
  platform: AllPlatformLike;
  state: SourceHealthLikeState;
  loggedIn?: boolean | null;
  expiresAt?: string | null;
  detail?: Record<string, unknown> | null;
}): {
  platform: AllPlatformLike;
  state: SourceHealthLikeState;
  loggedIn: boolean | null;
  expiresAt: string | null;
  checkedAt: string;
  detail: Record<string, unknown> | null;
} {
  return {
    platform: input.platform,
    state: input.state,
    loggedIn: input.loggedIn ?? null,
    expiresAt: input.expiresAt ?? null,
    checkedAt: nowIso(),
    detail: input.detail ?? null,
  };
}

type AllPlatformLike = 'boss' | 'zhilian' | 'ali' | 'mic' | 'tanji' | 'fuma';
type SourceHealthLikeState = 'ok' | 'degraded' | 'session_invalid' | 'verification_pending' | 'unavailable';
