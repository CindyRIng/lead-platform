/**
 * F2 数据层单元测试：迁移幂等 / 核心仓库 CRUD / 队列租约 / 快照去重 / 事件游标
 *
 * 说明：这里直接用 node:sqlite 构造内存连接 + migrate(src/db/migrate.ts)，
 * 不经过 src/db/index.ts 的 config 单例，保证 CI 无 .env 时也可独立运行。
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, currentVersion, SCHEMA_VERSION } from '../../src/db/migrate.js';
import { createRepositories, type Repositories } from '../../src/repositories/index.js';
import type { DbConnection } from '../../src/repositories/sql.js';

interface TestDb extends DbConnection {
  close(): void;
}

/** 内存库 + BEGIN IMMEDIATE/SAVEPOINT 事务（与 src/db/index.ts 的 DatabaseHandle 等价） */
function createMemoryDb(): TestDb {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  let depth = 0;
  const db: TestDb = {
    raw,
    transaction<T>(fn: () => T): T {
      const savepoint = `sp_${depth}`;
      if (depth === 0) raw.exec('BEGIN IMMEDIATE;');
      else raw.exec(`SAVEPOINT ${savepoint};`);
      depth += 1;
      try {
        const result = fn();
        depth -= 1;
        if (depth === 0) raw.exec('COMMIT;');
        else raw.exec(`RELEASE ${savepoint};`);
        return result;
      } catch (err) {
        depth -= 1;
        try {
          if (depth === 0) raw.exec('ROLLBACK;');
          else raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    close(): void {
      raw.close();
    },
  };
  migrate(raw);
  return db;
}

function goalInput(overrides: Record<string, unknown> = {}) {
  return {
    name: '河北省外贸线索',
    region: { province: '河北省', provinceCode: '130000', cityCodes: [] },
    platforms: ['boss', 'zhilian', 'ali', 'mic'] as const,
    keywords: { boss: ['外贸'], zhilian: ['外贸'], ali: ['machinery'], mic: [] },
    ...overrides,
  } as Parameters<Repositories['goals']['create']>[0];
}

describe('db migrate', () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('迁移幂等：user_version=1，第二次 applied=false', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-db-'));
    const file = path.join(dir, 'lead.db');
    const raw = new DatabaseSync(file);
    try {
      expect(currentVersion(raw)).toBe(0);
      const first = migrate(raw);
      expect(first).toEqual({ version: SCHEMA_VERSION, applied: true });
      expect(currentVersion(raw)).toBe(SCHEMA_VERSION);
      const second = migrate(raw);
      expect(second.applied).toBe(false);
      expect(second.version).toBe(SCHEMA_VERSION);
    } finally {
      raw.close();
    }
    // 重新打开：表已存在且幂等
    const raw2 = new DatabaseSync(file);
    try {
      expect(migrate(raw2).applied).toBe(false);
      const tables = raw2
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('goals','companies','change_events','raw_snapshots')")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBe(4);
    } finally {
      raw2.close();
    }
  });
});

describe('repositories', () => {
  let db: TestDb;
  let repos: Repositories;

  beforeEach(() => {
    db = createMemoryDb();
    repos = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it('meta：读写/JSON/租约', () => {
    expect(repos.meta.get('missing')).toBeNull();
    repos.meta.set('k', 'v');
    expect(repos.meta.get('k')).toBe('v');
    repos.meta.setJson('obj', { a: 1 });
    expect(repos.meta.getJson('obj', {})).toEqual({ a: 1 });
    expect(repos.meta.list().length).toBe(2);

    expect(repos.meta.acquireLease('leader', 'worker-a', 60_000)).toBe(true);
    expect(repos.meta.acquireLease('leader', 'worker-b', 60_000)).toBe(false);
    expect(repos.meta.acquireLease('leader', 'worker-a', 60_000)).toBe(true);
    expect(repos.meta.releaseLease('leader', 'worker-b')).toBe(false);
    expect(repos.meta.releaseLease('leader', 'worker-a')).toBe(true);
    expect(repos.meta.acquireLease('leader', 'worker-b', 60_000)).toBe(true);
  });

  it('goals：CRUD + 乐观锁冲突', () => {
    const goal = repos.goals.create(goalInput());
    expect(goal.id.startsWith('goal_')).toBe(true);
    expect(goal.region.province).toBe('河北省');
    expect(goal.platforms).toHaveLength(4);
    expect(goal.enabled).toBe(true);

    const updated = repos.goals.update(goal.id, { name: '改名', enabled: false }, { expectedVersion: 1 });
    expect(updated.name).toBe('改名');
    expect(updated.enabled).toBe(false);
    expect(updated.version).toBe(2);

    expect(() => repos.goals.update(goal.id, { name: '冲突' }, { expectedVersion: 1 })).toThrowError(
      /version conflict/,
    );
    expect(repos.goals.list({ enabled: false })).toHaveLength(1);
    expect(repos.goals.listEnabled()).toHaveLength(0);
  });

  it('runs：创建/状态/心跳/stats 合并/活动 Run 判定', () => {
    const goal = repos.goals.create(goalInput());
    const run = repos.runs.create({ goalId: goal.id, trigger: 'manual' });
    expect(run.status).toBe('pending');
    expect(repos.runs.findActiveByGoal(goal.id)?.id).toBe(run.id);

    repos.runs.updateStatus(run.id, 'running');
    let current = repos.runs.getById(run.id)!;
    expect(current.status).toBe('running');
    expect(current.startedAt).toBeTruthy();

    repos.runs.updateStats(run.id, { platforms: { boss: { queries: 2, pages: 1, leads: 5, companiesNew: 3 } } });
    repos.runs.updateStats(run.id, { platforms: { zhilian: { queries: 1, pages: 2, leads: 0, companiesNew: 0 } } });
    current = repos.runs.getById(run.id)!;
    expect(current.stats.platforms?.boss?.leads).toBe(5);
    expect(current.stats.platforms?.zhilian?.pages).toBe(2);

    repos.runs.updateHeartbeat(run.id);
    expect(repos.runs.getById(run.id)!.heartbeatAt).toBeTruthy();

    repos.runs.finish(run.id, 'completed');
    current = repos.runs.getById(run.id)!;
    expect(current.status).toBe('completed');
    expect(current.finishedAt).toBeTruthy();
    expect(repos.runs.findActiveByGoal(goal.id)).toBeNull();
    expect(repos.runs.countByStatus()).toEqual({ completed: 1 });
  });

  it('sourceQueries：幂等创建（含空关键词）+ 进度 + 统计', () => {
    const goal = repos.goals.create(goalInput());
    const run = repos.runs.create({ goalId: goal.id, trigger: 'manual' });
    const first = repos.sourceQueries.create({
      runId: run.id,
      platform: 'boss',
      cityCode: '130100',
      platformRegionValue: '101',
      keyword: '外贸',
    });
    expect(first.created).toBe(true);
    const dup = repos.sourceQueries.create({
      runId: run.id,
      platform: 'boss',
      cityCode: '130100',
      platformRegionValue: '101',
      keyword: '外贸',
    });
    expect(dup.created).toBe(false);
    expect(dup.query.id).toBe(first.query.id);

    // 空关键词（Ali/Mic）同样幂等
    const ali1 = repos.sourceQueries.create({
      runId: run.id,
      platform: 'ali',
      cityCode: '130000',
      platformRegionValue: 'Hebei',
      keyword: null,
    });
    const ali2 = repos.sourceQueries.create({
      runId: run.id,
      platform: 'ali',
      cityCode: '130000',
      platformRegionValue: 'Hebei',
      keyword: null,
    });
    expect(ali1.created).toBe(true);
    expect(ali2.created).toBe(false);

    repos.sourceQueries.updateProgress(first.query.id, { status: 'done', pagesFetched: 3, totalPages: 3 });
    expect(repos.sourceQueries.statsByRun(run.id)).toEqual({
      total: 2,
      pending: 1,
      running: 0,
      done: 1,
      failed: 0,
      skipped: 0,
    });
  });

  it('companies：创建/更新版本/去重查询/keyset 分页/覆盖度', () => {
    const base = {
      name: '河北石家庄ABC机械有限公司',
      province: '河北省',
      city: '石家庄市',
    };
    const c1 = repos.companies.create({ ...base, uscc: '91130100MA0AAAAAAA' });
    repos.companies.create({ name: '河北唐山XYZ贸易有限公司', province: '河北省', city: '唐山市' });
    repos.companies.create({ name: '河北保定QQQ管件有限公司', province: '河北省', city: '保定市' });
    const c4 = repos.companies.create({ name: '河北廊坊ABC机械有限公司', province: '河北省', city: '廊坊市' });

    expect(c1.normalizedName).toBe('ABC机械');
    expect(c4.normalizedName).toBe('ABC机械');
    expect(repos.companies.findByNormalizedName('ABC机械')).toHaveLength(2);
    expect(repos.companies.findByUscc('91130100MA0AAAAAAA')?.id).toBe(c1.id);
    // provinces 过滤
    expect(repos.companies.findByNormalizedName('ABC机械', { province: '山东省' })).toHaveLength(0);

    const updated = repos.companies.update(c1.id, { englishName: 'ABC Machinery Co., Ltd.' }, { expectedVersion: 1 });
    expect(updated.version).toBe(2);
    expect(updated.englishName).toBe('ABC Machinery Co., Ltd.');
    expect(() => repos.companies.update(c1.id, { industry: '机械' }, { expectedVersion: 1 })).toThrowError(
      /version conflict/,
    );

    // keyset 分页（每页 3）
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let i = 0; i < 10; i += 1) {
      const page = repos.companies.listKeyset({ limit: 3, cursor });
      for (const company of page.items) {
        expect(seen.has(company.id)).toBe(false);
        seen.add(company.id);
      }
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    expect(seen.size).toBe(4);

    expect(repos.companies.count()).toBe(4);
    expect(repos.companies.stats().total).toBe(4);
    expect(repos.companies.coverageByCity()['石家庄市']).toBe(1);
  });

  it('companies：USCC 唯一约束 + source 外键约束', () => {
    repos.companies.create({ name: 'A公司', uscc: 'USCC-DUP' });
    expect(() => repos.companies.create({ name: 'B公司', uscc: 'USCC-DUP' })).toThrow();
    expect(() =>
      repos.companySources.upsert({
        companyId: 'cmp_not_exists',
        platform: 'boss',
        platformCompanyId: 'p1',
      }),
    ).toThrow();
  });

  it('companySources：唯一键 upsert + lastSeen 更新', () => {
    const company = repos.companies.create({ name: '河北A有限公司' });
    const first = repos.companySources.upsert({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-1',
      sourceName: 'A',
      evidence: { keyword: '外贸' },
    });
    expect(first.created).toBe(true);
    const t0 = first.source.lastSeenAt;
    const second = repos.companySources.upsert({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-1',
      sourceName: 'A2',
      evidence: { jobs: 5 },
      lastSeenAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(second.created).toBe(false);
    expect(second.source.id).toBe(first.source.id);
    expect(second.source.sourceName).toBe('A2');
    expect(second.source.evidence).toEqual({ keyword: '外贸', jobs: 5 });
    expect(second.source.lastSeenAt).not.toBe(t0);
    expect(repos.companySources.listByCompany(company.id)).toHaveLength(1);
  });

  it('contacts：唯一键 upsert + 批量', () => {
    const company = repos.companies.create({ name: '河北B有限公司' });
    const c1 = repos.contacts.upsert({
      companyId: company.id,
      type: 'mobile',
      value: '13800000000',
      name: '张三',
      isKey: true,
    });
    const c2 = repos.contacts.upsert({
      companyId: company.id,
      type: 'mobile',
      value: '13800000000',
      name: '张三（更新）',
      position: '经理',
    });
    expect(c2.id).toBe(c1.id);
    expect(c2.position).toBe('经理');
    expect(c2.isKey).toBe(true);
    const batch = repos.contacts.upsertMany([
      { companyId: company.id, type: 'email', value: 'a@b.com' },
      { companyId: company.id, type: 'phone', value: '0311-0000000' },
    ]);
    expect(batch).toHaveLength(2);
    expect(repos.contacts.countByCompany(company.id)).toBe(3);
    expect(repos.contacts.summarizeByCompany(company.id)).toMatchObject({ total: 3, types: { mobile: 1, email: 1, phone: 1 } });
  });

  it('pipeline_jobs：幂等入队 / 原子领取 / 租约过期回收', () => {
    const company = repos.companies.create({ name: '河北C有限公司' });
    const first = repos.jobs.enqueue({ companyId: company.id, stage: 'tanji_match' });
    expect(first.created).toBe(true);
    const dup = repos.jobs.enqueue({ companyId: company.id, stage: 'tanji_match' });
    expect(dup.created).toBe(false);
    expect(dup.job.id).toBe(first.job.id);

    const t0 = new Date('2026-01-01T00:00:00.000Z');
    const claimed = repos.jobs.claimNext({ workerId: 'w1', now: t0, leaseSec: 60 });
    expect(claimed?.id).toBe(first.job.id);
    expect(claimed?.status).toBe('running');
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.leaseOwner).toBe('w1');
    // 同一时刻无法重复领取
    expect(repos.jobs.claimNext({ workerId: 'w2', now: t0, leaseSec: 60 })).toBeNull();
    // 租约过期后可被回收
    const reclaimed = repos.jobs.claimNext({
      workerId: 'w2',
      now: new Date(t0.getTime() + 61_000),
      leaseSec: 60,
    });
    expect(reclaimed?.id).toBe(first.job.id);
    expect(reclaimed?.leaseOwner).toBe('w2');
    expect(reclaimed?.attempts).toBe(2);

    // 续租
    const renewed = repos.jobs.renewLease(first.job.id, { workerId: 'w2', leaseSec: 30, now: t0 });
    expect(renewed?.leaseUntil).toBeTruthy();

    repos.jobs.complete(first.job.id);
    expect(repos.jobs.getById(first.job.id)?.status).toBe('done');
    expect(repos.jobs.stats()).toMatchObject({ done: 1, pending: 0, running: 0 });
  });

  it('pipeline_jobs：失败退避→dead / waiting_quota 唤醒 / claimById / retry', () => {
    const company = repos.companies.create({ name: '河北D有限公司' });
    const { job } = repos.jobs.enqueue({ companyId: company.id, stage: 'tanji_detail', maxAttempts: 2 });
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(repos.jobs.claimNext({ workerId: 'w', now })?.id).toBe(job.id);
    const failed = repos.jobs.fail(job.id, { error: 'network', errorCode: 'SOURCE_UNAVAILABLE', now });
    expect(failed?.status).toBe('pending');
    expect(failed?.nextRetryAt).toBeTruthy();
    // 未到重试时间不可领取
    expect(repos.jobs.claimNext({ workerId: 'w', now })).toBeNull();
    const dueAt = new Date(Date.parse(failed!.nextRetryAt!));
    expect(repos.jobs.claimNext({ workerId: 'w', now: dueAt })?.id).toBe(job.id);
    const dead = repos.jobs.fail(job.id, { error: 'boom', now: dueAt });
    expect(dead?.status).toBe('dead');

    // waiting_quota：不计失败次数，可被唤醒
    const { job: quotaJob } = repos.jobs.enqueue({ companyId: company.id, stage: 'unlock' });
    repos.jobs.claimById(quotaJob.id, { workerId: 'w', now });
    const waiting = repos.jobs.waitForQuota(quotaJob.id, { reason: 'QUOTA_EXHAUSTED' });
    expect(waiting?.status).toBe('waiting_quota');
    expect(waiting?.attempts).toBe(0);
    expect(repos.jobs.wakeWaitingQuota({ now: new Date(now.getTime() + 1000) })).toBe(1);
    expect(repos.jobs.getById(quotaJob.id)?.status).toBe('pending');
    // claimById 只领取 pending 且到期
    expect(repos.jobs.claimById(quotaJob.id, { workerId: 'w2', now: new Date(now.getTime() + 2000) })?.status).toBe(
      'running',
    );
    repos.jobs.cancel(quotaJob.id);
    expect(repos.jobs.getById(quotaJob.id)?.status).toBe('cancelled');
    expect(repos.jobs.retry(quotaJob.id)?.status).toBe('pending');
  });

  it('raw_snapshots：brotli 压缩 + sha256 内容去重 + gzip 兼容', () => {
    const payload = { data: 'x'.repeat(500), n: 1 };
    const first = repos.snapshots.writeText({ kind: 'source_search_page', payload, platform: 'boss' });
    expect(first.blobCreated).toBe(true);
    expect(first.snapshot.kind).toBe('source_search_page');
    expect(first.blob.hash.startsWith('sha256:')).toBe(true);
    expect(first.blob.bytes).toBeGreaterThan(0);
    expect(first.blob.storedBytes).toBeLessThan(first.blob.bytes);

    const second = repos.snapshots.writeText({ kind: 'source_search_page', payload, platform: 'boss' });
    expect(second.blobCreated).toBe(false);
    expect(second.blob.hash).toBe(first.blob.hash);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(repos.snapshots.countSnapshots()).toBe(2);
    expect(repos.snapshots.stats().blobs).toBe(1);
    expect(JSON.parse(repos.snapshots.getPayload(second.snapshot.id)!)).toEqual(payload);

    // gzip 兼容
    const gzipRepos = createRepositories(db, { snapshotCompression: 'gzip' });
    const gzipSnap = gzipRepos.snapshots.writeText({ kind: 'source_company_detail', payload: { g: 1 } });
    expect(gzipSnap.blob.encoding).toBe('gzip');
    expect(JSON.parse(gzipRepos.snapshots.getPayload(gzipSnap.snapshot.id)!)).toEqual({ g: 1 });

    // 待归档列表
    expect(repos.snapshots.listArchivable(new Date(Date.now() + 60_000).toISOString())).toHaveLength(3);
    const archived = repos.snapshots.markArchived(
      [first.snapshot.id],
      'archive/2026-01/part-0001.br',
    );
    expect(archived).toBe(1);
    expect(repos.snapshots.getSnapshot(first.snapshot.id)?.archived).toBe(true);
  });

  it('change_events：seq 单调 + sinceSeq 游标 + 批量同事务', () => {
    const company = repos.companies.create({ name: '河北E有限公司' });
    const e1 = repos.changeEvents.append({
      companyId: company.id,
      version: 1,
      eventType: 'company.created',
      source: 'system',
      newValue: { name: company.name },
    });
    const many = repos.changeEvents.appendMany([
      { companyId: company.id, version: 2, eventType: 'company.updated', field: 'industry', oldValue: null, newValue: '机械', source: 'tanji', valueType: 'string' },
      { companyId: company.id, version: 2, eventType: 'company.updated', field: 'scale', oldValue: '1', newValue: '10', source: 'tanji', valueType: 'string' },
    ]);
    expect(e1.seq).toBe(1);
    expect(many.map((e) => e.seq)).toEqual([2, 3]);
    expect(repos.changeEvents.maxSeq()).toBe(3);
    expect(repos.changeEvents.listSince(1)).toHaveLength(2);
    expect(repos.changeEvents.listSince(3)).toHaveLength(0);
    expect(repos.changeEvents.countSince(0)).toBe(3);
    const byCompany = repos.changeEvents.listByCompany(company.id);
    expect(byCompany).toHaveLength(3);
    expect(byCompany[1]!.newValue).toBe('机械');
    expect(repos.changeEvents.listSince(0, { types: ['company.created'] })).toHaveLength(1);
  });

  it('unlock_ledger：idempotency_key 幂等 + 统计', () => {
    const company = repos.companies.create({ name: '河北F有限公司' });
    const first = repos.unlockLedger.insertIfAbsent({
      companyId: company.id,
      result: 'unlocked',
      quotaCost: 1,
      idempotencyKey: 'unlock:1:2026-01-01',
    });
    expect(first.created).toBe(true);
    const second = repos.unlockLedger.insertIfAbsent({
      companyId: company.id,
      result: 'unlocked',
      quotaCost: 1,
      idempotencyKey: 'unlock:1:2026-01-01',
    });
    expect(second.created).toBe(false);
    expect(second.entry.id).toBe(first.entry.id);
    expect(repos.unlockLedger.sumQuotaCostSince('2000-01-01T00:00:00.000Z')).toBe(1);
    repos.unlockLedger.finish(first.entry.id, { quotaAfter: 499, finishedAt: new Date().toISOString() });
    expect(repos.unlockLedger.getById(first.entry.id)?.quotaAfter).toBe(499);
  });

  it('webhooks：订阅 + 投递失败退避/死信/重放', () => {
    const sub = repos.webhooks.createSubscription({
      url: 'http://127.0.0.1:9000/hook',
      eventTypes: ['company.created'],
      description: 'test',
    });
    expect(sub.secret.length).toBeGreaterThan(0);
    expect(repos.webhooks.listSubscriptions()).toHaveLength(1);

    const delivery = repos.webhooks.createDelivery({
      subscriptionId: sub.id,
      eventSeq: 1,
      eventType: 'company.created',
    });
    expect(repos.webhooks.listDueDeliveries()).toHaveLength(1);
    const failed = repos.webhooks.markDeliveryFailed(delivery.id, { error: 'timeout', responseStatus: 500 });
    expect(failed?.attempts).toBe(1);
    expect(failed?.status).toBe('failed');
    expect(failed?.nextRetryAt).toBeTruthy();
    // 未到时间不投递
    expect(repos.webhooks.listDueDeliveries()).toHaveLength(0);
    expect(
      repos.webhooks.listDueDeliveries({ now: new Date(Date.parse(failed!.nextRetryAt!)) }),
    ).toHaveLength(1);
    const delivered = repos.webhooks.markDelivered(delivery.id, { responseStatus: 200, responseBodyHead: 'ok' });
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveredAt).toBeTruthy();

    const replayed = repos.webhooks.replayDelivery(delivery.id);
    expect(replayed?.status).toBe('pending');
    expect(replayed?.attempts).toBe(0);
    // 显式 dead
    const dead = repos.webhooks.markDeliveryFailed(delivery.id, { error: 'fatal', retryable: false });
    expect(dead?.status).toBe('dead');
  });

  it('quota / source_health / regions / mappings', () => {
    const quota = repos.quota.insertObservation({
      dailyRemaining: 500,
      monthlyRemaining: 223,
      enterpriseRemaining: 11914,
      settlementDay: 11,
      raw: { ok: true },
    });
    expect(repos.quota.latest()?.id).toBe(quota.id);
    expect(repos.quota.listRecent(10)).toHaveLength(1);

    const health = repos.sourceHealth.upsert({ platform: 'boss', state: 'degraded', detail: { reason: 'x' } });
    expect(health.state).toBe('degraded');
    const failure = repos.sourceHealth.markFailure('boss', 'session_invalid');
    expect(failure.consecutiveFailures).toBe(1);
    expect(repos.sourceHealth.markOk('boss').consecutiveFailures).toBe(0);
    expect(repos.sourceHealth.listAll()).toHaveLength(1);

    repos.regions.upsertRegions([
      { code: '130000', name: '河北省', level: 'province', parentCode: null },
      { code: '130100', name: '石家庄市', level: 'city', parentCode: '130000' },
      { code: '130200', name: '唐山市', level: 'city', parentCode: '130000' },
    ]);
    expect(repos.regions.listProvinces()).toHaveLength(1);
    expect(repos.regions.listCities('130000')).toHaveLength(2);

    repos.regions.upsertMappings([
      { regionCode: '130100', platform: 'boss', platformValue: '101', source: 'builtin' },
      { regionCode: '130200', platform: 'boss', platformValue: '102', source: 'builtin' },
    ]);
    expect(repos.regions.listMappingsForProvince('130000', 'boss')).toEqual({ '130100': '101', '130200': '102' });
    expect(repos.regions.getMappingValue('130100', 'boss')).toBe('101');
  });

  it('platform_profiles / platform_jobs / customs_profiles', () => {
    const company = repos.companies.create({ name: '河北G有限公司' });

    const p1 = repos.platformProfiles.upsert({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-g-1',
      displayName: 'G',
      jobCount: 3,
    });
    expect(p1.created).toBe(true);
    expect(p1.profile.version).toBe(1);
    const p2 = repos.platformProfiles.upsert({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-g-1',
      displayName: 'G2',
      jobCount: 4,
      nextJobsRefreshAt: '2000-01-01T00:00:00.000Z',
    });
    expect(p2.created).toBe(false);
    expect(p2.previous?.displayName).toBe('G');
    expect(p2.profile.displayName).toBe('G2');
    expect(p2.profile.version).toBe(2);
    // 显式 version / next refresh 可控
    const p3 = repos.platformProfiles.upsert({
      companyId: company.id,
      platform: 'ali',
      platformCompanyId: 'ali-g-1',
      version: 5,
      nextJobsRefreshAt: '2000-01-01T00:00:00.000Z',
      nextStoreRefreshAt: '2000-01-01T00:00:00.000Z',
    });
    expect(p3.profile.version).toBe(5);
    expect(repos.platformProfiles.listByCompany(company.id)).toHaveLength(2);
    expect(repos.platformProfiles.listDueJobs().map((p) => p.platform)).toEqual(['boss']);
    expect(repos.platformProfiles.listDueStores().map((p) => p.platform)).toEqual(['ali']);
    expect(repos.platformProfiles.count()).toBe(2);

    const j1 = repos.platformJobs.upsertJob({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-g-1',
      jobId: 'job-1',
      title: '外贸业务员',
    });
    expect(j1.created).toBe(true);
    expect(j1.job.status).toBe('active');
    const j2 = repos.platformJobs.upsertJob({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-g-1',
      jobId: 'job-1',
      title: '外贸业务员（急聘）',
    });
    expect(j2.created).toBe(false);
    expect(j2.job.firstSeenAt).toBe(j1.job.firstSeenAt);
    expect(j2.job.title).toBe('外贸业务员（急聘）');
    expect(repos.platformJobs.countActiveByCompanyPlatform(company.id, 'boss')).toBe(1);

    const closed = repos.platformJobs.closeMissing(company.id, 'boss', []);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.status).toBe('closed');
    expect(repos.platformJobs.countActiveByCompanyPlatform(company.id, 'boss')).toBe(0);
    const reactivated = repos.platformJobs.upsertJob({
      companyId: company.id,
      platform: 'boss',
      platformCompanyId: 'boss-g-1',
      jobId: 'job-1',
      title: '外贸业务员',
    });
    expect(reactivated.job.status).toBe('active');
    expect(reactivated.job.closedAt).toBeNull();
    expect(repos.platformJobs.countActiveByCompanyIds([company.id]).get(company.id)).toBe(1);

    const customs1 = repos.customs.upsert({
      companyId: company.id,
      englishName: 'Hebei G Co., Ltd.',
      queryNames: ['Hebei G'],
      fetchedRecords: 20,
      matchedRecords: 12,
      confidence: 'high',
      nextRefreshAt: '2000-01-01T00:00:00.000Z',
    });
    expect(customs1.created).toBe(true);
    expect(customs1.profile.confidence).toBe('high');
    const customs2 = repos.customs.upsert({ companyId: company.id, confidence: 'medium' });
    expect(customs2.created).toBe(false);
    expect(customs2.previous?.confidence).toBe('high');
    expect(customs2.profile.confidence).toBe('medium');
    expect(customs2.profile.version).toBe(2);
    expect(repos.customs.listDue()).toHaveLength(1);
    expect(repos.customs.listByCompanyIds([company.id])).toHaveLength(1);
  });

  it('事务 helper：异常回滚', () => {
    const company = repos.companies.create({ name: '河北H有限公司' });
    expect(() =>
      repos.transaction(() => {
        repos.companySources.upsert({
          companyId: company.id,
          platform: 'boss',
          platformCompanyId: 'rollback-1',
        });
        throw new Error('rollback');
      }),
    ).toThrowError('rollback');
    expect(repos.companySources.countByCompany(company.id)).toBe(0);
  });
});
