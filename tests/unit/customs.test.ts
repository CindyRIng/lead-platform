/**
 * 海关补全单测（task-11）：全部 mock，不访问真实网络/DB。
 * 覆盖：名称 token 过滤、角色分类、去重聚合、confidence、查询计划、缓存元信息、
 *       no_data、permission_denied、到期入队与 Worker 任务生命周期。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  aggregateCustoms,
  buildCustomsNameMatcher,
  buildCustomsQueryPlan,
  classifyCustomsRecord,
  computeCustomsConfidence,
  createCustomsWorker,
  createCustomsWorkerFromConfig,
  customsNameTokens,
  matchesCustomsName,
  normalizeCustomsName,
  resolveCustomsCompanyIdentity,
  type CustomsAggregateInput,
  type CustomsQueryOutcome,
} from '../../src/pipeline/customs.js';
import { FumaClient, createFumaClientFromConfig } from '../../src/adapters/fuma.js';
import type { FumaCustomsQueryResult, FumaCustomsRecord } from '../../src/adapters/fuma.js';
import { LeadError } from '../../src/shared/errors.js';

// ---------------------------------------------------------------------------
// 合成数据（虚构公司，非真实企业/PII）
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-16T06:00:00.000Z');
const ENGLISH = 'Hebei Test Machinery Co., Ltd.';
const CHINESE = '河北测试机械有限公司';
const TOKENS = ['HEBEI', 'TEST', 'MACHINERY'];

function record(partial: Partial<FumaCustomsRecord> & { tradeno: string }): FumaCustomsRecord {
  return {
    inout: 'import',
    regdate: '2026-09-01',
    hscode: '848180',
    detail: 'TEST VALVE FOR PIPELINE',
    weight: 100,
    count: 10,
    money: 0,
    ...partial,
  };
}

function queryResult(
  records: FumaCustomsRecord[],
  overrides: Partial<FumaCustomsQueryResult> = {},
): FumaCustomsQueryResult {
  return {
    records,
    totalNum: overrides.totalNum ?? 100,
    allCount: overrides.allCount ?? overrides.totalNum ?? 100,
    exactCount: 0,
    source: 'upstream',
    cached: false,
    cachedAt: null,
    expiresAt: null,
    stale: false,
    upstreamVersion: 'v1',
    page: 1,
    pageSize: 20,
    raw: { list: records },
    ...overrides,
  };
}

function outcome(
  name: string,
  nameKind: 'english' | 'chinese',
  flag: 1 | 2,
  result: FumaCustomsQueryResult,
): CustomsQueryOutcome {
  return { name, nameKind, flag, ok: true, result, errorCode: null, errorMessage: null };
}

const MATCHING_RECORDS: FumaCustomsRecord[] = [
  record({ tradeno: 'T001', rawexporter: 'HEBEI TEST MACHINERY CO LTD', rawimporter: 'BUYER ONE LLC', importercountryen: 'United States', regdate: '2026-10-01' }),
  record({ tradeno: 'T002', exporter: 'HEBEI TEST MACHINERY', importer: 'BUYER TWO LTD', destcountry: 'Germany', hscode: '730799', regdate: '2026-09-15' }),
  record({ tradeno: 'T003', usedsuppliername: 'HEBEI TEST MACHINERY', rawimporter: 'BUYER THREE', importercountryen: 'Ukraine', hscode: '848190', regdate: '2026-11-02' }),
  record({ tradeno: 'T004', rawimporter: 'HEBEI TEST MACHINERY', rawexporter: 'KOREAN SUPPLIER CO', exportercountryen: 'Korea', hscode: '731815', regdate: '2026-08-20' }),
  record({ tradeno: 'T005', inventoried: false, importer: 'HEBEI TEST MACHINERY GROUP', exporter: 'VIETNAM SUPPLIER', exportercountryen: 'Vietnam' }),
  record({ tradeno: 'T006', rawexporter: 'OTHER INDUSTRIAL METAL CO', rawimporter: 'UNRELATED BUYER' }),
];

// ---------------------------------------------------------------------------
// Fake repositories（只实现 Worker 用到的部分）
// ---------------------------------------------------------------------------

interface FakeState {
  companies: Map<string, Record<string, unknown>>;
  customs: Map<string, Record<string, unknown>>;
  jobs: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown> & { seq: number }>;
  snapshots: Array<Record<string, unknown>>;
  sourceHealth: Array<Record<string, unknown>>;
  droppedCustoms: number;
}

function makeFakeRepos(options: { company?: Record<string, unknown>; due?: Array<{ companyId: string }>; missing?: Array<Record<string, unknown>> } = {}) {
  const state: FakeState = {
    companies: new Map(),
    customs: new Map(),
    jobs: [],
    events: [],
    snapshots: [],
    sourceHealth: [],
    droppedCustoms: 0,
  };
  let jobSeq = 0;
  let snapSeq = 0;
  let eventSeq = 0;

  const company = options.company ?? {
    id: 'cmp_test_001',
    name: CHINESE,
    englishName: ENGLISH,
    province: '河北省',
    city: '石家庄市',
    mergedInto: null,
    version: 3,
  };
  state.companies.set(String(company.id), company);

  const repos = {
    transaction: <T>(fn: () => T): T => fn(),
    companies: {
      getById: (id: string) => state.companies.get(id) ?? null,
      listAliMicMissingCustoms: () => options.missing ?? [],
    },
    customs: {
      getByCompany: (id: string) => state.customs.get(id) ?? null,
      listDue: () => options.due ?? [],
      upsert: (input: Record<string, unknown>) => {
        const prev = state.customs.get(String(input.companyId)) ?? null;
        const row = { ...input, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
        state.customs.set(String(input.companyId), row);
        return { profile: row, previous: prev, created: !prev };
      },
    },
    jobs: {
      enqueue: (input: Record<string, unknown>) => {
        const key = `${input.companyId}|${input.stage}|${input.platform ?? ''}`;
        const existing = state.jobs.find((j) => j.key === key);
        if (existing) {
          if (input.resetExisting && ['done', 'failed', 'dead', 'cancelled'].includes(String(existing.status))) {
            existing.status = 'pending';
            existing.attempts = 0;
            existing.nextRetryAt = null;
            return { job: existing, created: false };
          }
          return { job: existing, created: false };
        }
        jobSeq += 1;
        const job = {
          id: `job_${jobSeq}`,
          key,
          companyId: input.companyId,
          stage: input.stage,
          platform: input.platform ?? null,
          status: 'pending',
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
          nextRetryAt: null,
        };
        state.jobs.push(job);
        return { job, created: true };
      },
      claimNext: (input: { stages?: string[] }) => {
        const job = state.jobs.find((j) => j.status === 'pending' && (!input.stages || input.stages.includes(String(j.stage))));
        if (!job) return null;
        job.status = 'running';
        job.attempts = Number(job.attempts ?? 0) + 1;
        return job;
      },
      complete: (id: string) => {
        const job = state.jobs.find((j) => j.id === id);
        if (job) job.status = 'done';
        return job ?? null;
      },
      fail: (id: string, opts: { nextRetryAt?: string | null }) => {
        const job = state.jobs.find((j) => j.id === id);
        if (job) {
          job.status = opts.nextRetryAt ? 'pending' : 'dead';
          job.nextRetryAt = opts.nextRetryAt ?? null;
        }
        return job ?? null;
      },
    },
    changeEvents: {
      appendMany: (events: Array<Record<string, unknown>>) => {
        const written = events.map((event) => {
          eventSeq += 1;
          const row = { ...event, seq: eventSeq };
          state.events.push(row);
          return row;
        });
        return written;
      },
    },
    snapshots: {
      writeText: (input: Record<string, unknown>) => {
        snapSeq += 1;
        state.snapshots.push({ id: snapSeq, ...input });
        return { snapshot: { id: snapSeq }, blob: { created: true }, blobCreated: true };
      },
    },
    sourceHealth: {
      upsert: (row: Record<string, unknown>) => {
        state.sourceHealth.push(row);
        return row;
      },
    },
  };

  return { repos: repos as unknown as never, state, reposRaw: repos };
}

function makeFakeFuma(handler: (input: { inputCompany: string; companyFlag: 1 | 2 }) => Promise<FumaCustomsQueryResult>) {
  const calls: Array<{ inputCompany: string; companyFlag: 1 | 2; pageSize?: number; forceRefresh?: boolean }> = [];
  return {
    calls,
    queryCustoms: vi.fn(async (input: { inputCompany: string; companyFlag: 1 | 2; pageSize?: number; forceRefresh?: boolean }) => {
      calls.push(input);
      return handler(input);
    }),
  };
}

function makeWorker(handler: (input: { inputCompany: string; companyFlag: 1 | 2 }) => Promise<FumaCustomsQueryResult>, reposOptions: Parameters<typeof makeFakeRepos>[0] = {}) {
  const { repos, state, reposRaw } = makeFakeRepos(reposOptions);
  const fuma = makeFakeFuma(handler);
  const worker = createCustomsWorker({
    repos: repos as never,
    fuma: fuma as never,
    config: { workerId: 'test-worker', refreshDays: 30, pageSize: 20 },
    clock: () => NOW,
  });
  return { worker, fuma, state, reposRaw };
}

// ---------------------------------------------------------------------------
// 名称归一化 / 过滤
// ---------------------------------------------------------------------------

describe('customs name tokenization & role classification', () => {
  it('normalizes English names and strips generic words', () => {
    expect(customsNameTokens('Hebei Test Machinery Co., Ltd.')).toEqual(TOKENS);
    expect(customsNameTokens('HEBEI TEST MACHINERY GROUP CORP')).toEqual(TOKENS);
    expect(normalizeCustomsName('Hebei  Test—Machinery, Co.')).toBe('HEBEI TEST MACHINERY CO');
  });

  it('matches exporter/importer roles across all name fields', () => {
    const matcher = buildCustomsNameMatcher([ENGLISH, CHINESE]);
    const exporter = classifyCustomsRecord(MATCHING_RECORDS[0] as FumaCustomsRecord, matcher);
    expect(exporter).toMatchObject({ asExporter: true, asImporter: false, role: 'exporter', matched: true });

    const importer = classifyCustomsRecord(MATCHING_RECORDS[3] as FumaCustomsRecord, matcher);
    expect(importer).toMatchObject({ asExporter: false, asImporter: true, role: 'importer', matched: true });

    // 命中 exporter 的 importer 字段是买家（不影响 asExporter 判定）
    const usedSupplier = classifyCustomsRecord(MATCHING_RECORDS[2] as FumaCustomsRecord, matcher);
    expect(usedSupplier.asExporter).toBe(true);

    const unrelated = classifyCustomsRecord(MATCHING_RECORDS[5] as FumaCustomsRecord, matcher);
    expect(unrelated).toMatchObject({ asExporter: false, asImporter: false, matched: false, role: 'unmatched' });
  });

  it('matches partial names by token coverage (abbreviations tolerable)', () => {
    const matcher = buildCustomsNameMatcher(['Hebei Test Machinery Co., Ltd.']);
    expect(matchesCustomsName(matcher, ['HEBEI TEST MACHINERY'])).toBe(true);
    expect(matchesCustomsName(matcher, ['HEBEI TEST MACHINERY GROUP CO LTD'])).toBe(true);
    expect(matchesCustomsName(matcher, ['OTHER INDUSTRIAL METAL CO'])).toBe(false);
    // 只命中 1/3 token（HEBEI）不够阈值
    expect(matchesCustomsName(matcher, ['HEBEI INDUSTRIAL GROUP'])).toBe(false);
  });

  it('resolves query identity from company row (English preferred, Chinese fallback)', () => {
    expect(resolveCustomsCompanyIdentity({ name: CHINESE, englishName: ENGLISH, extra: null })).toEqual({
      englishName: ENGLISH,
      chineseName: CHINESE,
    });
    expect(resolveCustomsCompanyIdentity({ name: 'Hebei Test Machinery Co., Ltd.', englishName: null })).toEqual({
      englishName: 'Hebei Test Machinery Co., Ltd.',
      chineseName: null,
    });
  });

  it('builds EN×2 + CN×2 query plan and dedupes', () => {
    expect(buildCustomsQueryPlan({ englishName: ENGLISH, chineseName: CHINESE })).toEqual([
      { name: ENGLISH, nameKind: 'english', flag: 1 },
      { name: ENGLISH, nameKind: 'english', flag: 2 },
      { name: CHINESE, nameKind: 'chinese', flag: 1 },
      { name: CHINESE, nameKind: 'chinese', flag: 2 },
    ]);
    expect(buildCustomsQueryPlan({ englishName: null, chineseName: CHINESE })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 聚合 / confidence
// ---------------------------------------------------------------------------

describe('customs aggregation', () => {
  const input: CustomsAggregateInput = {
    englishName: ENGLISH,
    chineseName: CHINESE,
    outcomes: [
      outcome(ENGLISH, 'english', 2, queryResult([MATCHING_RECORDS[0]!, MATCHING_RECORDS[1]!, MATCHING_RECORDS[2]!, MATCHING_RECORDS[5]!], { totalNum: 754, cached: true, cachedAt: '2026-11-16T05:57:13.569Z', expiresAt: '2026-11-17T05:57:13.569Z', source: 'cache' })),
      outcome(ENGLISH, 'english', 1, queryResult([MATCHING_RECORDS[3]!, MATCHING_RECORDS[4]!], { totalNum: 1310 })),
      outcome(CHINESE, 'chinese', 1, queryResult([record({ tradeno: 'T007', rawexporter: 'HEBEI TEST MACHINERY', rawimporter: 'HEBEI TEST MACHINERY', importercountryen: 'Poland', hscode: '848130', regdate: '2026-10-11' })], { totalNum: 30 })),
      outcome(CHINESE, 'chinese', 2, queryResult([], { totalNum: 0 })),
    ],
  };
  const aggregate = aggregateCustoms(input);

  it('counts fetched/matched/exporter/importer/unmatched from deduped samples', () => {
    expect(aggregate.fetchedRecords).toBe(7);
    expect(aggregate.matchedRecords).toBe(6);
    expect(aggregate.unmatchedRecords).toBe(1);
    expect(aggregate.exporterRecords).toBe(4); // T001/T002/T003/T007
    expect(aggregate.importerRecords).toBe(3); // T004/T005/T007
    expect(aggregate.bothRecords).toBe(1);
    expect(aggregate.status).toBe('ok');
    expect(aggregate.confidence).toBe('high');
  });

  it('aggregates date range / destinations / origins / hs4 / products / buyers / suppliers', () => {
    expect(aggregate.dateMin).toBe('2026-08-20');
    expect(aggregate.dateMax).toBe('2026-11-02');
    expect(aggregate.destinations).toEqual(
      expect.arrayContaining([
        { key: 'United States', count: 1 },
        { key: 'Germany', count: 1 },
        { key: 'Ukraine', count: 1 },
        { key: 'Poland', count: 1 },
      ]),
    );
    expect(aggregate.origins).toEqual(expect.arrayContaining([{ key: 'Korea', count: 1 }, { key: 'Vietnam', count: 1 }]));
    expect(aggregate.hs4).toEqual(expect.arrayContaining([{ key: '8481', count: 4 }, { key: '7307', count: 1 }]));
    expect(aggregate.products[0]).toMatchObject({ key: 'TEST VALVE FOR PIPELINE' });
    expect(aggregate.buyers.map((b) => b.key)).toEqual(expect.arrayContaining(['BUYER ONE LLC', 'BUYER TWO LTD']));
    expect(aggregate.suppliers.map((s) => s.key)).toEqual(expect.arrayContaining(['KOREAN SUPPLIER CO']));
  });

  it('records upstream totals and cache metadata (sampled mode)', () => {
    expect(aggregate.upstreamTotals.status).toBe('ok');
    expect(aggregate.upstreamTotals.maxTotalNum).toBe(1310);
    expect(aggregate.upstreamTotals.queries).toHaveLength(4);
    expect(aggregate.cached).toBe(true);
    expect(aggregate.cachedAt).toBe('2026-11-16T05:57:13.569Z');
    expect(aggregate.sampleRecords.length).toBeLessThanOrEqual(20);
    expect(aggregate.sampleRecords[0]).toHaveProperty('role');
  });

  it('computes confidence thresholds', () => {
    expect(computeCustomsConfidence(0, 1000)).toBe('none');
    expect(computeCustomsConfidence(6, 1000)).toBe('high');
    expect(computeCustomsConfidence(2, 50)).toBe('medium');
    expect(computeCustomsConfidence(2, 500)).toBe('low'); // 命中少但上游模糊总数大 → 噪声
    expect(computeCustomsConfidence(4, 500)).toBe('medium');
  });
});

// ---------------------------------------------------------------------------
// Worker：写库 / 事件 / 缓存 / no_data / 权限
// ---------------------------------------------------------------------------

describe('CustomsWorker', () => {
  it('writes profile + raw snapshots + customs change events for matching data', async () => {
    const { worker, state } = makeWorker(
      async (input) => {
        if (input.companyFlag === 2) return queryResult([MATCHING_RECORDS[0]!, MATCHING_RECORDS[1]!, MATCHING_RECORDS[2]!, MATCHING_RECORDS[5]!], { totalNum: 754, cached: true, cachedAt: '2026-11-16T05:57:13.569Z', expiresAt: '2026-11-17T05:57:13.569Z', source: 'cache' });
        return queryResult([MATCHING_RECORDS[3]!, MATCHING_RECORDS[4]!], { totalNum: 1310 });
      },
    );

    const result = await worker.refreshCompany('cmp_test_001');
    expect(result.status).toBe('ok');
    expect(result.confidence).toBe('high');
    expect(result.matchedRecords).toBe(5); // T001/T002/T003/T004/T005（T006 只在 flag2 但被过滤）
    expect(result.exporterRecords).toBe(3);
    expect(result.importerRecords).toBe(2);
    expect(result.created).toBe(true);
    expect(result.version).toBe(1);

    const profile = state.customs.get('cmp_test_001') as Record<string, unknown>;
    expect(profile).toBeTruthy();
    expect(profile.sampled).toBe(true);
    expect(profile.source).toBe('fuma');
    expect(profile.englishName).toBe(ENGLISH);
    expect(profile.chineseName).toBe(CHINESE);
    expect(profile.confidence).toBe('high');
    expect(profile.cached).toBe(true);
    expect(profile.cachedAt).toBe('2026-11-16T05:57:13.569Z');
    expect(profile.nextRefreshAt).toBe('2026-12-16T06:00:00.000Z');
    expect(profile.fetchedAt).toBe(NOW.toISOString());
    expect(Array.isArray(profile.queryNames)).toBe(true);
    expect((profile.upstreamTotals as Record<string, unknown>).status).toBe('ok');

    // 每次成功查询都落 raw_snapshot(kind=fuma_customs_query)
    expect(state.snapshots).toHaveLength(4);
    expect(state.snapshots.every((s) => s.kind === 'fuma_customs_query')).toBe(true);

    // 每次刷新最多 1 条 customs.updated（快照型事件，newValue=画像摘要，避免 webhook 风暴）
    expect(state.events).toHaveLength(1);
    const event = state.events[0] as Record<string, unknown>;
    expect(event.eventType).toBe('customs.updated');
    expect(event.source).toBe('fuma:customs');
    expect(event.field).toBeNull();
    expect(event.newValue).toMatchObject({
      confidence: 'high',
      exporterRecords: 3,
      importerRecords: 2,
      matchedRecords: 5,
      dateRange: { min: '2026-08-20', max: '2026-11-02' },
    });
    expect((event.newValue as Record<string, unknown>).topDestinations).toEqual(
      expect.arrayContaining(['United States', 'Germany', 'Ukraine']),
    );
  });

  it('does not bump version or emit events when refreshed data is unchanged', async () => {
    const handler = async (input: { companyFlag: 1 | 2 }) =>
      input.companyFlag === 2
        ? queryResult([MATCHING_RECORDS[0]!], { totalNum: 10 })
        : queryResult([], { totalNum: 0 });
    const { worker, state } = makeWorker(handler);
    const first = await worker.refreshCompany('cmp_test_001');
    expect(first.version).toBe(1);
    const eventsAfterFirst = state.events.length;

    const second = await worker.refreshCompany('cmp_test_001');
    expect(second.changed).toBe(false);
    expect(second.version).toBe(1);
    expect(state.events.length).toBe(eventsAfterFirst);
  });

  it('treats totalNum=0 as no_data: writes empty profile, completes job, no events', async () => {
    const { worker, state, reposRaw } = makeWorker(async () => queryResult([], { totalNum: 0, allCount: 0, source: 'cache', cached: true }));
    const { job } = reposRaw.jobs.enqueue({ companyId: 'cmp_test_001', stage: 'customs', platform: null });

    const summary = await worker.runOnce({ enqueueDue: false });
    expect(summary.claimed).toBe(1);
    expect(summary.completed).toBe(1);
    expect(summary.noData).toBe(1);
    expect(summary.failed).toBe(0);

    const jobRow = state.jobs.find((j) => j.id === job.id) as Record<string, unknown>;
    expect(jobRow.status).toBe('done');

    const profile = state.customs.get('cmp_test_001') as Record<string, unknown>;
    expect(profile.confidence).toBe('none');
    expect((profile.upstreamTotals as Record<string, unknown>).status).toBe('no_data');
    expect(profile.matchedRecords).toBe(0);
    expect(state.events).toHaveLength(0); // low/none 不推送（docs/03 §4）
  });

  it('pauses queue and marks fuma degraded on permission_denied', async () => {
    const { worker, state, reposRaw } = makeWorker(async () => {
      throw new LeadError('CUSTOMS_PERMISSION_DENIED', 'account has no customs permission');
    });
    reposRaw.jobs.enqueue({ companyId: 'cmp_test_001', stage: 'customs', platform: null });
    const summary = await worker.runOnce({ enqueueDue: false });

    expect(summary.failed).toBe(1);
    expect(summary.permissionDenied).toBe(true);
    expect(summary.paused).toBe(true);
    expect(state.customs.size).toBe(0); // 权限错误不写画像
    const jobRow = state.jobs[0] as Record<string, unknown>;
    expect(jobRow.status).toBe('pending');
    expect(String(jobRow.nextRetryAt)).toMatch(/^2026-11-17T/); // 次日重试
    expect(state.sourceHealth).toContainEqual(expect.objectContaining({ platform: 'fuma', state: 'degraded' }));
  });

  it('enqueues due profiles and new Ali/Mic companies, then processes them', async () => {
    const { worker, state, reposRaw } = makeWorker(
      async (input) => (input.companyFlag === 2 ? queryResult([MATCHING_RECORDS[0]!], { totalNum: 5 }) : queryResult([], { totalNum: 0 })),
      {
        due: [{ companyId: 'cmp_test_001' }],
        missing: [{ id: 'cmp_new_002', englishName: 'Hebei New Exporter Co., Ltd.', name: '河北新出口有限公司' }],
      },
    );
    state.companies.set('cmp_new_002', {
      id: 'cmp_new_002',
      name: '河北新出口有限公司',
      englishName: 'Hebei New Exporter Co., Ltd.',
      mergedInto: null,
      version: 1,
    });

    const summary = await worker.runOnce();
    expect(summary.dueEnqueued).toBe(2);
    expect(summary.claimed).toBe(2);
    expect(summary.completed).toBe(2);
    expect(state.jobs.filter((j) => j.status === 'done')).toHaveLength(2);
    expect(state.customs.size).toBe(2);
  });

  it('skips companies without English name when enqueuing manually', async () => {
    const { worker, state } = makeWorker(async () => queryResult([]));
    state.companies.set('cmp_boss_only', { id: 'cmp_boss_only', name: '河北只有中文名有限公司', englishName: null, mergedInto: null, version: 1 });
    await expect(worker.enqueueForCompany('cmp_boss_only')).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(state.jobs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FumaClient 适配器（mock fetch，不访问真实网络）
// ---------------------------------------------------------------------------

describe('FumaClient', () => {
  function okResponse(data: unknown, status = 200): Response {
    return new Response(JSON.stringify({ ok: true, data, meta: { requestId: 'req_test' }, error: null }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  function errResponse(error: unknown, status: number): Response {
    return new Response(JSON.stringify({ ok: false, data: null, meta: {}, error }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('posts customs/query with account/flag/page params and normalizes result', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return okResponse({
        list: [{ tradeno: 'X1', inout: 'import', rawexporter: 'HEBEI TEST MACHINERY', hscode: '848180', detail: 'VALVE' }],
        totalNum: 754,
        allCount: 754,
        exactCount: 0,
        source: 'cache',
        cached: true,
        cachedAt: '2026-11-16T05:57:13.569Z',
        expiresAt: '2026-11-17T05:57:13.569Z',
        stale: false,
        upstreamVersion: '5602523828',
        page: 1,
        pageSize: 20,
      });
    }) as unknown as typeof fetch;

    const client = new FumaClient({
      baseUrl: 'http://127.0.0.1:17890',
      token: 'test-token',
      accountId: 'acct_01',
      fetchImpl,
      rate: { minIntervalMs: 0 },
    });
    const result = await client.queryCustoms({ inputCompany: ENGLISH, companyFlag: 2, pageSize: 20 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://127.0.0.1:17890/v1/customs/query');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-token');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      accountId: 'acct_01',
      inputCompany: ENGLISH,
      companyFlag: 2,
      page: 1,
      pageSize: 20,
      forceRefresh: false,
      allowStale: true,
    });
    expect(result).toMatchObject({ totalNum: 754, cached: true, source: 'cache', upstreamVersion: '5602523828', page: 1, pageSize: 20 });
    expect(result.records).toHaveLength(1);
  });

  it('normalizes permission_denied to CUSTOMS_PERMISSION_DENIED', async () => {
    const fetchImpl = (async () => errResponse({ code: 'permission_denied', message: 'account has no customs permission' }, 200)) as unknown as typeof fetch;
    const client = new FumaClient({ fetchImpl, rate: { minIntervalMs: 0 }, maxAttempts: 1 });
    await expect(client.queryCustoms({ inputCompany: ENGLISH, companyFlag: 1 })).rejects.toMatchObject({
      code: 'CUSTOMS_PERMISSION_DENIED',
    });
  });

  it('normalizes 401 to SOURCE_SESSION_INVALID and 429 to UPSTREAM_RATE_LIMITED', async () => {
    const unauthorized = new FumaClient({ fetchImpl: (async () => errResponse({ code: 'unauthorized' }, 401)) as unknown as typeof fetch, rate: { minIntervalMs: 0 }, maxAttempts: 1 });
    await expect(unauthorized.getStatus()).rejects.toMatchObject({ code: 'SOURCE_SESSION_INVALID' });

    const rateLimited = new FumaClient({ fetchImpl: (async () => errResponse({ code: 'rate_limited' }, 429)) as unknown as typeof fetch, rate: { minIntervalMs: 0 }, maxAttempts: 1 });
    await expect(rateLimited.getStatus()).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED', retryable: true });
  });

  it('retries 5xx/network errors with backoff and then succeeds', async () => {
    let attempt = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt < 3) throw new Error('ECONNREFUSED');
      return okResponse({ status: 'ok', version: '1.1.0', accounts: 1, onlineAccounts: 1, accountsDetail: [] });
    }) as unknown as typeof fetch;
    const client = new FumaClient({
      fetchImpl,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      rate: { minIntervalMs: 0 },
    });
    const status = await client.getStatus();
    expect(attempt).toBe(3);
    expect(sleeps).toEqual([10, 20]);
    expect(status).toMatchObject({ status: 'ok', version: '1.1.0', onlineAccounts: 1 });
  });

  it('serializes account queries (concurrency <= 1)', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = (async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return okResponse({ list: [], totalNum: 0, allCount: 0, page: 1, pageSize: 20 });
    }) as unknown as typeof fetch;
    const client = new FumaClient({ fetchImpl, rate: { minIntervalMs: 0 }, maxAttempts: 1 });
    await Promise.all([
      client.queryCustoms({ inputCompany: ENGLISH, companyFlag: 1 }),
      client.queryCustoms({ inputCompany: ENGLISH, companyFlag: 2 }),
      client.queryCustoms({ inputCompany: CHINESE, companyFlag: 1 }),
    ]);
    expect(maxActive).toBe(1);
  });

  it('validates input (inputCompany >= 2 chars, companyFlag 1/2)', async () => {
    const client = new FumaClient({ fetchImpl: (async () => okResponse({})) as unknown as typeof fetch, rate: { minIntervalMs: 0 } });
    await expect(client.queryCustoms({ inputCompany: 'A', companyFlag: 1 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(client.queryCustoms({ inputCompany: ENGLISH, companyFlag: 3 as 1 | 2 })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});


describe('flat AppConfig wiring helpers', () => {
  it('createCustomsWorkerFromConfig maps Lead config flat fields', () => {
    const fuma = makeFakeFuma(async () => queryResult([]));
    const worker = createCustomsWorkerFromConfig(
      {} as never,
      fuma as never,
      { fumaAccountId: 'acct_02', customsRefreshDays: 15, customsMaxPageSize: 50, jobLeaseSec: 30, jobMaxAttempts: 5 },
      { clock: () => NOW },
    );
    expect(worker.getConfig()).toMatchObject({ accountId: 'acct_02', refreshDays: 15, pageSize: 50, leaseSec: 30, jobMaxAttempts: 5 });
  });

  it('createFumaClientFromConfig reads flat fumaUrl/fumaToken/fumaAccountId', () => {
    const client = createFumaClientFromConfig({ fumaUrl: 'http://127.0.0.1:17890', fumaToken: 'tok', fumaAccountId: 'acct_01' });
    expect(client).toBeInstanceOf(FumaClient);
    expect(client.accountId).toBe('acct_01');
    const legacy = createFumaClientFromConfig({ fumaClientUrl: 'http://127.0.0.1:17890', fumaApiToken: 'tok2', fumaAccountId: 'acct_02' });
    expect(legacy.accountId).toBe('acct_02');
  });
});
