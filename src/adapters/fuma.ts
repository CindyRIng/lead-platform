/**
 * fuma-platform 海关数据适配器（只读，不写 fuma、不占客保）
 *
 * 契约见 docs/04 §6.6 与 docs/08 §3：
 *  - POST /v1/customs/query  { accountId, inputCompany, companyFlag, page, pageSize, forceRefresh, allowStale }
 *  - GET  /v1/status
 *  - GET  /v1/customs/dictionaries?kind=countries|hscode|sources|updatelog
 *  - GET  /v1/customs/cache/stats
 *
 * 约束：
 *  - 账号级请求池「串行 + 限速」：本适配器内部用 SerialGate 保证并发 ≤ 1、请求间隔 ≥ minIntervalMs；
 *  - 上游 5xx/网络错误重试（最多 maxAttempts，指数退避）；4xx/权限/登录态错误不重试；
 *  - 错误统一归一为 LeadError（permission_denied → CUSTOMS_PERMISSION_DENIED，401 → SOURCE_SESSION_INVALID …）。
 */
import { LeadError } from '../shared/errors.js';
import { asArray, asRecord } from '../shared/json.js';

// ---------------------------------------------------------------------------
// 上游数据结构（fuma `list[]`，字段见 docs/04 §6.6；仅声明实际使用的字段）
// ---------------------------------------------------------------------------

export interface FumaCustomsRecord {
  sourcetype?: string | null;
  tradeno?: string | null;
  blnumber?: string | null;
  source?: string | null;
  inout?: string | null; // import / export
  regdate?: string | null;
  rawimporter?: string | null;
  importerid?: string | null;
  importercountry?: string | null;
  importercountrycn?: string | null;
  importercountryen?: string | null;
  rawexporter?: string | null;
  exporterid?: string | null;
  exportercountry?: string | null;
  exportercountrycn?: string | null;
  exportercountryen?: string | null;
  hscode?: string | null;
  weight?: number | string | null;
  count?: number | string | null;
  countunit?: string | null;
  money?: number | string | null;
  origincountry?: string | null;
  destcountry?: string | null;
  usedbuyername?: string | null;
  usedsuppliername?: string | null;
  importer?: string | null;
  exporter?: string | null;
  notify?: string | null;
  detail?: string | null;
  departureport?: string | null;
  dischargeport?: string | null;
  containernumber?: string | null;
  [key: string]: unknown;
}

export interface FumaCustomsQueryInput {
  /** 公司关键词（英文抬头优先；≥2 字符） */
  inputCompany: string;
  /** 1=进口数据视图，2=出口数据视图 */
  companyFlag: 1 | 2;
  page?: number;
  pageSize?: number;
  forceRefresh?: boolean;
  allowStale?: boolean;
}

export interface FumaCustomsQueryResult {
  records: FumaCustomsRecord[];
  totalNum: number | null;
  allCount: number | null;
  exactCount: number | null;
  source: string | null;
  cached: boolean;
  cachedAt: string | null;
  expiresAt: string | null;
  stale: boolean;
  upstreamVersion: string | null;
  page: number;
  pageSize: number;
  /** 上游原始 data（用于 raw_snapshots） */
  raw: unknown;
}

export interface FumaStatus {
  status: string | null;
  version: string | null;
  accounts: number | null;
  onlineAccounts: number | null;
  accountsDetail: unknown[];
  raw: unknown;
}

export interface FumaCustomsClient {
  queryCustoms(input: FumaCustomsQueryInput): Promise<FumaCustomsQueryResult>;
}

// ---------------------------------------------------------------------------
// 选项
// ---------------------------------------------------------------------------

export interface FumaRateLimitConfig {
  /** 账号串行下两次请求的最小间隔（默认 800ms；实测单查询 0.8–1.5s） */
  minIntervalMs?: number;
  /** 可选：每分钟上限（令牌桶，默认不启用；fuma 本身串行） */
  perMinute?: number;
}

