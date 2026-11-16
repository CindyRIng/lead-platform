/**
 * 中国制造网 adapter（mic-client :8899，无鉴权、仅 loopback）。
 *
 * 端点（docs/04 §3.4、mic-client docs/03）：
 * - GET /api/version                              健康/版本（无 status）
 * - GET /api/regions[?province=]                  区域字典（32 省英文 api_value；河北 11 市 cities_complete=true）
 * - GET /api/search/factories                     工厂/贸易公司检索（keyword/province/city 至少一个）
 * - GET /api/companies/{account}?include=...      公司详情（英文抬头 + 会员/认证/能力；contacts 不作交付联系方式）
 *
 * 注意：
 * - 地区检索建议按省（城市过滤会损失召回）；城市字段随结果返回后本地映射/标注；
 * - page_size 上游原生 20；Mic 有本地缓存，默认请求间隔 ~1.8s（限频由 http 层令牌桶保证）。
 */
import { createHttpClient, type UpstreamHttpClient } from '../http.js';
import { nowIso } from '../../shared/time.js';
import type { SourceLead } from '../../shared/domain.js';
import {
  asNumber,
  asRecord,
  asStringArray,
  asText,
  emptyProfileFields,
  SOURCE_RATE_LIMITS,
  type AdapterOptions,
  type MicSearchResult,
  type MicSource,
  type PlatformCompanyDetail,
  type PlatformRegion,
  type SourceStatus,
} from './types.js';

interface MicListItemRaw {
  account: string;
  company_id?: string | null;
  encode_com_id?: string | null;
  company_name?: string | null;
  province?: string | null;
  city?: string | null;
  country?: string | null;
  main_products?: string[] | null;
  business_types?: string[] | null;
  membership?: Record<string, unknown> | null;
  audited?: boolean | null;
  capability_stars?: number | null;
  system_certifications?: string[] | null;
  employees?: unknown;
  turnover?: unknown;
  plant_area?: unknown;
  company_url?: string | null;
  company_info_url?: string | null;
  is_ad?: boolean | null;
}

interface MicCompanyDetailRaw extends MicListItemRaw {
  address?: string | null;
  established_at?: string | null;
  enrichment?: Record<string, unknown> | null;
  availability?: unknown;
  include?: string[];
}

function toLead(item: MicListItemRaw): SourceLead {
  return {
    platform: 'mic',
    // 详情端点以 account 为主键（m 站子域名）；company_id 仅作为证据
    platformCompanyId: String(asText(item.account) ?? ''),
    companyName: asText(item.company_name) ?? '',
    cityName: asText(item.city),
    sourceUrl: asText(item.company_url),
    evidence: {
      companyId: asText(item.company_id),
      encodeComId: asText(item.encode_com_id),
      province: asText(item.province),
      country: asText(item.country),
      mainProducts: Array.isArray(item.main_products) ? item.main_products.slice(0, 10) : [],
      businessTypes: asStringArray(item.business_types) ?? [],
      membership: asRecord(item.membership) ?? null,
      audited: item.audited === true,
      capabilityStars: asNumber(item.capability_stars),
      certifications: asStringArray(item.system_certifications) ?? [],
      isAd: item.is_ad === true,
      urls: {
        company: asText(item.company_url),
        info: asText(item.company_info_url),
      },
    },
    raw: item,
  };
}

export class MicAdapter implements MicSource {
  readonly platform = 'mic' as const;
  readonly http: UpstreamHttpClient;

