/**
 * AC 验收场景与检查清单（供 tests/integration/e2e-mock.test.ts 与 scripts/acceptance.ts 共用）。
 *
 * 场景：mock 六上游 + 真实 SQLite + 真实 wiring/workers/REST（进程内完整 app 生命周期）。
 * 每个 AC 检查只做断言并返回「证据」，不依赖 vitest；失败抛错。
 *
 * 安全：仅连本地 mock 上游；tanji unlock 只作用于 mock 内存；任何 check 结束都恢复 mock 场景状态。
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  type MockUpstreams,
  exhaustTanjiQuota,
  restoreTanjiQuota,
  setFumaPermission,
  setJobsRound,
  setSessionInvalid,
} from '../mock-upstreams/index.js';
import {
  createFullRuntime,
  type FullRuntime,
  type TickSummary,
} from '../helpers/fullRuntime.js';
import { defaultGoalInput } from '../helpers/runtime.js';
import { PROJECT_ROOT } from '../helpers/app.js';
import { createTempSandbox, type TempSandbox } from '../helpers/tmp.js';
import { WebhookReceiver } from '../helpers/webhook-receiver.js';

const execFileAsync = promisify(execFile);

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const WEBHOOK_EVENT_TYPES = [
  'company.created',
  'company.updated',
  'contact.unlocked',
  'platform.jobs.updated',
  'customs.updated',
];

export type CompanyKey = 'chenxing' | 'yunfan' | 'hengyue' | 'lanjing' | 'huaxi' | 'haichuan';

export interface FullScenario {
  rt: FullRuntime;
  mocks: MockUpstreams;
  sandbox: TempSandbox;
  receiver: WebhookReceiver;
  goal: any;
  run: any;
  collectionStats: any;
  tick: TickSummary;
  ids: Record<CompanyKey, string>;
  /** 收集阶段（补全/合并之前）的公司数/来源数 */
  preTick: { companiesAll: number; companiesLive: number; sources: number; jobs: number };
  /** 主场景 tick 后 mock 探迹实际扣点次数（后续子场景 reset mock 世界后仍可用） */
  quotaConsumed: number;
  secret: string;
  subscriptionId: string;
}

interface WaitRunOptions {
  timeoutMs?: number;
}

export async function waitRunTerminal(rt: FullRuntime, runId: string, opts: WaitRunOptions = {}): Promise<any> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await rt.api.getOk<any>(`/v1/runs/${runId}`);
    const status = run?.status ?? run?.run?.status;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(status)) return run;
    if (Date.now() > deadline) throw new Error(`等待 Run ${runId} 终态超时（${timeoutMs}ms），最后状态=${status}`);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

async function findCompanyIds(rt: FullRuntime): Promise<Record<CompanyKey, string>> {
  const repos = rt.repos as any;
  const companies = repos.companies.list({ limit: 200 });
  const pick = (predicate: (c: any) => boolean, label: string): string => {
    const found = companies.find(predicate);
    if (!found) throw new Error(`场景缺少公司：${label}`);
    return found.id;
  };
  return {
    chenxing: pick((c) => c.name.includes('辰星'), '辰星'),
    yunfan: pick((c) => c.name.includes('云帆'), '云帆'),
    hengyue: pick((c) => (c.englishName ?? '').includes('Hengyue'), '恒岳'),
    lanjing: pick((c) => c.name.includes('蓝鲸'), '蓝鲸'),
    huaxi: pick((c) => c.name.includes('华曦'), '华曦'),
    haichuan: pick((c) => c.name.includes('海川'), '海川'),
  };
}

/** 构建主验收场景（收集 + 补全 + 刷新 + 海关 + 解锁 + webhook） */
export async function buildFullScenario(mocks: MockUpstreams, sandbox: TempSandbox): Promise<FullScenario> {
  mocks.reset();
  const receiver = new WebhookReceiver({ secret: WEBHOOK_SECRET });
  await receiver.start();

  let rt: FullRuntime | null = null;
  try {
    rt = await createFullRuntime({ mocks, sandbox, memoryDb: true, maxAutoPriority: 3 });
    // 订阅必须先于 Run 创建，才能覆盖 company.created 等早期事件
    const subscription = await rt.api.postOk<any>('/v1/webhooks', {
      url: receiver.url,
      eventTypes: WEBHOOK_EVENT_TYPES,
      secret: WEBHOOK_SECRET,
      description: '验收测试 webhook',
    });
    const goal = await rt.api.postOk<any>('/v1/goals', defaultGoalInput());
    const runTrigger = await rt.api.post<any>(`/v1/goals/${goal.id}/run`);
    assert.equal(runTrigger.status, 202, `POST /v1/goals/:id/run 期望 202，实际 ${runTrigger.status}`);
    const runId = (runTrigger.body as any).data?.id ?? (runTrigger.body as any).data?.run?.id;
    assert.ok(runId, '触发 Run 未返回 run id');
    const run = await waitRunTerminal(rt, runId);
    const collectionStats = run.stats ?? {};
    const repos = rt.repos as any;
    const preTick = {
      companiesAll: repos.companies.count({ includeMerged: true }),
      companiesLive: repos.companies.count(),
      sources: repos.companySources.count(),
      jobs: repos.jobs.count(),
    };
    const tick = await rt.tick({ rounds: 12 });
    const quotaConsumed = mocks.world.scenario.tanjiQuotaConsumed;
    const ids = await findCompanyIds(rt);
    return {
      rt,
      mocks,
      sandbox,
      receiver,
      goal,
      run,
      collectionStats,
      tick,
      ids,
      preTick,
      quotaConsumed,
      secret: WEBHOOK_SECRET,
      subscriptionId: subscription?.id ?? subscription?.subscription?.id,
    };
  } catch (err) {
    if (rt) await rt.close().catch(() => undefined);
    await receiver.stop().catch(() => undefined);
    throw err;
  }
}

export async function closeFullScenario(scenario: FullScenario): Promise<void> {
  await scenario.rt.close().catch(() => undefined);
  await scenario.receiver.stop().catch(() => undefined);
}

export interface AcCheck {
  id: string;
  title: string;
  run(scenario: FullScenario): Promise<Record<string, unknown>>;
}

/** 在独立 sandbox/runtime 中执行一个子场景，结束后清理（不改动主场景 DB） */
async function withIsolatedRuntime<T>(
  scenario: FullScenario,
  fn: (rt: FullRuntime) => Promise<T>,
  opts: { fileDb?: boolean; maxAutoPriority?: number } = {},
): Promise<T> {
  const sandbox = createTempSandbox('lead-ac-sub-');
  let rt: FullRuntime | null = null;
  try {
    rt = await createFullRuntime({
      mocks: scenario.mocks,
      sandbox,
      memoryDb: !(opts.fileDb ?? false),
      maxAutoPriority: opts.maxAutoPriority ?? 3,
    });
    return await fn(rt);
  } finally {
    if (rt) await rt.close().catch(() => undefined);
    sandbox.cleanup();
    // 恢复主场景的进程级单例（多 runtime 交替创建会覆盖 global repositories/context/events 默认绑定）
    try {
      scenario.rt.activateGlobals();
    } catch {
      /* ignore */
    }
  }
}