export interface FumaClientOptions {
  baseUrl?: string;
  token?: string | null;
  accountId?: string | null;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  rate?: FumaRateLimitConfig;
  defaultPageSize?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:17890';
const DEFAULT_ACCOUNT_ID = 'acct_01';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// 传输与错误归一
// ---------------------------------------------------------------------------

interface EnvelopeLike {
  ok?: boolean;
  data?: unknown;
  meta?: unknown;
  error?: unknown;
}

function upstreamErrorCode(err: unknown): string | null {
  const e = asRecord(err);
  const code = e.code ?? e.errorCode ?? e.type;
  return typeof code === 'string' ? code.trim().toLowerCase() : null;
}

function upstreamErrorMessage(err: unknown): string {
  const e = asRecord(err);
  const msg = e.message ?? e.error ?? e.detail ?? e.msg;
  if (typeof msg === 'string' && msg.trim()) return msg.trim();
  if (typeof err === 'string') return err;
  return 'fuma upstream error';
}

/**
 * fuma 错误归一（docs/04 §7）。
 * permission_denied → CUSTOMS_PERMISSION_DENIED；401/unauthorized → SOURCE_SESSION_INVALID；
 * 429/rate_limited → UPSTREAM_RATE_LIMITED；5xx/超时/网络 → SOURCE_UNAVAILABLE（可重试）；
 * 其余 4xx → UPSTREAM_BAD_REQUEST。
 */
export function normalizeFumaError(
  status: number,
  error: unknown,
  opts?: { timeout?: boolean; network?: boolean },
): LeadError {
  const code = upstreamErrorCode(error);
  const message = upstreamErrorMessage(error);

  if (status === 401 || code === 'unauthorized' || code === 'session_invalid' || code === 'auth_required') {
    return new LeadError('SOURCE_SESSION_INVALID', `fuma 登录态失效: ${message}`, {
      httpStatus: 409,
      details: { upstreamStatus: status, upstreamCode: code },
    });
  }
  if (status === 403 || code === 'permission_denied' || code === 'forbidden' || code === 'no_permission') {
    return new LeadError('CUSTOMS_PERMISSION_DENIED', `fuma 海关权限不足: ${message}`, {
      httpStatus: 409,
      details: { upstreamStatus: status, upstreamCode: code },
    });
  }
  if (status === 429 || code === 'rate_limited' || code === 'rate_limit_exceeded' || code === 'too_many_requests') {
    return new LeadError('UPSTREAM_RATE_LIMITED', `fuma 限频: ${message}`, {
      httpStatus: 429,
      retryable: true,
      details: { upstreamStatus: status, upstreamCode: code },
    });
  }
  if (status === 404 || code === 'not_found') {
    return new LeadError('NOT_FOUND', `fuma 资源不存在: ${message}`, {
      httpStatus: 404,
      details: { upstreamStatus: status, upstreamCode: code },
    });
  }
  if (opts?.timeout || opts?.network || status >= 500 || status === 0) {
    return new LeadError('SOURCE_UNAVAILABLE', `fuma 不可用: ${message}`, {
      httpStatus: 503,
      retryable: true,
      details: { upstreamStatus: status, upstreamCode: code, timeout: !!opts?.timeout, network: !!opts?.network },
    });
  }
  return new LeadError('UPSTREAM_BAD_REQUEST', `fuma 请求失败(${status}): ${message}`, {
    httpStatus: 502,
    details: { upstreamStatus: status, upstreamCode: code },
  });
}

function isRetryableLeadError(err: LeadError): boolean {
  return err.retryable;
}

/** 串行门：并发 ≤ 1 且相邻请求间隔 ≥ minIntervalMs；可注入 now/sleep 便于测试。 */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve();
  private lastAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly now: () => number,
    private readonly sleep: (ms: number) => Promise<void>,
  ) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.minIntervalMs > 0) {
        const wait = this.minIntervalMs - (this.now() - this.lastAt);
        if (wait > 0) await this.sleep(wait);
      }
      this.lastAt = this.now();
      return await fn();
    } finally {
      release();
    }
  }
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class FumaClient implements FumaCustomsClient {
  private readonly baseUrl: string;
  private readonly token: string | null;
  readonly accountId: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly defaultPageSize: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: SerialGate;
  private readonly perMinute: number | null;
  private minuteWindowStart = 0;
  private minuteCount = 0;

  constructor(options: FumaClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token ?? null;
    this.accountId = options.accountId ?? DEFAULT_ACCOUNT_ID;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.defaultPageSize = options.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    this.gate = new SerialGate(options.rate?.minIntervalMs ?? 800, now, this.sleep);
    this.perMinute = options.rate?.perMinute ?? null;
  }

  // -- 低层请求 ---------------------------------------------------------------

  private async throttleByMinute(): Promise<void> {
    if (!this.perMinute) return;
    const now = Date.now();
    if (now - this.minuteWindowStart >= 60_000) {
      this.minuteWindowStart = now;
      this.minuteCount = 0;
    }
    if (this.minuteCount >= this.perMinute) {
      const wait = 60_000 - (now - this.minuteWindowStart);
      if (wait > 0) await this.sleep(wait);
      this.minuteWindowStart = Date.now();
      this.minuteCount = 0;
    }
    this.minuteCount += 1;
  }

  private async fetchOnce<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    let text = '';
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      const isTimeout = name === 'TimeoutError' || name === 'AbortError';
      throw normalizeFumaError(0, err, { timeout: isTimeout, network: !isTimeout });
    }

    let parsed: EnvelopeLike | null = null;
    try {
      parsed = text ? (JSON.parse(text) as EnvelopeLike) : null;
    } catch {
      if (!response.ok) throw normalizeFumaError(response.status, text.slice(0, 200));
      throw new LeadError('UPSTREAM_BAD_REQUEST', 'fuma 返回非 JSON 响应', {
        httpStatus: 502,
        details: { upstreamStatus: response.status },
      });
    }

    if (!response.ok) throw normalizeFumaError(response.status, parsed?.error ?? parsed);
    if (!parsed || parsed.ok === false) {
      throw normalizeFumaError(response.status, parsed?.error ?? parsed);
    }
    return (parsed.data ?? null) as T;
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.gate.run(async () => {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        await this.throttleByMinute();
        try {
          return await this.fetchOnce<T>(method, path, body);
        } catch (err) {
          const e = err instanceof LeadError ? err : new LeadError('INTERNAL_ERROR', String(err));
          if (attempt >= this.maxAttempts || !isRetryableLeadError(e)) throw e;
          const delay = this.retryBaseDelayMs * 2 ** (attempt - 1);
          await this.sleep(delay);
        }
      }
    });
  }

  // -- 业务方法 ---------------------------------------------------------------

  /** GET /v1/status → 健康/账号状态 */
  async getStatus(): Promise<FumaStatus> {
    const data = asRecord(await this.request<unknown>('GET', '/v1/status'));
    return {
      status: typeof data.status === 'string' ? data.status : null,
      version: typeof data.version === 'string' ? data.version : null,
      accounts: typeof data.accounts === 'number' ? data.accounts : null,
      onlineAccounts: typeof data.onlineAccounts === 'number' ? data.onlineAccounts : null,
      accountsDetail: asArray(data.accountsDetail),
      raw: data,
    };
  }

  /** POST /v1/customs/query → 提单记录 + 上游 totals/缓存元信息 */
  async queryCustoms(input: FumaCustomsQueryInput): Promise<FumaCustomsQueryResult> {
    const inputCompany = String(input.inputCompany ?? '').trim();
    if (inputCompany.length < 2) {
      throw new LeadError('VALIDATION_ERROR', 'inputCompany 至少 2 个字符', { httpStatus: 400 });
    }
    if (input.companyFlag !== 1 && input.companyFlag !== 2) {
      throw new LeadError('VALIDATION_ERROR', 'companyFlag 只能为 1 或 2', { httpStatus: 400 });
    }
    const page = Math.max(1, Math.trunc(input.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(input.pageSize ?? this.defaultPageSize)));
    const body = {
      accountId: this.accountId,
      inputCompany,
      companyFlag: input.companyFlag,
      page,
      pageSize,
      forceRefresh: input.forceRefresh === true,
      allowStale: input.allowStale !== false,
    };

    const raw = await this.request<unknown>('POST', '/v1/customs/query', body);
    const data = asRecord(raw);
    const records = asArray<FumaCustomsRecord>(data.list ?? data.records ?? data.tradeList);
    return {
      records,
      totalNum: numberOrNull(data.totalNum),
      allCount: numberOrNull(data.allCount),
      exactCount: numberOrNull(data.exactCount),
      source: typeof data.source === 'string' ? data.source : null,
      cached: data.cached === true,
      cachedAt: typeof data.cachedAt === 'string' ? data.cachedAt : null,
      expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : null,
      stale: data.stale === true,
      upstreamVersion: data.upstreamVersion == null ? null : String(data.upstreamVersion),
      page: numberOrNull(data.page) ?? page,
      pageSize: numberOrNull(data.pageSize) ?? pageSize,
      raw,
    };
  }

  /** GET /v1/customs/dictionaries?kind=…（TTL 7 天；仅只读参考） */
  async getDictionaries(kind?: 'countries' | 'hscode' | 'sources' | 'updatelog'): Promise<unknown> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return this.request<unknown>('GET', `/v1/customs/dictionaries${query}`);
  }

  /** GET /v1/customs/cache/stats（命中率/条目/占用） */
  async getCacheStats(): Promise<unknown> {
    return this.request<unknown>('GET', '/v1/customs/cache/stats');
  }
}

