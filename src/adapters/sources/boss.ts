/**
 * Boss 直聘 adapter（boss-client :8790，Bearer）。
 *
 * 端点（docs/04 §3.1、boss-client docs/02）：
 * - GET  /v1/status                         登录态/风控
 * - GET  /v1/cities?refresh=true            区域字典（374 城，可能无 province）
 * - POST /v1/search/jobs                    岗位检索（pages ≤5）
 * - GET  /v1/jobs?queryId=&page=N           续翻页
 * - GET  /v1/companies?queryId=             按公司去重（线索来源）
 * - GET  /v1/companies/{companyId}          公司详情 + 工商文本推导 + hotJobs/recruiters
 * - GET  /v1/companies/{companyId}/jobs     在招岗位（样例/分页）
 *
 * 只读，不登录、不解验证码；401/风控/429 归一为 LeadError。
 */
import { createHttpClient, type UpstreamHttpClient, type UpstreamResult } from '../http.js';
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
  type BusinessHint,
  type JobSearchResult,
  type NormalizedJob,
  type PlatformCompanyDetail,
  type PlatformRegion,
  type RecruitmentSource,
  type SourceStatus,
} from './types.js';

interface BossJobRaw {
  jobId: string;
  title: string;
  salaryText?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  experience?: string | null;
  degree?: string | null;
  cityCode?: string | number | null;
  cityName?: string | null;
  district?: string | null;
  businessDistrict?: string | null;
  recruiterName?: string | null;
  recruiterTitle?: string | null;
  bossName?: string | null;
  bossTitle?: string | null;
  jobUrl?: string | null;
  companyId?: string;
  companyName?: string;
  companyIndustry?: string | null;
  companyScale?: string | null;
  companyStage?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  raw?: unknown;
}

interface BossCompanyListItem {
  companyId: string;
  name: string;
  industry?: string | null;
  scale?: string | null;
  stage?: string | null;
  cityName?: string | null;
  jobCount?: number | null;
  matchedJobs?: Array<Record<string, unknown>>;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

interface BossCompanyDetailRaw {
  companyId: string;
  name?: string | null;
  fullName?: string | null;
  logo?: string | null;
  industry?: string | null;
  scale?: string | null;
  stage?: string | null;
  cityName?: string | null;
  address?: string | null;
  intro?: string | null;
  tags?: string[] | null;
  benefits?: string[] | null;
  jobCount?: number | null;
  bossCount?: number | null;
  hotJobs?: BossJobRaw[];
  recruiters?: Array<{ name?: string | null; title?: string | null; online?: boolean | null }>;
  business?: Record<string, unknown> | null;
  url?: string | null;
  fetchedAt?: string | null;
}

function mapJob(platformCompanyId: string, job: BossJobRaw): NormalizedJob {
  return {
    platform: 'boss',
    platformCompanyId,
    jobId: String(job.jobId),
    title: asText(job.title) ?? '',
    salaryText: asText(job.salaryText),
    salaryMin: asNumber(job.salaryMin),
    salaryMax: asNumber(job.salaryMax),
    cityName: asText(job.cityName),
    district: asText(job.district),
    degree: asText(job.degree),
    experience: asText(job.experience),
    publishTime: null,
    recruiterName: asText(job.recruiterName ?? job.bossName),
    recruiterTitle: asText(job.recruiterTitle ?? job.bossTitle),
    jobUrl: asText(job.jobUrl),
    status: 'active',
    firstSeenAt: asText(job.firstSeenAt) ?? nowIso(),
    lastSeenAt: asText(job.lastSeenAt) ?? nowIso(),
    closedAt: null,
    raw: job.raw ?? job,
  };
}

function mapBusiness(raw: Record<string, unknown> | null | undefined, fallbackIndustry: string | null): BusinessHint | null {
  if (!raw) return null;
  return {
    companyName: asText(raw.companyName),
    uscc: asText(raw.uscc),
    legalRepresentative: asText(raw.legalRepresentative),
    foundedAt: asText(raw.foundedAt),
    registeredCapital: asText(raw.registeredCapital),
    registeredAddress: asText(raw.registeredAddress),
    businessStatus: asText(raw.businessStatus),
    businessScope: asText(raw.businessScope),
    industry: asText(raw.industry) ?? fallbackIndustry,
    city: asText(raw.region),
    usccSource: asText(raw.usccSource),
    textDerived: raw.textDerived === true || asText(raw.usccSource) === 'boss_company_page_text',
  };
}

export class BossAdapter implements RecruitmentSource {
  readonly platform = 'boss' as const;
  readonly http: UpstreamHttpClient;

