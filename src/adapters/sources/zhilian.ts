/**
 * 智联招聘 adapter（zhilian-client :8791，Bearer）。
 *
 * 端点（docs/04 §3.2、zhilian-client docs/02）：
 * - GET  /v1/status                         登录态/验证/风控
 * - GET  /v1/cities                         区域字典（492 条；河北 11 市 code 565–575）
 * - POST /v1/search/jobs                    岗位检索（pages ≤5；count 字段不可靠，不使用）
 * - GET  /v1/jobs?queryId=&page=N           续翻页
 * - GET  /v1/companies?queryId=             按公司去重（线索来源）
 * - GET  /v1/companies/{companyNumber}      公司详情 + 工商文本推导
 * - GET  /v1/companies/{companyNumber}/jobs 在招岗位
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
  type BusinessHint,
  type JobSearchResult,
  type NormalizedJob,
  type PlatformCompanyDetail,
  type PlatformRegion,
  type RecruitmentSource,
  type SourceStatus,
} from './types.js';

interface ZhilianJobRaw {
  positionNumber?: string | null;
  jobId?: number | string | null;
  title?: string | null;
  salaryText?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  education?: string | null;
  degree?: string | null;
  experience?: string | null;
  cityCode?: string | null;
  cityName?: string | null;
  district?: string | null;
  publishTime?: string | null;
  companyNumber?: string | null;
  companyName?: string | null;
  recruitername?: string | null;
  recruiterName?: string | null;
  bossName?: string | null;
  jobUrl?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

interface ZhilianCompanyListItem {
  companyNumber: string;
  name: string;
  industry?: string | null;
  size?: string | null;
  financingStage?: string | null;
  cityName?: string | null;
  jobCount?: number | null;
  matchedJobs?: Array<Record<string, unknown>>;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
}

interface ZhilianCompanyDetailRaw {
  companyNumber?: string;
  name?: string | null;
  fullName?: string | null;
  logo?: string | null;
  size?: string | null;
  industry?: string | null;
  financingStage?: string | null;
  cityName?: string | null;
  address?: string | null;
  website?: string | null;
  intro?: string | null;
  tags?: string[] | null;
  benefits?: string[] | null;
  jobCount?: number | null;
  hotJobs?: ZhilianJobRaw[];
  business?: Record<string, unknown> | null;
  url?: string | null;
  fetchedAt?: string | null;
}

function mapJob(platformCompanyId: string, job: ZhilianJobRaw): NormalizedJob {
  const jobId = asText(job.positionNumber) ?? asText(job.jobId) ?? '';
  return {
    platform: 'zhilian',
    platformCompanyId,
    jobId,
    title: asText(job.title) ?? '',
    salaryText: asText(job.salaryText),
    salaryMin: asNumber(job.salaryMin),
    salaryMax: asNumber(job.salaryMax),
    cityName: asText(job.cityName),
    district: asText(job.district),
    degree: asText(job.degree ?? job.education),
    experience: asText(job.experience),
    publishTime: asText(job.publishTime),
    recruiterName: asText(job.recruiterName ?? job.recruitername ?? job.bossName),
    recruiterTitle: null,
    jobUrl: asText(job.jobUrl),
    status: 'active',
    firstSeenAt: asText(job.firstSeenAt) ?? nowIso(),
    lastSeenAt: asText(job.lastSeenAt) ?? nowIso(),
    closedAt: null,
    raw: job,
  };
}

function mapBusiness(raw: Record<string, unknown> | null | undefined, fallbackIndustry: string | null): BusinessHint | null {
  if (!raw) return null;
  return {
    companyName: asText(raw.registeredName) ?? asText(raw.companyName),
    uscc: asText(raw.uscc),
    legalRepresentative: asText(raw.legalPerson),
    foundedAt: asText(raw.createDate),
    registeredCapital: asText(raw.registeredCapital),
    registeredAddress: asText(raw.registeredAddress) ?? asText(raw.location),
    businessStatus: asText(raw.businessStatus),
    businessScope: asText(raw.businessScope),
    industry: asText(raw.industry) ?? fallbackIndustry,
    city: asText(raw.location),
    usccSource: asText(raw.usccSource) ?? 'zhilian_company_page_text',
    textDerived: raw.textDerived === true,
  };
}

export class ZhilianAdapter implements RecruitmentSource {
  readonly platform = 'zhilian' as const;
  readonly http: UpstreamHttpClient;

  constructor(opts: AdapterOptions) {
    this.http = createHttpClient({
      baseUrl: opts.baseUrl,
      token: opts.token,
      source: 'zhilian',
      timeoutMs: opts.timeoutMs ?? 30_000,
      retry: { maxAttempts: 3, baseDelayMs: 1_000 },
      rate: SOURCE_RATE_LIMITS.zhilian,
      fetchImpl: opts.fetchImpl,
      sleep: opts.sleep,
      now: opts.now,
    });
  }

  async getStatus(): Promise<SourceStatus> {
    const res = await this.http.get<Record<string, unknown>>('/v1/status');
    const data = res.data ?? {};
    const loggedIn = data.loggedIn === true;
    const mode = asText(data.mode) ?? asText(data.health);
    const session = asRecord(data.session) ?? {};
    const verification = asRecord(data.verification) ?? {};
    const risk = asRecord(data.risk) ?? {};
    const cooldownUntil = asText(risk.cooldownUntil);
    let state: SourceStatus['state'] = 'ok';
    if (verification.pending === true) state = 'verification_pending';
    else if (!loggedIn) state = mode === 'stopped' ? 'unavailable' : 'session_invalid';
    else if (cooldownUntil && Date.parse(cooldownUntil) > Date.now()) state = 'degraded';
    return {
      platform: 'zhilian',
      state,
      loggedIn,
      expiresAt: asText(session.expiresAt) ?? asText(session.rtExpiresAt),
      checkedAt: nowIso(),
      detail: {
        mode,
        verificationPending: verification.pending === true,
        verificationKind: asText(verification.kind),
        cooldownUntil,
        blockCount: asNumber(risk.blockCount),
      },
    };
  }

  async listRegions(): Promise<PlatformRegion[]> {
    const res = await this.http.get<{ cities?: Array<Record<string, unknown>> }>('/v1/cities');
    const cities = res.data?.cities ?? [];
    return cities
      .map((c): PlatformRegion | null => {
        const code = asText(c.code);
        const name = asText(c.name);
        if (!code || !name) return null;
        const levelText = asText(c.level);
        const level: 'province' | 'city' = levelText === 'city' ? 'city' : 'province';
        return {
          regionCode: code,
          platform: 'zhilian' as const,
          platformValue: code,
          level,
          nameZh: name,
          nameEn: asText(c.enName),
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
      pages,
    });
    const data = res.data ?? {};
    const query = asRecord(data.query) ?? {};
    const jobs = Array.isArray(data.jobs) ? (data.jobs as ZhilianJobRaw[]) : [];
    // 注意：智联 count 字段不可靠（实测 0 但有数据），只信 jobs.length/hasMore/pagesFetched
    return {
      platform: 'zhilian',
      queryId: asText(query.queryId) ?? '',
      keyword: asText(query.keyword) ?? input.keyword,
      cityCode: asText(query.cityCode) ?? input.cityCode,
      cityName: asText(query.cityName),
      pageSize: asNumber(query.pageSize),
      pagesFetched: asNumber(query.pagesFetched) ?? pages,
      totalCount: null,
      hasMore: query.hasMore === true,
      jobs: jobs.map((j) => mapJob(asText(j.companyNumber) ?? '', j)),
      raw: data,
    };
  }

  async listCompanies(queryId: string): Promise<SourceLead[]> {
    const res = await this.http.get<{ companies?: ZhilianCompanyListItem[] }>('/v1/companies', { queryId });
    return (res.data?.companies ?? []).map((c) => this.toLead(c));
  }

  async listJobsByPage(queryId: string, page: number): Promise<SourceLead[]> {
    await this.http.get('/v1/jobs', { queryId, page });
    return this.listCompanies(queryId);
  }

  async getCompanyDetail(platformCompanyId: string): Promise<PlatformCompanyDetail> {
    const res = await this.http.get<ZhilianCompanyDetailRaw>(`/v1/companies/${encodeURIComponent(platformCompanyId)}`);
    const d = res.data ?? ({} as ZhilianCompanyDetailRaw);
    const industry = asText(d.industry) ?? asText(asRecord(d.business)?.industry);
    const business = mapBusiness(d.business, industry);
    const profile = emptyProfileFields('active', asText(d.fetchedAt));
    profile.displayName = asText(d.name);
    profile.sourceUrl = asText(d.url);
    profile.fullName = asText(d.fullName);
    profile.cityName = asText(d.cityName);
    profile.address = asText(d.address);
    profile.industry = industry;
    profile.scale = asText(d.size);
    profile.stage = asText(d.financingStage);
    profile.logoUrl = asText(d.logo);
    profile.intro = asText(d.intro);
    profile.tags = asStringArray(d.tags);
    profile.benefits = asStringArray(d.benefits);
    profile.jobCount = asNumber(d.jobCount);
    profile.store = { website: asText(d.website) };
    const jobs = Array.isArray(d.hotJobs) ? d.hotJobs.map((j) => mapJob(platformCompanyId, j)) : [];
    const metaTimestamp = asText(res.meta?.timestamp);
    return {
      platform: 'zhilian',
      platformCompanyId,
      displayName: profile.displayName,
      sourceUrl: profile.sourceUrl,
      profile,
      jobs,
      business,
      raw: d,
      fetchedAt: asText(d.fetchedAt) ?? metaTimestamp ?? nowIso(),
    };
  }

  async listCompanyJobs(platformCompanyId: string): Promise<NormalizedJob[]> {
    const res = await this.http.get<{ jobs?: ZhilianJobRaw[]; jobCount?: number }>(
      `/v1/companies/${encodeURIComponent(platformCompanyId)}/jobs`,
    );
    return (res.data?.jobs ?? []).map((j) => mapJob(platformCompanyId, j));
  }

  private toLead(c: ZhilianCompanyListItem): SourceLead {
    const companyNumber = String(asText(c.companyNumber) ?? '');
    return {
      platform: 'zhilian',
      platformCompanyId: companyNumber,
      companyName: asText(c.name) ?? '',
      cityName: asText(c.cityName),
      sourceUrl: companyNumber ? `https://www.zhaopin.com/companydetail/${encodeURIComponent(companyNumber)}.htm` : null,
      evidence: {
        industry: asText(c.industry),
        size: asText(c.size),
        financingStage: asText(c.financingStage),
        jobCount: asNumber(c.jobCount),
        matchedJobs: Array.isArray(c.matchedJobs) ? c.matchedJobs.slice(0, 10) : [],
      },
      raw: c,
    };
  }
}
