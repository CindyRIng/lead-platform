/**
 * 中国制造网（Made-in-China）mock（`:8899`）。响应形状对齐 docs/04 §3.4 与 exploration 实测样例。
 * 注意：mic 的 envelope meta 用 snake_case（api_version 等），业务数据本身也以 snake_case 为主。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { findMicCompany, micCompanies, type SyntheticCompany } from '../fixtures/companies.js';
import { HEBEI_CITIES, HEBEI_PROVINCE } from '../fixtures/regions.js';
import {
  MOCK_APP_OPTIONS,
  applyGate,
  installControlRoutes,
  isForceEmpty,
  sendErr,
  sendOk,
} from './common.js';
import type { MockWorld } from './state.js';

const SOURCE = 'mic';

function nowIso(): string {
  return new Date().toISOString();
}

function factoryItem(company: SyntheticCompany) {
  const m = company.mic!;
  return {
    account: m.account,
    company_id: m.companyId,
    encode_com_id: `enc_${m.account}`,
    company_name: m.companyName,
    province: 'Hebei',
    province_zh: HEBEI_PROVINCE.shortName,
    city: m.city,
    country: 'China',
    main_products: m.mainProducts,
    business_types: m.businessTypes,
    membership: m.membership,
    audited: m.audited,
    capability_stars: m.capabilityStars,
    system_certifications: m.systemCertifications,
    employees: m.employees,
    turnover: m.turnover,
    plant_area: m.plantArea,
    company_url: m.companyUrl,
    company_info_url: m.companyInfoUrl,
    detail_source: 'mock',
    is_ad: false,
  };
}

function micCityMatches(company: SyntheticCompany, city: string): boolean {
  const m = company.mic!;
  const v = city.trim().toLowerCase();
  if (m.city.toLowerCase() === v) return true;
  return HEBEI_CITIES.some((c) => c.micName.toLowerCase() === v && c.name === company.cityName);
}

export function createMicMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/api/version', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    return sendOk(reply, {
      name: 'mic-client',
      version: '1.0.8-mock',
      api_version: 'v1',
      build: { commit: null, built_at: null },
      node_version: process.version,
      upstream_contract: {
        version: '2026-11-15',
        researched_at: '2026-11-15T22:50:00+08:00',
        notes: 'mock upstream for tests',
      },
    });
  });

  app.get('/api/regions', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { province?: string };
    const province = q.province;
    if (!province) {
      const provinces = [
        { api_value: HEBEI_PROVINCE.micValue, name_zh: HEBEI_PROVINCE.shortName, name: HEBEI_PROVINCE.micValue, city_count: 11, cities_complete: true },
        { api_value: 'Shandong', name_zh: '山东', name: 'Shandong', city_count: 17, cities_complete: false },
        { api_value: 'Zhejiang', name_zh: '浙江', name: 'Zhejiang', city_count: 11, cities_complete: false },
      ];
      return sendOk(reply, { provinces, items: provinces, total: provinces.length, fetched_at: nowIso() });
    }
    const known = province.trim().toLowerCase() === 'hebei' || province.trim() === '河北';
    const cities = known
      ? HEBEI_CITIES.map((c) => ({
          api_value: c.micName,
          name: c.micName,
          name_zh: c.name,
          city_zh: c.shortName,
        }))
      : [];
    return sendOk(reply, {
      province: known ? HEBEI_PROVINCE.micValue : province,
      province_zh: known ? HEBEI_PROVINCE.shortName : null,
      cities,
      items: cities,
      city_count: cities.length,
      cities_complete: known,
      source: known ? 'seo_facet' : 'none',
      fetched_at: nowIso(),
    });
  });

  app.get('/api/search/factories', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as {
      province?: string;
      city?: string;
      keyword?: string;
      page?: string;
      page_size?: string;
      pageSize?: string;
    };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(q.page_size ?? q.pageSize ?? 20) || 20));
    const empty = isForceEmpty(world, SOURCE);
    const provinceValue = (q.province ?? '').trim();
    const cityValue = (q.city ?? '').trim();
    const keyword = (q.keyword ?? '').trim().toLowerCase();

    let items: ReturnType<typeof factoryItem>[] = [];
    if (!empty) {
      const provinceOk = !provinceValue || ['hebei', '河北', '河北省'].includes(provinceValue.toLowerCase()) || provinceValue === '河北';
      const matched = provinceOk
        ? micCompanies().filter((company) => {
            if (cityValue && !micCityMatches(company, cityValue)) return false;
            if (keyword) {
              const hay = [company.mic!.companyName, ...company.mic!.mainProducts, ...company.mic!.businessTypes].join(' ').toLowerCase();
              if (!hay.includes(keyword)) return false;
            }
            return true;
          })
        : [];
      items = matched.map(factoryItem);
    }
    const total = items.length;
    const totalPage = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    const pageItems = items.slice(start, start + pageSize);
    return sendOk(reply, {
      query: {
        keyword: q.keyword ?? null,
        keyword_effective: keyword || (provinceValue ? provinceValue.toLowerCase() : null),
        province: provinceValue || null,
        province_zh: provinceValue ? HEBEI_PROVINCE.shortName : null,
        city: cityValue || null,
        city_zh: null,
        search_mode: keyword ? 'keyword' : 'region',
        region_validated: true,
        filters: {},
        page,
        page_size: pageSize,
        refresh: false,
        include_ads: true,
      },
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_page: totalPage,
        has_more: page < totalPage,
        total_capped: false,
        total_display: String(total),
        page_clamped: false,
        total_is_lower_bound: false,
      },
      items: pageItems,
    });
  });

  app.get('/api/companies/:account', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { account } = req.params as { account: string };
    const company = findMicCompany(decodeURIComponent(account));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `mic company not found: ${account}`);
    const m = company.mic!;
    return sendOk(reply, {
      account: m.account,
      company_id: m.companyId,
      encode_com_id: `enc_${m.account}`,
      company_name: m.companyName,
      province: 'Hebei',
      city: m.city,
      country: 'China',
      address: m.address,
      established_at: m.establishedAt,
      main_products: m.mainProducts,
      business_types: m.businessTypes,
      membership: m.membership,
      audited: m.audited,
      capability_stars: m.capabilityStars,
      system_certifications: m.systemCertifications,
      employees: m.employees,
      turnover: m.turnover,
      plant_area: m.plantArea,
      company_url: m.companyUrl,
      company_info_url: m.companyInfoUrl,
      detail_source: 'mock',
      include: ['audit', 'response'],
      enrichment: {
        audit: {
          audited: m.audited,
          sections: [
            { name: 'General Information', audited: true },
            { name: 'Manufacturing Capacity', audited: true },
            { name: 'Quality Control Capacity', audited: m.audited },
          ],
          audited_section_count: m.audited ? 3 : 0,
          agency: null,
          report_no: null,
          verify_url: null,
          source: 'mock',
          fetched_at: nowIso(),
        },
        response: {
          avg_response_hours: 4.5,
          timely_reply_ratio: 0.86,
          range_display: '≤4.5h',
          window_days: 30,
          as_of: '20261116',
          source: 'mock',
          fetched_at: nowIso(),
        },
        contacts: null,
        reviews: null,
      },
      availability: [
        { field: 'established_at', reason: m.establishedAt ? null : 'not_provided_by_supplier' },
        { field: 'employees', reason: m.employees ? null : 'not_provided_by_supplier' },
        { field: 'turnover', reason: m.turnover ? null : 'not_provided_by_supplier' },
        { field: 'plant_area', reason: m.plantArea ? null : 'not_provided_by_supplier' },
      ],
    });
  });

  app.get('/api/cache/stats', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    return sendOk(reply, { entries: micCompanies().length, hits: 0, misses: 0, bytes: 0 });
  });

  return app;
}