/** Lead `src/config.ts` 的扁平字段（fumaUrl/fumaToken/fumaAccountId；兼容旧的 fumaClientUrl/fumaApiToken） */
export interface FumaAppConfigLike {
  fumaUrl?: string;
  fumaToken?: string | null;
  fumaAccountId?: string | null;
  fumaClientUrl?: string;
  fumaApiToken?: string | null;
  [key: string]: unknown;
}

/**
 * 由扁平 AppConfig（或等价对象）构造 FumaClient，便于 main/wiring 一行接线：
 * `const fuma = createFumaClientFromConfig(config);`
 */
export function createFumaClientFromConfig(
  config: FumaAppConfigLike = {},
  extra: Omit<FumaClientOptions, 'baseUrl' | 'token' | 'accountId'> = {},
): FumaClient {
  const baseUrl = config.fumaUrl ?? config.fumaClientUrl ?? process.env.FUMA_CLIENT_URL;
  const token = config.fumaToken ?? config.fumaApiToken ?? process.env.FUMA_API_TOKEN ?? null;
  const accountId = config.fumaAccountId ?? process.env.FUMA_ACCOUNT_ID ?? null;
  const options: FumaClientOptions = { ...extra };
  if (baseUrl) options.baseUrl = baseUrl;
  if (token) options.token = token;
  if (accountId) options.accountId = accountId;
  return new FumaClient(options);
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return Number.isFinite(n) ? n : null;
}