  constructor(opts: AdapterOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      source: 'boss',
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: { maxAttempts: 3, baseDelayMs: 1_000 },
      rate: SOURCE_RATE_LIMITS.boss,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  async getStatus(): Promise<SourceStatus> {
    const res = await this.http.get<Record<string, unknown>>('/v1/status');
    const data = res.data ?? {};
    const loggedIn = data.loggedIn === true;
    const health = asText(data.health);
    const session = asRecord(data.session) ?? {};
    const risk = asRecord(data.risk) ?? {};
    const cooldownUntil = asText(risk.cooldownUntil);
    const cooldownActive = Boolean(cooldownUntil && Date.parse(cooldownUntil) > Date.now());
    let state: SourceStatus['state'] = 'ok';
    if (!loggedIn) state = asText(health) === 'stopped' ? 'unavailable' : 'session_invalid';
    else if (cooldownActive || health === 'cooldown' || health === 'degraded') state = 'degraded';
    else if (health === 'needs_human') state = 'verification_pending';
    return {
      platform: 'boss',
      state,
      loggedIn,
      expiresAt: asText(session.expiresAt),
      checkedAt: nowIso(),
      detail: { health, cooldownUntil, code37Count: asNumber(risk.code37Count), mode: asText(data.mode) },
    };
  }

  async listRegions(): Promise<PlatformRegion[]> {
    const res = await this.http.get<{ cities?: Array<Record<string, unknown>> }>('/v1/cities', { refresh: 'true' });
    const cities = res.data?.cities ?? [];
    return cities
      .map((c): PlatformRegion | null => {
        const cityCode = asText(c.cityCode);
        const cityName = asText(c.cityName);
        if (!cityCode || !cityName) return null;
        return {
          regionCode: cityCode,
          platform: 'boss' as const,
          platformValue: cityCode,
          level: 'city' as const,
          nameZh: cityName,
          nameEn: null,
          aliases: [],
          parentCode: null,
          raw: c,
        };
      })
      .filter((x): x is PlatformRegion => Boolean(x));
  }

  async searchJobs(input: { keyword: string; cityCode: string; pages?: number; pageSize?: number }): Promise<JobSearchResult> {
    const pages = Math.max(1, Math.min(5, input.pages ?? 1));
    const res = await this.http.post<Record<string, unknown>>('/v1/search/jobs', {
      keyword: input.keyword,
      cityCode: input.cityCode,
      page: 1,
      pageSize: input.pageSize ?? 15,
      pages,
    });
    const data = res.data ?? {};
    const query = asRecord(data.query) ?? {};
    const jobs = Array.isArray(data.jobs) ? (data.jobs as BossJobRaw[]) : [];
    return {
      platform: 'boss',
      queryId: asText(query.queryId) ?? '',
      keyword: asText(query.keyword) ?? input.keyword,
      cityCode: asText(query.cityCode) ?? input.cityCode,
      cityName: asText(query.cityName),
      pageSize: asNumber(query.pageSize),
      pagesFetched: asNumber(query.pagesFetched) ?? pages,
      totalCount: asNumber(query.resCount) ?? asNumber(query.totalCount),
      hasMore: query.hasMore === true,
      jobs: jobs.map((j) => mapJob(String(asText(j.companyId) ?? ''), j)),
      raw: data,
    };
  }

  async listCompanies(queryId: string): Promise<SourceLead[]> {
    const res = await this.http.get<{ companies?: BossCompanyListItem[] }>('/v1/companies', { queryId });
    return (res.data?.companies ?? []).map((c) => this.toLead(c));
  }

  async listJobsByPage(queryId: string, page: number): Promise<SourceLead[]> {
    await this.http.get('/v1/jobs', { queryId, page });
    // companies 视图按 queryId 累积去重，翻页后重新取即可拿到新增公司
    return this.listCompanies(queryId);
  }

  async getCompanyDetail(platformCompanyId: string): Promise<PlatformCompanyDetail> {
    const res: UpstreamResult<BossCompanyDetailRaw> = await this.http.get<BossCompanyDetailRaw>(
      `/v1/companies/${encodeURIComponent(platformCompanyId)}`,
    );
    const d = res.data ?? ({} as BossCompanyDetailRaw);
    const business = mapBusiness(d.business, asText(d.industry));
    const profile = emptyProfileFields('active', asText(d.fetchedAt));
    profile.displayName = asText(d.name);
    profile.sourceUrl = asText(d.url);
    profile.fullName = asText(d.fullName);
    profile.cityName = asText(d.cityName);
    profile.address = asText(d.address);
    profile.industry = asText(d.industry);
    profile.scale = asText(d.scale);
    profile.stage = asText(d.stage);
    profile.logoUrl = asText(d.logo);
    profile.intro = asText(d.intro);
    profile.tags = asStringArray(d.tags);
    profile.benefits = asStringArray(d.benefits);
    profile.jobCount = asNumber(d.jobCount);
    profile.bossCount = asNumber(d.bossCount);
    profile.recruiters = Array.isArray(d.recruiters)
      ? d.recruiters.map((r) => ({ name: asText(r.name), title: asText(r.title), online: r.online === true }))
      : null;
    const jobs = Array.isArray(d.hotJobs) ? d.hotJobs.map((j) => mapJob(platformCompanyId, j)) : [];
    return {
      platform: 'boss',
      platformCompanyId,
      displayName: profile.displayName,
      sourceUrl: profile.sourceUrl,
      profile,
      jobs,
      business,
      raw: d,
      fetchedAt: asText(d.fetchedAt) ?? asText(res.meta?.timestamp) ?? nowIso(),
    };
  }

  async listCompanyJobs(platformCompanyId: string): Promise<NormalizedJob[]> {
    const res = await this.http.get<{ jobs?: BossJobRaw[]; jobCount?: number }>(
      `/v1/companies/${encodeURIComponent(platformCompanyId)}/jobs`,
    );
    return (res.data?.jobs ?? []).map((j) => mapJob(platformCompanyId, j));
  }

  private toLead(c: BossCompanyListItem): SourceLead {
    const companyId = String(asText(c.companyId) ?? '');
    return {
      platform: 'boss',
      platformCompanyId: companyId,
      companyName: asText(c.name) ?? '',
      cityName: asText(c.cityName),
      sourceUrl: companyId ? `https://www.zhipin.com/gongsi/${encodeURIComponent(companyId)}.html` : null,
      evidence: {
        industry: asText(c.industry),
        scale: asText(c.scale),
        stage: asText(c.stage),
        jobCount: asNumber(c.jobCount),
        matchedJobs: Array.isArray(c.matchedJobs) ? c.matchedJobs.slice(0, 10) : [],
      },
      raw: c,
    };
  }
}
