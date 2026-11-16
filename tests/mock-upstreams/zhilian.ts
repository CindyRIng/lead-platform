/**
 * 智联招聘 mock（`:8791`）。响应形状对齐 docs/04 §3.2 与 exploration 实测样例。
 * 注意：真实智联搜索响应的 `count` 字段不可靠（常为 0），mock 同样保留 `count=0`
 * 以验证 LeadPlatform 不依赖该字段。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { findZhilianCompany, type SyntheticCompany, zhilianCompanies } from '../fixtures/companies.js';
import { zhilianJobsFor } from '../fixtures/jobs.js';
import { HEBEI_CITIES, HEBEI_PROVINCE, cityByZhilianCode } from '../fixtures/regions.js';
import {
  MOCK_APP_OPTIONS,
  applyGate,
  installControlRoutes,
  isForceEmpty,
  mockQueryId,
  paginate,
  sendErr,
  sendOk,
} from './common.js';
import type { MockWorld } from './state.js';

const SOURCE = 'zhilian';

function nowIso(): string {
  return new Date().toISOString();
}

function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function currentJobs(company: SyntheticCompany, world: MockWorld) {
  return zhilianJobsFor(company.key, world.scenario.jobRounds.zhilian);
}

function companyLead(company: SyntheticCompany, cityName: string, jobs: ReturnType<typeof zhilianJobsFor>) {
  const z = company.zhilian!;
  return {
    companyNumber: z.companyNumber,
    name: z.sourceName,
    industry: z.industry,
    size: z.size,
    cityName,
    jobCount: jobs.length,
    matchedJobs: jobs.map((j) => ({
      positionNumber: j.positionNumber,
      title: j.title,
      salaryText: j.salaryText,
      cityName: j.cityName,
      publishTime: j.publishTime,
    })),
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
  };
}

export function createZhilianMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/v1/status', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const invalid = world.platforms.zhilian.sessionInvalid;
    return sendOk(reply, {
      loggedIn: !invalid,
      mode: invalid ? 'anonymous' : 'logged_in',
      health: invalid ? 'session_invalid' : 'ok',
      account: { nameMasked: '示例用户', userIdTail: '000' },
      session: {
        profileDir: '/tmp/mock-zhilian/profile',
        startedAt: nowIso(),
        lastCheckedAt: nowIso(),
        atExpiresAt: isoPlusDays(5),
        rtExpiresAt: isoPlusDays(28),
        expiresAt: isoPlusDays(28),
        remainingSec: 2419200,
      },
      verification: { pending: false, kind: null, edgeTokenExpiresAt: isoPlusDays(20) },
      risk: { blockCount: 0 },
      requests: { today: 0, cacheHits: 0, cacheMisses: 0, lastUpstreamAt: nowIso() },
      warnings: invalid ? ['session invalid (mock)'] : [],
      cache: { dbPath: '/tmp/mock-zhilian/cache.db', sizeBytes: 1024, entries: { queries: 0, jobs: 0, companies: 0 } },
    });
  });

  // 区域字典：30 省 + 461 市 + 全国；这里只返回河北相关 + 一个省级 + 全国，够区域注册表用
  app.get('/v1/cities', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const cities = HEBEI_CITIES.map((c) => ({
      code: c.zhilianCode,
      cityCode: c.zhilianCode,
      name: c.shortName,
      cityName: c.shortName,
      level: 'city',
      province: HEBEI_PROVINCE.name,
      provinceCode: HEBEI_PROVINCE.code,
    }));
    const list = [
      { code: HEBEI_PROVINCE.code, cityCode: HEBEI_PROVINCE.code, name: HEBEI_PROVINCE.name, cityName: HEBEI_PROVINCE.name, level: 'province', province: null, provinceCode: null },
      ...cities,
      { code: '000000', cityCode: '000000', name: '全国', cityName: '全国', level: 'country', province: null, provinceCode: null },
    ];
    return sendOk(reply, { cities: list, items: list, total: list.length, count: list.length, fetchedAt: nowIso() });
  });

  app.post('/v1/search/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const body = (req.body ?? {}) as { keyword?: string; cityCode?: string; page?: number; pageSize?: number; pages?: number };
    const keyword = (body.keyword ?? '').trim();
    const cityCode = body.cityCode != null ? String(body.cityCode) : '';
    const city = cityCode ? cityByZhilianCode(cityCode) : undefined;
    const empty = isForceEmpty(world, SOURCE);

    let matched: SyntheticCompany[] = [];
    if (!empty) {
      matched = zhilianCompanies().filter((company) => {
        const z = company.zhilian!;
        if (city && company.cityName !== city.name) return false;
        if (cityCode && !city) return false;
        if (keyword && !z.keywords.some((k) => k === keyword || keyword.includes(k) || k.includes(keyword))) return false;
        return currentJobs(company, world).length > 0;
      });
    }

    const queryId = mockQueryId('zhilian');
    world.scenario.zhilianQueries.set(queryId, {
      keyword,
      cityCode,
      companyIds: matched.map((c) => c.key),
      createdAt: nowIso(),
    });

    const cityName = city?.shortName ?? (cityCode || '');
    const jobs = matched.flatMap((company) => {
      const z = company.zhilian!;
      return currentJobs(company, world).map((j) => ({
        ...j,
        companyNumber: z.companyNumber,
        companyName: z.sourceName,
        companyIndustry: z.industry,
        companySize: z.size,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
      }));
    });
    const companies = matched.map((company) =>
      companyLead(company, city?.shortName ?? company.cityName.replace(/市$/, ''), currentJobs(company, world)),
    );

    return sendOk(reply, {
      query: {
        queryId,
        keyword,
        cityCode,
        cityName,
        sortType: 'JOB_PUBLISH_TIME',
        pageSize: 20,
        pagesFetched: 1,
        hasMore: false,
        // 真实上游该字段不可靠（实测返回 0 但有数据）；保留以验证实现不依赖它
        count: 0,
        anonymous: false,
        fetchedAt: nowIso(),
      },
      jobs,
      companies,
      cached: false,
      pagination: { page: 1, pageSize: 20, total: jobs.length, hasMore: false },
    });
  });

  app.get('/v1/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { queryId?: string; page?: string };
    const query = q.queryId ? world.scenario.zhilianQueries.get(q.queryId) : undefined;
    const keys = query?.companyIds ?? [];
    const jobs = keys.flatMap((key) => {
      const company = zhilianCompanies().find((c) => c.key === key);
      if (!company) return [];
      const z = company.zhilian!;
      return currentJobs(company, world).map((j) => ({ ...j, companyNumber: z.companyNumber, companyName: z.sourceName }));
    });
    const pageData = paginate(jobs, Number(q.page ?? 1), 20);
    return sendOk(reply, {
      query: query
        ? {
            queryId: q.queryId,
            keyword: query.keyword,
            cityCode: query.cityCode,
            pageSize: 20,
            pagesFetched: pageData.page,
            hasMore: pageData.hasMore,
            count: 0,
            fetchedAt: query.createdAt,
          }
        : null,
      jobs: pageData.items,
      cached: false,
      pagination: { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total, hasMore: pageData.hasMore },
    });
  });

  app.get('/v1/companies', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { queryId?: string };
    const query = q.queryId ? world.scenario.zhilianQueries.get(q.queryId) : undefined;
    if (!query) return sendOk(reply, { query: null, companies: [], cached: false, pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } });
    const companies = query.companyIds
      .map((key) => zhilianCompanies().find((c) => c.key === key))
      .filter((c): c is SyntheticCompany => Boolean(c))
      .map((company) => companyLead(company, company.cityName.replace(/市$/, ''), currentJobs(company, world)));
    return sendOk(reply, {
      query: {
        queryId: q.queryId,
        keyword: query.keyword,
        cityCode: query.cityCode,
        pageSize: 20,
        pagesFetched: 1,
        hasMore: false,
        count: 0,
        fetchedAt: query.createdAt,
      },
      companies,
      cached: false,
      pagination: { page: 1, pageSize: 20, total: companies.length, hasMore: false },
    });
  });

  app.get('/v1/companies/:companyNumber', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { companyNumber } = req.params as { companyNumber: string };
    const company = findZhilianCompany(decodeURIComponent(companyNumber));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `zhilian company not found: ${companyNumber}`);
    const z = company.zhilian!;
    const jobs = currentJobs(company, world);
    return sendOk(reply, {
      companyNumber: z.companyNumber,
      name: z.sourceName,
      fullName: company.name,
      logo: 'https://example.invalid/zhilian/logo.png',
      size: z.size,
      cityName: company.cityName.replace(/市$/, ''),
      address: z.address,
      coordinate: { latitude: 38.0, longitude: 114.5 },
      website: z.website,
      intro: z.intro,
      tags: z.tags,
      benefits: z.benefits,
      jobCount: jobs.length,
      hotJobs: jobs.slice(0, 10).map((j) => ({
        positionNumber: j.positionNumber,
        title: j.title,
        salaryText: j.salaryText,
        publishTime: j.publishTime,
        jobUrl: j.jobUrl,
      })),
      business: {
        registeredName: company.name,
        uscc: company.uscc,
        legalPerson: company.legalRepresentative,
        registeredCapital: company.regCapital,
        companyType: '有限责任公司（自然人投资或控股）',
        businessStatus: '存续（在营、开业、在册）',
        createDate: company.foundTime,
        registeredOrg: '示例区市场监督管理局',
        location: company.address,
        registeredAddress: `${company.province}/${company.cityName}/示例区`,
        businessScope: company.businessScope,
        businessPeriod: `${company.foundTime} - 长期`,
        industry: company.industry,
        textDerived: true,
      },
      url: `https://example.invalid/zhilian/company/${z.companyNumber}`,
      fetchedAt: nowIso(),
    });
  });

  app.get('/v1/companies/:companyNumber/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { companyNumber } = req.params as { companyNumber: string };
    const company = findZhilianCompany(decodeURIComponent(companyNumber));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `zhilian company not found: ${companyNumber}`);
    const jobs = currentJobs(company, world);
    return sendOk(reply, { companyNumber: company.zhilian!.companyNumber, jobCount: jobs.length, jobs, truncated: false });
  });

  return app;
}
