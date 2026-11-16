/**
 * 阿里国际站 adapter（ali-client :8792，Bearer / anonymous-first）。
 *
 * 端点（docs/04 §3.3、ali-client docs/02）：
 * - GET  /v1/status                         运行态/风控/验证码
 * - GET  /v1/regions                        区域字典（373 条，code CN-13 / CN-13-1301）
 * - POST /v1/search/suppliers               供应商检索（province/city/keyword 至少一个；pages 默认 5 硬上限 20）
 * - GET  /v1/suppliers?queryId=&page=N      翻页
 * - GET  /v1/suppliers/{companyId}          供应商详情（store JSON，无 USCC）
 *
 * 采集策略（docs/04 实测校正）：
 * - 主路径 = 地理种子：keyword=<省/市/县英文名> + locationMode=off，本地按名称判省；
 * - 补充 = 行业词 × 城市 strict 矩阵：province=Hebei + keyword=<city> <industry>, maxEnrich=60。
 *   注意 strict 模式下 keyword 常返回 0（详情回填上限内 location unknown），由 orchestrator 容忍为空。
 * - 页间隔 10s（限频由 http 层令牌桶保证）；遇到 captchaRequired/cooldownUntil 暂停该来源。
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
  type AliSource,
  type PlatformCompanyDetail,
  type PlatformRegion,
  type SourceStatus,
  type SupplierSearchResult,
} from './types.js';

interface AliSupplierRaw {
  companyId: string;
  companyName?: string | null;
  storeUrl?: string | null;
  storeSubdomain?: string | null;
  logoUrl?: string | null;
  country?: string | null;
  location?: Record<string, unknown> | null;
  joinedYears?: number | null;
  joinedYearsText?: string | null;
  supplierIndex?: Record<string, unknown> | null;
  membership?: Record<string, unknown> | null;
  rating?: Record<string, unknown> | null;
  mainProducts?: string[] | null;
  mainProductsText?: string | null;
  businessType?: Record<string, unknown> | null;
  factoryAreaText?: string | null;
  staffText?: string | null;
  transactionsText?: string | null;
  responseTime?: string | null;
  isAd?: boolean | null;
  adType?: string | null;
  position?: number | null;
  enriched?: boolean | null;
  profile?: Record<string, unknown> | null;
  performance?: Record<string, unknown> | null;
  capabilities?: unknown;
  trust?: unknown;
  identity?: unknown;
  capabilityTags?: string[] | null;
}

function toLead(s: AliSupplierRaw): SourceLead {
  const location = asRecord(s.location);
  const membership = asRecord(s.membership);
  const supplierIndex = asRecord(s.supplierIndex);
  return {
    platform: 'ali',
    platformCompanyId: String(s.companyId),
    companyName: asText(s.companyName) ?? '',
    cityName: asText(location?.city),
    sourceUrl: asText(s.storeUrl),
    evidence: {
      location: location
        ? {
            province: asText(location.province),
            provinceCode: asText(location.provinceCode),
            city: asText(location.city),
            cityCode: asText(location.cityCode),
            address: asText(location.address),
            confidence: asText(location.confidence),
            source: asText(location.source),
          }
        : null,
      joinedYears: asNumber(s.joinedYears),
      supplierIndex: supplierIndex
        ? { stars: asNumber(supplierIndex.stars), maxStars: asNumber(supplierIndex.maxStars), label: asText(supplierIndex.label) }
        : null,
      membership: membership
        ? {
            plan: asText(membership.plan),
            label: asText(membership.label),
            rank: asNumber(membership.rank),
            verifiedSupplier: membership.verifiedSupplier === true,
            verifiedPro: membership.verifiedPro === true,
            paidMember: membership.paidMember === true,
            goldSupplier: membership.goldSupplier === true,
            onsiteAssessment: membership.onsiteAssessment === true,
            goldYears: asNumber(membership.goldYears),
          }
        : null,
      rating: asRecord(s.rating)
        ? { score: asNumber(asRecord(s.rating)?.score), count: asNumber(asRecord(s.rating)?.count) }
        : null,
      mainProducts: Array.isArray(s.mainProducts) ? s.mainProducts.slice(0, 10) : [],
      businessType: asText(asRecord(s.businessType)?.raw),
      isAd: s.isAd === true,
      position: asNumber(s.position),
      enriched: s.enriched === true,
    },
    raw: s,
  };
}

export class AliAdapter implements AliSource {
  readonly platform = 'ali' as const;
  readonly http: UpstreamHttpClient;

  constructor(opts: AdapterOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      source: 'ali',
      timeoutMs: opts.timeoutMs ?? 120_000,
      retry: { maxAttempts: 3, baseDelayMs: 5_000 },
      rate: SOURCE_RATE_LIMITS.ali,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  async getStatus(): Promise<SourceStatus> {
    const res = await this.http.get<Record<string, unknown>>('/v1/status');
    const data = res.data ?? {};
    const risk = asRecord(data.risk) ?? {};
    const upstream = asRecord(data.upstream) ?? {};
    const captcha = asRecord(upstream.captcha) ?? {};
    const cooldownUntil = asText(risk.cooldownUntil) ?? asText(upstream.cooldownUntil);
    const mode = asText(data.mode);
    let state: SourceStatus['state'] = 'ok';
    if (captcha.required === true) state = 'verification_pending';
    else if (cooldownUntil && Date.parse(cooldownUntil) > Date.now()) state = 'degraded';
    else if (asText(risk.riskState) === 'blocked') state = 'degraded';
    return {
      platform: 'ali',
      state,
      loggedIn: typeof data.loggedIn === 'boolean' ? data.loggedIn : mode === 'logged_in',
      expiresAt: asText(asRecord(data.session)?.expiresAt) ?? asText(risk.x5secExpiresAt),
      checkedAt: nowIso(),
      detail: {
        mode,
        riskState: asText(risk.riskState),
        cooldownUntil,
        captchaRequired: captcha.required === true,
        x5secExpiresAt: asText(risk.x5secExpiresAt),
      },
    };
  }

  async listRegions(): Promise<PlatformRegion[]> {
    const res = await this.http.get<{ items?: Array<Record<string, unknown>> }>('/v1/regions');
    const items = res.data?.items ?? [];
    return items
      .map((r): PlatformRegion | null => {
        const code = asText(r.code);
        const levelText = asText(r.level);
        if (!code || !levelText) return null;
        const nameZh = asText(r.nameZh);
        const nameEn = asText(r.nameEn);
        if (!nameZh && !nameEn) return null;
        return {
          regionCode: code,
          platform: 'ali' as const,
          platformValue: code,
          level: levelText === 'city' ? ('city' as const) : ('province' as const),
          nameZh,
          nameEn,
          aliases: asStringArray(r.aliases) ?? [],
          parentCode: asText(r.parentCode),
          raw: r,
        };
      })
      .filter((x): x is PlatformRegion => Boolean(x));
  }

  async searchSuppliers(input: {
    keyword?: string | null;
    province?: string | null;
    city?: string | null;
    locationMode?: 'strict' | 'keyword' | 'off';
    includeUnknownCity?: boolean;
    pages?: number;
    maxEnrich?: number;
  }): Promise<SupplierSearchResult> {
    const pages = Math.max(1, Math.min(20, input.pages ?? 5));
    const hasRegion = Boolean(input.province || input.city);
    const locationMode: 'strict' | 'keyword' | 'off' =
      input.locationMode ?? (hasRegion ? 'strict' : 'off');
    const body: Record<string, unknown> = {
      pages,
      locationMode,
      country: 'CN',
      includeUnknownCity: input.includeUnknownCity !== false,
    };
    if (input.keyword) body.keyword = input.keyword;
    if (input.province) body.province = input.province;
    if (input.city) body.city = input.city;
    if (input.maxEnrich != null) body.maxEnrich = input.maxEnrich;
    const res = await this.http.post<Record<string, unknown>>('/v1/search/suppliers', body);
    const data = res.data ?? {};
    const suppliers = Array.isArray(data.suppliers) ? (data.suppliers as AliSupplierRaw[]) : [];
    const stats = asRecord(data.stats) ?? {};
    const pagesRaw = Array.isArray(data.pages) ? (data.pages as Array<Record<string, unknown>>) : [];
    const totalCount = asNumber(stats.totalCount) ?? (pagesRaw.length ? asNumber(pagesRaw[0]?.totalCount) : null);
    return {
      platform: 'ali',
      queryId: asText(data.queryId) ?? '',
      keyword: asText(data.keyword),
      locationMode,
      pagesFetched: pagesRaw.length || pages,
      totalCount,
      // Ali 以「预抓页数 pages」控制深度，没有可靠的 hasMore；续翻用 listSuppliers
      hasMore: false,
      suppliers: suppliers.map(toLead),
      raw: data,
    };
  }

  async listSuppliers(queryId: string, page: number): Promise<{ page: number; suppliers: SourceLead[]; hasMore: boolean; raw: unknown }> {
    const res = await this.http.get<Record<string, unknown>>('/v1/suppliers', { queryId, page });
    const data = res.data ?? {};
    const suppliers = Array.isArray(data.suppliers) ? (data.suppliers as AliSupplierRaw[]) : [];
    return {
      page: asNumber(data.page) ?? page,
      suppliers: suppliers.map(toLead),
      hasMore: data.hasMore === true,
      raw: data,
    };
  }

  async getSupplierDetail(companyId: string, opts?: { refresh?: boolean }): Promise<PlatformCompanyDetail> {
    const res = await this.http.get<AliSupplierRaw & Record<string, unknown>>(
      `/v1/suppliers/${encodeURIComponent(companyId)}`,
      opts?.refresh ? { refresh: 'true' } : undefined,
    );
    const d = res.data ?? ({} as AliSupplierRaw);
    const location = asRecord(d.location);
    const profileRaw = asRecord(d.profile);
    const membership = asRecord(d.membership);
    const profile = emptyProfileFields('active', asText(asRecord(res.meta)?.timestamp));
    profile.displayName = asText(d.companyName);
    profile.sourceUrl = asText(d.storeUrl);
    profile.fullName = asText(d.companyName);
    profile.cityName = asText(location?.city);
    profile.address = asText(location?.address);
    profile.scale = asText(profileRaw?.employees);
    profile.stage = asText(membership?.label) ?? asText(membership?.plan);
    profile.logoUrl = asText(d.logoUrl);
    profile.intro = asText(profileRaw?.description);
    profile.tags = asStringArray(d.mainProducts);
    profile.store = {
      country: asText(d.country),
      storeSubdomain: asText(d.storeSubdomain),
      location: location
        ? {
            country: asText(location.country),
            province: asText(location.province),
            provinceCode: asText(location.provinceCode),
            city: asText(location.city),
            cityCode: asText(location.cityCode),
            address: asText(location.address),
            confidence: asText(location.confidence),
            source: asText(location.source),
          }
        : null,
      joinedYears: asNumber(d.joinedYears),
      joinedYearsText: asText(d.joinedYearsText),
      supplierIndex: d.supplierIndex ?? null,
      membership: membership ?? null,
      rating: asRecord(d.rating) ?? null,
      mainProducts: Array.isArray(d.mainProducts) ? d.mainProducts : null,
      mainProductsText: asText(d.mainProductsText),
      businessType: asRecord(d.businessType) ?? null,
      profile: profileRaw ?? null,
      performance: asRecord(d.performance) ?? null,
      capabilities: d.capabilities ?? null,
      trust: d.trust ?? null,
      identity: d.identity ?? null,
      factoryAreaText: asText(d.factoryAreaText),
      staffText: asText(d.staffText),
      transactionsText: asText(d.transactionsText),
      responseTime: asText(d.responseTime),
      raw: d,
    };
    const fetchedAt = asText(asRecord(res.meta)?.fetched_at) ?? asText(asRecord(res.meta)?.timestamp) ?? nowIso();
    return {
      platform: 'ali',
      platformCompanyId: String(asText(d.companyId) ?? companyId),
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
