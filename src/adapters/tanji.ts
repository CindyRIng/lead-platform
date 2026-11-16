/**
 * 探迹（tanji-client，默认 http://127.0.0.1:8787）HTTP 适配器。
 *
 * 契约来源：docs/04-上游对接与区域映射.md §3.5（端点/参数/字段）、§5（字段映射）、§7（错误归一）；
 * 实测校准：docs/09-上游接口与流水线验证报告.md §2.5、docs/12 英文抬头匹配。
 *
 * 设计要点：
 * - 统一 envelope 解包 `{ok,data,meta,error}`；兼容非 envelope 响应（直接返回 data）。
 * - Bearer 鉴权（TANJI_API_TOKEN）。
 * - 令牌桶限频，默认 20 req/min（与 tanji-client 的 TANJI_RATE_PER_MIN 对齐）；429 时按
 *   `Retry-After`/`retryAfter` 暂停桶（默认 60s），避免继续打上游。
 * - 请求超时（默认 15s，AbortController）。
 * - 错误归一为 LeadError：UNAUTHORIZED / SOURCE_SESSION_INVALID / QUOTA_EXHAUSTED /
 *   SOURCE_VERIFICATION_PENDING / UPSTREAM_RATE_LIMITED / NOT_FOUND / UPSTREAM_BAD_REQUEST /
 *   SOURCE_UNAVAILABLE；`retryable` 由错误码语义决定。
 * - **安全约束**：POST /v1/companies/{id}/unlock 会消耗探迹额度。适配器默认 `allowUnlock=false`，
 *   此时调用 `unlockCompany()` 直接抛 UNSUPPORTED，绝不会发出网络请求。只有 P7 真实验收环境
 *   （显式 `allowUnlock: true` 或 TANJI_ALLOW_UNLOCK=true）才可发起解锁。开发/测试一律不得真实调用。
 * - 幂等键：调用方传入的 `idempotencyKey` 原样透传到请求体（不覆盖、不重编码）；缺省时按
 *   `unlock:<companyId>:<yyyy-MM-dd Asia/Shanghai>` 生成，与 docs/02 §11 的台账约定一致。
 * - 本适配器只做传输/归一，不做字段映射（字段映射由 enrichment worker 负责）。
 */
import { LeadError } from '../shared/errors.js';
import type { ErrorCode } from '../shared/errors.js';
import { shanghaiParts } from '../shared/time.js';

// ---------------------------------------------------------------------------
// 常量 / 类型
// ---------------------------------------------------------------------------

export const TANJI_DEFAULT_BASE_URL = 'http://127.0.0.1:8787';
export const TANJI_DEFAULT_RATE_PER_MIN = 20;
export const TANJI_DEFAULT_TIMEOUT_MS = 15_000;
export const TANJI_MAX_PAGE_SIZE = 100;
export const TANJI_MAX_PAGES = 50;

/** POST /v1/search/name 的 field 取值（docs/04 §3.5） */
export type TanjiSearchField = 'name' | 'socialCreditCode' | 'address' | 'contact';

/** 最小 fetch 契约，便于单测注入 mock，不依赖 DOM/undici 类型 */
export interface TanjiFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null } | null;
  text(): Promise<string>;
}
export type TanjiFetch = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<TanjiFetchResponse>;

