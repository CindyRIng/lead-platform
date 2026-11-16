/**
 * Boss 直聘 mock（`:8790`）。响应形状对齐 docs/04 §3.1 与 exploration 实测样例。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { bossCompanies, findBossCompany, type SyntheticCompany } from '../fixtures/companies.js';
import { bossJobsFor } from '../fixtures/jobs.js';
import { HEBEI_CITIES, cityByBossCode } from '../fixtures/regions.js';
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

const SOURCE = 'boss';

function nowIso(): string {
  return new Date().toISOString();
}

function isoPlusDays(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

function currentJobs(company: SyntheticCompany, world: MockWorld) {
  return bossJobsFor(company.key, world.scenario.jobRounds.boss);
}

function companyLead(company: SyntheticCompany, cityName: string, jobs: ReturnType<typeof bossJobsFor>) {
  const b = company.boss!;
  return {
    companyId: b.companyId,
    name: b.sourceName,
    industry: b.industry,
    scale: b.scale,
    stage: b.stage,
    cityName,
    jobCount: jobs.length,
    matchedJobs: jobs.map((j) => ({
      jobId: j.jobId,
      title: j.title,
      salaryText: j.salaryText,
      cityName: j.cityName,
      bossName: j.recruiterName,
      bossTitle: j.recruiterTitle,
    })),
    firstSeenAt: nowIso(),
    lastSeenAt: nowIso(),
  };
}

export function createBossMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/v1/status', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const invalid = world.platforms.boss.sessionInvalid;
    return sendOk(reply, {
      loggedIn: !invalid,
      health: invalid ? 'session_invalid' : 'ok',
      account: { phoneMasked: '156****0000', nameMasked: '示例用户', isHunter: false, userIdTail: '000' },
      session: {
        profileDir: '/tmp/mock-boss/profile',
        startedAt: nowIso(),
        lastCheckedAt: nowIso(),
        expiresAt: isoPlusDays(5),
        remainingSec: 432000,
      },
      risk: { code37Count: 0 },
      requests: { today: 0, cacheHits: 0, cacheMisses: 0, lastUpstreamAt: nowIso() },
      warnings: invalid ? ['session invalid (mock)'] : [],
      cache: { dbPath: '/tmp/mock-boss/cache.db', sizeBytes: 1024, entries: { queries: 0, jobs: 0, companies: 0 } },
    });
  });

  // 区域字典：刷新结果只有 cityCode/cityName（无 province），与真实 boss-client 一致
  app.get('/v1/cities', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const cities = HEBEI_CITIES.map((c) => ({ cityCode: c.bossCityCode, cityName: c.shortName }));
    return sendOk(reply, {
      cities,
      items: cities,
      total: cities.length,
      fromCache: false,
      fetchedAt: nowIso(),
    });
  });

  app.post('/v1/search/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const body = (req.body ?? {}) as {
      keyword?: string;
      cityCode?: string;
      page?: number;
      pageSize?: number;
      pages?: number;
    };
    const keyword = (body.keyword ?? '').trim();
    const cityCode = body.cityCode != null ? String(body.cityCode) : '';
    const pageSize = Math.max(1, Math.min(100, Number(body.pageSize ?? 20)));
    const city = cityCode ? cityByBossCode(cityCode) : undefined;

    const empty = isForceEmpty(world, SOURCE);
    let matched: SyntheticCompany[] = [];
    if (!empty) {
      matched = bossCompanies().filter((company) => {
        const b = company.boss!;
        if (city && company.cityName !== city.name) return false;
        if (cityCode && !city) return false;
        if (keyword && !b.keywords.some((k) => k === keyword || keyword.includes(k) || k.includes(keyword))) return false;
        return currentJobs(company, world).length > 0;
      });
    }

    const queryId = mockQueryId('boss');
    world.scenario.bossQueries.set(queryId, {
      keyword,
      cityCode,
      companyIds: matched.map((c) => c.key),
      createdAt: nowIso(),
    });

    const cityName = city?.shortName ?? (cityCode ? cityCode : '');
    const jobs = matched.flatMap((company) => {
      const b = company.boss!;
      return currentJobs(company, world).map((j) => ({
        ...j,
        companyId: b.companyId,
        companyName: b.sourceName,
        companyIndustry: b.industry,
        companyScale: b.scale,
        companyStage: b.stage,
        firstSeenAt: nowIso(),
        lastSeenAt: nowIso(),
      }));
    });
    const companies = matched.map((company) => {
      const c = cityByBossCode(cityCode);
      return companyLead(company, c?.shortName ?? company.cityName.replace(/市$/, ''), currentJobs(company, world));
    });

    return sendOk(reply, {
      query: {
        queryId,
        keyword,
        cityCode,
        cityName,
        pageSize,
        pagesFetched: 1,
        resCount: jobs.length,
        totalCount: jobs.length,
        hasMore: false,
        fetchedAt: nowIso(),
      },
      jobs,
      companies,
      pagination: {
        page: 1,
        pageSize,
        total: jobs.length,
        hasMore: false,
        pagesFetched: 1,
        pagesAvailable: 1,
      },
      cached: false,
    });
  });

  app.get('/v1/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { queryId?: string; page?: string };
    const query = q.queryId ? world.scenario.bossQueries.get(q.queryId) : undefined;
    const page = Number(q.page ?? 1);
    const companies = (query?.companyIds ?? []).map((key) => bossCompanies().find((c) => c.key === key)).filter((c): c is SyntheticCompany => Boolean(c));
    const jobs = companies.flatMap((company) => {
      const b = company.boss!;
      return currentJobs(company, world).map((j) => ({ ...j, companyId: b.companyId, companyName: b.sourceName }));
    });
    const pageData = paginate(jobs, page, 20);
    return sendOk(reply, {
      query: query
        ? {
            queryId: q.queryId,
            keyword: query.keyword,
            cityCode: query.cityCode,
            pageSize: 20,
            pagesFetched: pageData.page,
            resCount: jobs.length,
            totalCount: jobs.length,
            hasMore: pageData.hasMore,
            fetchedAt: query.createdAt,
          }
        : null,
      jobs: pageData.items,
      pagination: {
        page: pageData.page,
        pageSize: pageData.pageSize,
        total: pageData.total,
        hasMore: pageData.hasMore,
        pagesFetched: pageData.page,
        pagesAvailable: pageData.totalPage,
      },
    });
  });

  app.get('/v1/companies', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { queryId?: string };
    const query = q.queryId ? world.scenario.bossQueries.get(q.queryId) : undefined;
    if (!query) {
      // 真实 boss-client 对未知 queryId 返回空列表（不报错）
      return sendOk(reply, { query: null, companies: [], pagination: { page: 1, pageSize: 20, total: 0, hasMore: false } });
    }
    const companies = query.companyIds
      .map((key) => bossCompanies().find((c) => c.key === key))
      .filter((c): c is SyntheticCompany => Boolean(c))
      .map((company) => companyLead(company, company.cityName.replace(/市$/, ''), currentJobs(company, world)));
    return sendOk(reply, {
      query: {
        queryId: q.queryId,
        keyword: query.keyword,
        cityCode: query.cityCode,
        pageSize: 20,
        pagesFetched: 1,
        resCount: companies.length,
        totalCount: companies.length,
        hasMore: false,
        fetchedAt: query.createdAt,
      },
      companies,
      pagination: { page: 1, pageSize: 20, total: companies.length, hasMore: false },
    });
  });

  app.get('/v1/companies/:companyId', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { companyId } = req.params as { companyId: string };
    const company = findBossCompany(decodeURIComponent(companyId));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `boss company not found: ${companyId}`);
    const b = company.boss!;
    const jobs = currentJobs(company, world);
    const hotJobs = jobs.slice(0, 10).map((j) => ({
      jobId: j.jobId,
      title: j.title,
      salaryText: j.salaryText,
      experience: j.experience,
      degree: j.degree,
      cityName: j.cityName,
      jobUrl: j.jobUrl,
    }));
    return sendOk(reply, {
      companyId: b.companyId,
      name: b.sourceName,
      fullName: company.name,
      logo: 'https://example.invalid/boss/logo.png',
      industry: b.industry,
      scale: b.scale,
      stage: b.stage,
      cityName: company.cityName.replace(/市$/, ''),
      address: b.address,
      intro: b.intro,
      tags: b.tags,
      benefits: b.benefits,
      jobCount: jobs.length,
      bossCount: b.bossCount,
      hotJobs,
      recruiters: [
        { name: '示例招聘者甲', title: 'HR', online: true },
        { name: '示例招聘者乙', title: '招聘主管', online: false },
      ],
      business: {
        companyName: company.name,
        legalRepresentative: company.legalRepresentative,
        foundedAt: company.foundTime,
        companyType: '有限责任公司（自然人投资或控股）',
        businessStatus: '存续',
        registeredCapital: company.regCapital,
        registeredAddress: company.address,
        businessTerm: `${company.foundTime}至长期`,
        region: company.province,
        uscc: company.uscc,
        usccSource: 'boss_company_page_text',
        textDerived: true,
        businessScope: company.businessScope,
      },
      url: `https://example.invalid/boss/company/${b.companyId}`,
      fetchedAt: nowIso(),
    });
  });

  app.get('/v1/companies/:companyId/jobs', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { companyId } = req.params as { companyId: string };
    const company = findBossCompany(decodeURIComponent(companyId));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `boss company not found: ${companyId}`);
    const jobs = currentJobs(company, world).map((j) => ({
      ...j,
      recruiterName: j.recruiterName,
      recruiterTitle: j.recruiterTitle,
    }));
    return sendOk(reply, {
      companyId: company.boss!.companyId,
      jobCount: jobs.length,
      jobs,
      truncated: false,
    });
  });

  return app;
}
