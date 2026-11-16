/**
 * 解锁队列 Worker（U1，FR-6 / AC-4 / Q14）。
 *
 * 关键规则：
 * - 入队：公司 `tanji_enriched` 且 `unlock_status=pending`（或 none）→ `pipeline_jobs(stage='unlock')`；
 * - 顺序：按 unlockPolicy 优先级（P0 招聘在招 > P1 付费/认证会员 > P2 有海关记录 > P3 其余），
 *   同级内 FIFO（created_at 升序）；P3（priority > maxAutoPriority）不自动解锁、不入队；
 * - 执行前置检查：先查 tanji contacts；`unlocked=true` 直接取明文入库，**不调用 unlock、不耗额度**；
 * - 成功：写 unlock_ledger（quotaCost/quotaBefore/quotaAfter）、联系人 upsert、company unlock_status=unlocked、
 *   追加 `contact.unlocked` 变更事件；
 * - QUOTA_EXHAUSTED：任务 waiting_quota、队列暂停；其他错误退避重试，超限 dead；
 * - 测试/开发环境绝不真实调用 unlock（依赖注入的 TanjiUnlockPort；tanji client 默认 allowUnlock=false）。
 */
import { LeadError } from '../shared/errors.js';
import { nowIso, shanghaiParts } from '../shared/time.js';
import type { JobStatus, UnlockStatus } from '../shared/domain.js';
import type { TanjiClient, TanjiContactItem, TanjiStatus } from '../adapters/tanji.js';

// ---------------------------------------------------------------------------
// 端口类型（结构上由 src/adapters/tanji.ts 的 TanjiClient 满足；测试用 mock）
// ---------------------------------------------------------------------------

/** Unlock Worker 只依赖 tanji client 的三个方法 */
export type TanjiUnlockPort = Pick<TanjiClient, 'getContacts' | 'unlockCompany' | 'getStatus'>;

export interface TanjiContactLike {
  contactId?: string | null;
  name?: string | null;
  type?: string | null;
  value: string;
  masked?: boolean | null;
  department?: string | null;
  position?: string | null;
  region?: string | null;
  source?: string | null;
  isKeyLead?: boolean | null;
}

export interface UnlockJobRecord {
  id: string;
  companyId: string;
  platform: string | null;
  runId: string | null;
  stage: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UnlockCompanyRecord {
  id: string;
  name: string;
  tanjiCompanyId: string | null;
  enrichmentStatus: string;
  unlockStatus: string;
  firstSeenAt: string;
}

export interface UnlockSignals {
  /** P0：Boss/智联招聘源公司且有在招岗位 */
  hasRecruiting: boolean;
  /** P1：Ali 金品诚企/Verified 或 Mic 钻石/金牌/Audited 等付费/认证会员 */
  isPaidMember: boolean;
  /** P2：有海关出口/进口记录（customs 画像 matched>0） */
  hasCustomsRecord: boolean;
}

export interface UnlockCandidate {
  job: UnlockJobRecord;
  company: UnlockCompanyRecord;
  signals: UnlockSignals;
}

export interface UnlockContactInput {
  tanjiContactId?: string | null;
  name?: string | null;
  position?: string | null;
  department?: string | null;
  region?: string | null;
  type: 'mobile' | 'phone' | 'email';
  value: string;
  masked?: boolean;
  source?: string | null;
  isKey?: boolean;
}

export interface UnlockLedgerInput {
  companyId: string;
  tanjiCompanyId: string | null;
  result: 'unlocked' | 'already_unlocked' | 'failed';
  quotaCost: number;
  quotaBefore: number | null;
  quotaAfter: number | null;
  accountId: string | null;
  idempotencyKey: string;
  errorCode?: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

export interface QuotaObservationSnapshot {
  observedAt: string;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  enterpriseLimit: number | null;
  enterpriseRemaining: number | null;
  settlementDay: number | null;
  raw?: unknown;
}

export interface UnlockEventInput {
  companyId: string;
  entityType?: 'company' | 'platform_profile' | 'job';
  entityId?: string | null;
  version: number;
  eventType: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  valueType?: string | null;
  source: string;
  runId?: string | null;
  actor?: string | null;
  occurredAt?: string;
}

type Maybe<T> = T | Promise<T>;

/**
 * 解锁 Worker 的数据访问端口；生产实现见 `src/pipeline/f2UnlockStore.ts`
 * （基于 F2 repositories），测试用内存 fake。
 */
export interface UnlockStore {
  // pipeline_jobs
  ensureJob(input: { companyId: string; stage: 'unlock'; runId?: string | null }): Maybe<{ job: UnlockJobRecord; created: boolean }>;
  claimJob(id: string, opts: { workerId: string; leaseSec: number; now: Date }): Maybe<UnlockJobRecord | null>;
  completeJob(id: string): Maybe<void>;
  failJob(
    id: string,
    opts: { errorCode?: string; error?: string; retryable: boolean; nextRetryAt?: string | null; now?: Date },
  ): Maybe<void>;
  waitForQuota(id: string, opts?: { reason?: string }): Maybe<void>;
  /** waiting_quota → pending（额度恢复时批量唤醒），返回唤醒数 */
  wakeWaitingQuota(opts?: { limit?: number; now?: Date }): Maybe<number>;
  /** 把当前所有 pending 的 unlock 任务置为 waiting_quota（额度耗尽时暂停队列），返回数 */
  pausePending(opts?: { limit?: number }): Maybe<number>;

