/**
 * repositories 类型契约（camelCase，输入/输出均与 shared/domain.ts 对齐）
 *
 * 约定：
 * - `NewXxx` = 写入输入（可选字段用 ?，缺省由仓库补默认值）
 * - `XxxRecord` = 从 DB 读出的完整行（camelCase；JSON 字段已解析为 JS 值）
 * - `XxxPatch` = 局部更新（undefined 表示不更新；null 表示显式置空）
 */
import type {
  AllPlatform,
  Company,
  CompanySource,
  Contact,
  CustomsProfile,
  EnrichmentStatus,
  Goal,
  GoalRegion,
  GoalRun,
  GoalRunStatus,
  JobStatus,
  MatchMeta,
  Platform,
  PlatformJob,
  PlatformProfile,
  PlatformStatus,
  RegionRow,
  RunStats,
  SourceHealth,
  SourceHealthState,
  Stage,
  UnlockStatus,
} from '../shared/domain.js';
import type { CompressionEncoding } from '../utils/compress.js';

// 便捷再导出：其他模块可直接从 repositories/types.js 取 shared 领域类型
export type {
  AllPlatform,
  Company,
  CompanySource,
  Contact,
  CoverageStats,
  CustomsProfile,
  EnrichmentStatus,
  EventEnvelope,
  EventType,
  Goal,
  GoalRegion,
  GoalRun,
  GoalRunStatus,
  JobStatus,
  MatchCandidate,
  MatchMeta,
  Platform,
  PlatformJob,
  PlatformProfile,
  PlatformStatus,
  RegionRow,
  RunStats,
  SourceHealth,
  SourceHealthState,
  SourceLead,
  Stage,
  UnlockStatus,
} from '../shared/domain.js';

// ---------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------

