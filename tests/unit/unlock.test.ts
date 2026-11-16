/**
 * 解锁队列 / 额度（U1）单元测试。
 *
 * - 真实临时 DB（F2 `openMemoryDatabase()+migrate()+createRepositories()`）；
 * - tanji 全 mock（FakeTanji：getContacts/unlockCompany/getStatus），绝不真实调用 unlock；
 * - 覆盖：Q14 优先级、FIFO、contacts 前置检查（已解锁不耗额度）、unlock_ledger、
 *   waiting_quota 暂停/恢复、Quota Poller、日额度上限、/v1/quota 视图。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { openMemoryDatabase, type Database } from '../../src/db/index.js';
import { migrate } from '../../src/db/migrate.js';
import { createRepositories, type Repositories } from '../../src/repositories/index.js';
import type { DatabaseHandle } from '../../src/db/index.js';
import {
  DEFAULT_MAX_AUTO_PRIORITY,
  UNLOCK_PRIORITY_ORDER,
  UnlockWorker,
  classifyUnlockPriority,
  contactCounts,
  enqueueManualUnlock,
  hasCustomsRecords,
  isPaidMemberStore,
  mapContactToInput,
  normalizeContactType,
  quotaObservationFromStatus,
  shanghaiDateString,
  startOfShanghaiDayIso,
  unlockIdempotencyKey,
  unlockPriorityLabel,
  type TanjiContactLike,
  type TanjiUnlockPort,
} from '../../src/pipeline/unlock.js';
import { QuotaPoller, detectQuotaRecovery, pollQuotaOnce } from '../../src/pipeline/quota.js';
import { createQuotaViewStore, createUnlockStore, getDefaultUnlockStore } from '../../src/pipeline/f2UnlockStore.js';
import { initUnlockEventsRuntime, resetUnlockEventsDefaults } from '../../src/pipeline/unlockEventsRuntime.js';
import { QuotaService, buildUnlockCurve, getQuota } from '../../src/services/quota.js';
import { LeadError } from '../../src/shared/errors.js';
import type { TanjiClient, TanjiContactsResult, TanjiStatus, TanjiUnlockResult } from '../../src/adapters/tanji.js';

// ---------------------------------------------------------------------------
// FakeTanji：只实现 worker 需要的 3 个方法（结构上满足 TanjiUnlockPort）
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<TanjiContactLike> & { type: string; value: string }): TanjiContactLike {
  return {
    contactId: `ct_${overrides.value}`,
    name: '张三',
    masked: false,
    department: '外贸部',
    position: '经理',
    region: '河北',
    source: '政务公示',
    isKeyLead: true,
    ...overrides,
  };
}

class FakeTanji {
  status: TanjiStatus = {
    loggedIn: true,
    version: 'test',
    quota: {
      daily: { limit: 500, used: 0, remaining: 500 },
      monthly: { limit: 1500, used: 1277, remaining: 223 },
      enterpriseMonthly: { limit: 19500, used: 7586, remaining: 11914 },
      settlementDay: 11,
      nearlySevenDayUnlockCount: 12,
      raw: {},
    },
    raw: { ok: true },
  };
  statusError: Error | null = null;
  contactsMap = new Map<string, { unlocked: boolean; contacts: TanjiContactLike[] }>();
  unlockCalls: Array<{ companyId: string; options: Record<string, unknown> }> = [];
  statusCalls = 0;
  contactsCalls = 0;
  unlockHandler: ((companyId: string, options: Record<string, unknown>) => Promise<TanjiUnlockResult>) | null = null;
  defaultUnlockContacts: TanjiContactLike[] = [makeContact({ type: 'mobile', value: '13800000001' })];

  async getStatus(): Promise<TanjiStatus> {
    this.statusCalls += 1;
    if (this.statusError) throw this.statusError;
    return this.status;
  }

  async getContacts(companyId: string): Promise<TanjiContactsResult> {
    this.contactsCalls += 1;
    const value = this.contactsMap.get(companyId);
    return {
      companyId,
      unlocked: value?.unlocked ?? false,
      contacts: value?.contacts ?? [],
      counts: null,
      raw: {},
    } as unknown as TanjiContactsResult;
  }

  async unlockCompany(companyId: string, options: Record<string, unknown> = {}): Promise<TanjiUnlockResult> {
    this.unlockCalls.push({ companyId, options });
    if (this.unlockHandler) return this.unlockHandler(companyId, options);
    return {
      companyId,
      companyName: '测试公司',
      alreadyUnlocked: false,
      unlockedBy: 'test',
      unlockedAt: new Date().toISOString(),
      quotaCost: 1,
      quotaBefore: 223,
      quotaAfter: 222,
      contacts: this.defaultUnlockContacts,
      raw: {},
    } as unknown as TanjiUnlockResult;
  }

  asPort(): TanjiUnlockPort {
    return this as unknown as TanjiUnlockPort;
  }
}

// ---------------------------------------------------------------------------
// DB fixtures
// ---------------------------------------------------------------------------

interface Harness {
  db: DatabaseHandle;
  repos: Repositories;
  store: ReturnType<typeof createUnlockStore>;
  tanji: FakeTanji;
  now: Date;
  setNow(d: Date): void;
}

const NOW = new Date('2026-11-16T02:00:00.000Z'); // 北京时间 10:00

function makeHarness(): Harness {
  const db = openMemoryDatabase();
  migrate(db);
  const repos = createRepositories(db);
  const store = createUnlockStore(repos);
  const tanji = new FakeTanji();
  const harness: Harness = {
    db,
    repos,
    store,
    tanji,
    now: new Date(NOW),
    setNow(d: Date) {
      harness.now = d;
    },
  };
  return harness;
}

function seedCompany(
  repos: Repositories,
  opts: {
    id: string;
    name?: string;
    tanjiCompanyId?: string | null;
    enrichmentStatus?: string;
    unlockStatus?: string;
  },
): void {
  repos.companies.create({
    id: opts.id,
    name: opts.name ?? `河北测试公司${opts.id}`,
    normalizedName: `河北测试公司${opts.id}`,
    tanjiCompanyId: opts.tanjiCompanyId === undefined ? `tj_${opts.id}` : opts.tanjiCompanyId,
    enrichmentStatus: (opts.enrichmentStatus ?? 'tanji_enriched') as never,
    unlockStatus: (opts.unlockStatus ?? 'none') as never,
    firstSeenAt: NOW.toISOString(),
    lastSeenAt: NOW.toISOString(),
  });
}

function seedRecruitingSignal(repos: Repositories, companyId: string): void {
  repos.companySources.upsert({
    companyId,
    platform: 'boss',
    platformCompanyId: `boss_${companyId}`,
    sourceName: '测试招聘公司',
  });
  repos.platformProfiles.upsert({
    companyId,
    platform: 'boss',
    platformCompanyId: `boss_${companyId}`,
    jobCount: 3,
    lastFetchedAt: NOW.toISOString(),
  });
}

function seedPaidMemberSignal(repos: Repositories, companyId: string): void {
  repos.platformProfiles.upsert({
    companyId,
    platform: 'ali',
    platformCompanyId: `ali_${companyId}`,
    store: { membership: { verifiedSupplier: true, plan: 'gold' } },
    lastFetchedAt: NOW.toISOString(),
  });
}

function seedCustomsSignal(repos: Repositories, companyId: string): void {
  repos.customs.upsert({
    companyId,
    englishName: 'Test Hebei Machinery Co., Ltd.',
    matchedRecords: 5,
    exporterRecords: 4,
    importerRecords: 1,
    confidence: 'high',
    fetchedAt: NOW.toISOString(),
  });
}

function makeWorker(h: Harness, overrides: Record<string, unknown> = {}): UnlockWorker {
  return new UnlockWorker({
    store: h.store,
    tanji: h.tanji.asPort(),
    now: () => h.now,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. 纯逻辑：Q14 优先级 / 会员识别 / 海关记录
// ---------------------------------------------------------------------------

describe('unlock priority (Q14)', () => {
  it('P0 招聘在招 > P1 付费会员 > P2 海关记录 > P3 其余', () => {
    expect(classifyUnlockPriority({ hasRecruiting: true, isPaidMember: true, hasCustomsRecord: true })).toBe(0);
    expect(classifyUnlockPriority({ hasRecruiting: false, isPaidMember: true, hasCustomsRecord: true })).toBe(1);
    expect(classifyUnlockPriority({ hasRecruiting: false, isPaidMember: false, hasCustomsRecord: true })).toBe(2);
    expect(classifyUnlockPriority({ hasRecruiting: false, isPaidMember: false, hasCustomsRecord: false })).toBe(3);
    expect(DEFAULT_MAX_AUTO_PRIORITY).toBe(2);
    expect(UNLOCK_PRIORITY_ORDER).toEqual(['recruiting', 'paid_member', 'customs', 'rest']);
    expect(unlockPriorityLabel(0)).toBe('recruiting');
    expect(unlockPriorityLabel(3)).toBe('rest');
  });

  it('Goal unlockPolicy.order 可重排优先级', () => {
    const order = ['customs', 'paid_member', 'recruiting', 'rest'];
    expect(classifyUnlockPriority({ hasRecruiting: true, isPaidMember: true, hasCustomsRecord: true }, order)).toBe(0);
    expect(classifyUnlockPriority({ hasRecruiting: true, isPaidMember: false, hasCustomsRecord: false }, order)).toBe(2);
    // 无 rest 且都不匹配 → 返回 order.length（不自动解锁）
    expect(classifyUnlockPriority({ hasRecruiting: true, isPaidMember: false, hasCustomsRecord: false }, ['customs'])).toBe(1);
  });

  it('isPaidMemberStore：Ali 金品/Verified、Mic 钻石/Audited', () => {
    expect(isPaidMemberStore('ali', { membership: { verifiedSupplier: true } })).toBe(true);
    expect(isPaidMemberStore('ali', { membership: { plan: 'gold supplier' } })).toBe(true);
    expect(isPaidMemberStore('ali', { membership: { plan: 'free' } })).toBe(false);
    expect(isPaidMemberStore('ali', null)).toBe(false);
    expect(isPaidMemberStore('mic', { audited: true })).toBe(true);
    expect(isPaidMemberStore('mic', { membership: { tier: 'diamond' } })).toBe(true);
    expect(isPaidMemberStore('mic', { membership: { tier: 'free' } })).toBe(false);
    expect(isPaidMemberStore('boss', { membership: { verified: true } })).toBe(false);
  });

  it('hasCustomsRecords：confidence=none 或无记录不算', () => {
    expect(hasCustomsRecords({ matchedRecords: 5, exporterRecords: 5, confidence: 'high' })).toBe(true);
    expect(hasCustomsRecords({ matchedRecords: 0, exporterRecords: 0, confidence: 'high' })).toBe(false);
    expect(hasCustomsRecords({ matchedRecords: 5, confidence: 'none' })).toBe(false);
    expect(hasCustomsRecords(null)).toBe(false);
  });

  it('幂等键/上海日期/联系人归一', () => {
    expect(shanghaiDateString(new Date('2026-11-16T02:00:00.000Z'))).toBe('2026-11-16');
    // UTC 2026-11-15 17:00 = 北京 2026-11-16 01:00
    expect(shanghaiDateString(new Date('2026-11-15T17:00:00.000Z'))).toBe('2026-11-16');
    expect(unlockIdempotencyKey('cmp_1', new Date('2026-11-16T02:00:00.000Z'))).toBe('unlock:cmp_1:2026-11-16');
    expect(startOfShanghaiDayIso(new Date('2026-11-16T02:00:00.000Z'))).toBe('2026-11-16T00:00:00+08:00');
    expect(normalizeContactType({ type: 'mobile', value: '138' })).toBe('mobile');
    expect(normalizeContactType({ type: 'EMAIL', value: 'a@b.com' })).toBe('email');
    expect(normalizeContactType({ type: 'fax', value: '0311-123' })).toBe('phone');
    expect(mapContactToInput(makeContact({ type: 'mobile', value: '13800000001' }), NOW.toISOString())).toMatchObject({
      type: 'mobile',
      value: '13800000001',
      tanjiContactId: 'ct_13800000001',
      isKey: true,
    });
    expect(contactCounts([{ type: 'mobile', value: '1' }, { type: 'email', value: 'a@b' }])).toMatchObject({ mobile: 1, email: 1, total: 2 });
  });
});

// ---------------------------------------------------------------------------
// 2. 入队：P0/P1/P2 入队，P3 不自动解锁
// ---------------------------------------------------------------------------

describe('unlock enqueue', () => {
  it('tanji_enriched 按优先级入队；P3 与无 tanjiId 不入队', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_p0', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_p0');
    seedCompany(h.repos, { id: 'cmp_p1', unlockStatus: 'pending' });
    seedPaidMemberSignal(h.repos, 'cmp_p1');
    seedCompany(h.repos, { id: 'cmp_p2', unlockStatus: 'pending' });
    seedCustomsSignal(h.repos, 'cmp_p2');
    seedCompany(h.repos, { id: 'cmp_p3', unlockStatus: 'pending' }); // 无任何信号 → P3
    seedCompany(h.repos, { id: 'cmp_no_tanji', tanjiCompanyId: null, unlockStatus: 'pending' });
    seedCompany(h.repos, { id: 'cmp_not_enriched', enrichmentStatus: 'discovered', unlockStatus: 'pending' });

    const worker = makeWorker(h);
    const result = await worker.enqueueEligible();
    expect(result.enqueued).toBe(3);
    // 仅扫描到的 tanji_enriched 公司参与计数：P3（cmp_p3）被跳过；无 tanjiId/未补全的不在候选查询里
    expect(result.skipped).toBe(1);

    const jobs = h.repos.jobs.list({ stage: 'unlock', limit: 100 });
    const jobCompanyIds = jobs.map((j) => j.companyId).sort();
    expect(jobCompanyIds).toEqual(['cmp_p0', 'cmp_p1', 'cmp_p2']);
    expect(h.repos.companies.getById('cmp_p0')!.unlockStatus).toBe('pending');
    expect(h.repos.companies.getById('cmp_p3')!.unlockStatus).toBe('pending'); // 未被自动解锁

    // 重复入队幂等
    const again = await worker.enqueueEligible();
    expect(again.enqueued).toBe(0);
    expect(h.repos.jobs.list({ stage: 'unlock', limit: 100 })).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3. 执行：contacts 前置检查 / 台账 / 事件
// ---------------------------------------------------------------------------

describe('unlock worker execution', () => {
  it('contacts.unlocked=true → 直接取联系人，不调用 unlock、不耗额度', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_free', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_free');
    h.tanji.contactsMap.set('tj_cmp_free', {
      unlocked: true,
      contacts: [makeContact({ type: 'mobile', value: '13800000002' }), makeContact({ type: 'email', value: 'a@b.com' })],
    });

    const worker = makeWorker(h);
    const tick = await worker.runOnce();
    expect(tick.enqueued).toBe(1);
    expect(tick.claimed).toBe(1);
    expect(tick.alreadyUnlocked).toBe(1);
    expect(tick.unlocked).toBe(0);
    expect(tick.quotaCost).toBe(0);
    expect(h.tanji.unlockCalls).toHaveLength(0);

    const contacts = h.repos.contacts.listByCompany('cmp_free');
    expect(contacts.map((c) => c.value).sort()).toEqual(['13800000002', 'a@b.com']);
    expect(h.repos.companies.getById('cmp_free')!.unlockStatus).toBe('unlocked');

    const ledger = h.repos.unlockLedger.listByCompany('cmp_free');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ result: 'already_unlocked', quotaCost: 0, idempotencyKey: unlockIdempotencyKey('cmp_free', h.now) });

    const events = h.repos.changeEvents.listByCompany('cmp_free');
    expect(events.map((e) => e.eventType)).toContain('contact.unlocked');
    expect(events.find((e) => e.eventType === 'contact.unlocked')!.newValue).toMatchObject({ contactCount: 2, quotaCost: 0 });

    const job = h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_free' })[0]!;
    expect(job.status).toBe('done');
  });

  it('contacts.unlocked=false → 调用 unlock（1 点），写台账/联系人/事件', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_paid', unlockStatus: 'pending' });
    seedPaidMemberSignal(h.repos, 'cmp_paid');
    h.tanji.defaultUnlockContacts = [makeContact({ type: 'mobile', value: '13800000003' })];

    const worker = makeWorker(h);
    const tick = await worker.runOnce();
    expect(tick.unlocked).toBe(1);
    expect(tick.quotaCost).toBe(1);
    expect(h.tanji.unlockCalls).toHaveLength(1);
    expect(h.tanji.unlockCalls[0]!.companyId).toBe('tj_cmp_paid');
    expect(h.tanji.unlockCalls[0]!.options).toMatchObject({
      idempotencyKey: unlockIdempotencyKey('cmp_paid', h.now),
      quota: true,
      contacts: true,
      confirm: true,
    });

    const ledger = h.repos.unlockLedger.listByCompany('cmp_paid');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ result: 'unlocked', quotaCost: 1, quotaBefore: 223, quotaAfter: 222, accountId: 'main' });
    expect(h.repos.companies.getById('cmp_paid')!.unlockStatus).toBe('unlocked');
    expect(h.repos.contacts.countByCompany('cmp_paid')).toBe(1);
    expect(h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_paid' })[0]!.status).toBe('done');
  });

  it('unlock 返回 alreadyUnlocked=true（上游业务幂等）→ 台账 0 点', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_race', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_race');
    h.tanji.unlockHandler = async (companyId) =>
      ({
        companyId,
        companyName: '测试',
        alreadyUnlocked: true,
        unlockedBy: 'other',
        unlockedAt: h.now.toISOString(),
        quotaCost: 0,
        quotaBefore: 1,
        quotaAfter: 1,
        contacts: [makeContact({ type: 'phone', value: '0311-8888888' })],
        raw: {},
      }) as unknown as TanjiUnlockResult;

    const tick = await makeWorker(h).runOnce();
    expect(tick.unlocked).toBe(0);
    expect(tick.alreadyUnlocked).toBe(1);
    expect(tick.quotaCost).toBe(0);
    const ledger = h.repos.unlockLedger.listByCompany('cmp_race');
    expect(ledger[0]).toMatchObject({ result: 'already_unlocked', quotaCost: 0 });
  });

  it('P0 优先于更早入队的 P1（不是全库 FIFO）', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_old_p1', unlockStatus: 'pending' });
    seedPaidMemberSignal(h.repos, 'cmp_old_p1');
    seedCompany(h.repos, { id: 'cmp_new_p0', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_new_p0');
    // 直接入队并控制 created_at：P1 更早
    h.repos.jobs.enqueue({ companyId: 'cmp_old_p1', stage: 'unlock', createdAt: '2026-11-16T01:00:00.000Z' });
    h.repos.jobs.enqueue({ companyId: 'cmp_new_p0', stage: 'unlock', createdAt: '2026-11-16T01:30:00.000Z' });

    const worker = makeWorker(h, { maxPerTick: 1 });
    await worker.runOnce();
    expect(h.tanji.unlockCalls.map((c) => c.companyId)).toEqual(['tj_cmp_new_p0']);
    expect(h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_old_p1' })[0]!.status).toBe('pending');
  });

  it('同级内 FIFO（created_at 升序）', async () => {
    const h = makeHarness();
    for (const id of ['cmp_a', 'cmp_b', 'cmp_c']) {
      seedCompany(h.repos, { id, unlockStatus: 'pending' });
      seedRecruitingSignal(h.repos, id);
    }
    h.repos.jobs.enqueue({ companyId: 'cmp_c', stage: 'unlock', createdAt: '2026-11-16T01:00:00.000Z' });
    h.repos.jobs.enqueue({ companyId: 'cmp_a', stage: 'unlock', createdAt: '2026-11-16T01:30:00.000Z' });
    h.repos.jobs.enqueue({ companyId: 'cmp_b', stage: 'unlock', createdAt: '2026-11-16T02:00:00.000Z' });

    const worker = makeWorker(h, { maxPerTick: 2 });
    const enqueueResult = await worker.enqueueEligible(); // 已有任务，不重复入队
    expect(enqueueResult.enqueued).toBe(0);
    await worker.runOnce();
    expect(h.tanji.unlockCalls.map((c) => c.companyId)).toEqual(['tj_cmp_c', 'tj_cmp_a']);
  });
});

// ---------------------------------------------------------------------------
// 4. 额度耗尽 / 暂停 / 恢复
// ---------------------------------------------------------------------------

describe('quota exhausted handling', () => {
  it('QUOTA_EXHAUSTED → waiting_quota，队列暂停，不写解锁台账', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_q', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_q');
    h.tanji.unlockHandler = async () => {
      throw new LeadError('QUOTA_EXHAUSTED', 'quota exhausted', { details: { upstreamStatus: 409 } });
    };

    const worker = makeWorker(h);
    const tick = await worker.runOnce();
    expect(tick.paused).toBe(true);
    expect(tick.pauseReason).toBe('QUOTA_EXHAUSTED');
    expect(tick.waitingQuota).toBe(1);
    expect(tick.quotaCost).toBe(0);
    const job = h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_q' })[0]!;
    expect(job.status).toBe('waiting_quota');
    expect(h.repos.unlockLedger.listByCompany('cmp_q')).toHaveLength(0);
    expect(h.repos.companies.getById('cmp_q')!.unlockStatus).toBe('waiting_quota');
  });

  it('额度观测 remaining=0 → 队列暂停；已解锁公司的免费联系人仍可入库', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_free2', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_free2');
    h.tanji.contactsMap.set('tj_cmp_free2', {
      unlocked: true,
      contacts: [makeContact({ type: 'mobile', value: '13800000009' })],
    });
    seedCompany(h.repos, { id: 'cmp_blocked', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_blocked');
    // 观测：日额度为 0（此时不应再尝试 unlock，但仍可查 contacts）
    h.repos.quota.insertObservation({
      observedAt: h.now.toISOString(),
      dailyLimit: 500,
      dailyRemaining: 0,
      monthlyLimit: 1500,
      monthlyRemaining: 223,
      settlementDay: 11,
    });

    const tick = await makeWorker(h).runOnce();
    expect(tick.paused).toBe(true);
    expect(tick.pauseReason).toBe('DAILY_QUOTA_EXHAUSTED');
    expect(tick.alreadyUnlocked).toBe(1);
    expect(tick.waitingQuota).toBe(1);
    expect(h.tanji.unlockCalls).toHaveLength(0);
    expect(h.repos.companies.getById('cmp_free2')!.unlockStatus).toBe('unlocked');
    expect(h.repos.contacts.countByCompany('cmp_free2')).toBe(1);
    expect(h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_blocked' })[0]!.status).toBe('waiting_quota');
    expect(h.repos.companies.getById('cmp_blocked')!.unlockStatus).toBe('waiting_quota');
  });

  it('Quota Poller 检测到额度恢复 → waiting_quota 批量回 pending', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_wait', unlockStatus: 'waiting_quota' });
    const job = h.repos.jobs.enqueue({ companyId: 'cmp_wait', stage: 'unlock' }).job;
    h.repos.jobs.waitForQuota(job.id, { reason: 'quota_exhausted' });
    expect(h.repos.jobs.list({ status: 'waiting_quota' })).toHaveLength(1);

    // 首次观测：剩余额度 > 0 → 恢复
    h.tanji.status.quota!.daily = { limit: 500, used: 200, remaining: 300 };
    const poller = new QuotaPoller({ store: h.store, tanji: h.tanji.asPort(), now: () => h.now });
    const result = await poller.pollOnce();
    expect(result.observed).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.recoveryReason).toBe('first_observation');
    expect(result.resumed).toBe(1);
    expect(h.repos.jobs.list({ status: 'waiting_quota' })).toHaveLength(0);
    expect(h.repos.jobs.list({ status: 'pending', companyId: 'cmp_wait' })).toHaveLength(1);
    // 恢复后公司状态 waiting_quota → pending
    expect(h.repos.companies.getById('cmp_wait')!.unlockStatus).toBe('pending');
    // 写入 quota_observations
    expect(h.repos.quota.latest()).toMatchObject({ dailyRemaining: 300, monthlyRemaining: 223 });
  });

  it('detectQuotaRecovery：日额度增加/跨天/结算日切换/仍为 0 不恢复', () => {
    const base = (over: Partial<Parameters<typeof detectQuotaRecovery>[1]> = {}) => ({
      observedAt: '2026-11-16T02:00:00.000Z',
      dailyLimit: 500,
      dailyRemaining: 100,
      monthlyLimit: 1500,
      monthlyRemaining: 223,
      enterpriseLimit: null,
      enterpriseRemaining: null,
      settlementDay: 11,
      ...over,
    });
    expect(detectQuotaRecovery(base({ dailyRemaining: 0 }), base({ dailyRemaining: 100 })).reason).toBe('from_zero');
    expect(detectQuotaRecovery(base({ dailyRemaining: 100 }), base({ dailyRemaining: 200 })).reason).toBe('daily_increased');
    expect(detectQuotaRecovery(base({ monthlyRemaining: 200 }), base({ monthlyRemaining: 800 })).reason).toBe('monthly_increased');
    expect(detectQuotaRecovery(base({ settlementDay: 11 }), base({ settlementDay: 12 })).reason).toBe('settlement_day');
    expect(
      detectQuotaRecovery(base({ observedAt: '2026-11-15T02:00:00.000Z' }), base({ observedAt: '2026-11-16T02:00:00.000Z' })).reason,
    ).toBe('new_day');
    expect(detectQuotaRecovery(base({ dailyRemaining: 100 }), base({ dailyRemaining: 100 })).recovered).toBe(false);
    expect(detectQuotaRecovery(base({ dailyRemaining: 0 }), base({ dailyRemaining: 0 })).recovered).toBe(false);
    expect(quotaObservationFromStatus(
      { loggedIn: true, version: null, quota: { daily: { limit: 500, used: 0, remaining: 500 }, monthly: null, enterpriseMonthly: null, settlementDay: 11, nearlySevenDayUnlockCount: 7, raw: {} }, raw: {} },
      NOW,
    )).toMatchObject({ dailyRemaining: 500, observedAt: NOW.toISOString() });
  });
});

// ---------------------------------------------------------------------------
// 5. 错误处理：退避 / 死信 / 日额度上限 / 手动解锁
// ---------------------------------------------------------------------------

describe('unlock error handling', () => {
  it('可重试错误 → pending + 退避（不写台账）', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_retry', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_retry');
    h.tanji.unlockHandler = async () => {
      throw new LeadError('SOURCE_UNAVAILABLE', 'upstream timeout');
    };
    const tick = await makeWorker(h).runOnce();
    expect(tick.failed).toBe(1);
    const job = h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_retry' })[0]!;
    expect(job.status).toBe('pending');
    expect(job.attempts).toBe(1);
    expect(job.nextRetryAt).toBeTruthy();
    expect(h.repos.unlockLedger.listByCompany('cmp_retry')).toHaveLength(0);
    // 退避期内不会被再次领取
    const job2 = h.repos.jobs.listFifo({ stage: 'unlock', now: h.now });
    expect(job2).toHaveLength(0);
  });

  it('不可重试错误（会话失效）→ dead + company failed + failed 台账', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_dead', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_dead');
    h.tanji.unlockHandler = async () => {
      throw new LeadError('SOURCE_SESSION_INVALID', 'tanji session invalid');
    };
    const tick = await makeWorker(h).runOnce();
    expect(tick.failed).toBe(1);
    const job = h.repos.jobs.list({ stage: 'unlock', companyId: 'cmp_dead' })[0]!;
    expect(job.status).toBe('dead');
    expect(h.repos.companies.getById('cmp_dead')!.unlockStatus).toBe('failed');
    const ledger = h.repos.unlockLedger.listByCompany('cmp_dead');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ result: 'failed', quotaCost: 0, errorCode: 'SOURCE_SESSION_INVALID' });
  });

  it('LEAD_UNLOCK_DAILY_CAP：当天消耗达上限后暂停', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_cap1', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_cap1');
    seedCompany(h.repos, { id: 'cmp_cap2', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_cap2');
    const worker = makeWorker(h, { dailyCap: 1, maxPerTick: 1 });
    const first = await worker.runOnce();
    expect(first.unlocked).toBe(1);
    const second = await worker.runOnce();
    expect(second.paused).toBe(true);
    expect(second.pauseReason).toBe('DAILY_CAP_EXCEEDED');
    expect(h.tanji.unlockCalls).toHaveLength(1);
  });

  it('enqueueManualUnlock / unlockCompanyNow（FR-11 人工优先）', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_manual', unlockStatus: 'none' });
    h.tanji.contactsMap.set('tj_cmp_manual', { unlocked: true, contacts: [makeContact({ type: 'mobile', value: '13900000001' })] });

    const enqueued = await enqueueManualUnlock(h.store, 'cmp_manual');
    expect(enqueued.created).toBe(true);
    expect(h.repos.companies.getById('cmp_manual')!.unlockStatus).toBe('pending');

    const worker = makeWorker(h);
    const outcome = await worker.unlockCompanyNow('cmp_manual');
    expect(outcome).toBe('already_unlocked');
    expect(h.repos.contacts.countByCompany('cmp_manual')).toBe(1);

    await expect(enqueueManualUnlock(h.store, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    seedCompany(h.repos, { id: 'cmp_no_tanji2', tanjiCompanyId: null });
    await expect(enqueueManualUnlock(h.store, 'cmp_no_tanji2')).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

// ---------------------------------------------------------------------------
// 6. /v1/quota 视图
// ---------------------------------------------------------------------------

describe('quota service', () => {
  it('getQuota 返回三层额度/结算日/近 7 天解锁数/近 N 天曲线', async () => {
    const h = makeHarness();
    h.repos.quota.insertObservation({
      observedAt: h.now.toISOString(),
      dailyLimit: 500,
      dailyRemaining: 223,
      monthlyLimit: 1500,
      monthlyRemaining: 223,
      enterpriseLimit: 19500,
      enterpriseRemaining: 11914,
      settlementDay: 11,
      raw: { loggedIn: true, nearlySevenDayUnlockCount: 12, quotaRaw: {} },
    });
    h.repos.unlockLedger.insertIfAbsent({
      companyId: 'cmp_a',
      result: 'unlocked',
      quotaCost: 1,
      idempotencyKey: 'unlock:cmp_a:2026-11-16',
      requestedAt: '2026-11-16T03:00:00.000Z',
      finishedAt: '2026-11-16T03:00:01.000Z',
    });
    h.repos.unlockLedger.insertIfAbsent({
      companyId: 'cmp_b',
      result: 'unlocked',
      quotaCost: 1,
      idempotencyKey: 'unlock:cmp_b:2026-11-15',
      requestedAt: '2026-11-15T03:00:00.000Z',
      finishedAt: '2026-11-15T03:00:01.000Z',
    });
    h.repos.unlockLedger.insertIfAbsent({
      companyId: 'cmp_c',
      result: 'already_unlocked',
      quotaCost: 0,
      idempotencyKey: 'unlock:cmp_c:2026-11-16',
      requestedAt: '2026-11-16T04:00:00.000Z',
    });

    const view = await getQuota({ deps: { store: createQuotaViewStore(h.repos), now: () => h.now } });
    expect(view.daily).toEqual({ limit: 500, used: 277, remaining: 223, unit: 'point' });
    expect(view.monthly).toEqual({ limit: 1500, used: 1277, remaining: 223, unit: 'point' });
    expect(view.enterpriseMonthly).toEqual({ limit: 19500, used: 7586, remaining: 11914, unit: 'point' });
    expect(view.settlementDay).toBe(11);
    expect(view.nearlySevenDayUnlockCount).toBe(12);
    expect(view.observedAt).toBe(h.now.toISOString());
    expect(view.recentUnlockCurve).toEqual([
      { date: '2026-11-15', count: 1, quotaCost: 1 },
      { date: '2026-11-16', count: 1, quotaCost: 1 },
    ]);
  });

  it('无观测数据时返回零值视图', async () => {
    const h = makeHarness();
    const service = new QuotaService({ store: createQuotaViewStore(h.repos), now: () => h.now });
    const view = await service.getQuota();
    expect(view.daily).toEqual({ limit: 0, used: 0, remaining: 0, unit: 'point' });
    expect(view.observedAt).toBeNull();
    expect(view.recentUnlockCurve).toEqual([]);
  });

  it('buildUnlockCurve 仅统计近 N 天成功解锁', () => {
    const now = new Date('2026-11-16T02:00:00.000Z');
    const curve = buildUnlockCurve(
      [
        { result: 'unlocked', quotaCost: 1, requestedAt: '2026-11-16T01:00:00.000Z' },
        { result: 'unlocked', quotaCost: 1, requestedAt: '2026-11-16T02:00:00.000Z' },
        { result: 'already_unlocked', quotaCost: 0, requestedAt: '2026-11-16T02:00:00.000Z' },
        { result: 'failed', quotaCost: 0, requestedAt: '2026-11-16T02:00:00.000Z' },
        { result: 'unlocked', quotaCost: 1, requestedAt: '2026-10-01T02:00:00.000Z' },
      ],
      now,
      14,
    );
    expect(curve).toEqual([{ date: '2026-11-16', count: 2, quotaCost: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// 7. F2 内存 DB 上的 Quota Poller 全链路（写入观测 + 唤醒）
// ---------------------------------------------------------------------------

describe('quota poller (integration)', () => {
  it('轮询写入 quota_observations，额度增加时唤醒队列', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_x', unlockStatus: 'pending' });
    const job = h.repos.jobs.enqueue({ companyId: 'cmp_x', stage: 'unlock' }).job;
    h.repos.jobs.waitForQuota(job.id);
    h.repos.quota.insertObservation({
      observedAt: '2026-11-16T00:00:00.000Z',
      dailyLimit: 500,
      dailyRemaining: 0,
      monthlyLimit: 1500,
      monthlyRemaining: 223,
      settlementDay: 11,
    });
    h.tanji.status.quota!.daily = { limit: 500, used: 100, remaining: 400 };
    const poll = await pollQuotaOnce(h.store, h.tanji.asPort(), { now: () => h.now });
    expect(poll.recovered).toBe(true);
    expect(poll.recoveryReason).toBe('from_zero');
    expect(poll.resumed).toBe(1);
    expect(h.repos.quota.listRecent(3).length).toBe(2);
    expect(h.repos.jobs.list({ status: 'pending', companyId: 'cmp_x' })).toHaveLength(1);
  });
});


// ---------------------------------------------------------------------------
// 8. 运行时接线（initUnlockEventsRuntime）：注入 fake tanji + 内存 DB
// ---------------------------------------------------------------------------

describe('unlock events runtime wiring', () => {
  it('runtime 组装 unlock worker + quota poller + dispatcher + SSE，默认安全开关', async () => {
    const h = makeHarness();
    seedCompany(h.repos, { id: 'cmp_rt', unlockStatus: 'pending' });
    seedRecruitingSignal(h.repos, 'cmp_rt');
    h.tanji.contactsMap.set('tj_cmp_rt', { unlocked: true, contacts: [makeContact({ type: 'mobile', value: '13700000001' })] });
    const runtime = initUnlockEventsRuntime({
      repos: h.repos,
      tanji: h.tanji as unknown as TanjiClient,
      allowUnlock: true,
      startUnlockWorker: false,
      startQuotaPoller: false,
      startWebhookDispatcher: false,
      startEventStreamer: false,
      logger: null,
      now: () => h.now,
    });
    try {
      expect(runtime.allowUnlock).toBe(true);
      expect(h.tanji.unlockCalls).toHaveLength(0);
      const tick = (await runtime.tickUnlock()) as { alreadyUnlocked: number; claimed: number };
      expect(tick.claimed).toBe(1);
      expect(tick.alreadyUnlocked).toBe(1);
      const webhookTick = (await runtime.tickWebhooks()) as { fanout: { created: number } };
      expect(webhookTick.fanout.created).toBe(0);
      expect(runtime.started).toBe(false);
      runtime.start();
      expect(runtime.started).toBe(true);
      runtime.stop();
      expect(runtime.started).toBe(false);
    } finally {
      runtime.stop();
      resetUnlockEventsDefaults();
    }
  });
});
