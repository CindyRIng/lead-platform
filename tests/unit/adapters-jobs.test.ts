/**
 * S2 适配器单测：Boss / 智联（mock fetch，绝不打真实上游）。
 * 覆盖：URL/方法/Bearer/参数（pages 上限）、响应映射、错误归一、限频间隔。
 */
import { describe, expect, it, vi } from 'vitest';
import { BossAdapter } from '../../src/adapters/sources/boss.js';
import { ZhilianAdapter } from '../../src/adapters/sources/zhilian.js';
import { LeadError } from '../../src/shared/errors.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function makeFetch(handler: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function bossStatus() {
  return {
    ok: true,
    data: { loggedIn: true, health: 'ok', session: { expiresAt: '2026-11-21T00:00:00+08:00' }, risk: { code37Count: 0, cooldownUntil: null } },
    meta: {},
    error: null,
  };
}

function bossSearchResponse() {
  return {
    ok: true,
    data: {
      query: { queryId: 'q_test_1', keyword: '外贸', cityCode: '101090100', cityName: '石家庄', pageSize: 15, pagesFetched: 1, resCount: 450, totalCount: 300, hasMore: true },
      jobs: [
        {
          jobId: 'job_1',
          title: '外贸业务员',
          salaryText: '6-10K',
          salaryMin: 6,
          salaryMax: 10,
          experience: '1-3年',
          degree: '大专',
          cityName: '石家庄',
          district: '裕华区',
          businessDistrict: '万达',
          companyId: 'cmp_1',
          companyName: '河北测试进出口有限公司',
          companyIndustry: '进出口贸易',
          bossName: '刘*',
          bossTitle: 'HR',
          jobUrl: 'https://www.zhipin.com/job_detail/job_1.html',
        },
      ],
    },
    meta: {},
    error: null,
  };
}


/** 可控时钟 + sleep（避免测试真实等待限频/退避） */
function makeClock(start = 1_700_000_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += Math.max(0, ms);
    },
    sleeps,
  };
}