export interface TanjiClientOptions {
  baseUrl?: string;
  token?: string | null;
  /** 上游单次请求超时，默认 15000ms */
  timeoutMs?: number;
  /** 限频（次/分钟），默认 20（tanji-client 的 TANJI_RATE_PER_MIN） */
  ratePerMin?: number;
  /** 令牌桶容量（突发请求数），默认 = ratePerMin */
  burst?: number;
  /** 是否允许调用解锁；默认 false（生产开发/测试环境禁止真实解锁） */
  allowUnlock?: boolean;
  fetchImpl?: TanjiFetch;
  /** 可注入时钟（毫秒），默认 Date.now */
  now?: () => number;
  /** 可注入 sleep，默认 setTimeout */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

/** 额度桶（docs/04 §5） */
export interface TanjiQuotaBucket {
  limit: number;
  used: number;
  remaining: number;
  unit?: string | null;
  raw?: Record<string, unknown>;
}

export interface TanjiQuota {
  daily: TanjiQuotaBucket | null;
  monthly: TanjiQuotaBucket | null;
  enterpriseMonthly: TanjiQuotaBucket | null;
  settlementDay: number | null;
  nearlySevenDayUnlockCount: number | null;
  raw: Record<string, unknown>;
}

export interface TanjiStatus {
  loggedIn: boolean | null;
  version: string | null;
  quota: TanjiQuota | null;
  raw: Record<string, unknown>;
}

export interface TanjiAccount {
  id: string;
  name: string | null;
  current: boolean | null;
  raw: Record<string, unknown>;
}

export interface TanjiAccountsResult {
  accounts: TanjiAccount[];
  raw: unknown;
}

/** SearchResult.companies[] = CompanySummary（docs/04 §3.5） */
export interface TanjiCompanySummary {
  id: string;
  name: string;
  uscc: string | null;
  englishName: string | null;
  legalRepresentative: string | null;
  regCapital: string | null;
  foundTime: string | null;
  address: string | null;
  province: string | null;
  city: string | null;
  operStatus: string | null;
  industry: string | null;
  scale: string | null;
  phoneCount: number | null;
  emailCount: number | null;
  contactCount: number | null;
  unlocked: boolean | null;
  tags: string[];
  /** 探迹相关度分（英文抬头实测 224–466，中文名 100–1100+） */
  score: number | null;
  rankScore: number | null;
  raw: Record<string, unknown>;
}

export interface TanjiSearchResult {
  queryId: string | null;
  companies: TanjiCompanySummary[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  pagesFetched: number;
  warnings: string[];
  raw: unknown;
}

export interface TanjiCompanyListResult {
  queryId: string | null;
  companies: TanjiCompanySummary[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  raw: unknown;
}

/** CompanyDetail（docs/04 §5） */
export interface TanjiCompanyDetail {
  id: string;
  name: string;
  uscc: string | null;
  englishName: string | null;
  legalRepresentative: string | null;
  regCapital: unknown;
  foundTime: string | null;
  address: string | null;
  province: string | null;
  city: string | null;
  operStatus: string | null;
  industry: unknown;
  scale: string | null;
  businessScope: string | null;
  homepage: string | null;
  phoneCount: number | null;
  emailCount: number | null;
  contactCount: number | null;
  unlocked: boolean | null;
  tags: string[];
  updatedAt: string | null;
  /** 全量上游对象（含 companyType/formerNames/keyPeople/shareholders 等扩展字段） */
  raw: Record<string, unknown>;
}

/** ContactItem（docs/04 §5） */
export interface TanjiContactItem {
  contactId: string;
  name: string | null;
  type: string;
  value: string;
  masked: boolean;
  department: string | null;
  position: string | null;
  region: string | null;
  source: string | null;
  isKeyLead: boolean;
  unlocked: boolean;
  raw: Record<string, unknown>;
}

/**
 * ContactsResult。注意（docs/09 §2.5 实测）：`CompanyDetail.unlocked` 与 contacts 接口的
 * unlocked 可能不一致；**解锁状态以 contacts 接口为准**，解锁前应先查本接口以免浪费额度。
 */
export interface TanjiContactsResult {
  companyId: string | null;
  unlocked: boolean;
  contacts: TanjiContactItem[];
  counts: { mobile: number | null; phone: number | null; email: number | null; total: number | null } | null;
  raw: unknown;
}

export interface TanjiUnlockOptions {
  /** 幂等键；缺省生成 `unlock:<companyId>:<yyyy-MM-dd>`。原样透传，不覆盖。 */
  idempotencyKey?: string;
  /** 是否请求精确额度（默认 true；仍只扣 1 点） */
  quota?: boolean;
  /** 是否同时返回联系人（默认 true；仍只扣 1 点） */
  contacts?: boolean;
  confirm?: boolean;
}

export interface TanjiUnlockResult {
  companyId: string | null;
  companyName: string | null;
  alreadyUnlocked: boolean;
  unlockedBy: string | null;
  unlockedAt: string | null;
  quotaCost: number | null;
  quotaBefore: number | null;
  quotaAfter: number | null;
  contacts: TanjiContactItem[];
  raw: unknown;
}

export interface TanjiNameSearchParams {
  name: string;
  field?: TanjiSearchField;
  /** 1..100，默认 20 */
  pageSize?: number;
  /** 1..50，默认：socialCreditCode=1，其余=2 */
  maxPages?: number;
}

export interface TanjiListCompaniesParams {
  queryId: string;
  page?: number;
  pageSize?: number;
}

export interface TanjiCallOptions {
  requestId?: string;
}

// ---------------------------------------------------------------------------
// 令牌桶（简单、FIFO、可注入时钟，便于测试）
// ---------------------------------------------------------------------------

export interface RateLimiterOptions {
  ratePerMin: number;
  capacity?: number;
  /** 最大并发请求数，默认 1（来源内部串行；docs/02 §12） */
  concurrency?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface LimiterWaiter {
  priority: number;
  seq: number;
  resolve: (release: () => void) => void;
}

/**
 * 令牌桶 + 优先级 + 串行闸门。
 * - 限频：默认 20 req/min，桶容量默认 = ratePerMin；
 * - 并发：默认 1（同一来源内部串行）；
 * - 优先级：数值越大越先获得令牌（unlock=10 > 批量读=0），同优先级 FIFO。
 * acquire() 返回 release()，调用方必须在请求结束后释放并发槽。
 */
export class RateLimiter {
  private readonly ratePerMs: number;
  private readonly capacity: number;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefill: number;
  private pausedUntil = 0;
  private active = 0;
  private seq = 0;
  private pumping = false;
  private readonly waiters: LimiterWaiter[] = [];

