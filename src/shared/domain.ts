/** 共享领域类型（跨模块契约，冻结版 v1） */
export type Platform = 'boss' | 'zhilian' | 'ali' | 'mic';
export type SourcePlatform = Platform;
export type AllPlatform = Platform | 'tanji' | 'fuma';

export type GoalRunStatus = 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type Stage =
  | 'source_detail'
  | 'tanji_match'
  | 'tanji_detail'
  | 'unlock'
  | 'contact_sync'
  | 'platform_profile'
  | 'platform_jobs'
  | 'customs';
export type JobStatus = 'pending' | 'running' | 'waiting_quota' | 'done' | 'failed' | 'dead' | 'cancelled';
export type EnrichmentStatus = 'discovered' | 'source_detailed' | 'tanji_matched' | 'tanji_enriched' | 'unmatched' | 'failed';
export type UnlockStatus = 'none' | 'pending' | 'waiting_quota' | 'unlocked' | 'failed';
export type PlatformStatus = 'active' | 'stale' | 'lost';
export type SourceHealthState = 'ok' | 'degraded' | 'session_invalid' | 'verification_pending' | 'unavailable';

export interface GoalRegion {
  province: string; // 如 河北省
  provinceCode?: string; // GB/T 2260
  cityCodes?: string[]; // 可选；空 = 全省地级市
}

