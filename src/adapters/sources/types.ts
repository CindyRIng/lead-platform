/**
 * 四源适配器统一类型（S2/S3 对外契约）。
 *
 * 归一目标：搜索 → SourceLead（src/shared/domain.ts）；
 *           详情 → PlatformCompanyDetail（profile 可直接写 company_platform_profiles；
 *                   岗位 → NormalizedJob 可直接写 company_platform_jobs）。
 * 适配器只读；错误统一抛 LeadError（错误码见 src/shared/errors.ts）。
 */
import type {
  Platform,
  PlatformJob,
  PlatformProfile,
  PlatformStatus,
  SourceHealthState,
  SourceLead,
} from '../../shared/domain.js';

export type RecruitmentPlatform = 'boss' | 'zhilian';
export type SupplierPlatform = 'ali' | 'mic';

/** /v1/status（或 mic /api/version）归一后的来源健康状态 */
export interface SourceStatus {
  platform: Platform;
  state: SourceHealthState;
  loggedIn: boolean | null;
  expiresAt: string | null;
  checkedAt: string;
  detail: Record<string, unknown> | null;
}

/** 平台区域字典条目（Boss/智联/ Ali/Mic 统一） */
export interface PlatformRegion {
  /** 规范 region code（能匹配到内置基线时填 GB/T 2260，否则为平台侧 code） */
  regionCode: string;
  platform: Platform;
  /** 传给该平台的检索取值（Boss cityCode / 智联 code / Ali code / Mic 英文名） */
  platformValue: string;
  level: 'province' | 'city';
  nameZh: string | null;
  nameEn: string | null;
  aliases: string[];
  parentCode: string | null;
  /** 平台原始条目（供快照/排障） */
  raw: unknown;
}

/**
 * 平台档案字段（可直接映射 company_platform_profiles 除 company_id/platform/platform_company_id
 * 与刷新时间/版本/快照 id 之外的列）。
 */
export type PlatformProfileFields = Pick<
  PlatformProfile,
  | 'displayName'
  | 'sourceUrl'
  | 'fullName'
  | 'cityName'
  | 'address'
  | 'industry'
  | 'scale'
  | 'stage'
  | 'logoUrl'
  | 'intro'
  | 'tags'
  | 'benefits'
  | 'jobCount'
  | 'bossCount'
  | 'recruiters'
  | 'store'
  | 'platformStatus'
  | 'lastSeenAt'
>;

/** 岗位字段（可直接映射 company_platform_jobs 除 company_id 之外的列） */
export type NormalizedJob = Omit<PlatformJob, 'companyId'>;

/** 平台详情里可推导的工商提示（Boss/智联文本推导，只作探迹精确搜索提示） */
export interface BusinessHint {
  companyName: string | null;
  uscc: string | null;
  legalRepresentative: string | null;
  foundedAt: string | null;
  registeredCapital: string | null;
  registeredAddress: string | null;
  businessStatus: string | null;
  businessScope: string | null;
  industry: string | null;
  city: string | null;
  usccSource: string | null;
  textDerived: boolean;
}

/** 公司详情归一结果 */
export interface PlatformCompanyDetail {
  platform: Platform;
  platformCompanyId: string;
  displayName: string | null;
  sourceUrl: string | null;
  profile: PlatformProfileFields;
  /** 详情内嵌岗位（Boss hotJobs 等，样例级；全量请再调 listCompanyJobs） */
  jobs: NormalizedJob[];
  business: BusinessHint | null;
  raw: unknown;
  fetchedAt: string;
}

/** 招聘源搜索结果（一次 search 的聚合视图） */
export interface JobSearchResult {
  platform: RecruitmentPlatform;
  queryId: string;
  keyword: string;
  cityCode: string;
  cityName: string | null;
  pageSize: number | null;
  pagesFetched: number;
  totalCount: number | null;
  hasMore: boolean;
  jobs: NormalizedJob[];
  raw: unknown;
}

/** Ali 搜索归一结果 */
export interface SupplierSearchResult {
  platform: SupplierPlatform;
  queryId: string;
  keyword: string | null;
  locationMode: 'strict' | 'keyword' | 'off';
  pagesFetched: number;
  totalCount: number | null;
  hasMore: boolean;
  suppliers: SourceLead[];
  raw: unknown;
}

