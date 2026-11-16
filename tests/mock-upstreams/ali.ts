/**
 * 阿里巴巴国际站 mock（`:8792`）。响应形状对齐 docs/04 §3.3 与 exploration 实测样例。
 *
 * 关键行为：
 *  - `POST /v1/search/suppliers` 支持 province / city / keyword / locationMode；
 *  - `GET /v1/suppliers?queryId=&page=N` 翻页；
 *  - `GET /v1/suppliers/{companyId}` 店铺详情（英文抬头 + store 字段）；
 *  - `GET /v1/regions` 区域字典（CN-13 / CN-13-13xx）。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { aliCompanies, findAliCompany, type SyntheticCompany } from '../fixtures/companies.js';
import { HEBEI_CITIES, HEBEI_PROVINCE } from '../fixtures/regions.js';
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

const SOURCE = 'ali';

function nowIso(): string {
  return new Date().toISOString();
}

function supplierSummary(company: SyntheticCompany) {
  const a = company.ali!;
  return {
    companyId: a.companyId,
    companyName: a.companyName,
    storeUrl: `https://example.invalid/ali/${a.storeSubdomain}`,
    storeSubdomain: a.storeSubdomain,
    logoUrl: 'https://example.invalid/ali/logo.png',
    country: 'CN',
    location: a.location,
    joinedYears: a.joinedYears,
    joinedYearsText: String(a.joinedYears),
    supplierIndex: a.supplierIndex,
    membership: a.membership,
    mainProducts: a.mainProducts,
    mainProductsText: a.mainProducts.join(', '),
    rating: a.rating,
    businessType: a.businessType,
  };
}

function supplierDetail(company: SyntheticCompany) {
  const a = company.ali!;
  return {
    ...supplierSummary(company),
    profile: a.profile,
    performance: a.performance,
    capabilities: a.capabilities,
    trust: a.trust,
    identity: a.identity,
    fetchedAt: nowIso(),
  };
}

function provinceMatches(value: string | null | undefined): boolean {
  if (!value) return true;
  const v = value.trim().toLowerCase();
  return ['河北', '河北省', 'hebei', 'cn-13', 'cn13'].includes(v);
}

function cityMatches(company: SyntheticCompany, value: string): boolean {
  const a = company.ali!;
  const v = value.trim().toLowerCase();
  return (
    a.location.cityCode.toLowerCase() === v ||
    a.location.city.toLowerCase() === v ||
    a.location.city.toLowerCase().includes(v) ||
    HEBEI_CITIES.some((c) => c.aliNameEn.toLowerCase() === v && c.code === a.location.cityCode)
  );
}

function keywordMatches(company: SyntheticCompany, keyword: string): boolean {
  const a = company.ali!;
  const k = keyword.trim().toLowerCase();
  if (!k) return true;
  if (a.keywords.some((x) => x.toLowerCase() === k || x.toLowerCase().includes(k) || k.includes(x.toLowerCase()))) return true;
  return a.mainProducts.some((p) => p.toLowerCase().includes(k));
}

export function createAliMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/v1/status', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const invalid = world.platforms.ali.sessionInvalid;
    return sendOk(reply, {
      mode: 'anonymous',
      loggedIn: false,
      account: null,
      language: 'en-US',
      profile: { dir: '/tmp/mock-ali/profile', present: true, lockedByPid: null },
      browser: { running: !invalid, pid: 1000, headless: true, uptimeMs: 60000 },
      worker: { url: 'https://example.invalid/ali/search', ready: !invalid, fetchHealthy: !invalid, lastFetchHungAt: null },
      risk: {
        state: invalid ? 'cooldown' : 'normal',
        x5secExpiresAt: null,
        cooldownUntil: invalid ? new Date(Date.now() + 3600_000).toISOString() : null,
        captchaRequired: invalid,
        lastSolvedAt: null,
        lastError: invalid ? 'mock session invalid' : null,
      },
      upstream: { requestsLast10Min: 0, lastPageNavAt: null, lastFetchAt: null, lastDetailAt: null, events: [] },
      cache: { driver: 'sqlite', queries: 0, suppliers: 0, details: 0, factories: 0, bytes: 0 },
      version: '0.1.0-mock',
    });
  });

  app.get('/v1/regions', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const province = {
      code: HEBEI_PROVINCE.aliCode,
      nameZh: HEBEI_PROVINCE.name,
      nameEn: HEBEI_PROVINCE.aliNameEn,
      pinyin: 'hebei',
      aliases: ['河北', '河北省', 'Hebei', 'HEBEI', 'hebei'],
      aliSpellings: ['Hebei', 'HEBEI'],
      level: 'province',
      parentCode: 'CN',
    };
    const cities = HEBEI_CITIES.map((c) => ({
      code: c.aliCode,
      nameZh: c.name,
      nameEn: c.aliNameEn,
      pinyin: c.aliNameEn.toLowerCase(),
      aliases: [c.name, c.name.replace(/市$/, ''), c.aliNameEn, c.aliNameEn.toUpperCase()],
      aliSpellings: [c.aliNameEn],
      level: 'city',
      parentCode: HEBEI_PROVINCE.aliCode,
    }));
    const regions = [province, ...cities];
    return sendOk(reply, { regions, items: regions, total: regions.length, fetchedAt: nowIso() });
  });

  app.post('/v1/search/suppliers', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const body = (req.body ?? {}) as {
      province?: string | null;
      city?: string | null;
      keyword?: string | null;
      locationMode?: string;
      country?: string;
      pages?: number;
      maxEnrich?: number;
    };
    const empty = isForceEmpty(world, SOURCE);
    const province = body.province ?? null;
    const city = body.city ?? null;
    const keyword = body.keyword ?? null;
    const locationMode = body.locationMode ?? 'strict';

    let matched: SyntheticCompany[] = [];
    if (!empty && provinceMatches(province)) {
      matched = aliCompanies().filter((company) => {
        if (city && !cityMatches(company, city)) return false;
        if (keyword && !keywordMatches(company, keyword)) return false;
        return true;
      });
      // locationMode=strict 时丢弃城市未知的公司（mock 中全部已知，仅保留语义）
      if (locationMode === 'strict') matched = matched.filter((c) => Boolean(c.ali?.location.city));
    }

    const queryId = mockQueryId('ali');
    world.scenario.aliQueries.set(queryId, {
      province: province ? String(province) : null,
      city: city ? String(city) : null,
      keyword: keyword ? String(keyword) : null,
      supplierIds: matched.map((c) => c.ali!.companyId),
      createdAt: nowIso(),
    });

    const suppliers = matched.map(supplierSummary);
    const effectiveKeyword = keyword ?? (province ? HEBEI_PROVINCE.aliNameEn : null);
    return sendOk(reply, {
      queryId,
      keyword: keyword ?? null,
      effectiveKeyword,
      location: {
        requested: { province, city },
        normalized: {
          province: province
            ? { code: HEBEI_PROVINCE.aliCode, level: 'province', nameZh: '河北', nameEn: HEBEI_PROVINCE.aliNameEn, parentCode: 'CN' }
            : null,
          city: null,
        },
        mode: locationMode,
        includeUnknownCity: true,
        enrichedCompanies: suppliers.length,
        matched: suppliers.length,
        unknownLocation: 0,
        limitReached: false,
        confidence: 'high',
      },
      pages: [
        {
          page: 1,
          totalCount: suppliers.length,
          items: suppliers.length,
          ads: 0,
          fetchedAt: nowIso(),
          cached: false,
        },
      ],
      suppliers,
      stats: { elapsedMs: 1, detailEnrichment: suppliers.length },
    });
  });

  // 翻页：GET /v1/suppliers?queryId=...&page=N
  app.get('/v1/suppliers', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { queryId?: string; page?: string };
    const query = q.queryId ? world.scenario.aliQueries.get(q.queryId) : undefined;
    const ids = query?.supplierIds ?? [];
    const companies = ids
      .map((id) => findAliCompany(id))
      .filter((c): c is SyntheticCompany => Boolean(c));
    const pageData = paginate(companies, Number(q.page ?? 1), 20);
    return sendOk(reply, {
      queryId: q.queryId ?? null,
      keyword: query?.keyword ?? null,
      pages: [{ page: pageData.page, totalCount: companies.length, items: pageData.items.length, ads: 0, fetchedAt: nowIso(), cached: false }],
      suppliers: pageData.items.map(supplierSummary),
      cached: false,
      pagination: { page: pageData.page, pageSize: pageData.pageSize, total: pageData.total, hasMore: pageData.hasMore },
    });
  });

  app.get('/v1/suppliers/:companyId', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { companyId } = req.params as { companyId: string };
    const company = findAliCompany(decodeURIComponent(companyId));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `ali supplier not found: ${companyId}`);
    return sendOk(reply, supplierDetail(company));
  });

  return app;
}
