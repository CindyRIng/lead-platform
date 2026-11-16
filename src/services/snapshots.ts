/**
 * 原始快照服务（FR-4、docs/02 §5.4/§10.1）。
 *
 * 流式采集要求：每拿到一页/一家公司详情立即落快照（append-only），便于回溯/重放。
 * 压缩（brotli 默认）+ 内容哈希去重由 F2 `repositories.snapshots.writeText` 负责；
 * 本模块只负责 kind/ref/run 语义、payload 序列化与快照 id 返回。
 */
import type { AllPlatform } from '../shared/domain.js';
import type { SnapshotsPort } from '../pipeline/ports.js';
import { getServiceContext, type ServiceContext } from './context.js';

export type SnapshotKind =
  | 'source_search_page'
  | 'source_company_detail'
  | 'source_company_jobs'
  | 'tanji_search'
  | 'tanji_company_detail'
  | 'fuma_customs_query';

export interface WriteSnapshotInput {
  kind: SnapshotKind | string;
  platform?: AllPlatform | null;
  runId?: string | null;
  refType?: string | null;
  refId?: string | null;
  url?: string | null;
  payload: unknown;
  fetchedAt?: string;
}

export interface SnapshotWriteResult {
  snapshotId: number;
  blobHash: string | null;
  deduped: boolean;
  fetchedAt: string;
}

export interface SnapshotServiceDeps {
  snapshots: SnapshotsPort;
  now?: () => Date;
}

function serializePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

export function createSnapshotService(deps: SnapshotServiceDeps) {
  const now = deps.now ?? (() => new Date());

  async function write(input: WriteSnapshotInput): Promise<SnapshotWriteResult> {
    const fetchedAt = input.fetchedAt ?? now().toISOString();
    const body = serializePayload(input.payload);
    const result = await deps.snapshots.writeText({
      kind: input.kind,
      payload: body,
      platform: input.platform ?? null,
      runId: input.runId ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      url: input.url ?? null,
      fetchedAt,
    });
    const snapshot = result?.snapshot as { id?: number; blobHash?: string | null; hash?: string } | undefined;
    return {
      snapshotId: Number(snapshot?.id ?? 0),
      blobHash: snapshot?.blobHash ?? snapshot?.hash ?? null,
      deduped: result?.blobCreated === false,
      fetchedAt,
    };
  }

  /** 检索页快照（Boss/智联/Ali/Mic 每次搜索/翻页响应） */
  async function writeSearchPage(input: {
    platform: AllPlatform;
    runId?: string | null;
    queryId?: string | null;
    sourceQueryId?: string | null;
    keyword?: string | null;
    cityCode?: string | null;
    url?: string | null;
    payload: unknown;
  }): Promise<SnapshotWriteResult> {
    return write({
      kind: input.platform === 'tanji' ? 'tanji_search' : 'source_search_page',
      platform: input.platform,
      runId: input.runId ?? null,
      refType: input.sourceQueryId ? 'source_query' : 'upstream_query',
      refId: input.sourceQueryId ?? input.queryId ?? null,
      url: input.url ?? null,
      payload: {
        platform: input.platform,
        queryId: input.queryId ?? null,
        keyword: input.keyword ?? null,
        cityCode: input.cityCode ?? null,
        fetchedAt: now().toISOString(),
        payload: input.payload,
      },
    });
  }

  /** 公司详情快照（Boss/智联/Ali/Mic 平台公司详情） */
  async function writeCompanyDetail(input: {
    platform: AllPlatform;
    runId?: string | null;
    platformCompanyId: string;
    url?: string | null;
    payload: unknown;
  }): Promise<SnapshotWriteResult> {
    return write({
      kind: input.platform === 'tanji' ? 'tanji_company_detail' : input.platform === 'fuma' ? 'fuma_customs_query' : 'source_company_detail',
      platform: input.platform,
      runId: input.runId ?? null,
      refType: 'company_source',
      refId: input.platformCompanyId,
      url: input.url ?? null,
      payload: input.payload,
    });
  }

  /** 公司岗位列表快照（Boss/智联） */
  async function writeCompanyJobs(input: {
    platform: 'boss' | 'zhilian';
    runId?: string | null;
    platformCompanyId: string;
    url?: string | null;
    payload: unknown;
  }): Promise<SnapshotWriteResult> {
    return write({
      kind: 'source_company_jobs',
      platform: input.platform,
      runId: input.runId ?? null,
      refType: 'company_source',
      refId: input.platformCompanyId,
      url: input.url ?? null,
      payload: input.payload,
    });
  }

  return { write, writeSearchPage, writeCompanyDetail, writeCompanyJobs };
}

export type SnapshotService = ReturnType<typeof createSnapshotService>;

let defaultService: SnapshotService | null = null;

function service(): SnapshotService {
  if (!defaultService) {
    const ctx: ServiceContext = getServiceContext();
    defaultService = createSnapshotService({ snapshots: ctx.repos.snapshots, now: ctx.now });
  }
  return defaultService;
}

export function resetSnapshotService(): void {
  defaultService = null;
}

export const writeSnapshot = (input: WriteSnapshotInput): Promise<SnapshotWriteResult> => service().write(input);
export const writeSearchPageSnapshot: SnapshotService['writeSearchPage'] = (input) => service().writeSearchPage(input);
export const writeCompanyDetailSnapshot: SnapshotService['writeCompanyDetail'] = (input) => service().writeCompanyDetail(input);
export const writeCompanyJobsSnapshot: SnapshotService['writeCompanyJobs'] = (input) => service().writeCompanyJobs(input);