  constructor(opts: RateLimiterOptions) {
    const ratePerMin = opts.ratePerMin;
    if (!Number.isFinite(ratePerMin) || ratePerMin <= 0) {
      throw new LeadError('VALIDATION_ERROR', `限频配置非法：ratePerMin=${String(opts.ratePerMin)}`);
    }
    this.ratePerMs = ratePerMin / 60_000;
    this.capacity = Math.max(1, Math.floor(opts.capacity ?? ratePerMin));
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.now = opts.now ?? (() => Date.now());
    this.sleep =
      opts.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  /** 暂停令牌桶（如收到 429 Retry-After） */
  pauseFor(ms: number): void {
    if (!Number.isFinite(ms) || ms <= 0) return;
    this.pausedUntil = Math.max(this.pausedUntil, this.now() + ms);
    void this.pump();
  }

  /** 获取请求许可；返回 release()。priority 越大越优先（unlock 用高优先级）。 */
  acquire(priority = 0): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      this.waiters.push({ priority, seq: this.seq++, resolve });
      void this.pump();
    });
  }

  private refill(): void {
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.ratePerMs);
      this.lastRefill = now;
    }
  }

  /** 当前可用令牌数（观测用） */
  get available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /** 当前排队等待数（观测用） */
  get pending(): number {
    return this.waiters.length;
  }

  private pickWaiter(): number {
    let best = 0;
    for (let i = 1; i < this.waiters.length; i++) {
      const a = this.waiters[i] as LimiterWaiter;
      const b = this.waiters[best] as LimiterWaiter;
      if (a.priority > b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
    }
    return best;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        if (this.waiters.length === 0) break;
        const now = this.now();
        if (now < this.pausedUntil) {
          await this.sleep(Math.max(1, this.pausedUntil - now));
          continue;
        }
        if (this.active >= this.concurrency) break; // release() 会再次驱动 pump
        this.refill();
        if (this.tokens < 1) {
          await this.sleep(Math.max(1, Math.ceil((1 - this.tokens) / this.ratePerMs)));
          continue;
        }
        const idx = this.pickWaiter();
        const [waiter] = this.waiters.splice(idx, 1) as [LimiterWaiter];
        this.tokens -= 1;
        this.active += 1;
        let released = false;
        waiter.resolve(() => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          void this.pump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim();
    return t.length > 0 ? t : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  return null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = asString(item);
    if (s) out.push(s);
  }
  return out;
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  try {
    // 仅 loopback/合法 URL；非法配置直接拒绝
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`unsupported protocol ${parsed.protocol}`);
    }
    return trimmed;
  } catch (err) {
    throw new LeadError('VALIDATION_ERROR', `TANJI_CLIENT_URL 非法：${baseUrl}`, { cause: err });
  }
}

function assertIntInRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new LeadError('VALIDATION_ERROR', `${name} 必须是 ${min}..${max} 的整数，收到 ${String(value)}`);
  }
  return value;
}

/** 上游错误码 → LeadError 错误码（docs/04 §7） */
const UPSTREAM_CODE_MAP: Record<string, ErrorCode> = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  AUTH_REQUIRED: 'UNAUTHORIZED',
  AUTH_FAILED: 'UNAUTHORIZED',
  INVALID_TOKEN: 'UNAUTHORIZED',
  TOKEN_INVALID: 'UNAUTHORIZED',
  INVALID_API_TOKEN: 'UNAUTHORIZED',
  SESSION_INVALID: 'SOURCE_SESSION_INVALID',
  SESSION_EXPIRED: 'SOURCE_SESSION_INVALID',
  LOGIN_REQUIRED: 'SOURCE_SESSION_INVALID',
  NOT_LOGGED_IN: 'SOURCE_SESSION_INVALID',
  AUTH_EXPIRED: 'SOURCE_SESSION_INVALID',
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',
  QUOTA_LIMIT_EXCEEDED: 'QUOTA_EXHAUSTED',
  INSUFFICIENT_QUOTA: 'QUOTA_EXHAUSTED',
  RATE_LIMITED: 'UPSTREAM_RATE_LIMITED',
  RATE_LIMIT_EXCEEDED: 'UPSTREAM_RATE_LIMITED',
  TOO_MANY_REQUESTS: 'UPSTREAM_RATE_LIMITED',
  VERIFICATION_REQUIRED: 'SOURCE_VERIFICATION_PENDING',
  VERIFICATION_PENDING: 'SOURCE_VERIFICATION_PENDING',
  NEED_VERIFICATION: 'SOURCE_VERIFICATION_PENDING',
  CAPTCHA_REQUIRED: 'SOURCE_VERIFICATION_PENDING',
  LOGIN_VERIFICATION_REQUIRED: 'SOURCE_VERIFICATION_PENDING',
  NOT_FOUND: 'NOT_FOUND',
  COMPANY_NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'UPSTREAM_BAD_REQUEST',
  VALIDATION_ERROR: 'UPSTREAM_BAD_REQUEST',
  INVALID_PARAMS: 'UPSTREAM_BAD_REQUEST',
  UPSTREAM_BAD_REQUEST: 'UPSTREAM_BAD_REQUEST',
  TIMEOUT: 'SOURCE_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'SOURCE_UNAVAILABLE',
  NETWORK_ERROR: 'SOURCE_UNAVAILABLE',
  UPSTREAM_UNAVAILABLE: 'SOURCE_UNAVAILABLE',
  SERVER_ERROR: 'SOURCE_UNAVAILABLE',
  INTERNAL_ERROR: 'SOURCE_UNAVAILABLE',
};