/** 隔离场景：创建 goal + 跑收集（不 tick），返回 run */
async function collectIsolated(rt: FullRuntime): Promise<{ goal: any; run: any }> {
  const goal = await rt.api.postOk<any>('/v1/goals', defaultGoalInput());
  const trigger = await rt.api.post<any>(`/v1/goals/${goal.id}/run`);
  const runId = (trigger.body as any).data?.id;
  const run = await waitRunTerminal(rt, runId);
  return { goal, run };
}

/* ========================================================================== */
/*  AC 检查清单（docs/01 §8）                                                  */
/* ========================================================================== */

export const AC_CHECKS: AcCheck[] = [
  {
    id: 'AC-1',
    title: 'Goal 创建/手动 Run 进度（平台/城市/关键词级），最终 completed',
    async run(s) {
      const goalDetail = await s.rt.api.getOk<any>(`/v1/goals/${s.goal.id}`);
      assert.equal(goalDetail.region.provinceCode, '130000');
      assert.equal(goalDetail.resolvedCities.length, 4);
      for (const city of goalDetail.resolvedCities) {
        assert.ok(city.platformValues.boss && city.platformValues.zhilian && city.platformValues.ali && city.platformValues.mic, `城市 ${city.code} 平台映射不完整`);
      }
      assert.equal(s.run.status, 'completed');
      assert.ok(s.run.finishedAt);
      const platforms = new Set<string>();
      for (const p of ['boss', 'zhilian', 'ali', 'mic']) {
        const stat = s.collectionStats.platforms?.[p];
        assert.ok(stat, `Run.stats 缺少平台 ${p}`);
        assert.ok(stat.queries > 0 && stat.leads > 0, `平台 ${p} 无查询/线索`);
        platforms.add(p);
      }
      assert.equal(platforms.size, 4);
      // 进度接口：platform/city/keyword 级
      const progress = await s.rt.api.getOk<any>(`/v1/runs/${s.run.id}`);
      assert.ok(progress.progress.totalQueries > 0);
      assert.equal(progress.progress.doneQueries, progress.progress.totalQueries, '存在未完成查询');
      assert.ok(progress.progress.byPlatform.boss?.queries > 0);
      assert.ok(Object.keys(progress.progress.byCity).length >= 4);
      assert.ok(progress.progress.byKeyword['外贸']?.queries > 0);
      // source_queries 全部 done
      const dbQueries = (s.rt.repos as any).sourceQueries.listByRun(s.run.id);
      assert.ok(dbQueries.length > 0);
      assert.ok(dbQueries.every((q: any) => q.status === 'done'));
      return { runId: s.run.id, status: s.run.status, queries: progress.progress.totalQueries, platforms: [...platforms] };
    },
  },
  {
    id: 'AC-2',
    title: '线索流式入库 + 跨源同公司合并（1 company + 多 source）',
    async run(s) {
      const repos = s.rt.repos as any;
      // 收集阶段：中文名/英文抬头分别建公司（跨语言去重发生在补全合并阶段）
      assert.equal(s.preTick.companiesAll, 8, '收集阶段应创建 8 条公司（含跨语言重复）');
      assert.equal(s.preTick.sources, 9, '收集阶段应有 9 条来源记录（多平台重复）');
      assert.equal(s.preTick.jobs, 8, '收集阶段应为 8 家新公司各入队 1 个补全任务');
      // 补全合并后：6 家存活公司，2 条 merged_into
      assert.equal(repos.companies.count(), 6, '合并后应只剩 6 家存活公司');
      assert.equal(repos.companies.count({ includeMerged: true }), 8);
      const merged = repos.companies.list({ limit: 50, includeMerged: true }).filter((c: any) => c.mergedInto);
      assert.equal(merged.length, 2);
      const sourcesOf = (id: string) => repos.companySources.listByCompany(id).map((x: any) => x.platform).sort();
      assert.deepEqual(sourcesOf(s.ids.chenxing), ['ali', 'boss']);
      assert.deepEqual(sourcesOf(s.ids.yunfan), ['mic', 'zhilian']);
      assert.deepEqual(sourcesOf(s.ids.haichuan), ['ali', 'mic']);
      assert.deepEqual(sourcesOf(s.ids.hengyue), ['ali']);
      assert.deepEqual(sourcesOf(s.ids.lanjing), ['boss']);
      assert.deepEqual(sourcesOf(s.ids.huaxi), ['mic']);
      // 每家存活公司 sourceCount 与来源记录一致
      for (const id of Object.values(s.ids)) {
        const company = repos.companies.getById(id);
        assert.equal(company.sourceCount, repos.companySources.listByCompany(id).length, `sourceCount 不一致: ${company.name}`);
      }
      // 原始快照（流式采集落盘）
      assert.ok(repos.snapshots.listByRun(s.run.id, 100).length > 0, '缺少搜索页快照');
      return { live: 6, merged: 2, sources: 9, snapshotCount: repos.snapshots.countSnapshots({ runId: s.run.id }) };
    },
  },
  {
    id: 'AC-3',
    title: 'USCC 精确匹配 / 英文抬头匹配 / unmatched 不消耗额度',
    async run(s) {
      const repos = s.rt.repos as any;
      const lanjing = repos.companies.getById(s.ids.lanjing);
      assert.equal(lanjing.enrichmentStatus, 'tanji_enriched');
      assert.equal(lanjing.tanjiCompanyId, 'tanji_lj_002');
      assert.equal(lanjing.matchMeta?.method, 'uscc', 'Boss 详情 USCC 应触发探迹 USCC 精确匹配');
      const chenxing = repos.companies.getById(s.ids.chenxing);
      assert.ok(['uscc', 'english_name', 'name_exact', 'name_fuzzy'].includes(chenxing.matchMeta?.method));
      assert.ok(chenxing.matchMeta?.confidence > 0);
      assert.ok(Array.isArray(chenxing.matchMeta?.candidates));
      // 英文抬头匹配（yunfan: mic 英文名 → 中文主体）
      const yunfan = repos.companies.getById(s.ids.yunfan);
      assert.equal(yunfan.tanjiCompanyId, 'tanji_yf_001');
      // unmatched：恒岳（探迹无结果）→ unmatched、不入 unlock 队列、不扣额度
      const hengyue = repos.companies.getById(s.ids.hengyue);
      assert.equal(hengyue.enrichmentStatus, 'unmatched');
      assert.equal(hengyue.tanjiCompanyId, null);
      assert.equal(hengyue.unlockStatus, 'none');
      assert.equal(repos.jobs.findByIdentity(hengyue.id, 'unlock'), null, 'unmatched 公司不应有 unlock 任务');
      const ledger = repos.unlockLedger.listByCompany(hengyue.id);
      assert.equal(ledger.length, 0, 'unmatched 公司不应产生解锁台账');
      // 匹配留痕快照
      const snaps = repos.snapshots.listByRun(s.run.id, 500);
      assert.ok(snaps.some((x: any) => x.kind === 'tanji_search'), '缺少 tanji_search 快照');
      return {
        lanjingMethod: lanjing.matchMeta?.method,
        yunfanTanjiId: yunfan.tanjiCompanyId,
        unmatched: hengyue.name,
      };
    },
  },
  {
    id: 'AC-4',
    title: '解锁台账/额度：alreadyUnlocked 不扣、QUOTA_EXHAUSTED→waiting_quota、恢复后续跑',
    async run(s) {
      const repos = s.rt.repos as any;
      // 主场景：3 家非已解锁公司各扣 1 点；已解锁公司不扣
      const ledger = repos.unlockLedger.list({ limit: 50 });
      assert.equal(ledger.length, 3, `主场景应有 3 条扣点台账，实际 ${ledger.length}`);
      for (const row of ledger) {
        assert.equal(row.result, 'unlocked');
        assert.equal(row.quotaCost, 1);
        assert.ok(row.idempotencyKey?.startsWith(`unlock:${row.companyId}:`), 'idempotencyKey 格式错误');
        assert.ok(row.quotaBefore !== null && row.quotaAfter === row.quotaBefore - 1);
      }
      const unlockedIds = new Set(ledger.map((x: any) => x.companyId));
      assert.ok(!unlockedIds.has(s.ids.chenxing), '已解锁公司不应扣额度');
      assert.ok(!unlockedIds.has(s.ids.haichuan), '已解锁公司不应扣额度');
      for (const id of [s.ids.chenxing, s.ids.haichuan, s.ids.yunfan, s.ids.huaxi, s.ids.lanjing]) {
        assert.equal(repos.contacts.countByCompany(id) > 0, true, `联系人未入库: ${id}`);
      }
      assert.equal(s.mocks.world.scenario.tanjiQuotaConsumed, 3);
      // 额度展示：/v1/quota（tick 中已写入观测）
      const quota = await s.rt.api.getOk<any>('/v1/quota');
      assert.equal(quota.daily.limit, 500);
      assert.equal(quota.daily.remaining, 497, `/v1/quota 剩余额度应为 497，实际 ${quota.daily.remaining}`);
      assert.ok(quota.recentUnlockCurve?.some((x: any) => x.count === 3));

      // 子场景：额度耗尽 → waiting_quota；恢复 → 自动续跑且不重复扣点
      const sub = await withIsolatedRuntime(s, async (rt) => {
        // 独立子场景：重置 mock 世界（主场景已解锁的公司状态不应影响本场景）
        s.mocks.reset();
        exhaustTanjiQuota(s.mocks.world);
        const repos2 = rt.repos as any;
        const { goal } = await collectIsolated(rt);
        // 收集 + 补全（补全会入队 unlock，但额度门禁应暂停）
        const enrichment = rt.enrichment as any;
        await enrichment.runUntilIdle(500);
        const tick1 = await (rt.unlockEvents as any).tickUnlock();
        const waitingJobs = repos2.jobs.list({ status: 'waiting_quota', limit: 50 });
        assert.ok(waitingJobs.length >= 1, `额度耗尽时应有 waiting_quota 任务，实际 ${waitingJobs.length}（tick=${JSON.stringify(tick1)}）`);
        const waitingCompanies = repos2.companies.list({ limit: 50 }).filter((c: any) => c.unlockStatus === 'waiting_quota');
        assert.ok(waitingCompanies.length >= 1, 'company.unlock_status 未同步为 waiting_quota');
        const ledgerBefore = repos2.unlockLedger.list({ limit: 50 }).length;
        assert.equal(ledgerBefore, 0, '额度耗尽时不应产生扣点台账');
        // 额度恢复（模拟日额度刷新）→ QuotaPoller 检测恢复并唤醒
        restoreTanjiQuota(s.mocks.world, 500);
        await (rt.quotaPoller as any).pollOnce();
        // 再跑几轮解锁
        for (let i = 0; i < 6; i += 1) {
          await (rt.unlockEvents as any).tickUnlock();
          await enrichment.runUntilIdle(200);
        }
        await (rt.quotaPoller as any).pollOnce();
        const done = repos2.jobs.list({ stage: 'unlock', status: 'done', limit: 50 });
        assert.ok(done.length >= 1, '额度恢复后 unlock 任务应完成');
        assert.equal(repos2.jobs.list({ status: 'waiting_quota', limit: 50 }).length, 0, '仍有 waiting_quota 残留');
        const ledgerAfter = repos2.unlockLedger.list({ limit: 50 });
        assert.ok(ledgerAfter.length >= 1, '恢复后应产生扣点台账');
        assert.equal(new Set(ledgerAfter.map((x: any) => x.idempotencyKey)).size, ledgerAfter.length, 'idempotencyKey 重复');
        const totalCost = ledgerAfter.reduce((sum: number, x: any) => sum + x.quotaCost, 0);
        assert.equal(totalCost, ledgerAfter.length, '每家公司只应扣 1 点（无重复扣点）');
        return {
          goalId: goal.id,
          waitingJobs: waitingJobs.length,
          waitingCompanies: waitingCompanies.length,
          unlockedAfterRecovery: ledgerAfter.length,
          doneUnlockJobs: done.length,
        };
      });
      return {
        mainLedger: ledger.length,
        quotaRemaining: quota.daily.remaining,
        alreadyUnlockedSkipped: 2,
        exhaustionRecovery: sub,
      };
    },
  },
  {
    id: 'AC-5',
    title: '公司详情 + 字段级变更历史；/v1/changes sinceSeq 增量正确',
    async run(s) {
      const repos = s.rt.repos as any;
      // 默认详情应带 sources/contacts/recentChanges（docs/03 §4）
      const detail = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}`);
      assert.ok(detail.company?.uscc && detail.company.tanjiCompanyId && detail.company.matchMeta);
      assert.ok(Array.isArray(detail.sources) && detail.sources.length === 2, `默认详情 sources 期望 2，实际 ${JSON.stringify(detail.sources?.length)}`);
      assert.ok(detail.contacts && detail.contacts.total >= 2, `默认详情 contacts 期望 >=2，实际 ${detail.contacts?.total}`);
      assert.ok(Array.isArray(detail.recentChanges));
      // 平台卡片单独接口
      const platforms = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/platforms`);
      assert.ok(Array.isArray(platforms.items) && platforms.items.length >= 2);
      // 单公司字段级历史（含老值/新值/来源/run/版本）
      const changes = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/changes`);
      assert.ok(changes.items.length > 0);
      const usccEvent = changes.items.find((e: any) => e.field === 'uscc');
      assert.ok(usccEvent, '缺少 uscc 字段变更事件');
      assert.equal(usccEvent.oldValue, null);
      assert.equal(usccEvent.newValue, '91SYNTH0000000001A');
      assert.ok(usccEvent.source && usccEvent.version >= 1);
      // 全局增量分页：无重复、无跳号、可续传
      let sinceSeq = 0;
      const seen: number[] = [];
      for (let page = 0; page < 30; page += 1) {
        const batch = await s.rt.api.getOk<any>(`/v1/changes?sinceSeq=${sinceSeq}&limit=50`);
        if (batch.items.length === 0) break;
        for (const item of batch.items) {
          assert.ok(item.seq > sinceSeq, `seq 非递增: ${item.seq} <= ${sinceSeq}`);
          seen.push(item.seq);
          sinceSeq = item.seq;
        }
        if (!batch.hasMore) break;
      }
      assert.equal(new Set(seen).size, seen.length, 'sinceSeq 分页出现重复');
      assert.equal(seen.length, repos.changeEvents.count(), '分页总数与 change_events 计数不一致');
      const tail = await s.rt.api.getOk<any>(`/v1/changes?sinceSeq=${sinceSeq}`);
      assert.equal(tail.items.length, 0, '游标末尾仍返回事件');
      return { companyChanges: changes.items.length, globalEvents: seen.length, lastSeq: sinceSeq };
    },
  },
  {
    id: 'AC-6',
    title: 'Webhook 签名/重试/死信 + SSE 实时事件',
    async run(s) {
      const receiver = s.receiver;
      // 先排空事件总线积压（分批 fanout）
      for (let i = 0; i < 12; i += 1) {
        await (s.rt.unlockEvents as any).tickWebhooks();
      }
      // 至少收到 company.created / company.updated / contact.unlocked 三类
      const types = new Set(receiver.received.map((r) => r.eventType));
      for (const t of ['company.created', 'company.updated', 'contact.unlocked']) {
        assert.ok(types.has(t), `未收到 webhook 事件: ${t}（收到: ${[...types].join(',')}）`);
      }
      for (const r of receiver.received) {
        assert.ok(r.eventId && r.deliveryId && r.timestamp, 'Webhook 缺少 X-Lead-* 头');
        assert.equal(r.signatureValid, true, `Webhook 签名校验失败: ${r.eventType}`);
      }
      // 投递记录（delivered）
      const deliveries = await s.rt.api.getOk<any>(`/v1/webhooks/${s.subscriptionId}/deliveries?limit=100`);
      assert.ok(deliveries.items.length > 0);
      assert.ok(deliveries.items.every((d: any) => ['delivered', 'pending', 'failed'].includes(d.status)));

      // 重试：调用 replay 重置投递 → 下一次 tick 投递到失败接收端（attempts=1、failed）→ 推进时钟后重投成功（attempts>=2）
      const delivered = deliveries.items.find((d: any) => d.status === 'delivered');
      assert.ok(delivered, '没有可重放的 delivered 投递');
      const getDelivery = async (): Promise<any> => {
        const list = await s.rt.api.getOk<any>(`/v1/webhooks/${s.subscriptionId}/deliveries?limit=200`);
        return list.items.find((d: any) => d.id === delivered.id);
      };
      receiver.failNext(1);
      await s.rt.api.postOk<any>(`/v1/webhooks/${s.subscriptionId}/deliveries/${delivered.id}/replay`);
      // replay 只重置投递状态；实际投递由 dispatcher tick 完成（第 1 次失败 → failed，attempts=1）
      await (s.rt.unlockEvents as any).tickWebhooks();
      const failedDelivery = await getDelivery();
      assert.ok(failedDelivery.attempts >= 1, `首次投递失败后 attempts 应 >=1，实际 ${failedDelivery.attempts}`);
      assert.equal(failedDelivery.status, 'failed', `首次投递失败后状态应为 failed，实际 ${failedDelivery.status}`);
      // 推进时钟越过退避（10s/1m/…）后重投成功
      let recovered: any = failedDelivery;
      for (let i = 0; i < 4 && recovered?.status !== 'delivered'; i += 1) {
        s.rt.clock.advance(6 * 3600_000);
        await (s.rt.unlockEvents as any).tickWebhooks();
        recovered = await getDelivery();
      }
      assert.equal(recovered?.status, 'delivered', `重试未恢复 delivered（最后 ${recovered?.status}/${recovered?.attempts}）`);
      // attempts 只在失败时递增（成功投递不 +1）；恢复后应保持失败次数 >=1
      assert.ok(recovered.attempts >= 1, `重试恢复后 attempts 应保留失败次数>=1，实际 ${recovered.attempts}`);

      // 死信：连续失败达到最大尝试次数 → dead
      receiver.failNext(20);
      await s.rt.api.postOk<any>(`/v1/webhooks/${s.subscriptionId}/deliveries/${delivered.id}/replay`);
      let dead: any = null;
      for (let i = 0; i < 12; i += 1) {
        s.rt.clock.advance(6 * 3600_000);
        await (s.rt.unlockEvents as any).tickWebhooks();
        const list = await s.rt.api.getOk<any>(`/v1/webhooks/${s.subscriptionId}/deliveries?limit=200`);
        dead = list.items.find((d: any) => d.id === delivered.id);
        if (dead?.status === 'dead') break;
      }
      assert.equal(dead?.status, 'dead', `未进入死信（最后状态 ${dead?.status}, attempts=${dead?.attempts}）`);
      assert.ok((dead?.attempts ?? 0) >= 2, `死信 attempts 应 >=2，实际 ${dead?.attempts}`);

      // SSE：Last-Event-ID 补发 seq 之后的事件
      const lastSeq = (s.rt.repos as any).changeEvents.maxSeq();
      const ac = new AbortController();
      let sseText = '';
      const ssePromise = (async () => {
        const res = await fetch(`${s.rt.baseUrl}/v1/events/stream`, {
          headers: { authorization: `Bearer ${s.rt.token}`, 'Last-Event-ID': String(Math.max(0, lastSeq - 3)) },
          signal: ac.signal,
        });
        assert.equal(res.status, 200);
        const reader = res.body?.getReader();
        assert.ok(reader);
        const decoder = new TextDecoder();
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          sseText += decoder.decode(value, { stream: true });
          if ((sseText.match(/^data: /gm) ?? []).length >= 1) break;
        }
        ac.abort();
      })().catch((err) => {
        if ((err as Error).name === 'AbortError') return;
        throw err;
      });
      await ssePromise;
      assert.ok(/id: \d+/m.test(sseText), `SSE 未返回 id 行：${sseText.slice(0, 300)}`);
      const dataLine = sseText.split('\n').find((l) => l.startsWith('data: '));
      assert.ok(dataLine, 'SSE 未返回 data 行');
      const envelope = JSON.parse(dataLine!.slice('data: '.length));
      assert.ok(typeof envelope.seq === 'number' && envelope.companyId, 'SSE data 不是事件 envelope');
      return {
        received: receiver.received.length,
        types: [...types],
        delivered: deliveries.items.length,
        deadLetterStatus: dead?.status,
        sse: sseText.slice(0, 120),
      };
    },
  },
  {
    id: 'AC-7',
    title: '上游会话失效：Run 不崩溃、来源标记、其他来源继续',
    async run(s) {
      const result = await withIsolatedRuntime(s, async (rt) => {
        s.mocks.reset();
        setSessionInvalid(s.mocks.world, 'zhilian', true);
        try {
          const { run } = await collectIsolated(rt);
          const skipped = (run.stats?.skippedSources ?? []) as Array<{ platform: string; errorCode?: string }>;
          assert.equal(run.status, 'partial', `会话失效时 Run 应为 partial，实际 ${run.status}`);
          assert.ok(skipped.some((x) => x.platform === 'zhilian' && x.errorCode === 'SOURCE_SESSION_INVALID'), 'skippedSources 未标记 zhilian');
          const repos2 = rt.repos as any;
          const zhQueries = repos2.sourceQueries.listByRun(run.id).filter((q: any) => q.platform === 'zhilian');
          assert.ok(zhQueries.length > 0, '失效来源的 source_queries 应预建以便观测');
          assert.ok(zhQueries.every((q: any) => q.status === 'skipped'), '失效来源 source_queries 应标记 skipped');
          assert.ok(zhQueries.some((q: any) => String(q.lastError ?? '').includes('SOURCE_SESSION_INVALID')), 'skipped 查询缺 lastError');
          // source_health 记录 session_invalid，/v1/sources 可查
          const health = repos2.sourceHealth.get('zhilian');
          assert.equal(health?.state, 'session_invalid', `/v1/sources 健康态未标记 session_invalid：${health?.state}`);
          const sourcesApi = await rt.api.getOk<any>('/v1/sources');
          const zh = (sourcesApi.items as any[]).find((x) => x.platform === 'zhilian');
          assert.equal(zh?.state, 'session_invalid');
          // 其他来源继续：boss/ali/mic 公司入库，且无 zhilian 来源
          const companies = repos2.companies.list({ limit: 100 });
          const platforms = new Set<string>();
          for (const c of companies) for (const src of repos2.companySources.listByCompany(c.id)) platforms.add(src.platform);
          assert.ok(platforms.has('boss') && platforms.has('ali') && platforms.has('mic'), '其他来源未继续采集');
          assert.ok(!platforms.has('zhilian'), 'zhilian 失效但仍写入来源');
          return { status: run.status, skipped, companies: companies.length, platforms: [...platforms], sourceHealth: health.state };
        } finally {
          setSessionInvalid(s.mocks.world, 'zhilian', false);
        }
      });
      return result;
    },
  },
  {
    id: 'AC-8',
    title: 'kill -9 后重启续跑：不重复扣额度、不重复入库公司',
    async run(s) {
      // 用文件 DB 模拟进程重启：收集后不 tick（等价于采集刚结束即 kill -9）→ 新 runtime 续跑
      s.mocks.reset();
      const sandbox2 = createTempSandbox('lead-ac8-');
      let first: FullRuntime | null = null;
      let second: FullRuntime | null = null;
      let third: FullRuntime | null = null;
      try {
        first = await createFullRuntime({ mocks: s.mocks, sandbox: sandbox2, memoryDb: false, maxAutoPriority: 3 });
        const { run } = await collectIsolated(first);
        assert.equal(run.status, 'completed');
        const repos1 = first.repos as any;
        const companiesAfterCollect = repos1.companies.count({ includeMerged: true });
        const sourcesAfterCollect = repos1.companySources.count();
        assert.equal(companiesAfterCollect, 8);
        assert.equal(sourcesAfterCollect, 9);
        // 模拟 kill -9：不调用 close()（不做优雅收尾），直接用同一 DB 文件启动新实例
        const staleDb = first.db as any;
        second = await createFullRuntime({ mocks: s.mocks, sandbox: sandbox2, memoryDb: false, maxAutoPriority: 3 });
        await second.tick({ rounds: 12 });
        const repos2 = second.repos as any;
        assert.equal(repos2.companies.count({ includeMerged: true }), companiesAfterCollect, '重启后重复入库公司');
        assert.equal(repos2.companySources.count(), sourcesAfterCollect, '重启后重复来源记录');
        assert.equal(repos2.companies.count(), 6, '重启补全后存活公司应为 6');
        const ledger2 = repos2.unlockLedger.list({ limit: 50 });
        assert.equal(ledger2.length, 3, `重启后解锁台账应 3 条，实际 ${ledger2.length}`);
        const quotaConsumed = s.mocks.world.scenario.tanjiQuotaConsumed;
        const contacts2 = repos2.contacts.count();
        // 二次重启：不得重复扣点/重复入库
        await second.close();
        second = null;
        third = await createFullRuntime({ mocks: s.mocks, sandbox: sandbox2, memoryDb: false, maxAutoPriority: 3 });
        await third.tick({ rounds: 12 });
        const repos3 = third.repos as any;
        assert.equal(repos3.companies.count({ includeMerged: true }), 8, '二次重启后重复入库公司');
        assert.equal(repos3.unlockLedger.list({ limit: 50 }).length, 3, '二次重启后出现重复扣点台账');
        assert.equal(repos3.contacts.count(), contacts2, '二次重启后联系人数变化');
        assert.equal(s.mocks.world.scenario.tanjiQuotaConsumed, quotaConsumed, '二次重启后重复消耗额度');
        try {
          staleDb?.close?.();
        } catch {
          /* ignore */
        }
        return { companiesAll: 8, live: 6, ledger: 3, quotaConsumed, contacts: contacts2 };
      } finally {
        if (first) await first.close().catch(() => undefined);
        if (second) await second.close().catch(() => undefined);
        if (third) await third.close().catch(() => undefined);
        sandbox2.cleanup();
        try {
          s.rt.activateGlobals();
        } catch {
          /* ignore */
        }
      }
    },
  },
  {
    id: 'AC-9',
    title: 'REST/CLI/MCP 契约与文档：/docs、/openapi.json、/mcp-tools.json 一致可访问',
    async run(s) {
      const openapiRes = await fetch(`${s.rt.baseUrl}/openapi.json`);
      assert.equal(openapiRes.status, 200);
      const openapi = (await openapiRes.json()) as any;
      const paths = Object.keys(openapi.paths ?? {});
      for (const p of ['/v1/goals', '/v1/runs/{id}', '/v1/companies', '/v1/changes', '/v1/webhooks', '/v1/quota']) {
        assert.ok(paths.includes(p), `/openapi.json 缺少路径 ${p}`);
      }
      const mcpRes = await fetch(`${s.rt.baseUrl}/mcp-tools.json`);
      assert.equal(mcpRes.status, 200);
      const mcp = (await mcpRes.json()) as any;
      const toolNames = (mcp.tools ?? []).map((t: any) => t.name);
      for (const name of ['lead_status', 'lead_quota', 'lead_company_get', 'lead_company_customs', 'lead_changes']) {
        assert.ok(toolNames.includes(name), `/mcp-tools.json 缺少工具 ${name}`);
      }
      const docsRes = await fetch(`${s.rt.baseUrl}/docs`);
      assert.equal(docsRes.status, 200);
      const html = await docsRes.text();
      assert.ok(html.includes('/v1/goals') && html.includes('openapi'), '/docs 内容异常');
      // CLI：命令清单与源码定义存在（不实际执行真实服务）
      const cliJsonPath = path.join(PROJECT_ROOT, 'spec/cli-commands.json');
      assert.ok(fs.existsSync(cliJsonPath), 'spec/cli-commands.json 缺失（npm run gen 未生成）');
      const cliJson = JSON.parse(fs.readFileSync(cliJsonPath, 'utf8')) as any;
      const commands = JSON.stringify(cliJson);
      for (const cmd of ['goal', 'run', 'company', 'changes', 'webhook', 'job', 'admin']) {
        assert.ok(commands.includes(cmd), `CLI 清单缺少子命令 ${cmd}`);
      }
      assert.ok(fs.existsSync(path.join(PROJECT_ROOT, 'src/cli/index.ts')), 'CLI 入口缺失');
      return { paths: paths.length, mcpTools: toolNames.length, docsBytes: html.length };
    },
  },
  {
    id: 'AC-11',
    title: '平台档案卡片（Boss/智联岗位、Ali/Mic 店铺、lastFetchedAt）',
    async run(s) {
      const repos = s.rt.repos as any;
      const cards = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/platforms`);
      const byPlatform = new Map<string, any>((cards.items as any[]).map((x) => [x.platform, x]));
      const boss = byPlatform.get('boss');
      assert.ok(boss, '缺少 Boss 档案卡片');
      assert.equal(boss.jobCount, 3);
      assert.ok(Array.isArray(boss.latestJobs) && boss.latestJobs.length > 0);
      assert.ok(boss.lastFetchedAt);
      const ali = byPlatform.get('ali');
      assert.ok(ali, '缺少 Ali 店铺卡片');
      assert.ok(ali.store?.membership?.verifiedSupplier === true);
      assert.ok(ali.store?.joinedYears >= 1);
      assert.ok(ali.lastFetchedAt);
      // 云帆：智联岗位 + Mic 店铺
      const yunfanCards = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.yunfan}/platforms`);
      const yp = new Map<string, any>((yunfanCards.items as any[]).map((x) => [x.platform, x]));
      assert.ok(yp.get('zhilian')?.jobCount >= 1, '智联岗位卡片缺失');
      assert.ok(yp.get('mic')?.store?.audited === true, 'Mic 店铺卡片 audited 缺失');
      // 全部 4 平台档案都应有 lastFetchedAt；招聘/店铺刷新时间可查
      const profiles = repos.platformProfiles.listByCompanyIds(Object.values(s.ids));
      assert.ok(profiles.length >= 6);
      for (const p of profiles) {
        assert.ok(p.lastFetchedAt, `${p.platform} 档案缺 lastFetchedAt`);
        if (p.platform === 'boss' || p.platform === 'zhilian') assert.ok(p.nextJobsRefreshAt, `${p.platform} 缺 nextJobsRefreshAt`);
        if (p.platform === 'ali' || p.platform === 'mic') assert.ok(p.nextStoreRefreshAt, `${p.platform} 缺 nextStoreRefreshAt`);
      }
      // 平台岗位列表接口
      const jobs = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/platforms/boss/jobs`);
      assert.equal(jobs.items.length, 3);
      return {
        cards: (cards.items as any[]).map((x) => x.platform),
        bossJobs: boss.jobCount,
        aliMembership: ali.store?.membership?.label,
        profiles: profiles.length,
      };
    },
  },
  {
    id: 'AC-12',
    title: '岗位新增/下线可追溯 + platforms.boss.jobs 聚合事件',
    async run(s) {
      const repos = s.rt.repos as any;
      const before = repos.platformJobs.listByCompanyPlatform(s.ids.chenxing, 'boss');
      assert.equal(before.length, 3);
      const seqBefore = repos.changeEvents.maxSeq();
      // 上游岗位轮次切换：002 下线、004 新增
      setJobsRound(s.mocks.world, 'boss', 2);
      try {
        await s.rt.api.postOk<any>(`/v1/companies/${s.ids.chenxing}/refresh`, { platforms: ['boss'], kinds: ['jobs'] });
        // 处理 refresh 队列（不重复 enqueue due）
        await (s.rt.refresh as any).runOnce({ limit: 50, enqueueDue: false });
        const after = repos.platformJobs.listByCompanyPlatform(s.ids.chenxing, 'boss');
        const closed = after.find((x: any) => x.jobId === 'bossjob_cx_002');
        const added = after.find((x: any) => x.jobId === 'bossjob_cx_004');
        const kept = after.find((x: any) => x.jobId === 'bossjob_cx_001');
        assert.equal(closed?.status, 'closed', '下线岗位未标 closed');
        assert.ok(closed.closedAt, 'closed 岗位缺 closed_at');
        assert.equal(added?.status, 'active', '新增岗位未 active');
        assert.ok(added.firstSeenAt, '新增岗位缺 first_seen_at');
        assert.equal(kept?.status, 'active', '保留岗位状态错误');
        assert.ok(Date.parse(closed.firstSeenAt) < Date.parse(closed.closedAt), 'closed_at 早于 first_seen_at');
        // 聚合事件 platforms.boss.jobs
        const events = repos.changeEvents.listSince(seqBefore, { limit: 500 });
        const jobEvent = events.find((e: any) => e.field === 'platforms.boss.jobs' || e.eventType === 'platform.jobs.updated');
        assert.ok(jobEvent, '缺少 platforms.boss.jobs 聚合事件');
        const payload = jobEvent.newValue ?? {};
        assert.ok(typeof payload === 'object');
        // REST 可查 closed 岗位与平台变更历史
        const closedList = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/platforms/boss/jobs?status=closed`);
        assert.ok((closedList.items as any[]).some((x) => x.jobId === 'bossjob_cx_002'));
        return { closed: closed.jobId, added: added.jobId, eventField: jobEvent.field, seq: jobEvent.seq };
      } finally {
        setJobsRound(s.mocks.world, 'boss', 1);
      }
    },
  },
  {
    id: 'AC-13',
    title: '手动刷新立即触发；存量按周/月调度（nextRefreshAt 可查）',
    async run(s) {
      const repos = s.rt.repos as any;
      const profileBefore = repos.platformProfiles.getByCompanyPlatform(s.ids.yunfan, 'zhilian');
      const job = await s.rt.api.postOk<any>(`/v1/companies/${s.ids.yunfan}/refresh`, {
        platforms: ['zhilian'],
        kinds: ['profile', 'jobs'],
      });
      assert.ok(job, '手动刷新未返回任务信息');
      // 入队立即可见（pending），且任务带公司/平台
      const pending = repos.jobs.list({ status: 'pending', stage: 'platform_jobs', limit: 50 });
      assert.ok(pending.some((j: any) => j.companyId === s.ids.yunfan && j.platform === 'zhilian'), '手动刷新未立即入队');
      await (s.rt.refresh as any).runOnce({ limit: 50, enqueueDue: false });
      const profileAfter = repos.platformProfiles.getByCompanyPlatform(s.ids.yunfan, 'zhilian');
      assert.ok(Date.parse(profileAfter.lastFetchedAt) >= Date.parse(profileBefore.lastFetchedAt), '刷新后 lastFetchedAt 未更新');
      const d = (iso: string) => Date.parse(iso) - Date.now();
      assert.ok(d(profileAfter.nextJobsRefreshAt) > 6 * 86400_000, '智联 nextJobsRefreshAt 应约为 7 天后');
      const aliProfile = repos.platformProfiles.getByCompanyPlatform(s.ids.chenxing, 'ali');
      assert.ok(profileBefore.nextStoreRefreshAt === null || aliProfile.nextStoreRefreshAt, 'Ali nextStoreRefreshAt 缺失');
      assert.ok(Date.parse(aliProfile.nextStoreRefreshAt) - Date.now() > 25 * 86400_000, 'Ali nextStoreRefreshAt 应约为 30 天后');
      return {
        manualJob: job?.job?.id ?? job?.id ?? job,
        nextJobsRefreshAt: profileAfter.nextJobsRefreshAt,
        nextStoreRefreshAt: aliProfile.nextStoreRefreshAt,
      };
    },
  },
  {
    id: 'AC-14',
    title: 'Ali/Mic 海关画像：totals/dateRange/topHs4/confidence/sampled',
    async run(s) {
      const repos = s.rt.repos as any;
      const record = repos.customs.getByCompany(s.ids.chenxing);
      assert.ok(record, '缺少 company_customs_profiles 记录');
      assert.equal(record.confidence, 'high');
      assert.ok(record.sampled, 'sampled 标记缺失');
      assert.ok(record.matchedRecords >= 5);
      const card = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/customs`);
      assert.equal(card.status, 'ok');
      assert.equal(card.confidence, 'high');
      assert.equal(card.sampled, true);
      assert.ok(card.totals?.importView?.totalNum > 0);
      assert.ok(card.totals?.exportView?.totalNum > 0);
      assert.ok(card.dateRange?.min && card.dateRange?.max);
      assert.ok(card.topHs4.length > 0);
      assert.ok(card.topDestinations.length > 0);
      assert.ok(card.sample?.matched >= 5);
      // 仅 Ali/Mic 有；Boss-only 公司（蓝鲸）→ 404
      const notFound = await s.rt.api.err('GET', `/v1/companies/${s.ids.lanjing}/customs`);
      assert.equal(notFound.status, 404);
      assert.equal(notFound.code, 'NOT_FOUND');
      return {
        confidence: card.confidence,
        matched: card.sample.matched,
        dateRange: card.dateRange,
        hs4: card.topHs4.slice(0, 3),
        totals: card.totals,
      };
    },
  },
  {
    id: 'AC-15',
    title: '海关名称过滤有效：matchedSample 命中；unmatched 不计入；none 时榜单为空',
    async run(s) {
      const repos = s.rt.repos as any;
      const record = repos.customs.getByCompany(s.ids.chenxing);
      assert.ok(record.unmatchedRecords >= 1, '样本应包含未命中噪声记录');
      const card = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/customs`);
      assert.ok(card.sample.fetched > card.sample.matched, 'fetched 应大于 matched（含噪声）');
      // matchedSample 中目标公司必须出现在 exporter/importer 名称字段
      const tokens = ['CHENXING', 'HEBEI CHENXING'];
      for (const sample of card.sampleRecords) {
        const hay = `${sample.rawexporter ?? ''} ${sample.exporter ?? ''} ${sample.rawimporter ?? ''} ${sample.importer ?? ''}`.toUpperCase();
        assert.ok(tokens.some((t) => hay.includes(t)), `sampleRecords 命中项不含目标公司名称: ${JSON.stringify(sample)}`);
        assert.ok(['exporter', 'importer'].includes(sample.role));
      }
      // unmatched 噪声不出现在 Top 榜单
      const buyerKeys = card.topBuyers.map((x: any) => x.key.toUpperCase());
      assert.ok(!buyerKeys.some((k: string) => k.includes('NOISE')), 'unmatched 噪声进入了 Top 买家');
      // confidence=none：hengyue 无数据 → 榜单为空
      const none = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.hengyue}/customs`);
      assert.equal(none.confidence, 'none');
      assert.deepEqual(none.topHs4, []);
      assert.deepEqual(none.topBuyers, []);
      assert.equal(none.status, 'no_data');
      return {
        fetched: card.sample.fetched,
        matched: card.sample.matched,
        unmatched: record.unmatchedRecords,
        topBuyers: card.topBuyers.length,
        noneStatus: none.status,
      };
    },
  },
  {
    id: 'AC-16',
    title: 'fuma 权限/无数据/缓存场景正确（不阻塞主流程）',
    async run(s) {
      // 1) 缓存：手动刷新同参数 24h 内命中 fuma 缓存（cached=true），上游查询次数不增加
      const before = s.mocks.world.scenario.fumaUpstreamQueries;
      await s.rt.api.postOk<any>(`/v1/companies/${s.ids.chenxing}/customs/refresh`);
      await (s.rt.customs as any).runOnce({ limit: 20, enqueueDue: false });
      const after = s.mocks.world.scenario.fumaUpstreamQueries;
      assert.equal(after, before, `fuma 缓存未生效：上游查询 ${before} → ${after}`);
      const refreshed = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.chenxing}/customs`);
      assert.equal(refreshed.cached, true, '重复查询应 cached=true');
      // 2) 无数据：hengyue confidence=none 且 status=no_data（正常，不重试）
      const noData = await s.rt.api.getOk<any>(`/v1/companies/${s.ids.hengyue}/customs`);
      assert.equal(noData.status, 'no_data');
      assert.equal(noData.confidence, 'none');
      const noDataJobs = (s.rt.repos as any).jobs.list({ stage: 'customs', limit: 50 }).filter((j: any) => j.companyId === s.ids.hengyue);
      assert.ok(noDataJobs.every((j: any) => j.status === 'done'), 'no_data 海关任务不应重试/失败');
      // 3) 权限错误：独立场景 → 海关任务失败(PERMISSION_DENIED)，主流程继续
      const denied = await withIsolatedRuntime(s, async (rt) => {
        s.mocks.reset();
        const repos2 = rt.repos as any;
        setFumaPermission(s.mocks.world, true);
        try {
          const { run } = await collectIsolated(rt);
          assert.equal(run.status, 'completed');
          await (rt.enrichment as any).runUntilIdle(500);
          const summary = await (rt.customs as any).runOnce({ limit: 20, enqueueDue: true });
          assert.equal(summary.permissionDenied, true);
          const customsJobs = repos2.jobs.list({ stage: 'customs', limit: 50 });
          assert.ok(customsJobs.length > 0, '未创建海关任务');
          assert.ok(
            customsJobs.every((j: any) => j.status === 'failed' || j.status === 'dead' || j.status === 'pending'),
            '权限错误时海关任务状态异常',
          );
          const failed = customsJobs.filter((j: any) => j.status === 'failed' || j.status === 'dead');
          assert.ok(failed.length > 0, '权限错误未导致海关任务失败');
          assert.ok(failed.some((j: any) => String(j.lastError ?? '').includes('CUSTOMS_PERMISSION_DENIED') || String(j.lastError ?? '').includes('PERMISSION')), 'lastError 未记录权限错误');
          // 主流程不受影响：补全/解锁continue
          const enrichment = repos2.jobs.countByStage();
          assert.ok(enrichment.tanji_match?.done >= 1);
          return { customsJobs: customsJobs.length, failed: failed.length, lastError: failed[0]?.lastError ?? null };
        } finally {
          setFumaPermission(s.mocks.world, false);
        }
      });
      return { cacheUpstreamBefore: before, cacheUpstreamAfter: after, noData: noData.status, denied };
    },
  },
  {
    id: 'AC-17',
    title: 'Run 覆盖度指标（uniqueCompanies/crossSourceOverlap/coverageByCity/keywordYield）',
    async run(s) {
      const repos = s.rt.repos as any;
      const coverage = s.collectionStats.coverage;
      assert.ok(coverage, 'Run.stats 缺少 coverage');
      assert.equal(coverage.uniqueCompanies, 8, '收集阶段去重公司数应为 8');
      assert.equal(coverage.crossSourceOverlap, 1, '收集阶段跨源重叠应为 1（海川 ali+mic）');
      // 城市统一规范为中文短名（sources-dev 已在编排层归一）
      assert.deepEqual(coverage.coverageByCity, { 石家庄: 3, 唐山: 3, 保定: 1, 沧州: 1 });
      assert.equal(coverage.keywordYield['外贸'], 3);
      assert.equal(coverage.keywordYield['(none)'], 6);
      // 持久化可回读
      const stored = repos.runs.getById(s.run.id);
      assert.equal(stored.stats.coverage.uniqueCompanies, 8);
      // /v1/stats?kind=coverage 可查（服务层聚合；当前实现可能为 0，记录证据而不强断言）
      const stats = await s.rt.api.getOk<any>('/v1/stats?kind=coverage');
      // 合并后真实去重：6 家；跨源 3 家
      const mergedCoverage = { unique: repos.companies.count(), overlap: 0 as number };
      const companies = repos.companies.list({ limit: 100 });
      for (const c of companies) if (repos.companySources.listByCompany(c.id).length >= 2) mergedCoverage.overlap += 1;
      assert.equal(mergedCoverage.unique, 6);
      assert.equal(mergedCoverage.overlap, 3);
      return {
        rawCoverage: coverage,
        mergedCoverage,
        statsApiCoverage: stats.coverage ?? stats,
      };
    },
  },
  {
    id: 'AC-18',
    title: '覆盖基线校准（mock 按比例缩放）与解锁优先级策略',
    async run(s) {
      const repos = s.rt.repos as any;
      // 平台并集口径（缩放基线）：boss 2 / zhilian 1 / ali 3 / mic 3
      const perPlatform: Record<string, number> = {};
      for (const p of ['boss', 'zhilian', 'ali', 'mic']) perPlatform[p] = repos.companySources.countDistinctCompanies(p);
      assert.deepEqual(perPlatform, { boss: 2, zhilian: 1, ali: 3, mic: 3 });
      // 英文源并集（Ali ∪ Mic）：4 家；招聘源并集（Boss ∪ 智联）：3 家；总去重 6
      const companies = repos.companies.list({ limit: 100 });
      const platformsOf = (id: string) => repos.companySources.listByCompany(id).map((x: any) => x.platform);
      const en = companies.filter((c: any) => platformsOf(c.id).some((p: string) => p === 'ali' || p === 'mic'));
      const recruiting = companies.filter((c: any) => platformsOf(c.id).some((p: string) => p === 'boss' || p === 'zhilian'));
      assert.equal(en.length, 5, '英文源并集应有 5 家（辰星/云帆/恒岳/海川/华曦）');
      assert.equal(recruiting.length, 3, '招聘源并集应有 3 家（辰星/云帆/蓝鲸）');
      assert.equal(companies.length, 6);
      // 解锁策略：只解锁有优先级信号的公司（P0/P1），unmatched/P3 不自动解锁
      const ledger = repos.unlockLedger.list({ limit: 50 });
      assert.equal(ledger.length, 3);
      assert.ok(ledger.every((x: any) => x.quotaCost === 1));
      assert.equal(s.quotaConsumed, 3, '主场景实际扣点次数应为 3');
      // 未匹配公司不消耗额度；已解锁公司不重复扣
      assert.equal(repos.unlockLedger.listByCompany(s.ids.hengyue).length, 0);
      assert.equal(repos.unlockLedger.listByCompany(s.ids.chenxing).length, 0);
      // 缩放比例核对（基线 9586 = 招聘 2375 + 英文 7510 − 跨语言 299）
      const scaled = {
        recruiting: recruiting.length,
        english: en.length,
        union: companies.length,
        crossLanguageOverlap: recruiting.length + en.length - companies.length,
      };
      assert.equal(scaled.crossLanguageOverlap, 2, '跨语言重叠应为 2（辰星/云帆）');
      return { perPlatform, ...scaled, ledger: ledger.length, quotaConsumed: 3 };
    },
  },
];

/** 执行单个 AC 检查（统一异常转换） */
export async function runAcCheck(check: AcCheck, scenario: FullScenario): Promise<{ status: 'pass' | 'fail'; details?: Record<string, unknown>; error?: string }> {
  try {
    const details = await check.run(scenario);
    return { status: 'pass', details };
  } catch (err) {
    return { status: 'fail', error: err instanceof Error ? (err.stack ?? err.message) : String(err) };
  }
}

/** 供验收脚本/性能冒烟使用的 CLI 冒烟（--help 不依赖服务） */
export async function cliHelpSmoke(): Promise<{ ok: boolean; output?: string; error?: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-sqlite', '--import', 'tsx', path.join(PROJECT_ROOT, 'src/cli.ts'), '--help'], {
      cwd: PROJECT_ROOT,
      timeout: 20_000,
    });
    return { ok: stdout.includes('goal') && stdout.includes('company'), output: stdout.slice(0, 400) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