  constructor(opts: AdapterOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      // mic 无鉴权
      token: null,
      source: 'mic',
      timeoutMs: opts.timeoutMs ?? 60_000,
      retry: { maxAttempts: 3, baseDelayMs: 3_000 },
      rate: SOURCE_RATE_LIMITS.mic,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  async getStatus(): Promise<SourceStatus> {
    const res = await this.http.get<Record<string, unknown>>('/api/version');
    const data = res.data ?? {};
    const contract = asRecord(data.upstream_contract) ?? {};
    return {
      platform: 'mic',
      state: 'ok',
      loggedIn: null,
      expiresAt: null,
      checkedAt: nowIso(),
      detail: {
        version: asText(data.version),
        upstreamContractVersion: asText(contract.version),
        upstreamResearchedAt: asText(contract.researched_at),
        cached: res.meta?.cached === true,
      },
    };
  }

  async listRegions(province?: string): Promise<PlatformRegion[]> {
    const res = await this.http.get<Record<string, unknown>>('/api/regions', province ? { province } : undefined);
    const data = res.data ?? {};
    if (!province) {
      const provinces = Array.isArray(data.provinces) ? (data.provinces as Array<Record<string, unknown>>) : [];
      return provinces
        .map((p): PlatformRegion | null => {
          const apiValue = asText(p.api_value) ?? asText(p.name);
          if (!apiValue) return null;
          return {
            regionCode: apiValue,
            platform: 'mic' as const,
            platformValue: apiValue,
            level: 'province' as const,
            nameZh: asText(p.name_zh),
            nameEn: asText(p.name),
            aliases: [],
            parentCode: null,
            raw: p,
          };
        })
        .filter((x): x is PlatformRegion => Boolean(x));
    }
    const provinceRaw = asRecord(data.province) ?? {};
    const provinceValue = asText(provinceRaw.api_value) ?? asText(provinceRaw.name) ?? province;
    const cities = Array.isArray(data.cities) ? (data.cities as Array<Record<string, unknown>>) : [];
    const rows: PlatformRegion[] = [
      {
        regionCode: provinceValue,
        platform: 'mic',
        platformValue: provinceValue,
        level: 'province',
        nameZh: asText(provinceRaw.name_zh),
        nameEn: asText(provinceRaw.name),
        aliases: [],
        parentCode: null,
        raw: provinceRaw,
      },
    ];
    for (const c of cities) {
      const value = asText(c.name) ?? asText(c.api_value);
      if (!value) continue;
      rows.push({
        regionCode: value,
        platform: 'mic',
        platformValue: value,
        level: 'city',
        nameZh: asText(c.name_zh),
        nameEn: asText(c.name),
        aliases: [],
        parentCode: provinceValue,
        raw: c,
      });
    }
    return rows;
  }

  async searchFactories(input: {
    keyword?: string | null;
    province?: string | null;
    city?: string | null;
    page?: number;
    pageSize?: number;
    audited?: boolean;
    businessType?: string;
  }): Promise<MicSearchResult> {
    const query: Record<string, string | number | boolean> = { page: input.page ?? 1, page_size: input.pageSize ?? 20 };
    if (input.keyword) query.keyword = input.keyword;
    if (input.province) query.province = input.province;
    if (input.city) query.city = input.city;
    if (input.audited != null) query.audited = input.audited;
    if (input.businessType) query.business_type = input.businessType;
    const res = await this.http.get<Record<string, unknown>>('/api/search/factories', query);
    const data = res.data ?? {};
    const pagination = asRecord(data.pagination) ?? {};
    const items = Array.isArray(data.items) ? (data.items as MicListItemRaw[]) : [];
    const queryEcho = asRecord(data.query) ?? {};
    return {
      platform: 'mic',
      keyword: asText(queryEcho.keyword),
      province: asText(queryEcho.province),
      city: asText(queryEcho.city),
      page: asNumber(pagination.page) ?? input.page ?? 1,
      pageSize: asNumber(pagination.page_size) ?? input.pageSize ?? 20,
      total: asNumber(pagination.total),
      totalPages: asNumber(pagination.total_page),
      hasMore: pagination.has_more === true,
      items: items.map(toLead),
      raw: data,
    };
  }

  async getCompanyDetail(account: string, include: string[] = ['audit', 'response']): Promise<PlatformCompanyDetail> {
    const includeParam = include.length > 0 ? include.join(',') : 'none';
    const res = await this.http.get<MicCompanyDetailRaw>(`/api/companies/${encodeURIComponent(account)}`, {
      include: includeParam,
    });
    const d = res.data ?? ({} as MicCompanyDetailRaw);
    const membership = asRecord(d.membership);
    const enrich = asRecord(d.enrichment);
    const profile = emptyProfileFields('active', asText(asRecord(res.meta)?.fetched_at));
    profile.displayName = asText(d.company_name);
    profile.sourceUrl = asText(d.company_url);
    profile.fullName = asText(d.company_name);
    profile.cityName = asText(d.city);
    profile.address = asText(d.address);
    profile.scale = asText(d.employees);
    profile.stage = asText(membership?.tier);
    profile.tags = asStringArray(d.system_certifications);
    profile.store = {
      membership: membership ?? null,
      audited: d.audited === true,
      capabilityStars: asNumber(d.capability_stars),
      certifications: asStringArray(d.system_certifications) ?? [],
      businessTypes: asStringArray(d.business_types) ?? [],
      mainProducts: Array.isArray(d.main_products) ? d.main_products : null,
      establishedAt: asText(d.established_at),
      employees: asText(d.employees),
      turnover: asText(d.turnover),
      plantArea: asText(d.plant_area),
      location: { address: asText(d.address), province: asText(d.province), city: asText(d.city) },
      urls: { company: asText(d.company_url), info: asText(d.company_info_url) },
      // 仅作来源证据，不作交付联系人（交付以探迹解锁为准）
      enrichment: enrich ?? null,
      availability: d.availability ?? null,
      raw: d,
    };
    const fetchedAt = asText(asRecord(res.meta)?.fetched_at) ?? asText(asRecord(res.meta)?.timestamp) ?? nowIso();
    return {
      platform: 'mic',
      platformCompanyId: String(asText(d.account) ?? account),
      displayName: profile.displayName,
      sourceUrl: profile.sourceUrl,
      profile,
      jobs: [],
      business: null,
      raw: d,
      fetchedAt,
    };
  }
}
