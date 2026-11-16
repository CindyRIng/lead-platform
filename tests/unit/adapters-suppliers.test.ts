/**
 * S3 适配器单测：Ali / Mic（mock fetch，绝不打真实上游）。
 * 覆盖：搜索参数（Ali strict/off、Mic province=Hebei）、翻页、详情映射（英文抬头/店铺字段）、错误归一。
 */
import { describe, expect, it } from 'vitest';
import { AliAdapter } from '../../src/adapters/sources/ali.js';
import { MicAdapter } from '../../src/adapters/sources/mic.js';
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

function aliSupplier(overrides: Record<string, unknown> = {}) {
  return {
    companyId: '200267220',
    companyName: 'Hebei Example Industrial Metal Co., Ltd.',
    storeUrl: 'https://ejinshi.en.alibaba.com/company_profile.html',
    storeSubdomain: 'ejinshi',
    logoUrl: 'https://img.example/logo.jpg',
    country: 'CN',
    location: {
      country: 'CN',
      province: 'Hebei',
      provinceCode: 'CN-13',
      city: 'Shijiazhuang',
      cityCode: 'CN-13-1301',
      address: 'Room 608, Tianlin Building',
      display: 'Hebei, China',
      confidence: 'high',
      source: 'detail',
    },
    joinedYears: 18,
    joinedYearsText: '18',
    supplierIndex: { stars: 3, maxStars: 5, label: 'Supplier Index' },
    membership: {
      plan: 'verified_supplier',
      label: 'Verified Supplier',
      rank: 2,
      verifiedSupplier: true,
      verifiedPro: false,
      paidMember: true,
      goldSupplier: true,
      onsiteAssessment: true,
      goldYears: 18,
      assessedBy: 'SGS Group',
    },
    rating: { score: 4.9, count: 25 },
    mainProducts: ['Fence Post', 'Garden Gate'],
    mainProductsText: 'Fence Post, Garden Gate',
    businessType: { raw: 'Manufacturer, Trading Company', manufacturer: true, tradingCompany: true },
    factoryAreaText: '6828m²',
    staffText: null,
    transactionsText: '$14144125',
    responseTime: '≤3h',
    isAd: true,
    position: 1,
    enriched: true,
    identity: { key: 'strengthFactory', name: 'Custom Manufacturer', verified: true },
    profile: {
      establishedYear: 2008,
      annualRevenue: { value: '16274846', kind: 'number' },
      employees: '51 - 100 People',
      mainMarkets: ['Oceania', 'North America'],
      description: '公司简介',
    },
    performance: {
      storeRating: { score: 4.9, count: 25 },
      onTimeDeliveryRate: '100.0%',
      responseRate: '96.99%',
      totalExportRevenueUSD: 14144125,
      floorSpaceM2: 6828,
    },
    capabilities: null,
    trust: null,
    ...overrides,
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

describe('AliAdapter', () => {
  it('searchSuppliers：province → strict 默认；参数 pages/maxEnrich/country 正确', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          queryId: 'q_ali_1',
          keyword: 'machinery',
          location: { mode: 'strict', matched: 21 },
          pages: [{ page: 1, totalCount: 739, items: 21 }],
          suppliers: [aliSupplier(), aliSupplier({ companyId: '200267221', companyName: 'Hebei Shengtian Pipe-Fitting Group Co., Ltd.' })],
          stats: { totalCount: 739, returned: 21 },
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 'ali-token', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchSuppliers({ province: 'Hebei', keyword: 'machinery', pages: 5, maxEnrich: 60 });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8792/v1/search/suppliers');
    expect(calls[0]?.headers.authorization).toBe('Bearer ali-token');
    expect(calls[0]?.body).toMatchObject({ province: 'Hebei', keyword: 'machinery', pages: 5, maxEnrich: 60, locationMode: 'strict', country: 'CN' });
    expect(res.queryId).toBe('q_ali_1');
    expect(res.locationMode).toBe('strict');
    expect(res.totalCount).toBe(739);
    expect(res.suppliers).toHaveLength(2);
    expect(res.suppliers[0]).toMatchObject({
      platform: 'ali',
      platformCompanyId: '200267220',
      companyName: 'Hebei Example Industrial Metal Co., Ltd.',
      cityName: 'Shijiazhuang',
    });
    expect(res.suppliers[0]?.evidence.membership).toMatchObject({ verifiedSupplier: true, paidMember: true });
  });

  it('searchSuppliers：仅 keyword（地理种子）→ locationMode=off', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, data: { queryId: 'q_seed', keyword: 'shijiazhuang', pages: [{ page: 1, totalCount: 100, items: 20 }], suppliers: [aliSupplier()], stats: { totalCount: 100 } }, meta: {}, error: null }),
    );
    const adapter = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchSuppliers({ keyword: 'shijiazhuang', pages: 5 });
    expect(res.locationMode).toBe('off');
    expect(calls[0]?.body).toMatchObject({ keyword: 'shijiazhuang', locationMode: 'off', pages: 5 });
  });

  it('listSuppliers：GET /v1/suppliers?queryId=&page= 翻页映射', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, data: { queryId: 'q_ali_1', page: 2, pageSize: 20, totalCount: 739, suppliers: [aliSupplier()], hasMore: true }, meta: {}, error: null }),
    );
    const adapter = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.listSuppliers('q_ali_1', 2);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8792/v1/suppliers?queryId=q_ali_1&page=2');
    expect(res.page).toBe(2);
    expect(res.hasMore).toBe(true);
    expect(res.suppliers[0]?.platform).toBe('ali');
  });

  it('getSupplierDetail：store JSON 字段映射（joinedYears/membership/rating/performance/profile）', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() => jsonResponse({ ok: true, data: aliSupplier(), meta: { fetched_at: '2026-11-16T13:54:09+08:00' }, error: null }));
    const adapter = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const detail = await adapter.getSupplierDetail('200267220');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8792/v1/suppliers/200267220');
    expect(detail.platformCompanyId).toBe('200267220');
    expect(detail.profile.displayName).toBe('Hebei Example Industrial Metal Co., Ltd.');
    expect(detail.profile.cityName).toBe('Shijiazhuang');
    const store = detail.profile.store as Record<string, unknown>;
    expect(store.joinedYears).toBe(18);
    expect(store.membership).toMatchObject({ verifiedSupplier: true, goldYears: 18 });
    expect(store.rating).toMatchObject({ score: 4.9, count: 25 });
    expect(store.supplierIndex).toMatchObject({ stars: 3 });
    expect(store.performance).toMatchObject({ onTimeDeliveryRate: '100.0%', floorSpaceM2: 6828 });
    expect(store.profile).toMatchObject({ establishedYear: 2008 });
    expect(detail.business).toBeNull();
  });

  it('listRegions：解析 CN-13 / CN-13-1301', async () => {
    const clock = makeClock();
    const { impl } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          items: [
            { code: 'CN-13', level: 'province', nameZh: '河北', nameEn: 'Hebei', aliases: ['河北', 'Hebei'], parentCode: 'CN' },
            { code: 'CN-13-1301', level: 'city', nameZh: '石家庄市', nameEn: 'Shijiazhuang', aliases: ['石家庄'], parentCode: 'CN-13' },
          ],
        },
        meta: {},
        error: null,
      }),
    );
    const adapter = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const regions = await adapter.listRegions();
    expect(regions).toHaveLength(2);
    expect(regions[1]).toMatchObject({ platform: 'ali', platformValue: 'CN-13-1301', nameZh: '石家庄市', level: 'city' });
  });

  it('错误归一：captcha 409 → SOURCE_VERIFICATION_PENDING；429 → UPSTREAM_RATE_LIMITED', async () => {
    const clock = makeClock();
    const captcha = makeFetch(() =>
      jsonResponse({ ok: false, data: null, error: { code: 'CAPTCHA_REQUIRED', message: 'slider', retryable: true, details: {} }, meta: {} }, 409),
    );
    const ali = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: captcha.impl, now: clock.now, sleep: clock.sleep });
    await expect(ali.searchSuppliers({ province: 'Hebei' })).rejects.toMatchObject({ code: 'SOURCE_VERIFICATION_PENDING' });

    const limited = makeFetch(() =>
      jsonResponse({ ok: false, data: null, error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true, details: { retryAfterMs: 1 } }, meta: {} }, 429),
    );
    const ali2 = new AliAdapter({ baseUrl: 'http://127.0.0.1:8792', token: 't', fetchImpl: limited.impl, now: clock.now, sleep: clock.sleep });
    await expect(ali2.searchSuppliers({ province: 'Hebei' })).rejects.toMatchObject({ code: 'UPSTREAM_RATE_LIMITED' });
  });
});