function mapUpstreamCode(code: string | null): ErrorCode | null {
  if (!code) return null;
  return UPSTREAM_CODE_MAP[code.trim().toUpperCase()] ?? null;
}

/** HTTP 状态码 → LeadError 错误码 */
function mapHttpStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'UNAUTHORIZED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'QUOTA_EXHAUSTED';
  if (status === 429) return 'UPSTREAM_RATE_LIMITED';
  if (status >= 500) return 'SOURCE_UNAVAILABLE';
  if (status >= 400) return 'UPSTREAM_BAD_REQUEST';
  return 'SOURCE_UNAVAILABLE';
}

function parseRetryAfterMs(headerValue: string | null, fallbackMs: number | null = null): number | null {
  if (!headerValue) return fallbackMs;
  const trimmed = headerValue.trim();
  if (!trimmed) return fallbackMs;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return fallbackMs;
}

function todayInShanghai(now: Date = new Date()): string {
  const p = shanghaiParts(now);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function toCompanySummary(item: unknown): TanjiCompanySummary | null {
  const rec = asRecord(item);
  const id = asString(rec.id);
  const name = asString(rec.name);
  if (!id || !name) return null;
  return {
    id,
    name,
    uscc: asString(rec.uscc),
    englishName: asString(rec.englishName ?? rec.english_name ?? rec.nameEn),
    legalRepresentative: asString(rec.legalRepresentative),
    regCapital: typeof rec.regCapital === 'string' ? rec.regCapital : null,
    foundTime: asString(rec.foundTime),
    address: asString(rec.address),
    province: asString(rec.province),
    city: asString(rec.city),
    operStatus: asString(rec.operStatus),
    industry: typeof rec.industry === 'string' ? rec.industry : null,
    scale: asString(rec.scale),
    phoneCount: asNumber(rec.phoneCount),
    emailCount: asNumber(rec.emailCount),
    contactCount: asNumber(rec.contactCount),
    unlocked: asBoolean(rec.unlocked),
    tags: asStringArray(rec.tags),
    score: asNumber(rec.score),
    rankScore: asNumber(rec.rankScore),
    raw: rec,
  };
}

function toContactItem(item: unknown): TanjiContactItem | null {
  const rec = asRecord(item);
  const value = asString(rec.value);
  if (!value) return null;
  return {
    contactId: asString(rec.contactId) ?? asString(rec.id) ?? '',
    name: asString(rec.name),
    type: asString(rec.type) ?? 'phone',
    value,
    masked: rec.masked === true,
    department: asString(rec.department),
    position: asString(rec.position),
    region: asString(rec.region),
    source: asString(rec.source),
    isKeyLead: rec.isKeyLead === true || rec.isKey === true,
    unlocked: rec.unlocked === true,
    raw: rec,
  };
}

function toContacts(items: unknown): TanjiContactItem[] {
  if (!Array.isArray(items)) return [];
  const out: TanjiContactItem[] = [];
  for (const item of items) {
    const parsed = toContactItem(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function toQuotaBucket(value: unknown): TanjiQuotaBucket | null {
  if (!isRecord(value)) return null;
  const limit = asNumber(value.limit);
  const used = asNumber(value.used);
  const remaining = asNumber(value.remaining);
  const unit = asString(value.unit);
  if (limit === null && used === null && remaining === null) return null;
  return {
    limit: limit ?? 0,
    used: used ?? 0,
    remaining: remaining ?? 0,
    unit,
    raw: value,
  };
}

function toQuota(value: unknown): TanjiQuota | null {
  if (!isRecord(value)) return null;
  return {
    daily: toQuotaBucket(value.daily),
    monthly: toQuotaBucket(value.monthly),
    enterpriseMonthly: toQuotaBucket(value.enterpriseMonthly ?? value.enterprise_monthly),
    settlementDay: asNumber(value.settlementDay ?? value.settlement_day),
    nearlySevenDayUnlockCount: asNumber(value.nearlySevenDayUnlockCount ?? value.nearly_seven_day_unlock_count),
    raw: value,
  };
}

function toStatus(data: unknown): TanjiStatus {
  const rec = asRecord(data);
  return {
    loggedIn: asBoolean(rec.loggedIn ?? rec.logged_in),
    version: asString(rec.version),
    quota: toQuota(rec.quota),
    raw: rec,
  };
}

function toCompanyDetail(data: unknown): TanjiCompanyDetail {
  const rec = asRecord(data);
  const id = asString(rec.id);
  const name = asString(rec.name);
  if (!id || !name) {
    throw new LeadError('SOURCE_UNAVAILABLE', '探迹公司详情响应缺少 id/name', {
      details: { keys: Object.keys(rec).slice(0, 20) },
    });
  }
  return {
    id,
    name,
    uscc: asString(rec.uscc),
    englishName: asString(rec.englishName ?? rec.english_name),
    legalRepresentative: asString(rec.legalRepresentative),
    regCapital: rec.regCapital ?? null,
    foundTime: asString(rec.foundTime),
    address: asString(rec.address),
    province: asString(rec.province),
    city: asString(rec.city),
    operStatus: asString(rec.operStatus),
    industry: rec.industry ?? null,
    scale: asString(rec.scale),
    businessScope: asString(rec.businessScope),
    homepage: asString(rec.homepage),
    phoneCount: asNumber(rec.phoneCount),
    emailCount: asNumber(rec.emailCount),
    contactCount: asNumber(rec.contactCount),
    unlocked: asBoolean(rec.unlocked),
    tags: asStringArray(rec.tags),
    updatedAt: asString(rec.updatedAt),
    raw: rec,
  };
}

// ---------------------------------------------------------------------------
// TanjiClient
// ---------------------------------------------------------------------------

type HttpMethod = 'GET' | 'POST';

interface RequestInitLike {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | number | null | undefined>;
  body?: unknown;
  requestId?: string;
  /** 调度优先级：unlock=10（优先），批量读=0 */
  priority?: number;
}

interface ErrorContext {
  method: HttpMethod;
  path: string;
  requestId?: string;
  upstreamStatus: number;
  upstreamCode?: string | null;
}

export class TanjiClient {
  readonly baseUrl: string;
  readonly ratePerMin: number;
  readonly timeoutMs: number;
  readonly allowUnlock: boolean;
  readonly limiter: RateLimiter;
  private readonly token: string | null;
  private readonly fetchImpl: TanjiFetch;
  private readonly userAgent: string;

  constructor(options: TanjiClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? TANJI_DEFAULT_BASE_URL);
    this.token = options.token && options.token.trim() !== '' ? options.token.trim() : null;
    this.timeoutMs = options.timeoutMs ?? TANJI_DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new LeadError('VALIDATION_ERROR', `timeoutMs 非法：${String(options.timeoutMs)}`);
    }
    this.ratePerMin = options.ratePerMin ?? TANJI_DEFAULT_RATE_PER_MIN;
    this.allowUnlock = options.allowUnlock === true;
    this.userAgent = options.userAgent ?? 'lead-platform/0.1 (+tanji-adapter)';
    this.limiter = new RateLimiter({
      ratePerMin: this.ratePerMin,
      capacity: options.burst,
      now: options.now,
      sleep: options.sleep,
    });
    this.fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as TanjiFetch);
    if (typeof this.fetchImpl !== 'function') {
      throw new LeadError('INTERNAL_ERROR', '未找到可用 fetch 实现（Node >= 22 自带）');
    }
  }

  // -- 基础请求 -------------------------------------------------------------

  private async request<T>(init: RequestInitLike): Promise<T> {
    const release = await this.limiter.acquire(init.priority ?? 0);

    const url = new URL(this.baseUrl + init.path);
    if (init.query) {
      for (const [key, value] of Object.entries(init.query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': this.userAgent,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.requestId) headers['x-request-id'] = init.requestId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    timer.unref?.();

    let response: TanjiFetchResponse;
    try {
      try {
        response = await this.fetchImpl(url, {
          method: init.method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
          redirect: 'error',
        });
      } finally {
        release();
      }
    } catch (err) {
      const aborted = controller.signal.aborted;
      throw new LeadError(
        'SOURCE_UNAVAILABLE',
        aborted
          ? `探迹请求超时（${this.timeoutMs}ms）：${init.method} ${init.path}`
          : `探迹请求失败（网络/连接错误）：${init.method} ${init.path}：${err instanceof Error ? err.message : String(err)}`,
        {
          retryable: true,
          cause: err,
          details: { timeoutMs: this.timeoutMs, method: init.method, path: init.path, aborted, requestId: init.requestId },
        },
      );
    } finally {
      clearTimeout(timer);
    }

    const retryAfterMs = this.retryAfterFromHeaders(response, null);

    let text: string;
    try {
      text = await response.text();
    } catch (err) {
      throw new LeadError('SOURCE_UNAVAILABLE', `读取探迹响应失败：${init.method} ${init.path}`, {
        retryable: true,
        cause: err,
        details: { method: init.method, path: init.path, upstreamStatus: response.status, requestId: init.requestId },
      });
    }

    let payload: unknown = null;
    if (text.trim() !== '') {
      try {
        payload = JSON.parse(text) as unknown;
      } catch (err) {
        if (!response.ok) {
          throw this.httpError(init, response.status, null, `上游返回非 JSON（HTTP ${response.status}）`, retryAfterMs);
        }
        throw new LeadError('SOURCE_UNAVAILABLE', `探迹响应非法 JSON：${init.method} ${init.path}`, {
          retryable: true,
          cause: err,
          details: {
            method: init.method,
            path: init.path,
            upstreamStatus: response.status,
            bodyPreview: text.slice(0, 200),
            requestId: init.requestId,
          },
        });
      }
    }

    const envelope = isRecord(payload) && typeof payload.ok === 'boolean' ? payload : null;
    if (envelope && envelope.ok === false) {
      throw this.upstreamError(init, response.status, envelope.error, retryAfterMs);
    }
    if (!response.ok) {
      throw this.httpError(init, response.status, null, null, retryAfterMs);
    }
    if (envelope) return (envelope.data ?? null) as T;
    return payload as T;
  }

  private retryAfterFromHeaders(response: TanjiFetchResponse, fallbackMs: number | null): number | null {
    try {
      const header = response.headers?.get?.('retry-after') ?? null;
      return parseRetryAfterMs(header, fallbackMs);
    } catch {
      return fallbackMs;
    }
  }

  private errorDetails(ctx: ErrorContext): Record<string, unknown> {
    const details: Record<string, unknown> = {
      upstream: 'tanji',
      method: ctx.method,
      path: ctx.path,
      upstreamStatus: ctx.upstreamStatus,
    };
    if (ctx.upstreamCode) details.upstreamCode = ctx.upstreamCode;
    if (ctx.requestId) details.requestId = ctx.requestId;
    return details;
  }

  /** envelope.error / 上游业务错误 → LeadError（可能带 retryAfter/cooldownUntil） */
  private upstreamError(
    init: RequestInitLike,
    status: number,
    error: unknown,
    fallbackRetryAfterMs: number | null,
  ): LeadError {
    const errRec = asRecord(error);
    const rawCode = asString(errRec.code);
    const message = asString(errRec.message) ?? asString(errRec.msg) ?? `探迹上游错误（HTTP ${status}）`;
    const mapped = mapUpstreamCode(rawCode) ?? mapHttpStatus(status);
    const retryAfterMs =
      asNumber(errRec.retryAfterMs) ??
      asNumber(errRec.retry_after_ms) ??
      (asNumber(errRec.retryAfter) !== null ? (asNumber(errRec.retryAfter) as number) * 1000 : null) ??
      parseRetryAfterMs(asString(errRec.retryAfter), fallbackRetryAfterMs) ??
      fallbackRetryAfterMs;
    const details = this.errorDetails({
      method: init.method,
      path: init.path,
      requestId: init.requestId,
      upstreamStatus: status,
      upstreamCode: rawCode,
    });
    if (retryAfterMs !== null) details.retryAfterMs = retryAfterMs;
    if (isRecord(errRec.details)) details.upstreamDetails = errRec.details;
    if (mapped === 'UPSTREAM_RATE_LIMITED') {
      this.limiter.pauseFor(retryAfterMs ?? 60_000);
    }
    return new LeadError(mapped, `探迹上游错误 [${rawCode ?? status}]：${message}（${init.method} ${init.path}）`, {
      retryable: mapped === 'UPSTREAM_RATE_LIMITED' || mapped === 'SOURCE_UNAVAILABLE',
      details,
      cause: undefined,
    });
  }

  /** 无 envelope 的 HTTP 错误 → LeadError */
  private httpError(
    init: RequestInitLike,
    status: number,
    body: unknown,
    fallbackMessage: string | null,
    retryAfterMs: number | null,
  ): LeadError {
    const rec = asRecord(body);
    const rawCode = asString(rec.code) ?? asString(asRecord(rec.error).code);
    const message = asString(rec.message) ?? asString(asRecord(rec.error).message) ?? fallbackMessage ?? `探迹上游 HTTP ${status}`;
    const mapped = mapUpstreamCode(rawCode) ?? mapHttpStatus(status);
    const details = this.errorDetails({
      method: init.method,
      path: init.path,
      requestId: init.requestId,
      upstreamStatus: status,
      upstreamCode: rawCode,
    });
    if (retryAfterMs !== null) details.retryAfterMs = retryAfterMs;
    if (mapped === 'UPSTREAM_RATE_LIMITED') {
      this.limiter.pauseFor(retryAfterMs ?? 60_000);
    }
    return new LeadError(mapped, `探迹上游错误（HTTP ${status}）：${message}（${init.method} ${init.path}）`, {
      retryable: mapped === 'UPSTREAM_RATE_LIMITED' || mapped === 'SOURCE_UNAVAILABLE',
      details,
    });
  }

  // -- 端点（docs/04 §3.5） -------------------------------------------------

  /** GET /v1/status：登录态 + 额度（不扣额度） */
  async getStatus(options: TanjiCallOptions = {}): Promise<TanjiStatus> {
    const data = await this.request<unknown>({
      method: 'GET',
      path: '/v1/status',
      requestId: options.requestId,
    });
    return toStatus(data);
  }

  /** GET /v1/accounts：多账号列表（当前仅 main） */
  async getAccounts(options: TanjiCallOptions = {}): Promise<TanjiAccountsResult> {
    const data = await this.request<unknown>({
      method: 'GET',
      path: '/v1/accounts',
      requestId: options.requestId,
    });
    const rec = asRecord(data);
    const rawList = Array.isArray(data) ? data : Array.isArray(rec.accounts) ? rec.accounts : [];
    const accounts: TanjiAccount[] = [];
    for (const item of rawList) {
      const itemRec = asRecord(item);
      const id = asString(itemRec.id) ?? asString(itemRec.accountId) ?? asString(itemRec.name);
      if (!id) continue;
      accounts.push({
        id,
        name: asString(itemRec.name) ?? asString(itemRec.label),
        current: asBoolean(itemRec.current ?? itemRec.isDefault),
        raw: itemRec,
      });
    }
    return {
      accounts,
      raw: data,
    };
  }

  /**
   * POST /v1/search/name：按 USCC / 名称 / 地址 / 联系方式匹配（搜索/翻页/详情不扣额度）。
   * - 默认 pageSize=20、maxPages=2（socialCreditCode 默认 maxPages=1）
   * - pageSize 上限 100，maxPages 上限 50（超出抛 VALIDATION_ERROR）
   * - 响应 SearchResult：queryId/companies/page/pageSize/total/hasMore/pagesFetched/warnings
   */
  async searchByName(params: TanjiNameSearchParams, options: TanjiCallOptions = {}): Promise<TanjiSearchResult> {
    const name = params.name?.trim();
    if (!name || name.length < 2) {
      throw new LeadError('VALIDATION_ERROR', `探迹匹配参数 name 至少 2 个字符（收到 "${params.name ?? ''}"）`);
    }
    const field: TanjiSearchField = params.field ?? 'name';
    if (!['name', 'socialCreditCode', 'address', 'contact'].includes(field)) {
      throw new LeadError('VALIDATION_ERROR', `探迹匹配 field 非法：${String(field)}`);
    }
    const pageSize = assertIntInRange(params.pageSize ?? 20, 'pageSize', 1, TANJI_MAX_PAGE_SIZE);
    const maxPages = assertIntInRange(
      params.maxPages ?? (field === 'socialCreditCode' ? 1 : 2),
      'maxPages',
      1,
      TANJI_MAX_PAGES,
    );

    const data = await this.request<unknown>({
      method: 'POST',
      path: '/v1/search/name',
      body: { name, field, pageSize, maxPages },
      requestId: options.requestId,
    });
    const rec = asRecord(data);
    const list = Array.isArray(rec.companies) ? rec.companies : Array.isArray(rec.list) ? rec.list : [];
    const companies: TanjiCompanySummary[] = [];
    for (const item of list) {
      const summary = toCompanySummary(item);
      if (summary) companies.push(summary);
    }
    return {
      queryId: asString(rec.queryId),
      companies,
      page: asNumber(rec.page) ?? 1,
      pageSize: asNumber(rec.pageSize) ?? pageSize,
      total: asNumber(rec.total) ?? companies.length,
      hasMore: rec.hasMore === true,
      pagesFetched: asNumber(rec.pagesFetched) ?? 1,
      warnings: asStringArray(rec.warnings),
      raw: data,
    };
  }

  /** GET /v1/companies?queryId=...：按 queryId 续翻搜索结果（不扣额度） */
  async listCompanies(params: TanjiListCompaniesParams, options: TanjiCallOptions = {}): Promise<TanjiCompanyListResult> {
    const queryId = params.queryId?.trim();
    if (!queryId) throw new LeadError('VALIDATION_ERROR', 'listCompanies 需要 queryId');
    const page = assertIntInRange(params.page ?? 1, 'page', 1, 10_000);
    const pageSize = assertIntInRange(params.pageSize ?? 20, 'pageSize', 1, TANJI_MAX_PAGE_SIZE);
    const data = await this.request<unknown>({
      method: 'GET',
      path: '/v1/companies',
      query: { queryId, page, pageSize },
      requestId: options.requestId,
    });
    const rec = asRecord(data);
    const list = Array.isArray(rec.companies) ? rec.companies : Array.isArray(rec.list) ? rec.list : [];
    const companies: TanjiCompanySummary[] = [];
    for (const item of list) {
      const summary = toCompanySummary(item);
      if (summary) companies.push(summary);
    }
    return {
      queryId: asString(rec.queryId) ?? queryId,
      companies,
      page: asNumber(rec.page) ?? page,
      pageSize: asNumber(rec.pageSize) ?? pageSize,
      total: asNumber(rec.total) ?? companies.length,
      hasMore: rec.hasMore === true,
      raw: data,
    };
  }

  /** GET /v1/companies/{id}：工商详情（详情免费、缓存 7d；refresh=true 强制刷新） */
  async getCompany(companyId: string, options: TanjiCallOptions & { refresh?: boolean } = {}): Promise<TanjiCompanyDetail> {
    const id = companyId?.trim();
    if (!id) throw new LeadError('VALIDATION_ERROR', 'getCompany 需要 companyId');
    const data = await this.request<unknown>({
      method: 'GET',
      path: `/v1/companies/${encodeURIComponent(id)}`,
      query: options.refresh === true ? { refresh: 'true' } : undefined,
      requestId: options.requestId,
    });
    return toCompanyDetail(data);
  }

  /**
   * GET /v1/companies/{id}/contacts：联系人（未解锁返回空）
   * **注意**：解锁状态以本接口为准（CompanyDetail.unlocked 可能不一致）；解锁前先查本接口可省额度。
   */
  async getContacts(companyId: string, options: TanjiCallOptions = {}): Promise<TanjiContactsResult> {
    const id = companyId?.trim();
    if (!id) throw new LeadError('VALIDATION_ERROR', 'getContacts 需要 companyId');
    const data = await this.request<unknown>({
      method: 'GET',
      path: `/v1/companies/${encodeURIComponent(id)}/contacts`,
      requestId: options.requestId,
    });
    const rec = asRecord(data);
    const countsRec = asRecord(rec.counts);
    const hasCounts = Object.keys(countsRec).length > 0;
    return {
      companyId: asString(rec.companyId) ?? id,
      unlocked: rec.unlocked === true,
      contacts: toContacts(rec.contacts),
      counts: hasCounts
        ? {
            mobile: asNumber(countsRec.mobile),
            phone: asNumber(countsRec.phone),
            email: asNumber(countsRec.email),
            total: asNumber(countsRec.total),
          }
        : null,
      raw: data,
    };
  }

  /**
   * POST /v1/companies/{id}/unlock：解锁联系人（**消耗 1 额度点**）。
   *
   * 安全：默认构造的客户端 allowUnlock=false，本方法直接抛 UNSUPPORTED、不发网络请求；
   * 只有显式 allowUnlock=true（P7 真实验收、用户授权）才能调用。开发/测试一律 mock。
   *
   * 建议 body：{confirm:true, quota:true, contacts:true, idempotencyKey}；
   * `alreadyUnlocked=true` → 不扣额度；QUOTA_EXHAUSTED(409) → 调用方转 waiting_quota。
   */
  async unlockCompany(companyId: string, unlockOptions: TanjiUnlockOptions = {}, callOptions: TanjiCallOptions = {}): Promise<TanjiUnlockResult> {
    if (!this.allowUnlock) {
      throw new LeadError(
        'UNSUPPORTED',
        '探迹解锁未启用：适配器默认 allowUnlock=false（开发/测试禁止真实解锁；P7 真实验收需显式开启并授权额度）',
        {
          retryable: false,
          details: { companyId, blockedBy: 'allowUnlock=false', upstream: 'tanji' },
        },
      );
    }
    const id = companyId?.trim();
    if (!id) throw new LeadError('VALIDATION_ERROR', 'unlockCompany 需要 companyId');

    const idempotencyKey = unlockOptions.idempotencyKey ?? `unlock:${id}:${todayInShanghai()}`;
    if (idempotencyKey.trim().length === 0 || idempotencyKey.length > 200) {
      throw new LeadError('VALIDATION_ERROR', 'idempotencyKey 长度非法（1..200）', {
        details: { idempotencyKey },
      });
    }

    const body: Record<string, unknown> = {
      confirm: unlockOptions.confirm ?? true,
      quota: unlockOptions.quota ?? true,
      contacts: unlockOptions.contacts ?? true,
      idempotencyKey, // 原样透传
    };
    const data = await this.request<unknown>({
      method: 'POST',
      path: `/v1/companies/${encodeURIComponent(id)}/unlock`,
      body,
      requestId: callOptions.requestId,
      priority: 10, // 解锁优先于批量读（docs/02 §12）
    });
    const rec = asRecord(data);
    return {
      companyId: asString(rec.companyId) ?? id,
      companyName: asString(rec.companyName),
      alreadyUnlocked: rec.alreadyUnlocked === true,
      unlockedBy: asString(rec.unlockedBy),
      unlockedAt: asString(rec.unlockedAt),
      quotaCost: asNumber(rec.quotaCost),
      quotaBefore: asNumber(rec.quotaBefore),
      quotaAfter: asNumber(rec.quotaAfter),
      contacts: toContacts(rec.contacts),
      raw: data,
    };
  }

  /** GET /v1/filters/registry：高级筛选项字典（只读；预留给 field=advance，可选） */
  async getFiltersRegistry(options: TanjiCallOptions = {}): Promise<{ raw: unknown }> {
    const data = await this.request<unknown>({
      method: 'GET',
      path: '/v1/filters/registry',
      requestId: options.requestId,
    });
    return { raw: data };
  }
}

export function createTanjiClient(options: TanjiClientOptions = {}): TanjiClient {
  return new TanjiClient(options);
}

export interface TanjiEnvSource {
  TANJI_CLIENT_URL?: string;
  TANJI_API_TOKEN?: string;
  TANJI_RATE_PER_MIN?: string;
  TANJI_TIMEOUT_MS?: string;
  TANJI_ALLOW_UNLOCK?: string;
  [key: string]: string | undefined;
}

/**
 * 从环境变量创建客户端（默认读取 process.env）。
 * 真实解锁需要 TANJI_ALLOW_UNLOCK=true（默认关闭）。
 */
export function createTanjiClientFromEnv(
  env: TanjiEnvSource = process.env,
  overrides: Partial<TanjiClientOptions> = {},
): TanjiClient {
  const rate = env.TANJI_RATE_PER_MIN ? Number(env.TANJI_RATE_PER_MIN) : TANJI_DEFAULT_RATE_PER_MIN;
  const timeout = env.TANJI_TIMEOUT_MS ? Number(env.TANJI_TIMEOUT_MS) : TANJI_DEFAULT_TIMEOUT_MS;
  return new TanjiClient({
    baseUrl: env.TANJI_CLIENT_URL ?? TANJI_DEFAULT_BASE_URL,
    token: env.TANJI_API_TOKEN ?? null,
    ratePerMin: Number.isFinite(rate) && rate > 0 ? rate : TANJI_DEFAULT_RATE_PER_MIN,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : TANJI_DEFAULT_TIMEOUT_MS,
    allowUnlock: env.TANJI_ALLOW_UNLOCK === 'true' || env.TANJI_ALLOW_UNLOCK === '1',
    ...overrides,
  });
}