/** Mic 搜索归一结果 */
export interface MicSearchResult {
  platform: 'mic';
  keyword: string | null;
  province: string | null;
  city: string | null;
  page: number;
  pageSize: number;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
  items: SourceLead[];
  raw: unknown;
}

export interface AdapterOptions {
  baseUrl: string;
  token?: string | null;
  timeoutMs?: number;
  /** 注入 fetch（测试用 mock）；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 注入 sleep/now（测试限频/重试用） */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** 限频配置（docs/04 §2） */
export const SOURCE_RATE_LIMITS = {
  boss: { perMinute: 12, minIntervalMs: 2_500, jitterMs: 0 },
  zhilian: { perMinute: 15, minIntervalMs: 2_500, jitterMs: 500 },
  ali: { perMinute: null, minIntervalMs: 10_000 },
  mic: { perMinute: null, minIntervalMs: 1_800, jitterMs: 400 },
} as const;

/** S2 适配器统一接口（Refresh Worker / Orchestrator 可依赖此 narrow interface） */
export interface RecruitmentSource {
  readonly platform: RecruitmentPlatform;
  getStatus(): Promise<SourceStatus>;
  listRegions(): Promise<PlatformRegion[]>;
  searchJobs(input: { keyword: string; cityCode: string; pages?: number; pageSize?: number }): Promise<JobSearchResult>;
  /** 按 queryId 取上游「按公司去重」结果 */
  listCompanies(queryId: string): Promise<SourceLead[]>;
  /** 续翻一页并返回公司（GET /v1/jobs?queryId=&page= 之后 companies 视图自动累积） */
  listJobsByPage(queryId: string, page: number): Promise<SourceLead[]>;
  getCompanyDetail(platformCompanyId: string): Promise<PlatformCompanyDetail>;
  listCompanyJobs(platformCompanyId: string): Promise<NormalizedJob[]>;
}

/** S3 Ali 适配器接口 */
export interface AliSource {
  readonly platform: 'ali';
  getStatus(): Promise<SourceStatus>;
  listRegions(): Promise<PlatformRegion[]>;
  searchSuppliers(input: {
    keyword?: string | null;
    province?: string | null;
    city?: string | null;
    locationMode?: 'strict' | 'keyword' | 'off';
    includeUnknownCity?: boolean;
    pages?: number;
    maxEnrich?: number;
  }): Promise<SupplierSearchResult>;
  listSuppliers(queryId: string, page: number): Promise<{ page: number; suppliers: SourceLead[]; hasMore: boolean; raw: unknown }>;
  getSupplierDetail(companyId: string, opts?: { refresh?: boolean }): Promise<PlatformCompanyDetail>;
}

/** S3 Mic 适配器接口 */
export interface MicSource {
  readonly platform: 'mic';
  getStatus(): Promise<SourceStatus>;
  listRegions(province?: string): Promise<PlatformRegion[]>;
  searchFactories(input: {
    keyword?: string | null;
    province?: string | null;
    city?: string | null;
    page?: number;
    pageSize?: number;
    audited?: boolean;
    businessType?: string;
  }): Promise<MicSearchResult>;
  getCompanyDetail(account: string, include?: string[]): Promise<PlatformCompanyDetail>;
}

export interface SourceAdapterRegistry {
  boss: RecruitmentSource;
  zhilian: RecruitmentSource;
  ali: AliSource;
  mic: MicSource;
}

/** 常用字段安全的取值工具（上游字段可能缺失/null） */
export function asText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((v) => asText(v)).filter((v): v is string => Boolean(v));
  return items.length > 0 ? items : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 默认档案字段（平台无该字段时使用） */
export function emptyProfileFields(platformStatus: PlatformStatus = 'active', lastSeenAt: string | null = null): PlatformProfileFields {
  return {
    displayName: null,
    sourceUrl: null,
    fullName: null,
    cityName: null,
    address: null,
    industry: null,
    scale: null,
    stage: null,
    logoUrl: null,
    intro: null,
    tags: null,
    benefits: null,
    jobCount: null,
    bossCount: null,
    recruiters: null,
    store: null,
    platformStatus,
    lastSeenAt,
  };
}