function micItem(overrides: Record<string, unknown> = {}) {
  return {
    account: 'htwirecable',
    company_id: '1932377254',
    encode_com_id: 'rZYtXWgHXuDB',
    company_name: 'Hebei Huatong Wires & Cables Group Co., Ltd.',
    province: 'Hebei',
    city: 'Tangshan',
    country: 'China',
    main_products: ['Power Cable', 'Electric Cable'],
    business_types: ['Manufacturer/Factory'],
    membership: { tier: 'diamond', raw_cs_level: 50, since_year: null, evidence: ['json:csLevel=50'], confidence: 'high' },
    audited: true,
    capability_stars: 3,
    system_certifications: ['ISO 9001', 'ISO 14001'],
    employees: null,
    turnover: null,
    plant_area: null,
    company_url: 'https://m.made-in-china.com/company-htwirecable/',
    company_info_url: 'https://m.made-in-china.com/company-htwirecable/info.html',
    detail_source: 'json',
    is_ad: false,
    ...overrides,
  };
}

describe('MicAdapter', () => {
  it('searchFactories：GET /api/search/factories?province=Hebei&page=&page_size=，英文抬头映射', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({
        ok: true,
        data: {
          query: { keyword: null, keyword_effective: 'hebei', province: 'Hebei', province_zh: '河北', city: null, search_mode: 'region', page: 1, page_size: 20 },
          pagination: { page: 1, page_size: 20, total: 1101, total_page: 56, has_more: true },
          items: [micItem()],
        },
        meta: { request_id: 'req_1', cached: true },
        error: null,
      }),
    );
    const adapter = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.searchFactories({ province: 'Hebei', page: 1, pageSize: 20 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.url).toContain('http://127.0.0.1:8899/api/search/factories?');
    expect(calls[0]?.url).toContain('province=Hebei');
    expect(calls[0]?.url).toContain('page=1');
    expect(calls[0]?.url).toContain('page_size=20');
    expect(res.total).toBe(1101);
    expect(res.totalPages).toBe(56);
    expect(res.hasMore).toBe(true);
    expect(res.items[0]).toMatchObject({
      platform: 'mic',
      platformCompanyId: 'htwirecable',
      companyName: 'Hebei Huatong Wires & Cables Group Co., Ltd.',
      cityName: 'Tangshan',
    });
    expect(res.items[0]?.evidence).toMatchObject({ audited: true, capabilityStars: 3, membership: { tier: 'diamond' } });
  });

  it('searchFactories：city 关键词透传 + business_type/audited 过滤参数', async () => {
    const clock = makeClock();
    const { impl, calls } = makeFetch(() =>
      jsonResponse({ ok: true, data: { query: {}, pagination: { page: 1, page_size: 20, total: 10, total_page: 1, has_more: false }, items: [] }, meta: {}, error: null }),
    );
    const adapter = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    await adapter.searchFactories({ province: 'Hebei', keyword: 'langfang', audited: true, businessType: 'trading_company' });
    expect(calls[0]?.url).toContain('keyword=langfang');
    expect(calls[0]?.url).toContain('audited=true');
    expect(calls[0]?.url).toContain('business_type=trading_company');
  });

  it('getCompanyDetail：include=audit,response + store 字段映射（会员/认证/能力/地址）', async () => {
    const clock = makeClock();
    const detail = {
      ...micItem(),
      address: 'Tangshan, Hebei, China',
      established_at: null,
      business_types: ['Manufacturer/Factory & Trading Company'],
      enrichment: {
        audit: { audited: true, audited_section_count: 8 },
        response: { avg_response_hours: 4.63, timely_reply_ratio: 0.859 },
        contacts: null,
        reviews: null,
      },
      availability: [{ field: 'employees', reason: 'not_provided_by_supplier' }],
    };
    const { impl, calls } = makeFetch(() => jsonResponse({ ok: true, data: detail, meta: { request_id: 'req_2', fetched_at: '2026-11-16T13:54:09+08:00' }, error: null }));
    const adapter = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const res = await adapter.getCompanyDetail('htwirecable');
    expect(calls[0]?.url).toBe('http://127.0.0.1:8899/api/companies/htwirecable?include=audit%2Cresponse');
    expect(res.platformCompanyId).toBe('htwirecable');
    expect(res.profile.displayName).toBe('Hebei Huatong Wires & Cables Group Co., Ltd.');
    expect(res.profile.cityName).toBe('Tangshan');
    const store = res.profile.store as Record<string, unknown>;
    expect(store.membership).toMatchObject({ tier: 'diamond' });
    expect(store.audited).toBe(true);
    expect(store.capabilityStars).toBe(3);
    expect(store.certifications).toEqual(['ISO 9001', 'ISO 14001']);
    expect(store.location).toMatchObject({ province: 'Hebei', city: 'Tangshan' });
    // contacts 不作交付联系人（默认 include 不含 contacts）
    const enrichment = store.enrichment as Record<string, unknown>;
    expect(enrichment.contacts).toBeNull();
  });

  it('listRegions：省列表 + province=Hebei 城市列表', async () => {
    const clock = makeClock();
    const provinces = {
      ok: true,
      data: {
        count: 32,
        provinces: [
          { name: 'Hebei', name_zh: '河北', api_value: 'Hebei', city_count: 11, cities_complete: true, source: 'seo_facet' },
          { name: 'Shandong', name_zh: '山东', api_value: 'Shandong', city_count: null, cities_complete: false, source: 'refine' },
        ],
      },
      meta: {},
      error: null,
    };
    const hebei = {
      ok: true,
      data: {
        province: { name: 'Hebei', name_zh: '河北', api_value: 'Hebei', city_count: 11, cities_complete: true },
        cities: [
          { name: 'Shijiazhuang', name_zh: '石家庄', province: 'Hebei', verified: true },
          { name: 'Tangshan', name_zh: '唐山', province: 'Hebei', verified: true },
        ],
      },
      meta: {},
      error: null,
    };
    const { impl, calls } = makeFetch((call) => jsonResponse(call.url.includes('province=') ? hebei : provinces));
    const adapter = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: impl, now: clock.now, sleep: clock.sleep });
    const list = await adapter.listRegions();
    expect(calls[0]?.url).toBe('http://127.0.0.1:8899/api/regions');
    expect(list[0]).toMatchObject({ platform: 'mic', platformValue: 'Hebei', level: 'province', nameZh: '河北' });
    const cities = await adapter.listRegions('Hebei');
    expect(cities.find((c) => c.level === 'city')).toMatchObject({ platformValue: 'Shijiazhuang', nameZh: '石家庄', parentCode: 'Hebei' });
  });

  it('错误归一：NEED_HUMAN_VERIFICATION 409 → SOURCE_VERIFICATION_PENDING；5xx→SOURCE_UNAVAILABLE', async () => {
    const clock = makeClock();
    const needHuman = makeFetch(() =>
      jsonResponse({ ok: false, error: { code: 'NEED_HUMAN_VERIFICATION', message: '需要 mic auth', details: null }, meta: {} }, 409),
    );
    const mic = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: needHuman.impl, now: clock.now, sleep: clock.sleep });
    await expect(mic.searchFactories({ province: 'Hebei' })).rejects.toMatchObject({ code: 'SOURCE_VERIFICATION_PENDING' });

    const down = makeFetch(() => jsonResponse({ ok: false, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'boom' }, meta: {} }, 503));
    const mic2 = new MicAdapter({ baseUrl: 'http://127.0.0.1:8899', fetchImpl: down.impl, now: clock.now, sleep: clock.sleep });
    await expect(mic2.getStatus()).rejects.toBeInstanceOf(LeadError);
    await expect(mic2.getStatus()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
});