describe('BossAdapter', () => {
  it('searchJobs：POST /v1/search/jobs + Bearer + pages 上限 5 + 岗位映射', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() => jsonResponse(bossSearchResponse()));
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 'token-boss', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchJobs({ keyword: '外贸', cityCode: '101090100', pages: 99 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8790/v1/search/jobs');
    expect(calls[0]?.headers.authorization).toBe('Bearer token-boss');
    expect((calls[0]?.body as { pages: number; cityCode: string; keyword: string }).pages).toBe(5);
    expect((calls[0]?.body as { cityCode: string }).cityCode).toBe('101090100');
    expect(res.queryId).toBe('q_test_1');
    expect(res.hasMore).toBe(true);
    expect(res.totalCount).toBe(450);
    expect(res.jobs[0]).toMatchObject({
      platform: 'boss',
      platformCompanyId: 'cmp_1',
      jobId: 'job_1',
      salaryMin: 6,
      recruiterName: '刘*',
      status: 'active',
    });
  });

  it('listCompanies：GET /v1/companies?queryId= → SourceLead（含来源证据/URL）', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          companies: [
            {
              companyId: 'cmp_1',
              name: '河北测试进出口有限公司',
              industry: '进出口贸易',
              scale: '100-499人',
              stage: '不需要融资',
              cityName: '石家庄',
              jobCount: 3,
              matchedJobs: [{ jobId: 'job_1', title: '外贸业务员' }],
            },
          ],
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const leads = await adapter.listCompanies('q_test_1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8790/v1/companies?queryId=q_test_1');
    expect(calls[0]?.method).toBe('GET');
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ platform: 'boss', platformCompanyId: 'cmp_1', companyName: '河北测试进出口有限公司', cityName: '石家庄' });
    expect(leads[0]?.sourceUrl).toContain('zhipin.com');
    expect(leads[0]?.evidence.jobCount).toBe(3);
  });

  it('getCompanyDetail：映射 profile/business/recruiters/hotJobs', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          companyId: 'cmp_1',
          name: '测试',
          fullName: '河北测试进出口有限公司',
          logo: 'https://img.example/logo.png',
          industry: '进出口贸易',
          scale: '100-499人',
          stage: '不需要融资',
          cityName: '石家庄',
          address: '石家庄市裕华区',
          intro: '公司简介',
          tags: ['进出口贸易'],
          benefits: ['双休'],
          jobCount: 48,
          bossCount: 7,
          hotJobs: [{ jobId: 'job_hot', title: '外贸经理', salaryText: '10-20K' }],
          recruiters: [{ name: '王*', title: 'HR', online: true }],
          business: {
            companyName: '河北测试进出口有限公司',
            uscc: '91130100TEST000001',
            legalRepresentative: '张三',
            foundedAt: '2015-06-10',
            registeredCapital: '300万人民币',
            registeredAddress: '河北省石家庄市裕华区',
            businessStatus: '存续',
            businessScope: '货物进出口',
            usccSource: 'boss_company_page_text',
            textDerived: true,
          },
          url: 'https://www.zhipin.com/gongsi/cmp_1.html',
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const detail = await adapter.getCompanyDetail('cmp_1');
    expect(detail.profile.fullName).toBe('河北测试进出口有限公司');
    expect(detail.profile.jobCount).toBe(48);
    expect(detail.profile.recruiters?.[0]).toMatchObject({ name: '王*', online: true });
    expect(detail.business?.uscc).toBe('91130100TEST000001');
    expect(detail.business?.textDerived).toBe(true);
    expect(detail.jobs[0]).toMatchObject({ jobId: 'job_hot', platform: 'boss' });
  });

  it('getStatus：解析 loggedIn/expiresAt', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() => jsonResponse(bossStatus()));
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const status = await adapter.getStatus();
    expect(status).toMatchObject({ platform: 'boss', state: 'ok', loggedIn: true });
    expect(status.expiresAt).toBe('2026-11-21T00:00:00+08:00');
  });

  it('错误归一：401 → SOURCE_SESSION_INVALID；验证码 409 → SOURCE_VERIFICATION_PENDING', async () => {
    const clock = makeClock();
    const unauthorized = makeFetch(() => jsonResponse({ ok: false, data: null, error: { code: 'UNAUTHORIZED', message: 'bad token' }, meta: {} }, 401));
    const boss = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 'bad', fetchImpl: unauthorized.impl, now: clock.now, sleep: clock.sleep });
    await expect(boss.searchJobs({ keyword: '外贸', cityCode: '101090100' })).rejects.toMatchObject({ code: 'SOURCE_SESSION_INVALID' });

    const captcha = makeFetch(() =>
      jsonResponse({ ok: false, data: null, error: { code: 'CAPTCHA_REQUIRED', message: '需要极验', details: {} }, meta: {} }, 409),
    );
    const boss2 = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: captcha.impl, now: clock.now, sleep: clock.sleep });
    await expect(boss2.searchJobs({ keyword: '外贸', cityCode: '101090100' })).rejects.toBeInstanceOf(LeadError);
    await expect(boss2.searchJobs({ keyword: '外贸', cityCode: '101090100' })).rejects.toMatchObject({ code: 'SOURCE_VERIFICATION_PENDING' });
  });

  it('429 退避重试：第一次 429（retryAfterMs=1）→ 第二次成功', async () => {
    const clock = makeClock();
    let attempt = 0;
    const { impl, calls } = makeFetch(() => {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse(
          { ok: false, data: null, error: { code: 'RATE_LIMITED', message: 'limited', retryable: true, details: { retryAfterMs: 1 } }, meta: {} },
          429,
        );
      }
      return jsonResponse(bossSearchResponse());
    });
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchJobs({ keyword: '外贸', cityCode: '101090100' });
    expect(res.queryId).toBe('q_test_1');
    expect(calls).toHaveLength(2);
    expect(clock.sleeps.some((ms) => ms <= 60_000)).toBe(true);
  });

  it('5xx 重试 3 次后抛 SOURCE_UNAVAILABLE', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() => jsonResponse({ ok: false, data: null, error: { code: 'INTERNAL', message: 'boom' }, meta: {} }, 500));
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    await expect(adapter.getStatus()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    expect(calls).toHaveLength(3);
  });

  it('限频：第二次请求按页间隔 sleep（Boss ≥2500ms）', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() => jsonResponse(bossStatus()));
    const adapter = new BossAdapter({ baseUrl: 'http://127.0.0.1:8790', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    await adapter.getStatus();
    await adapter.getStatus();
    expect(clock.sleeps.length).toBeGreaterThan(0);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(2_500);
  });
});