export interface Goal {
  id: string;
  name: string;
  region: GoalRegion;
  platforms: Platform[];
  keywords: Partial<Record<Platform, string[]>>;
  maxLeadsPerRun: number | null;
  dailyLeadLimit: number | null;
  schedule: { cron: string; timeZone: string; timeWindow?: string | null };
  priority: number;
  tradeFilter: unknown | null;
  unlockPolicy: { mode: 'priority'; order: string[] };
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalRun {
  id: string;
  goalId: string;
  trigger: 'cron' | 'manual';
  status: GoalRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  stats: RunStats;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface RunStats {
  platforms?: Partial<Record<Platform, { queries: number; pages: number; leads: number; companiesNew: number }>>;
  enrichment?: { done: number; unmatched: number; failed: number };
  unlock?: { unlocked: number; waitingQuota: number; quotaCost: number };
  coverage?: CoverageStats;
  [k: string]: unknown;
}

export interface CoverageStats {
  uniqueCompanies: number;
  crossSourceOverlap: number;
  coverageByCity: Record<string, number>;
  keywordYield: Record<string, number>;
}

export interface Company {
  id: string;
  name: string;
  normalizedName: string;
  englishName: string | null;
  uscc: string | null;
  tanjiCompanyId: string | null;
  legalRepresentative: string | null;
  regCapital: string | null;
  foundTime: string | null;
  operStatus: string | null;
  industry: string | null;
  scale: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  address: string | null;
  businessScope: string | null;
  homepage: string | null;
  phoneCount: number | null;
  emailCount: number | null;
  contactCount: number | null;
  tradeTags: string[];
  extra: Record<string, unknown> | null;
  sourceCount: number;
  enrichmentStatus: EnrichmentStatus;
  unlockStatus: UnlockStatus;
  matchMeta: MatchMeta | null;
  firstRunId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  mergedInto: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface MatchCandidate {
  id: string;
  name: string;
  uscc?: string | null;
  score: number;
}
export interface MatchMeta {
  method?: string;
  confidence: number;
  matchedAt?: string;
  candidates: MatchCandidate[];
}

export interface CompanySource {
  id: string;
  companyId: string;
  platform: Platform;
  platformCompanyId: string;
  sourceName: string | null;
  sourceUrl: string | null;
  cityName: string | null;
  evidence: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface Contact {
  id: string;
  companyId: string;
  tanjiContactId: string | null;
  name: string | null;
  position: string | null;
  department: string | null;
  region: string | null;
  type: 'mobile' | 'phone' | 'email';
  value: string;
  masked: boolean;
  source: string | null;
  isKey: boolean;
  unlockedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeEventInput {
  companyId: string;
  entityType: 'company' | 'platform_profile' | 'job';
  entityId?: string | null;
  version: number;
  eventType: string;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  valueType?: string | null;
  source: string;
  runId?: string | null;
  actor?: string;
  occurredAt?: string;
}

export interface SourceLead {
  platform: Platform;
  platformCompanyId: string;
  companyName: string;
  cityName?: string | null;
  sourceUrl?: string | null;
  evidence: Record<string, unknown>;
  raw?: unknown;
}

export interface RegionRow {
  code: string;
  name: string;
  level: 'province' | 'city';
  parentCode: string | null;
}

export interface PlatformProfile {
  companyId: string;
  platform: Platform;
  platformCompanyId: string;
  displayName: string | null;
  sourceUrl: string | null;
  fullName: string | null;
  cityName: string | null;
  address: string | null;
  industry: string | null;
  scale: string | null;
  stage: string | null;
  logoUrl: string | null;
  intro: string | null;
  tags: string[] | null;
  benefits: string[] | null;
  jobCount: number | null;
  bossCount: number | null;
  recruiters: unknown | null;
  store: Record<string, unknown> | null;
  platformStatus: PlatformStatus;
  lastFetchedAt: string;
  lastSeenAt: string | null;
  nextJobsRefreshAt: string | null;
  nextStoreRefreshAt: string | null;
  rawSnapshotId: number | null;
  version: number;
}

export interface PlatformJob {
  companyId: string;
  platform: 'boss' | 'zhilian';
  platformCompanyId: string;
  jobId: string;
  title: string;
  salaryText: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  cityName: string | null;
  district: string | null;
  degree: string | null;
  experience: string | null;
  publishTime: string | null;
  recruiterName: string | null;
  recruiterTitle: string | null;
  jobUrl: string | null;
  status: 'active' | 'closed';
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  raw: unknown | null;
}

export interface CustomsProfile {
  companyId: string;
  englishName: string | null;
  chineseName: string | null;
  queryNames: string[];
  upstreamTotals: unknown;
  fetchedRecords: number;
  matchedRecords: number;
  exporterRecords: number;
  importerRecords: number;
  unmatchedRecords: number;
  dateMin: string | null;
  dateMax: string | null;
  destinations: unknown;
  origins: unknown;
  hs4: unknown;
  products: unknown;
  buyers: unknown;
  suppliers: unknown;
  totalWeight: number | null;
  totalCount: number | null;
  amount: number | null;
  sampleRecords: unknown;
  confidence: 'high' | 'medium' | 'low' | 'none';
  accountId: string | null;
  source: string;
  cached: boolean | null;
  cachedAt: string | null;
  expiresAt: string | null;
  upstreamVersion: string | null;
  sampled: boolean;
  fetchedAt: string;
  nextRefreshAt: string | null;
  version: number;
}

export interface QuotaSummary {
  daily: { limit: number; used: number; remaining: number; unit: string };
  monthly: { limit: number; used: number; remaining: number; unit: string };
  enterpriseMonthly: { limit: number; used: number; remaining: number; unit: string };
  settlementDay: number | null;
  nearlySevenDayUnlockCount: number | null;
  observedAt: string | null;
}

export interface SourceHealth {
  platform: AllPlatform;
  state: SourceHealthState;
  loggedIn: boolean | null;
  expiresAt: string | null;
  checkedAt: string;
  consecutiveFailures: number;
  detail: Record<string, unknown> | null;
}

export type EventType =
  | 'company.created'
  | 'company.updated'
  | 'contact.unlocked'
  | 'company.merged'
  | 'company.rematched'
  | 'platform.profile.updated'
  | 'platform.jobs.updated'
  | 'customs.updated';

export interface EventEnvelope {
  eventId: string;
  seq: number;
  type: EventType | string;
  occurredAt: string;
  companyId: string;
  version: number;
  source: string;
  runId: string | null;
  data: Record<string, unknown>;
}