export interface MetaEntry {
  key: string;
  value: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// goals / goal_runs / source_queries
// ---------------------------------------------------------------------------

export interface NewGoal {
  id?: string;
  name: string;
  region: GoalRegion;
  platforms: Platform[];
  keywords: Partial<Record<Platform, string[]>>;
  maxLeadsPerRun?: number | null;
  dailyLeadLimit?: number | null;
  schedule?: { cron?: string; timeZone?: string; timeWindow?: string | null } | null;
  priority?: number;
  tradeFilter?: unknown | null;
  unlockPolicy?: { mode: 'priority'; order: string[] };
  enabled?: boolean;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

export type GoalPatch = {
  name?: string;
  region?: GoalRegion;
  platforms?: Platform[];
  keywords?: Partial<Record<Platform, string[]>>;
  maxLeadsPerRun?: number | null;
  dailyLeadLimit?: number | null;
  schedule?: { cron?: string; timeZone?: string; timeWindow?: string | null } | null;
  priority?: number;
  tradeFilter?: unknown | null;
  unlockPolicy?: { mode: 'priority'; order: string[] };
  enabled?: boolean;
};

export interface GoalListOptions {
  enabled?: boolean;
  limit?: number;
  offset?: number;
}

export interface GoalRunRecord extends GoalRun {
  heartbeatAt: string | null;
}

export interface NewGoalRun {
  id?: string;
  goalId: string;
  trigger: 'cron' | 'manual';
  status?: GoalRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  stats?: RunStats;
  errorCode?: string | null;
  errorMessage?: string | null;
  createdAt?: string;
}

export interface GoalRunPatch {
  status?: GoalRunStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  heartbeatAt?: string | null;
  stats?: RunStats;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface GoalRunListOptions {
  goalId?: string;
  status?: GoalRunStatus | GoalRunStatus[];
  limit?: number;
  offset?: number;
}

export type SourceQueryStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SourceQueryRecord {
  id: string;
  runId: string;
  platform: Platform;
  cityCode: string;
  platformRegionValue: string;
  keyword: string | null;
  upstreamQueryId: string | null;
  status: SourceQueryStatus;
  pagesFetched: number;
  totalPages: number | null;
  totalCount: number | null;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface NewSourceQuery {
  id?: string;
  runId: string;
  platform: Platform;
  cityCode: string;
  platformRegionValue: string;
  keyword?: string | null;
  upstreamQueryId?: string | null;
  status?: SourceQueryStatus;
  pagesFetched?: number;
  totalPages?: number | null;
  totalCount?: number | null;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface SourceQueryProgress {
  status?: SourceQueryStatus;
  pagesFetched?: number;
  totalPages?: number | null;
  totalCount?: number | null;
  upstreamQueryId?: string | null;
  lastError?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface SourceQueryStats {
  total: number;
  pending: number;
  running: number;
  done: number;
  failed: number;
  skipped: number;
}

// ---------------------------------------------------------------------------
// raw_blobs / raw_snapshots
// ---------------------------------------------------------------------------

export interface RawSnapshot {
  id: number;
  kind: string;
  platform: string | null;
  runId: string | null;
  refType: string | null;
  refId: string | null;
  url: string | null;
  blobHash: string;
  fetchedAt: string;
  archived: boolean;
  archivePath: string | null;
  archivedAt: string | null;
}

export interface NewRawSnapshot {
  kind: string;
  platform?: string | null;
  runId?: string | null;
  refType?: string | null;
  refId?: string | null;
  url?: string | null;
  blobHash: string;
  fetchedAt?: string;
  archived?: boolean;
  archivePath?: string | null;
  archivedAt?: string | null;
}

export interface SnapshotWriteInput {
  kind: string;
  payload: unknown;
  platform?: string | null;
  runId?: string | null;
  refType?: string | null;
  refId?: string | null;
  url?: string | null;
  fetchedAt?: string;
  encoding?: CompressionEncoding;
}

export interface BlobRecord {
  hash: string;
  encoding: CompressionEncoding;
  body: Buffer;
  bytes: number;
  createdAt: string;
}

export interface BlobPutResult {
  hash: string;
  encoding: CompressionEncoding;
  created: boolean;
  bytes: number;
  storedBytes: number;
}

export interface SnapshotWriteResult {
  snapshot: RawSnapshot;
  blob: BlobPutResult;
  blobCreated: boolean;
}

export interface SnapshotListOptions {
  kind?: string;
  platform?: string;
  runId?: string;
  refType?: string;
  refId?: string;
  archived?: boolean;
  afterId?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// companies
// ---------------------------------------------------------------------------

export interface NewCompany {
  id?: string;
  name: string;
  normalizedName?: string;
  englishName?: string | null;
  uscc?: string | null;
  tanjiCompanyId?: string | null;
  legalRepresentative?: string | null;
  regCapital?: string | null;
  foundTime?: string | null;
  operStatus?: string | null;
  industry?: string | null;
  scale?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  businessScope?: string | null;
  homepage?: string | null;
  phoneCount?: number | null;
  emailCount?: number | null;
  contactCount?: number | null;
  tradeTags?: string[];
  extra?: Record<string, unknown> | null;
  sourceCount?: number;
  enrichmentStatus?: EnrichmentStatus;
  unlockStatus?: UnlockStatus;
  matchMeta?: MatchMeta | null;
  firstRunId?: string | null;
  firstSeenAt?: string;
  lastSeenAt?: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 局部更新：undefined = 不改；null = 置空 */
export type CompanyPatch = {
  name?: string;
  normalizedName?: string;
  englishName?: string | null;
  uscc?: string | null;
  tanjiCompanyId?: string | null;
  legalRepresentative?: string | null;
  regCapital?: string | null;
  foundTime?: string | null;
  operStatus?: string | null;
  industry?: string | null;
  scale?: string | null;
  province?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  businessScope?: string | null;
  homepage?: string | null;
  phoneCount?: number | null;
  emailCount?: number | null;
  contactCount?: number | null;
  tradeTags?: string[];
  extra?: Record<string, unknown> | null;
  sourceCount?: number;
  enrichmentStatus?: EnrichmentStatus;
  unlockStatus?: UnlockStatus;
  matchMeta?: MatchMeta | null;
  firstRunId?: string | null;
  lastSeenAt?: string;
  mergedInto?: string | null;
};

export interface CompanyUpdateOptions {
  /** 乐观锁：必须匹配当前 version，否则抛 CONFLICT */
  expectedVersion?: number;
  /** 是否 version+1（默认 true；纯 last_seen 刷新可用 false） */
  bumpVersion?: boolean;
}

export interface CompanyListOptions {
  limit?: number;
  cursor?: string | null;
  province?: string;
  city?: string;
  enrichmentStatus?: EnrichmentStatus | EnrichmentStatus[];
  unlockStatus?: UnlockStatus | UnlockStatus[];
  sourcePlatform?: Platform;
  /** 名称包含搜索（对 name / english_name / uscc 做 LIKE） */
  q?: string;
  includeMerged?: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface CompanyStats {
  total: number;
  merged: number;
  byEnrichment: Record<string, number>;
  byUnlock: Record<string, number>;
  bySourcePlatform: Record<string, number>;
}

// ---------------------------------------------------------------------------
// company_sources / company_contacts
// ---------------------------------------------------------------------------

export interface NewCompanySource {
  id?: string;
  companyId: string;
  platform: Platform;
  platformCompanyId: string;
  sourceName?: string | null;
  sourceUrl?: string | null;
  cityName?: string | null;
  evidence?: Record<string, unknown>;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface CompanySourceUpsertResult {
  source: CompanySource;
  created: boolean;
}

export interface NewContact {
  id?: string;
  companyId: string;
  tanjiContactId?: string | null;
  name?: string | null;
  position?: string | null;
  department?: string | null;
  region?: string | null;
  type: 'mobile' | 'phone' | 'email';
  value: string;
  masked?: boolean;
  source?: string | null;
  isKey?: boolean;
  unlockedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// pipeline_jobs
// ---------------------------------------------------------------------------

export interface PipelineJob {
  id: string;
  companyId: string;
  platform: Platform | null;
  runId: string | null;
  stage: Stage;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  nextRetryAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewPipelineJob {
  id?: string;
  companyId: string;
  stage: Stage;
  platform?: Platform | null;
  runId?: string | null;
  status?: JobStatus;
  attempts?: number;
  maxAttempts?: number;
  nextRetryAt?: string | null;
  createdAt?: string;
}

export interface EnqueueResult {
  job: PipelineJob;
  created: boolean;
}

export interface ClaimNextOptions {
  workerId: string;
  leaseSec?: number;
  stages?: Stage[];
  stage?: Stage;
  platform?: Platform | null;
  runId?: string;
  /** 是否回收 lease_until 过期的 running 任务（默认 true） */
  reclaimExpired?: boolean;
  now?: Date | string;
}

export interface ClaimByIdOptions {
  workerId: string;
  leaseSec?: number;
  now?: Date | string;
}

export interface FailJobOptions {
  error?: string;
  message?: string;
  errorCode?: string;
  retryable?: boolean;
  /** 明确的重试时间（ISO）；null = 直接进入 dead */
  nextRetryAt?: string | null;
  now?: Date | string;
}

export interface JobListOptions {
  status?: JobStatus | JobStatus[];
  stage?: Stage | Stage[];
  companyId?: string;
  runId?: string;
  platform?: Platform;
  limit?: number;
  offset?: number;
}

export interface JobStats {
  pending: number;
  running: number;
  waitingQuota: number;
  done: number;
  failed: number;
  dead: number;
  cancelled: number;
}

// ---------------------------------------------------------------------------
// unlock_ledger
// ---------------------------------------------------------------------------

export type UnlockLedgerResult = 'unlocked' | 'already_unlocked' | 'failed';

export interface UnlockLedgerEntry {
  id: string;
  companyId: string;
  tanjiCompanyId: string | null;
  result: UnlockLedgerResult;
  quotaCost: number;
  quotaBefore: number | null;
  quotaAfter: number | null;
  accountId: string | null;
  idempotencyKey: string;
  errorCode: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

export interface NewUnlockLedger {
  id?: string;
  companyId: string;
  tanjiCompanyId?: string | null;
  result: UnlockLedgerResult;
  quotaCost?: number;
  quotaBefore?: number | null;
  quotaAfter?: number | null;
  accountId?: string | null;
  idempotencyKey: string;
  errorCode?: string | null;
  requestedAt?: string;
  finishedAt?: string | null;
}

export interface UnlockLedgerInsertResult {
  entry: UnlockLedgerEntry;
  created: boolean;
}

export interface UnlockLedgerFinish {
  result?: UnlockLedgerResult;
  quotaCost?: number;
  quotaAfter?: number | null;
  finishedAt?: string;
  errorCode?: string | null;
}

// ---------------------------------------------------------------------------
// change_events
// ---------------------------------------------------------------------------

export interface ChangeEventRecord {
  seq: number;
  companyId: string;
  entityType: 'company' | 'platform_profile' | 'job' | string;
  entityId: string | null;
  version: number;
  eventType: string;
  field: string | null;
  oldValue: unknown;
  newValue: unknown;
  valueType: string | null;
  source: string;
  runId: string | null;
  actor: string | null;
  occurredAt: string;
  createdAt: string;
}

export interface ChangeEventListOptions {
  types?: string[];
  companyId?: string;
  entityType?: string;
  runId?: string;
  limit?: number;
}

export interface CompanyChangeListOptions {
  limit?: number;
  afterSeq?: number;
  maxVersion?: number;
}

// ---------------------------------------------------------------------------
// webhooks
// ---------------------------------------------------------------------------

export interface WebhookSubscription {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewWebhookSubscription {
  id?: string;
  url: string;
  secret?: string;
  eventTypes?: string[];
  active?: boolean;
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventSeq: number;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextRetryAt: string | null;
  responseStatus: number | null;
  responseBodyHead: string | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface NewWebhookDelivery {
  id?: string;
  subscriptionId: string;
  eventSeq: number;
  eventType: string;
  status?: WebhookDeliveryStatus;
  attempts?: number;
  nextRetryAt?: string | null;
  responseStatus?: number | null;
  responseBodyHead?: string | null;
  lastError?: string | null;
  createdAt?: string;
  deliveredAt?: string | null;
}

export interface DeliveryListOptions {
  subscriptionId?: string;
  status?: WebhookDeliveryStatus | WebhookDeliveryStatus[];
  limit?: number;
  offset?: number;
}

export interface MarkDeliveredInput {
  responseStatus?: number | null;
  responseBodyHead?: string | null;
  deliveredAt?: string;
}

export interface MarkDeliveryFailedInput {
  error?: string | null;
  retryable?: boolean;
  nextRetryAt?: string | null;
  status?: 'failed' | 'dead';
  responseStatus?: number | null;
  responseBodyHead?: string | null;
}

// ---------------------------------------------------------------------------
// quota_observations / source_health
// ---------------------------------------------------------------------------

export interface QuotaObservation {
  id: string;
  observedAt: string;
  dailyLimit: number | null;
  dailyRemaining: number | null;
  monthlyLimit: number | null;
  monthlyRemaining: number | null;
  enterpriseLimit: number | null;
  enterpriseRemaining: number | null;
  settlementDay: number | null;
  raw: unknown;
}

export interface NewQuotaObservation {
  id?: string;
  observedAt?: string;
  dailyLimit?: number | null;
  dailyRemaining?: number | null;
  monthlyLimit?: number | null;
  monthlyRemaining?: number | null;
  enterpriseLimit?: number | null;
  enterpriseRemaining?: number | null;
  settlementDay?: number | null;
  raw?: unknown;
}

export type SourceHealthRecord = SourceHealth;

export interface NewSourceHealth {
  platform: AllPlatform;
  state: SourceHealthState;
  loggedIn?: boolean | null;
  expiresAt?: string | null;
  checkedAt?: string;
  consecutiveFailures?: number;
  detail?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// regions / region_platform_map
// ---------------------------------------------------------------------------

export type RegionRecord = RegionRow;

export interface RegionPlatformMapping {
  regionCode: string;
  platform: Platform;
  platformValue: string;
  source: string | null;
  syncedAt: string | null;
}

export interface NewRegionPlatformMapping {
  regionCode: string;
  platform: Platform;
  platformValue: string;
  source?: string | null;
  syncedAt?: string | null;
}

// ---------------------------------------------------------------------------
// company_platform_profiles / company_platform_jobs
// ---------------------------------------------------------------------------

export interface PlatformProfileRecord extends PlatformProfile {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPlatformProfile {
  id?: string;
  companyId: string;
  platform: Platform;
  platformCompanyId: string;
  displayName?: string | null;
  sourceUrl?: string | null;
  fullName?: string | null;
  cityName?: string | null;
  address?: string | null;
  industry?: string | null;
  scale?: string | null;
  stage?: string | null;
  logoUrl?: string | null;
  intro?: string | null;
  tags?: string[] | null;
  benefits?: string[] | null;
  jobCount?: number | null;
  bossCount?: number | null;
  recruiters?: unknown | null;
  store?: Record<string, unknown> | null;
  platformStatus?: PlatformStatus;
  lastFetchedAt?: string;
  lastSeenAt?: string | null;
  nextJobsRefreshAt?: string | null;
  nextStoreRefreshAt?: string | null;
  rawSnapshotId?: number | null;
  version?: number;
}

export type PlatformProfilePatch = Partial<Omit<NewPlatformProfile, 'id' | 'companyId' | 'platform' | 'platformCompanyId'>>;

export interface PlatformProfileUpsertResult {
  profile: PlatformProfileRecord;
  previous: PlatformProfileRecord | null;
  created: boolean;
}

export interface PlatformJobRecord extends PlatformJob {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewPlatformJob {
  id?: string;
  companyId: string;
  platform: 'boss' | 'zhilian';
  platformCompanyId: string;
  jobId: string;
  title: string;
  salaryText?: string | null;
  salaryMin?: number | null;
  salaryMax?: number | null;
  cityName?: string | null;
  district?: string | null;
  degree?: string | null;
  experience?: string | null;
  publishTime?: string | null;
  recruiterName?: string | null;
  recruiterTitle?: string | null;
  jobUrl?: string | null;
  status?: 'active' | 'closed';
  firstSeenAt?: string;
  lastSeenAt?: string;
  closedAt?: string | null;
  raw?: unknown;
}

export interface PlatformJobUpsertResult {
  job: PlatformJobRecord;
  previous: PlatformJobRecord | null;
  created: boolean;
}

// ---------------------------------------------------------------------------
// company_customs_profiles
// ---------------------------------------------------------------------------

export interface CustomsProfileRecord extends CustomsProfile {
  createdAt: string;
  updatedAt: string;
}

export interface NewCustomsProfile {
  companyId: string;
  englishName?: string | null;
  chineseName?: string | null;
  queryNames?: string[];
  upstreamTotals?: unknown;
  fetchedRecords?: number;
  matchedRecords?: number;
  exporterRecords?: number;
  importerRecords?: number;
  unmatchedRecords?: number;
  dateMin?: string | null;
  dateMax?: string | null;
  destinations?: unknown;
  origins?: unknown;
  hs4?: unknown;
  products?: unknown;
  buyers?: unknown;
  suppliers?: unknown;
  totalWeight?: number | null;
  totalCount?: number | null;
  amount?: number | null;
  sampleRecords?: unknown;
  confidence?: 'high' | 'medium' | 'low' | 'none';
  accountId?: string | null;
  source?: string;
  cached?: boolean | null;
  cachedAt?: string | null;
  expiresAt?: string | null;
  upstreamVersion?: string | null;
  sampled?: boolean;
  fetchedAt?: string;
  nextRefreshAt?: string | null;
  version?: number;
}

export interface CustomsProfileUpsertResult {
  profile: CustomsProfileRecord;
  previous: CustomsProfileRecord | null;
  created: boolean;
}

export interface CustomsListOptions {
  now?: Date | string;
  limit?: number;
}