  // companies / signals
  listCandidates(limit: number): Maybe<UnlockCandidate[]>;
  listEligibleCompanies(limit: number): Maybe<UnlockCompanyRecord[]>;
  loadSignals(companyIds: string[]): Maybe<Map<string, UnlockSignals>>;
  getCompany(id: string): Maybe<UnlockCompanyRecord | null>;
  updateUnlockStatus(companyId: string, status: UnlockStatus): Maybe<void>;
  upsertContacts(companyId: string, contacts: UnlockContactInput[], unlockedAt: string): Maybe<number>;

  // ledger / quota / events
  insertLedger(input: UnlockLedgerInput): Maybe<void>;
  latestQuotaObservation(): Maybe<QuotaObservationSnapshot | null>;
  insertQuotaObservation(input: QuotaObservationSnapshot): Maybe<void>;
  sumQuotaCostSince(iso: string): Maybe<number>;
  appendChangeEvent(input: UnlockEventInput): Maybe<{ seq: number } | void>;
}

export interface UnlockLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// 优先级（Q14）
// ---------------------------------------------------------------------------

/** 默认优先级顺序（Goal.unlockPolicy.order 可覆盖） */
export const UNLOCK_PRIORITY_ORDER: readonly string[] = ['recruiting', 'paid_member', 'customs', 'rest'];

/** 自动解锁的最大优先级；P3（index 3）及以后只入工商库，不自动解锁 */
export const DEFAULT_MAX_AUTO_PRIORITY = 2;

export const UNLOCK_STAGE = 'unlock' as const;
export const UNLOCK_ACCOUNT_ID = 'main';
export const UNLOCK_DAILY_CAP_EXCEEDED = 'DAILY_CAP_EXCEEDED';

/**
 * 按 unlockPolicy.order 计算优先级（0 = 最高）。
 * 未匹配任何策略且 order 中无 `rest` 时返回 order.length（视为不自动解锁）。
 */
export function classifyUnlockPriority(signals: UnlockSignals, order: readonly string[] = UNLOCK_PRIORITY_ORDER): number {
  const keys = order.length > 0 ? order : UNLOCK_PRIORITY_ORDER;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (key === 'rest') return i;
    if (key === 'recruiting' && signals.hasRecruiting) return i;
    if (key === 'paid_member' && signals.isPaidMember) return i;
    if (key === 'customs' && signals.hasCustomsRecord) return i;
  }
  return keys.length;
}

/** 优先级名称（日志/展示用） */
export function unlockPriorityLabel(priority: number, order: readonly string[] = UNLOCK_PRIORITY_ORDER): string {
  const key = order[priority];
  return key === undefined || priority > (order.length - 1) ? 'none' : key;
}

/**
 * 判断 Ali/Mic 店铺档案是否付费/认证会员（P1）。
 * 字段映射见 docs/04 §6.4/§6.5：Ali store.membership.*；Mic store.audited / store.membership.tier。
 */
export function isPaidMemberStore(platform: string, store: Record<string, unknown> | null | undefined): boolean {
  if (!store) return false;
  if (platform === 'ali') {
    const membership = store.membership;
    if (typeof membership === 'string') return /gold|verified|paid|金品|认证/i.test(membership);
    if (membership && typeof membership === 'object') {
      const m = membership as Record<string, unknown>;
      if (m.verifiedSupplier === true || m.verifiedPro === true || m.paidMember === true || m.goldSupplier === true) return true;
      const plan = `${m.plan ?? ''} ${m.label ?? ''} ${m.rank ?? ''}`;
      if (/gold|verified|paid|金品/i.test(plan)) return true;
    }
    const trust = store.trust;
    if (trust && typeof trust === 'object') {
      const t = trust as Record<string, unknown>;
      if (t.verified === true || t.verifiedSupplier === true) return true;
    }
    return false;
  }
  if (platform === 'mic') {
    if (store.audited === true) return true;
    const membership = store.membership;
    if (typeof membership === 'string') return /diamond|gold|钻石|金牌/i.test(membership);
    if (membership && typeof membership === 'object') {
      const tier = String((membership as Record<string, unknown>).tier ?? '').toLowerCase();
      if (tier === 'diamond' || tier === 'gold') return true;
      const raw = `${(membership as Record<string, unknown>).raw_cs_level ?? ''} ${(membership as Record<string, unknown>).raw_member_level ?? ''}`;
      if (/diamond|gold|钻石|金牌/i.test(raw)) return true;
    }
    return false;
  }
  return false;
}

/** 判断海关画像是否有真实记录（P2） */
export function hasCustomsRecords(profile: {
  matchedRecords?: number | null;
  exporterRecords?: number | null;
  importerRecords?: number | null;
  confidence?: string | null;
} | null | undefined): boolean {
  if (!profile) return false;
  if ((profile.confidence ?? 'none') === 'none') return false;
  const matched = profile.matchedRecords ?? 0;
  const exporter = profile.exporterRecords ?? 0;
  const importer = profile.importerRecords ?? 0;
  return matched > 0 && (exporter > 0 || importer > 0 || matched > 0);
}

// ---------------------------------------------------------------------------
// 时间/幂等键工具
// ---------------------------------------------------------------------------

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Asia/Shanghai 日期 `YYYY-MM-DD`（幂等键/日额度用） */
export function shanghaiDateString(now: Date): string {
  const p = shanghaiParts(now);
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)}`;
}

/** 幂等键：`unlock:<companyId>:<yyyy-MM-dd(Asia/Shanghai)>`（docs/04 §5） */
export function unlockIdempotencyKey(companyId: string, now: Date = new Date()): string {
  return `unlock:${companyId}:${shanghaiDateString(now)}`;
}

/** Asia/Shanghai 当天 00:00 的 ISO（带 +08:00） */
export function startOfShanghaiDayIso(now: Date): string {
  const p = shanghaiParts(now);
  return `${p.y}-${pad2(p.m)}-${pad2(p.day)}T00:00:00+08:00`;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/**
 * 额度展示所需的最小只读端口（/v1/quota）。
 */
export interface QuotaViewStore {
  latestQuotaObservation(): Maybe<QuotaObservationSnapshot | null>;
  listRecentLedger(limit: number): Maybe<Array<{ result: 'unlocked' | 'already_unlocked' | 'failed'; quotaCost: number; requestedAt: string }>>;
}

export interface UnlockWorkerOptions {
  store: UnlockStore;
  tanji: TanjiUnlockPort;
  workerId?: string;
  now?: () => Date;
  /** P0..P(max) 自动解锁；默认 2（P3 不自动解锁） */
  maxAutoPriority?: number;
  /** Goal.unlockPolicy.order 可覆盖 */
  policyOrder?: readonly string[];
  /** LEAD_UNLOCK_DAILY_CAP；null/undefined = 不限 */
  dailyCap?: number | null;
  leaseSec?: number;
  /** 单轮最多真正解锁的家数（节省额度、便于观测） */
  maxPerTick?: number;
  /** 单轮扫描候选数 */
  candidateScanLimit?: number;
  /** 额度观测过期阈值（ms），过期则主动拉一次 tanji /v1/status */
  quotaStaleMs?: number;
  logger?: UnlockLogger;
}

export interface UnlockTickResult {
  paused: boolean;
  pauseReason: string | null;
  /** 本轮新入队数 */
  enqueued: number;
  /** 因 P3/无 tanjiId 等原因跳过数 */
  skipped: number;
  /** 实际领取执行数 */
  claimed: number;
  unlocked: number;
  alreadyUnlocked: number;
  failed: number;
  waitingQuota: number;
  quotaCost: number;
}

export type UnlockOutcome = 'unlocked' | 'already_unlocked' | 'failed' | 'quota_exhausted' | 'skipped';

const RETRYABLE_ERROR_CODES = new Set(['SOURCE_UNAVAILABLE', 'UPSTREAM_RATE_LIMITED', 'RATE_LIMITED', 'INTERNAL_ERROR']);

function emptyTick(): UnlockTickResult {
  return { paused: false, pauseReason: null, enqueued: 0, skipped: 0, claimed: 0, unlocked: 0, alreadyUnlocked: 0, failed: 0, waitingQuota: 0, quotaCost: 0 };
}

/** tanji 联系人的 type 归一为 company_contacts.type */
export function normalizeContactType(item: { type?: string | null; value: string }): 'mobile' | 'phone' | 'email' {
  const t = (item.type ?? '').toLowerCase();
  if (t === 'mobile' || t === 'phone' || t === 'email') return t;
  if (t.includes('email') || t.includes('mail')) return 'email';
  if (item.value.includes('@')) return 'email';
  return t.includes('mobile') || t.includes('cell') ? 'mobile' : 'phone';
}

export function mapContactToInput(item: TanjiContactLike, unlockedAt: string): UnlockContactInput | null {
  const value = (item.value ?? '').trim();
  if (!value) return null;
  return {
    tanjiContactId: item.contactId ?? null,
    name: item.name ?? null,
    position: item.position ?? null,
    department: item.department ?? null,
    region: item.region ?? null,
    type: normalizeContactType({ type: item.type, value }),
    value,
    masked: item.masked === true,
    source: item.source ?? null,
    isKey: item.isKeyLead === true,
  };
}

export class UnlockWorker {
  private readonly store: UnlockStore;
  private readonly tanji: TanjiUnlockPort;
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly maxAutoPriority: number;
  private readonly policyOrder: readonly string[];
  private readonly dailyCap: number | null;
  private readonly leaseSec: number;
  private readonly maxPerTick: number;
  private readonly candidateScanLimit: number;
  private readonly quotaStaleMs: number;
  private readonly logger: UnlockLogger;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: UnlockWorkerOptions) {
    this.store = opts.store;
    this.tanji = opts.tanji;
    this.workerId = opts.workerId ?? 'unlock-worker';
    this.now = opts.now ?? (() => new Date());
    this.maxAutoPriority = opts.maxAutoPriority ?? DEFAULT_MAX_AUTO_PRIORITY;
    this.policyOrder = opts.policyOrder ?? UNLOCK_PRIORITY_ORDER;
    this.dailyCap = opts.dailyCap ?? null;
    this.leaseSec = opts.leaseSec ?? 120;
    this.maxPerTick = Math.max(1, opts.maxPerTick ?? 3);
    this.candidateScanLimit = Math.max(1, opts.candidateScanLimit ?? 50);
    this.quotaStaleMs = Math.max(1_000, opts.quotaStaleMs ?? 120_000);
    this.logger = opts.logger ?? { info() {}, warn() {}, error() {} };
  }

  /** 入队：tanji_enriched + unlock_status∈(none,pending) + 未入队 + 优先级允许 */
  async enqueueEligible(limit = 200): Promise<{ enqueued: number; skipped: number }> {
    const companies = await this.store.listEligibleCompanies(limit);
    if (companies.length === 0) return { enqueued: 0, skipped: 0 };
    const signals = await this.store.loadSignals(companies.map((c) => c.id));
    let enqueued = 0;
    let skipped = 0;
    for (const company of companies) {
      if (!company.tanjiCompanyId) {
        skipped += 1;
        continue;
      }
      const sig = signals.get(company.id) ?? { hasRecruiting: false, isPaidMember: false, hasCustomsRecord: false };
      const priority = classifyUnlockPriority(sig, this.policyOrder);
      if (priority > this.maxAutoPriority) {
        // P3：只入工商库，不自动解锁、不占队列
        skipped += 1;
        continue;
      }
      const { created } = await this.store.ensureJob({ companyId: company.id, stage: UNLOCK_STAGE, runId: null });
      if (created) {
        await this.store.updateUnlockStatus(company.id, 'pending');
        enqueued += 1;
        this.logger.info('unlock job enqueued', { companyId: company.id, priority, label: unlockPriorityLabel(priority, this.policyOrder) });
      }
    }
    return { enqueued, skipped };
  }

  /** 单轮：入队 + 额度门禁 + 按优先级领取执行 */
  async runOnce(): Promise<UnlockTickResult> {
    const result = emptyTick();
    const enqueueResult = await this.enqueueEligible();
    result.enqueued = enqueueResult.enqueued;
    result.skipped = enqueueResult.skipped;

    const gate = await this.checkQuotaGate();
    if (gate.blocked) {
      // 额度耗尽：仍先处理「已解锁公司的免费联系人」（contacts.unlocked=true 不耗额度），其余暂停
      const free = await this.drainFreeUnlocks(result);
      if (!free) {
        const paused = await this.store.pausePending({ limit: 1000 });
        this.logger.warn('unlock queue paused: quota exhausted', { reason: gate.reason, paused });
        result.paused = true;
        result.pauseReason = gate.reason;
        return result;
      }
      result.paused = true;
      result.pauseReason = gate.reason;
      return result;
    }

    // LEAD_UNLOCK_DAILY_CAP（默认不限）
    if (this.dailyCap !== null) {
      const used = await this.store.sumQuotaCostSince(startOfShanghaiDayIso(this.now()));
      if (used >= this.dailyCap) {
        result.paused = true;
        result.pauseReason = UNLOCK_DAILY_CAP_EXCEEDED;
        this.logger.warn('unlock queue paused: daily cap reached', { used, cap: this.dailyCap });
        return result;
      }
    }

    const candidates = await this.orderCandidates();
    if (candidates.length === 0) return result;

    for (const candidate of candidates) {
      if (result.claimed >= this.maxPerTick) break;
      const claimed = await this.store.claimJob(candidate.job.id, { workerId: this.workerId, leaseSec: this.leaseSec, now: this.now() });
      if (!claimed) continue; // 被其他 worker 领走 / 状态已变
      result.claimed += 1;
      const outcome = await this.executeCandidate(claimed, candidate.company, result);
      if (outcome === 'quota_exhausted') {
        const paused = await this.store.pausePending({ limit: 1000 });
        this.logger.warn('unlock queue paused: QUOTA_EXHAUSTED from upstream', { paused });
        result.paused = true;
        result.pauseReason = 'QUOTA_EXHAUSTED';
        break;
      }
      if (outcome === 'failed') break; // 上游异常时结束本轮，等待下一轮/额度轮询
    }
    return result;
  }

  async tick(): Promise<UnlockTickResult> {
    return this.runOnce();
  }

  start(intervalMs = 5000): void {
    if (this.timer) return;
    // 防重入：单次解锁可能因上游浏览器操作耗时数十秒；5s tick 不能叠加 claim，否则会并发扣点
    let inFlight = false;
    const run = (): void => {
      if (inFlight) return;
      inFlight = true;
      void this.runOnce()
        .catch((err: unknown) => this.logger.error('unlock worker tick failed', { err: String(err) }))
        .finally(() => { inFlight = false; });
    };
    this.timer = setInterval(run, Math.max(1000, intervalMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 手动解锁：立即入队并优先执行（FR-11；可被 REST/CLI 调用） */
  async unlockCompanyNow(companyId: string): Promise<UnlockOutcome> {
    const company = await this.ensureEligibleCompany(companyId);
    if (!company) return 'skipped';
    await this.store.ensureJob({ companyId, stage: UNLOCK_STAGE });
    await this.store.updateUnlockStatus(companyId, 'pending');
    // claimJob 需要真实 job id：从候选中定位
    const candidates = await this.store.listCandidates(this.candidateScanLimit);
    const target = candidates.find((c) => c.company.id === companyId);
    if (!target) return 'skipped';
    const claimed = await this.store.claimJob(target.job.id, { workerId: this.workerId, leaseSec: this.leaseSec, now: this.now() });
    if (!claimed) return 'skipped';
    const result = emptyTick();
    return this.executeCandidate(claimed, company, result);
  }

  // ------------------------------------------------------------------
  // 内部：候选排序 / 执行
  // ------------------------------------------------------------------

  private async orderCandidates(): Promise<UnlockCandidate[]> {
    const candidates = await this.store.listCandidates(this.candidateScanLimit);
    const scored = candidates
      .map((candidate) => ({
        candidate,
        priority: classifyUnlockPriority(candidate.signals, this.policyOrder),
      }))
      .filter((item) => item.priority <= this.maxAutoPriority)
      .sort((a, b) => a.priority - b.priority || Date.parse(a.candidate.job.createdAt) - Date.parse(b.candidate.job.createdAt));
    return scored.map((item) => item.candidate);
  }

  /**
   * 额度耗尽时：只处理「contacts 已解锁」的免费队列项（不耗额度）。
   * @returns true 表示本轮处理了至少一条免费项（可继续下一轮），false 表示无免费项
   */
  private async drainFreeUnlocks(result: UnlockTickResult): Promise<boolean> {
    const candidates = await this.orderCandidates();
    let handled = 0;
    for (const candidate of candidates.slice(0, 10)) {
      const company = candidate.company;
      if (!company.tanjiCompanyId) continue;
      let contactsResult: Awaited<ReturnType<TanjiUnlockPort['getContacts']>>;
      try {
        contactsResult = await this.tanji.getContacts(company.tanjiCompanyId);
      } catch {
        continue;
      }
      if (!contactsResult.unlocked) {
        await this.store.waitForQuota(candidate.job.id, { reason: 'quota_exhausted' });
        result.waitingQuota += 1;
        continue;
      }
      const claimed = await this.store.claimJob(candidate.job.id, { workerId: this.workerId, leaseSec: this.leaseSec, now: this.now() });
      if (!claimed) continue;
      result.claimed += 1;
      const now = this.now();
      await this.importContactsAndFinish(claimed, company, contactsResult.contacts ?? [], now.toISOString(), true, null);
      result.alreadyUnlocked += 1;
      handled += 1;
    }
    return handled > 0;
  }

  private async checkQuotaGate(): Promise<{ blocked: boolean; reason: string | null }> {
    let observation = await this.store.latestQuotaObservation();
    const now = this.now();
    const stale = !observation || now.getTime() - Date.parse(observation.observedAt) > this.quotaStaleMs;
    if (stale) {
      try {
        const status = await this.tanji.getStatus();
        const snapshot = quotaObservationFromStatus(status, now);
        if (snapshot) {
          await this.store.insertQuotaObservation(snapshot);
          observation = snapshot;
        }
      } catch (err) {
        const lead = err instanceof LeadError ? err : null;
        if (lead?.code === 'QUOTA_EXHAUSTED') return { blocked: true, reason: 'QUOTA_EXHAUSTED' };
        this.logger.warn('quota check failed, continue with cached observation', { err: lead?.code ?? String(err) });
      }
    }
    if (!observation) return { blocked: false, reason: null };
    if (observation.dailyRemaining !== null && observation.dailyRemaining <= 0) return { blocked: true, reason: 'DAILY_QUOTA_EXHAUSTED' };
    if (observation.monthlyRemaining !== null && observation.monthlyRemaining <= 0) return { blocked: true, reason: 'MONTHLY_QUOTA_EXHAUSTED' };
    return { blocked: false, reason: null };
  }

  private async executeCandidate(job: UnlockJobRecord, company: UnlockCompanyRecord, result: UnlockTickResult): Promise<UnlockOutcome> {
    const now = this.now();
    if (!company.tanjiCompanyId) {
      await this.failUnlock(job, company, null, 'INVALID_COMPANY', '公司缺少 tanji_company_id', false);
      result.failed += 1;
      return 'failed';
    }

    // 1) 前置检查联系人接口：unlocked=true → 免费取明文，不调用 unlock
    let precheck: Awaited<ReturnType<TanjiUnlockPort['getContacts']>> | null = null;
    try {
      precheck = await this.tanji.getContacts(company.tanjiCompanyId);
    } catch (err) {
      return this.handleUnlockError(job, company, err, result);
    }
    if (precheck.unlocked) {
      await this.importContactsAndFinish(job, company, precheck.contacts ?? [], now.toISOString(), true, null);
      result.alreadyUnlocked += 1;
      return 'already_unlocked';
    }

    // 2) 调用解锁（1 家 1 点；幂等键防重复扣点）
    const idempotencyKey = unlockIdempotencyKey(company.id, now);
    let unlockResult: Awaited<ReturnType<TanjiUnlockPort['unlockCompany']>>;
    try {
      unlockResult = await this.tanji.unlockCompany(company.tanjiCompanyId, { idempotencyKey, quota: true, contacts: true, confirm: true });
    } catch (err) {
      return this.handleUnlockError(job, company, err, result);
    }

    const alreadyUnlocked = unlockResult.alreadyUnlocked === true;
    const quotaCost = alreadyUnlocked ? 0 : Math.max(0, unlockResult.quotaCost ?? 1);
    const contacts = unlockResult.contacts ?? precheck.contacts ?? [];
    await this.importContactsAndFinish(job, company, contacts, this.parseUnlockedAt(unlockResult.unlockedAt, now), alreadyUnlocked, {
      quotaCost,
      quotaBefore: unlockResult.quotaBefore ?? null,
      quotaAfter: unlockResult.quotaAfter ?? null,
      idempotencyKey,
    });
    result.quotaCost += quotaCost;
    if (alreadyUnlocked) result.alreadyUnlocked += 1;
    else result.unlocked += 1;
    return alreadyUnlocked ? 'already_unlocked' : 'unlocked';
  }

  private parseUnlockedAt(value: string | null | undefined, fallback: Date): string {
    if (value && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    return fallback.toISOString();
  }

  /** 成功/免费路径：联系人入库 + 公司状态 + 台账 + 变更事件 + 任务完成 */
  private async importContactsAndFinish(
    job: UnlockJobRecord,
    company: UnlockCompanyRecord,
    contacts: TanjiContactLike[],
    unlockedAtIso: string,
    alreadyUnlocked: boolean,
    ledger: { quotaCost: number; quotaBefore: number | null; quotaAfter: number | null; idempotencyKey: string } | null,
  ): Promise<void> {
    const unlockedAt = new Date(unlockedAtIso);
    const mapped = contacts
      .map((item) => mapContactToInput(item as TanjiContactLike, unlockedAtIso))
      .filter((item): item is UnlockContactInput => item !== null);
    const count = await this.store.upsertContacts(company.id, mapped, unlockedAtIso);
    await this.store.updateUnlockStatus(company.id, 'unlocked');
    await this.store.completeJob(job.id);
    const types = [...new Set(mapped.map((c) => c.type))];
    const resolvedLedger = ledger ?? {
      quotaCost: 0,
      quotaBefore: null,
      quotaAfter: null,
      idempotencyKey: unlockIdempotencyKey(company.id, unlockedAt),
    };
    await this.store.insertLedger({
      companyId: company.id,
      tanjiCompanyId: company.tanjiCompanyId,
      result: alreadyUnlocked ? 'already_unlocked' : 'unlocked',
      quotaCost: resolvedLedger.quotaCost,
      quotaBefore: resolvedLedger.quotaBefore,
      quotaAfter: resolvedLedger.quotaAfter,
      accountId: UNLOCK_ACCOUNT_ID,
      idempotencyKey: resolvedLedger.idempotencyKey,
      errorCode: null,
      requestedAt: unlockedAt.toISOString(),
      finishedAt: this.now().toISOString(),
    });
    await this.store.appendChangeEvent({
      companyId: company.id,
      entityType: 'company',
      version: 1,
      eventType: 'contact.unlocked',
      field: null,
      oldValue: null,
      newValue: {
        contactCount: count,
        types,
        quotaCost: resolvedLedger.quotaCost,
        alreadyUnlocked,
      },
      valueType: 'json',
      source: 'system:unlock',
      actor: 'system',
      occurredAt: unlockedAt.toISOString(),
    });
    this.logger.info('company unlocked', {
      companyId: company.id,
      tanjiCompanyId: company.tanjiCompanyId,
      contacts: count,
      alreadyUnlocked,
      quotaCost: resolvedLedger.quotaCost,
    });
  }

  private async handleUnlockError(
    job: UnlockJobRecord,
    company: UnlockCompanyRecord,
    err: unknown,
    result: UnlockTickResult,
  ): Promise<UnlockOutcome> {
    const lead = err instanceof LeadError ? err : null;
    const code = lead?.code ?? 'INTERNAL_ERROR';
    const message = err instanceof Error ? err.message : String(err);
    if (code === 'QUOTA_EXHAUSTED') {
      await this.store.waitForQuota(job.id, { reason: 'QUOTA_EXHAUSTED' });
      result.waitingQuota += 1;
      this.logger.warn('unlock waiting quota', { companyId: company.id, jobId: job.id });
      return 'quota_exhausted';
    }
    if (code === 'SOURCE_SESSION_INVALID' || code === 'UNAUTHORIZED') {
      await this.failUnlock(job, company, null, code, message, false);
      result.failed += 1;
      return 'failed';
    }
    if (code === 'SOURCE_VERIFICATION_PENDING' || code === 'VALIDATION_ERROR' || code === 'NOT_FOUND' || code === 'UNSUPPORTED') {
      await this.failUnlock(job, company, null, code, message, false);
      result.failed += 1;
      return 'failed';
    }
    const retryable = RETRYABLE_ERROR_CODES.has(code) || lead === null;
    await this.failUnlock(job, company, null, code, message, retryable);
    result.failed += 1;
    return 'failed';
  }

  private async failUnlock(
    job: UnlockJobRecord,
    company: UnlockCompanyRecord,
    _unused: null,
    errorCode: string,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    await this.store.failJob(job.id, { errorCode, error: message, retryable });
    if (!retryable) {
      await this.store.updateUnlockStatus(company.id, 'failed');
      await this.store.insertLedger({
        companyId: company.id,
        tanjiCompanyId: company.tanjiCompanyId,
        result: 'failed',
        quotaCost: 0,
        quotaBefore: null,
        quotaAfter: null,
        accountId: UNLOCK_ACCOUNT_ID,
        idempotencyKey: `${unlockIdempotencyKey(company.id, this.now())}:failed:${job.attempts + 1}`,
        errorCode,
        requestedAt: job.createdAt,
        finishedAt: this.now().toISOString(),
      });
    }
    this.logger.warn('unlock failed', { companyId: company.id, jobId: job.id, errorCode, retryable, message });
  }

  private async ensureEligibleCompany(companyId: string): Promise<UnlockCompanyRecord | null> {
    const company = await this.store.getCompany(companyId);
    if (!company) throw new LeadError('NOT_FOUND', `公司不存在: ${companyId}`);
    if (!company.tanjiCompanyId) throw new LeadError('CONFLICT', '公司尚未匹配探迹主体，无法解锁');
    return company;
  }
}

/** tanji /v1/status → quota_observations 快照 */
export function quotaObservationFromStatus(status: TanjiStatus, now: Date): QuotaObservationSnapshot | null {
  const quota = status.quota;
  if (!quota) return null;
  return {
    observedAt: now.toISOString(),
    dailyLimit: quota.daily?.limit ?? null,
    dailyRemaining: quota.daily?.remaining ?? null,
    monthlyLimit: quota.monthly?.limit ?? null,
    monthlyRemaining: quota.monthly?.remaining ?? null,
    enterpriseLimit: quota.enterpriseMonthly?.limit ?? null,
    enterpriseRemaining: quota.enterpriseMonthly?.remaining ?? null,
    settlementDay: quota.settlementDay ?? null,
    raw: {
      loggedIn: status.loggedIn,
      nearlySevenDayUnlockCount: quota.nearlySevenDayUnlockCount,
      quotaRaw: quota.raw,
    },
  };
}

/** 便捷函数：手动解锁入队（不触发执行；供 REST/CLI 调用） */
export async function enqueueManualUnlock(store: UnlockStore, companyId: string): Promise<{ job: UnlockJobRecord; created: boolean }> {
  const company = await store.getCompany(companyId);
  if (!company) throw new LeadError('NOT_FOUND', `公司不存在: ${companyId}`);
  if (!company.tanjiCompanyId) throw new LeadError('CONFLICT', '公司尚未匹配探迹主体，无法解锁');
  const result = await store.ensureJob({ companyId, stage: UNLOCK_STAGE });
  await store.updateUnlockStatus(companyId, 'pending');
  return result;
}

/** 联系人数量（测试/展示辅助） */
export function contactCounts(contacts: UnlockContactInput[]): Record<string, number> {
  const out: Record<string, number> = { mobile: 0, phone: 0, email: 0 };
  for (const c of contacts) out[c.type] = (out[c.type] ?? 0) + 1;
  out.total = contacts.length;
  return out;
}

export { nowIso };

/** 类型别名：tanji 原始联系人（供调用方转换） */
export type { TanjiContactItem };
