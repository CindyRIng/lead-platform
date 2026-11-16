/**
 * Mock 上游自检（测试基础设施本身的回归测试）。
 *
 * 不依赖 LeadPlatform 生产代码：验证六个 mock 的端点形状、fixture 数据、
 * 失败注入、分页、缓存与额度/解锁语义，确保后续 e2e/验收测试站在可靠的地基上。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MOCK_TOKENS,
  type MockUpstreams,
  injectFailure,
  exhaustTanjiQuota,
  restoreTanjiQuota,
  setForceEmpty,
  setFumaPermission,
  setJobsRound,
  setSessionInvalid,
  startMockUpstreams,
} from '../mock-upstreams/index.js';
import { COMPANIES, HEBEI_CITIES, findCustomsFixtureByQueryName } from '../fixtures/index.js';

let mocks: MockUpstreams;

async function call(
  platform: keyof MockUpstreams['urls'],
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${mocks.url(platform)}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${MOCK_TOKENS[platform]}`,
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const json = (await res.json()) as any;
  return { status: res.status, json };
}

beforeAll(async () => {
  mocks = await startMockUpstreams();
});

afterAll(async () => {
  await mocks.stop();
});

beforeEach(() => {
  mocks.reset();
});

describe('mock infra', () => {
  it('六上游都监听在 loopback 随机端口并返回 status', async () => {
    for (const platform of ['boss', 'zhilian', 'ali', 'mic', 'tanji', 'fuma'] as const) {
      expect(mocks.url(platform)).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(mocks.ports[platform]).toBeGreaterThan(0);
    }
    expect((await call('boss', '/v1/status')).json.data.loggedIn).toBe(true);
    expect((await call('zhilian', '/v1/status')).json.data.loggedIn).toBe(true);
    expect((await call('ali', '/v1/status')).json.data.risk.state).toBe('normal');
    expect((await call('mic', '/api/version')).json.data.name).toBe('mic-client');
    expect((await call('tanji', '/v1/status')).json.data.quota.daily.limit).toBe(500);
    expect((await call('fuma', '/v1/status')).json.data.status).toBe('ok');
  });
});

describe('boss mock', () => {
  it('search/jobs → companies 去重 → detail business.uscc → jobs（岗位生命周期轮次可切换）', async () => {
    const search = await call('boss', '/v1/search/jobs', {
      method: 'POST',
      body: { keyword: '外贸', cityCode: '101090100', page: 1, pageSize: 20, pages: 1 },
    });
    expect(search.status).toBe(200);
    expect(search.json.ok).toBe(true);
    const queryId = search.json.data.query.queryId;
    expect(queryId).toBeTruthy();

    const companies = await call('boss', `/v1/companies?queryId=${encodeURIComponent(queryId)}`);
    const leads = companies.json.data.companies as any[];
    expect(leads.length).toBeGreaterThan(0);
    expect(leads.some((c) => c.companyId === 'boss_cx_001')).toBe(true);

    const detail = await call('boss', '/v1/companies/boss_cx_001');
    expect(detail.json.data.business.uscc).toBe('91SYNTH0000000001A');
    expect(detail.json.data.business.textDerived).toBe(true);

    const jobsRound1 = await call('boss', '/v1/companies/boss_cx_001/jobs');
    expect(jobsRound1.json.data.jobs.map((j: any) => j.jobId)).toContain('bossjob_cx_002');
    setJobsRound(mocks.world, 'boss', 2);
    const jobsRound2 = await call('boss', '/v1/companies/boss_cx_001/jobs');
    const ids = jobsRound2.json.data.jobs.map((j: any) => j.jobId);
    expect(ids).toContain('bossjob_cx_004');
    expect(ids).not.toContain('bossjob_cx_002');
  });

  it('cities 返回河北 11 市 boss cityCode', async () => {
    const res = await call('boss', '/v1/cities?refresh=true');
    const cities = res.json.data.cities as any[];
    expect(cities.length).toBeGreaterThanOrEqual(11);
    expect(cities.find((c) => c.cityCode === '101090100')?.cityName).toBe('石家庄');
  });

  it('注入 429 / 401 / 空结果', async () => {
    injectFailure(mocks.world, 'boss', { status: 429, code: 'RATE_LIMITED', message: 'rate limited', times: 1 });
    const limited = await call('boss', '/v1/search/jobs', { method: 'POST', body: { keyword: '外贸', cityCode: '101090100' } });
    expect(limited.status).toBe(429);
    expect(limited.json.error.code).toBe('RATE_LIMITED');

    setSessionInvalid(mocks.world, 'boss', true);
    const unauthorized = await call('boss', '/v1/search/jobs', { method: 'POST', body: { keyword: '外贸', cityCode: '101090100' } });
    expect(unauthorized.status).toBe(401);
    const statusRes = await call('boss', '/v1/status');
    expect(statusRes.json.data.loggedIn).toBe(false);
    setSessionInvalid(mocks.world, 'boss', false);

    setForceEmpty(mocks.world, 'boss', true);
    const empty = await call('boss', '/v1/search/jobs', { method: 'POST', body: { keyword: '外贸', cityCode: '101090100' } });
    expect(empty.json.data.companies).toEqual([]);
  });
});

describe('zhilian mock', () => {
  it('search/jobs + detail business.uscc + count 字段不可靠', async () => {
    const search = await call('zhilian', '/v1/search/jobs', {
      method: 'POST',
      body: { keyword: '外贸', cityCode: '566', page: 1, pages: 1, pageSize: 20 },
    });
    expect(search.json.data.query.count).toBe(0);
    expect(search.json.data.jobs.length).toBeGreaterThan(0);
    const qid = search.json.data.query.queryId;
    const companies = await call('zhilian', `/v1/companies?queryId=${encodeURIComponent(qid)}`);
    expect(companies.json.data.companies.some((c: any) => c.companyNumber === 'ZL_yf_001')).toBe(true);
    const detail = await call('zhilian', '/v1/companies/ZL_yf_001');
    expect(detail.json.data.business.uscc).toBe('91SYNTH0000000002B');
    const cities = await call('zhilian', '/v1/cities');
    expect(cities.json.data.cities.find((c: any) => c.code === '566')?.name).toBe('唐山');
  });
});

describe('ali / mic mock', () => {
  it('ali 省检索返回英文抬头 + 详情 store 字段；支持分页', async () => {
    const search = await call('ali', '/v1/search/suppliers', {
      method: 'POST',
      body: { province: '河北', pages: 1, maxEnrich: 60 },
    });
    const suppliers = search.json.data.suppliers as any[];
    expect(suppliers.map((s) => s.companyId)).toEqual(expect.arrayContaining(['ali_cx_1001', 'ali_hy_1002', 'ali_hc_1003']));
    const qid = search.json.data.queryId;
    const paged = await call('ali', `/v1/suppliers?queryId=${encodeURIComponent(qid)}&page=1`);
    expect(paged.json.data.suppliers.length).toBe(3);
    const detail = await call('ali', '/v1/suppliers/ali_cx_1001');
    expect(detail.json.data.companyName).toContain('Hebei Chenxing');
    expect(detail.json.data.membership.verifiedSupplier).toBe(true);
    expect(detail.json.data.profile.establishedYear).toBe(2012);
  });

  it('ali 关键词过滤命中（machinery -> 辰星）', async () => {
    const search = await call('ali', '/v1/search/suppliers', {
      method: 'POST',
      body: { province: '河北', keyword: 'machinery', locationMode: 'strict', pages: 1 },
    });
    expect(search.json.data.suppliers.map((s: any) => s.companyId)).toEqual(['ali_cx_1001']);
  });

  it('mic 省检索 + regions + 公司详情 store', async () => {
    const search = await call('mic', '/api/search/factories?province=Hebei&page=1&page_size=20');
    expect(search.json.data.items.length).toBe(3);
    expect(search.json.data.pagination.total).toBe(3);
    const regions = await call('mic', '/api/regions?province=Hebei');
    expect(regions.json.data.cities_complete).toBe(true);
    expect(regions.json.data.cities.length).toBe(HEBEI_CITIES.length);
    const detail = await call('mic', '/api/companies/haichuan-pipe?include=audit,response');
    expect(detail.json.data.company_name).toContain('Cangzhou Haichuan');
    expect(detail.json.data.membership.tier).toBe('diamond');
    expect(detail.json.data.enrichment.audit.audited).toBe(true);
  });
});

describe('tanji mock', () => {
  it('USCC 精确匹配 / 英文抬头匹配 / unmatched 空结果', async () => {
    const byUscc = await call('tanji', '/v1/search/name', {
      method: 'POST',
      body: { name: '91SYNTH0000000001A', field: 'socialCreditCode', pageSize: 20, maxPages: 1 },
    });
    expect(byUscc.json.data.companies[0].id).toBe('tanji_cx_001');

    const byEnglish = await call('tanji', '/v1/search/name', {
      method: 'POST',
      body: { name: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.', field: 'name', pageSize: 20, maxPages: 2 },
    });
    expect(byEnglish.json.data.companies[0].name).toBe('河北辰星机械制造有限公司');

    const unmatched = await call('tanji', '/v1/search/name', {
      method: 'POST',
      body: { name: 'Strictly Unmatched Synthetic Name Co., Ltd.', field: 'name', pageSize: 20, maxPages: 1 },
    });
    expect(unmatched.json.data.companies).toEqual([]);
    expect(unmatched.json.data.total).toBe(0);
  });

  it('contacts：未解锁返回 counts 无明文；已解锁返回明文', async () => {
    const locked = await call('tanji', '/v1/companies/tanji_yf_001/contacts');
    expect(locked.json.data.unlocked).toBe(false);
    expect(locked.json.data.contacts).toEqual([]);
    expect(locked.json.data.counts.total).toBeGreaterThan(0);
    const unlocked = await call('tanji', '/v1/companies/tanji_cx_001/contacts');
    expect(unlocked.json.data.unlocked).toBe(true);
    expect(unlocked.json.data.contacts.length).toBeGreaterThan(0);
    expect(unlocked.json.data.contacts[0].value).toMatch(/^138/);
  });

  it('unlock：已解锁不扣额度；正常解锁扣 1；额度耗尽返回 409；恢复后可继续；幂等', async () => {
    const before = (await call('tanji', '/v1/status')).json.data.quota.daily.remaining;

    const already = await call('tanji', '/v1/companies/tanji_cx_001/unlock', {
      method: 'POST',
      body: { confirm: true, quota: true, contacts: true, idempotencyKey: 'unlock:tanji_cx_001:test' },
    });
    expect(already.json.data.alreadyUnlocked).toBe(true);
    expect(already.json.data.quotaCost).toBe(0);
    expect(mocks.world.scenario.tanjiQuotaConsumed).toBe(0);

    const unlocked = await call('tanji', '/v1/companies/tanji_yf_001/unlock', {
      method: 'POST',
      body: { confirm: true, quota: true, contacts: true, idempotencyKey: 'unlock:tanji_yf_001:test' },
    });
    expect(unlocked.json.data.alreadyUnlocked).toBe(false);
    expect(unlocked.json.data.quotaCost).toBe(1);
    expect(unlocked.json.data.quotaAfter).toBe(before - 1);
    expect(mocks.world.scenario.tanjiQuotaConsumed).toBe(1);

    const again = await call('tanji', '/v1/companies/tanji_yf_001/unlock', {
      method: 'POST',
      body: { confirm: true, quota: true, contacts: true, idempotencyKey: 'unlock:tanji_yf_001:test' },
    });
    expect(again.json.data.alreadyUnlocked).toBe(true);
    expect(again.json.data.quotaCost).toBe(0);
    expect(mocks.world.scenario.tanjiQuotaConsumed).toBe(1);

    exhaustTanjiQuota(mocks.world);
    const exhausted = await call('tanji', '/v1/companies/tanji_lj_002/unlock', {
      method: 'POST',
      body: { confirm: true, quota: true, contacts: true, idempotencyKey: 'unlock:tanji_lj_002:test' },
    });
    expect(exhausted.status).toBe(409);
    expect(exhausted.json.error.code).toBe('QUOTA_EXHAUSTED');

    restoreTanjiQuota(mocks.world);
    const restored = await call('tanji', '/v1/companies/tanji_lj_002/unlock', {
      method: 'POST',
      body: { confirm: true, quota: true, contacts: true, idempotencyKey: 'unlock:tanji_lj_002:test' },
    });
    expect(restored.json.data.alreadyUnlocked).toBe(false);
    expect(restored.json.data.quotaCost).toBe(1);
  });
});

describe('fuma mock', () => {
  it('海关查询：英文抬头命中 + flag1/flag2 + 缓存 + 无数据 + 权限错误', async () => {
    const flag1 = await call('fuma', '/v1/customs/query', {
      method: 'POST',
      body: { accountId: 'acct_01', inputCompany: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.', companyFlag: 1, page: 1, pageSize: 20 },
    });
    expect(flag1.json.data.list.length).toBe(findCustomsFixtureByQueryName('Hebei Chenxing Machinery Manufacturing Co., Ltd.')!.records[1].length);
    expect(flag1.json.data.cached).toBe(false);
    expect(flag1.json.data.source).toBe('upstream');

    const cached = await call('fuma', '/v1/customs/query', {
      method: 'POST',
      body: { accountId: 'acct_01', inputCompany: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.', companyFlag: 1, page: 1, pageSize: 20 },
    });
    expect(cached.json.data.cached).toBe(true);
    expect(cached.json.data.source).toBe('cache');
    expect(mocks.world.scenario.fumaUpstreamQueries).toBe(1);

    const flag2 = await call('fuma', '/v1/customs/query', {
      method: 'POST',
      body: { accountId: 'acct_01', inputCompany: '河北辰星机械制造有限公司', companyFlag: 2, page: 1, pageSize: 20 },
    });
    expect(flag2.json.data.list.length).toBeGreaterThan(0);

    const noData = await call('fuma', '/v1/customs/query', {
      method: 'POST',
      body: { accountId: 'acct_01', inputCompany: 'Shijiazhuang Hengyue Metal Products Co., Ltd.', companyFlag: 1, page: 1, pageSize: 20 },
    });
    expect(noData.json.data.totalNum).toBe(0);
    expect(noData.json.data.list).toEqual([]);

    setFumaPermission(mocks.world, true);
    const denied = await call('fuma', '/v1/customs/query', {
      method: 'POST',
      body: { accountId: 'acct_01', inputCompany: 'Hebei Chenxing Machinery Manufacturing Co., Ltd.', companyFlag: 1, page: 1, pageSize: 20 },
    });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('CUSTOMS_PERMISSION_DENIED');
  });
});

describe('fixtures', () => {
  it('不包含真实公司/PII：所有公司名以合成标记或虚构词命名，USCC 为可辨识合成值', () => {
    for (const c of COMPANIES) {
      expect(c.name).toMatch(/合成|示例|测试|辰星|云帆|恒岳|蓝鲸|华曦|海川/);
      expect(c.legalRepresentative).toMatch(/^示例/);
      if (c.uscc) expect(c.uscc).toMatch(/^91SYNTH/);
    }
  });

  it('跨源场景完整：同一公司在多平台出现', () => {
    const chenxing = COMPANIES.find((c) => c.key === 'chenxing')!;
    expect(chenxing.boss).toBeTruthy();
    expect(chenxing.ali).toBeTruthy();
    const yunfan = COMPANIES.find((c) => c.key === 'yunfan')!;
    expect(yunfan.zhilian).toBeTruthy();
    expect(yunfan.mic).toBeTruthy();
  });
});
