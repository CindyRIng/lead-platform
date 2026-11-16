/**
 * 编排层数据访问端口（Ports）。
 *
 * 目的：services / pipeline 不直接 import F2 的具体实现，只依赖这里的窄接口；
 * 运行期由 `src/pipeline/wiring.ts` 注入 F2 `createRepositories(db)` 返回的对象。
 * 方法命名/语义与 foundation-dev 公布的 `Repositories` 子集保持一致，
 * 因此 wiring 侧基本是结构直传（必要时仅对返回形状做一次归一）。
 */
import type {
  ChangeEventInput,
  Company,
  CompanySource,
  Goal,
  GoalRun,
  GoalRunStatus,
  Platform,
  RegionRow,
  RunStats,
  SourceHealth,
  SourceHealthState,
  AllPlatform,
} from '../shared/domain.js';

export type MaybePromise<T> = T | Promise<T>;

/** 统一「列表接口」返回形状兼容：数组 或 {items,total} */
export type ListResult<T> = T[] | { items: T[]; total?: number };

export function listItems<T>(result: ListResult<T> | null | undefined): T[] {
  if (!result) return [];
  return Array.isArray(result) ? result : result.items;
}

// ---------------------------------------------------------------------------
// goals
// ---------------------------------------------------------------------------

export interface GoalCreateData {
  id?: string;
  name: string;
  region: { province: string; provinceCode?: string; cityCodes?: string[] };
  platforms: Platform[];
  keywords: Partial<Record<Platform, string[]>>;
  maxLeadsPerRun?: number | null;
  dailyLeadLimit?: number | null;
  schedule: { cron: string; timeZone: string; timeWindow?: string | null };
  priority: number;
  tradeFilter?: unknown | null;
  unlockPolicy: { mode: 'priority'; order: string[] };
  enabled?: boolean;
}

export type GoalPatch = Partial<Omit<GoalCreateData, 'id'>> & { version?: number };