describe('ZhilianAdapter', () => {
  it('searchJobs：POST /v1/search/jobs，count 不可靠→totalCount=null，岗位映射', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          query: { queryId: 'q_z_1', keyword: '外贸', cityCode: '565', cityName: '石家庄', pagesFetched: 1, count: 0, hasMore: true },
          jobs: [
            {
              positionNumber: 'CCL1J2',
              jobId: 2,
              title: '外贸经理',
              salaryText: '1-2万',
              salaryMin: 10000,
              salaryMax: 20000,
              education: '本科',
              experience: '3-5年',
              cityName: '石家庄',
              district: '裕华',
              publishTime: '2026-11-14T13:47:27+08:00',
              companyNumber: 'CZL1',
              companyName: '河北测试科技有限公司',
              jobUrl: 'https://www.zhaopin.com/jobdetail/CCL1J2.htm',
            },
          ],
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new ZhilianAdapter({ baseUrl: 'http://127.0.0.1:8791', token: 'token-z', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchJobs({ keyword: '外贸', cityCode: '565', pages: 2 });
    expect(calls[0]?.url).toBe('http://127.0.0.1:8791/v1/search/jobs');
    expect(calls[0]?.headers.authorization).toBe('Bearer token-z');
    expect((calls[0]?.body as { pages: number }).pages).toBe(2);
    expect(res.totalCount).toBeNull();
    expect(res.jobs[0]).toMatchObject({
      platform: 'zhilian',
      platformCompanyId: 'CZL1',
      jobId: 'CCL1J2',
      salaryMin: 10000,
      degree: '本科',
      publishTime: '2026-11-14T13:47:27+08:00',
    });
  });

  it('listRegions：解析 code/name/level/province 字段', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          cities: [
            { code: '565', name: '石家庄', enName: 'SHIJIAZHUANG', province: '河北', level: 'city', isDefault: true },
            { code: '489', name: '全国', enName: '', province: null, level: 'country', isDefault: false },
          ],
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new ZhilianAdapter({ baseUrl: 'http://127.0.0.1:8791', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const regions = await adapter.listRegions();
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ platform: 'zhilian', platformValue: '565', nameZh: '石家庄', level: 'city' });
  });

  it('getStatus：verification.pending → verification_pending', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          loggedIn: true,
          mode: 'logged_in',
          session: { expiresAt: '2026-12-14T23:59:59+08:00' },
          verification: { pending: true, kind: 'edgeone' },
          risk: { blockCount: 0, cooldownUntil: null },
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new ZhilianAdapter({ baseUrl: 'http://127.0.0.1:8791', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const status = await adapter.getStatus();
    expect(status.state).toBe('verification_pending');
    expect(status.loggedIn).toBe(true);
    expect(status.expiresAt).toBe('2026-12-14T23:59:59+08:00');
  });

  it('getCompanyDetail + listCompanyJobs：business/岗位字段映射', async () => {
    const clock = makeClock();
    const detailBody = {
      ok: true,
      data: {
        companyNumber: 'CZL1',
        name: '河北安诺自动化科技有限公司',
        fullName: '河北安诺自动化科技有限公司',
        size: '100-299人',
        cityName: '石家庄',
        address: '赵县新寨店工业园区',
        website: 'www.example.cn',
        intro: '简介',
        tags: [],
        benefits: [],
        jobCount: 6,
        business: {
          registeredName: '河北安诺自动化科技有限公司',
          uscc: '91130100TEST0000F6',
          legalPerson: '安和平',
          registeredCapital: '1200万元人民币',
          businessStatus: '存续',
          createDate: '2016-02-03',
          location: '河北省石家庄市赵县',
          registeredAddress: '河北省/石家庄市/赵县',
          businessScope: '货物或技术进出口',
          industry: '其他未列明专业技术服务业',
          textDerived: true,
        },
      },
      meta: { timestamp: '2026-11-16T05:54:16.489Z' },
      error: null,
    };
    const jobsBody = {
      ok: true,
      data: {
        companyNumber: 'CZL1',
        jobCount: 1,
        jobs: [
          {
            positionNumber: 'CCL1J2',
            title: '外贸业务员',
            salaryText: '4000-8000元',
            salaryMin: 4000,
            salaryMax: 8000,
            education: '大专',
            experience: '1-3年',
            cityName: '石家庄',
            district: '裕华',
            recruiterName: '王*',
            jobUrl: 'https://jobs.zhaopin.com/CCL1J2.htm',
          },
        ],
      },
      meta: {},
      error: null,
    };
    const { impl, calls } = makeFetch((call) => jsonResponse(call.url.endsWith('/jobs') ? jobsBody : detailBody));
    const adapter = new ZhilianAdapter({ baseUrl: 'http://127.0.0.1:8791', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const detail = await adapter.getCompanyDetail('CZL1');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8791/v1/companies/CZL1');
    expect(detail.profile.scale).toBe('100-299人');
    expect(detail.profile.industry).toBe('其他未列明专业技术服务业');
    expect(detail.business?.uscc).toBe('91130100TEST0000F6');
    expect(detail.business?.legalRepresentative).toBe('安和平');
    const jobs = await adapter.listCompanyJobs('CZL1');
    expect(jobs[0]).toMatchObject({ platform: 'zhilian', jobId: 'CCL1J2', salaryMin: 4000, recruiterName: '王*' });
  });
});