export interface GoalsPort {
  create(input: GoalCreateData): MaybePromise<Goal>;
  getById(id: string): MaybePromise<Goal | null>;
  list(filter?: { enabled?: boolean; limit?: number; offset?: number }): MaybePromise<ListResult<Goal>>;
  update(id: string, patch: Record<string, unknown>, opts?: { expectedVersion?: number }): MaybePromise<Goal>;
  setEnabled(id: string, enabled: boolean): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// goal_runs
// ---------------------------------------------------------------------------

export interface RunCreateInput {
  goalId: string;
  trigger: 'cron' | 'manual';
  id?: string;
  actor?: string;
}

export interface GoalRunsPort {
  create(input: RunCreateInput): MaybePromise<GoalRun>;
  getById(id: string): MaybePromise<GoalRun | null>;
  list(filter?: { goalId?: string; status?: GoalRunStatus; limit?: number; offset?: number }): MaybePromise<ListResult<GoalRun>>;
  listByGoal(goalId: string, limit?: number): MaybePromise<GoalRun[]>;
  findActiveByGoal(goalId: string): MaybePromise<GoalRun | null>;
  findInterrupted(): MaybePromise<GoalRun[]>;
  updateStatus(
    id: string,
    status: GoalRunStatus,
    opts?: { finishedAt?: string | null; errorCode?: string | null; errorMessage?: string | null; stats?: RunStats },
  ): MaybePromise<GoalRun | null>;
  updateStats(id: string, stats: RunStats): MaybePromise<void>;
  heartbeat(id: string, at?: string): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// source_queries
// ---------------------------------------------------------------------------

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

export interface SourceQueryCreateInput {
  runId: string;
  platform: Platform;
  cityCode: string;
  platformRegionValue: string;
  keyword?: string | null;
  id?: string;
}

export interface SourceQueriesPort {
  create(input: SourceQueryCreateInput): MaybePromise<{ query: SourceQueryRecord; created: boolean } | SourceQueryRecord>;
  listByRun(runId: string): MaybePromise<SourceQueryRecord[]>;
  updateProgress(
    id: string,
    patch: Partial<{
      pagesFetched: number;
      totalPages: number | null;
      totalCount: number | null;
      status: SourceQueryStatus;
      upstreamQueryId: string | null;
      startedAt: string | null;
      finishedAt: string | null;
      lastError: string | null;
    }>,
  ): MaybePromise<unknown>;
}

export function unwrapQueryCreate(result: { query: SourceQueryRecord; created: boolean } | SourceQueryRecord): SourceQueryRecord {
  return 'query' in result && result.query ? result.query : (result as SourceQueryRecord);
}

// ---------------------------------------------------------------------------
// raw snapshots
// ---------------------------------------------------------------------------

export interface SnapshotWriteInput {
  kind: string;
  payload: string | unknown;
  platform?: AllPlatform | null;
  runId?: string | null;
  refType?: string | null;
  refId?: string | null;
  url?: string | null;
  fetchedAt?: string;
}

export interface SnapshotRecordLike {
  id: number;
  kind?: string;
  blobHash?: string | null;
}

export interface SnapshotWriteResult {
  snapshot: SnapshotRecordLike;
  blobCreated: boolean;
}

export interface SnapshotsPort {
  writeText(input: SnapshotWriteInput): MaybePromise<SnapshotWriteResult>;
}

// ---------------------------------------------------------------------------
// companies / company_sources
// ---------------------------------------------------------------------------

export type CompanyCreateData = Partial<Company> & { name: string; normalizedName: string };

export interface CompaniesPort {
  create(input: CompanyCreateData): MaybePromise<Company>;
  getById(id: string): MaybePromise<Company | null>;
  findByUscc(uscc: string): MaybePromise<Company | null>;
  findByNormalizedName(
    normalizedName: string,
    filter?: { province?: string | null; city?: string | null },
  ): MaybePromise<Company | null>;
  update(id: string, patch: Partial<Company>, opts?: { expectedVersion?: number; bumpVersion?: boolean }): MaybePromise<Company>;
  touchLastSeen(id: string, at?: string): MaybePromise<void>;
}

export interface CompanySourceUpsertInput {
  companyId: string;
  platform: Platform;
  platformCompanyId: string;
  sourceName?: string | null;
  sourceUrl?: string | null;
  cityName?: string | null;
  evidence: Record<string, unknown>;
  firstSeenAt?: string;
  lastSeenAt?: string;
}

export interface CompanySourcesPort {
  upsert(input: CompanySourceUpsertInput): MaybePromise<{ source: CompanySource; created: boolean }>;
  getByPlatformId(platform: Platform, platformCompanyId: string): MaybePromise<CompanySource | null>;
  /** 某公司的来源平台记录数（用于刷新 companies.source_count） */
  countByCompany?(companyId: string): MaybePromise<number>;
}

// ---------------------------------------------------------------------------
// pipeline_jobs
// ---------------------------------------------------------------------------

export interface PipelineEnqueueInput {
  companyId: string;
  stage: string;
  platform?: string | null;
  runId?: string | null;
  maxAttempts?: number;
  nextRetryAt?: string | null;
}

export interface PipelineJobsPort {
  enqueue(input: PipelineEnqueueInput): MaybePromise<{ job: { id: string }; created: boolean }>;
}

// ---------------------------------------------------------------------------
// regions / region_platform_map
// ---------------------------------------------------------------------------

export interface RegionMappingRow {
  regionCode: string;
  platform: Platform;
  platformValue: string;
  source?: string | null;
  syncedAt?: string | null;
}

export interface RegionsPort {
  upsertRegions(rows: RegionRow[]): MaybePromise<void>;
  listCities(provinceCode: string): MaybePromise<RegionRow[]>;
  getRegion(code: string): MaybePromise<RegionRow | null>;
  upsertMapping(row: RegionMappingRow): MaybePromise<void>;
  upsertMappings(rows: RegionMappingRow[]): MaybePromise<void>;
  getMapping(regionCode: string, platform: Platform): MaybePromise<{ platformValue: string } | null>;
  listMappingsForProvince(provinceCode: string, platform: Platform): MaybePromise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// source_health
// ---------------------------------------------------------------------------

export interface SourceHealthUpsert {
  platform: AllPlatform;
  state: SourceHealthState;
  loggedIn?: boolean | null;
  expiresAt?: string | null;
  checkedAt?: string;
  consecutiveFailures?: number;
  detail?: Record<string, unknown> | null;
}

export interface SourceHealthPort {
  upsert(input: SourceHealthUpsert): MaybePromise<SourceHealth | void>;
  get(platform: AllPlatform): MaybePromise<SourceHealth | null>;
  listAll(): MaybePromise<SourceHealth[]>;
  markFailure?(platform: AllPlatform, state: SourceHealthState, detail?: Record<string, unknown> | null): MaybePromise<unknown>;
}

// ---------------------------------------------------------------------------
// change_events（新公司 company.created 事件；可选）
// ---------------------------------------------------------------------------

export interface ChangeEventsPort {
  append(input: ChangeEventInput): MaybePromise<unknown>;
}

// ---------------------------------------------------------------------------
// meta（调度状态/leader 锁；可选）
// ---------------------------------------------------------------------------

export interface MetaPort {
  get(key: string): MaybePromise<{ value: string } | string | null>;
  set(key: string, value: unknown): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// 聚合端口（services / pipeline 使用的全部依赖）
// ---------------------------------------------------------------------------

export interface PipelineRepos {
  goals: GoalsPort;
  runs: GoalRunsPort;
  sourceQueries: SourceQueriesPort;
  snapshots: SnapshotsPort;
  companies: CompaniesPort;
  companySources: CompanySourcesPort;
  jobs: PipelineJobsPort;
  regions: RegionsPort;
  sourceHealth: SourceHealthPort;
  /** change_events 写入（可选；新建公司时发 company.created） */
  changeEvents?: ChangeEventsPort;
  meta?: MetaPort;
}
