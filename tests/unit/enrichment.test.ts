/**
 * T2 单元测试：去重/归并（src/domain/dedupe.ts）+ 公司服务（src/services/companies.ts）
 * + 补全流水线（src/pipeline/enrichment.ts）。
 *
 * 全部使用内存 fake 仓库 + mock 探迹/Boss 端口，**不访问真实网络、不调用真实 unlock、不写真实 DB**。
 * 覆盖：USCC 优先去重、归一化名称+省市去重、英文抬头去重、字段 diff/事件、合并软删除、
 * rematch/unlock 入队、Boss source_detail → tanji_match → tanji_detail → unlock 全链路、
 * 英文抬头匹配、unmatched 不排队、已解锁不排 unlock、失败重试。
 */
import { describe, expect, it } from 'vitest';
import type {
  ChangeEventInput,
  Company,
  CompanySource,
  Contact,
  MatchCandidate,
  MatchMeta,
  Platform,
  Stage,
  UnlockStatus,
} from '../../src/shared/domain';
import type {
  ChangeEventRecord,
  CompanyListOptions,
  CompanyPatch,
  CompanyUpdateOptions,
  CursorPage,
  EnqueueResult,
  FailJobOptions,
  NewCompany,
  NewCompanySource,
  NewContact,
  NewPipelineJob,
  PipelineJob,
  RawSnapshot,
  SnapshotListOptions,
} from '../../src/repositories/types';
import { normalizeCompanyName, normalizeRegionName } from '../../src/domain/normalize';
import {
  buildMatchMeta,
  dedupeNameKeys,
  mergeCompanyViews,
  planCompanyAttach,
  planFieldPatch,
  type ExistingCompanyView,
  type SourceIdentity,
} from '../../src/domain/dedupe';
import {
  applyCompanyFields,
  configureCompaniesService,
  diffCompanyFields,
  createRematchJob,
  createUnlockJob,
  getCompanyDetail,
  listCompanies,
  listCompanyChanges,
  listCompanyContacts,
  mergeCompanies,
  upsertSourceCompany,
  type CompaniesServiceDeps,
  type CompanySourcesRepoPort,
  type CompaniesRepoPort,
  type ContactsRepoPort,
  type PipelineJobsRepoPort,
  type ChangeEventsRepoPort,
  type SnapshotsRepoPort,
} from '../../src/services/companies';
import {
  EnrichmentWorker,
  companyFieldsFromTanjiDetail,
  contactInputsFromTanji,
  parseCityFromAddress,
  regCapitalText,
  type EnrichmentWorkerDeps,
  type SourceDetailPort,
  type TanjiEnrichmentPort,
} from '../../src/pipeline/enrichment';
import type { TanjiCompanyDetail, TanjiContactsResult } from '../../src/adapters/tanji';
import { LeadError } from '../../src/shared/errors';
import { openMemoryDatabase } from '../../src/db/index';
import { createRepositories } from '../../src/repositories/index';
import { companiesDepsFromRepositories } from '../../src/services/companies';

// ===========================================================================
// 内存 fake：F2 repositories 端口实现
// ===========================================================================

let clock = 0;
function tick(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 16, 2, 0, 0) + clock * 60_000).toISOString();
}
function resetClock(): void {
  clock = 0;
}

class FakeCompaniesRepo implements CompaniesRepoPort {
  readonly rows = new Map<string, Company>();
  private seq = 0;

  create(input: NewCompany): Company {
    const id = input.id ?? `cmp_${++this.seq}`;
    const now = tick();
    const company: Company = {
      id,
      name: input.name,
      normalizedName: input.normalizedName ?? normalizeCompanyName(input.name),
      englishName: input.englishName ?? null,
      uscc: input.uscc ?? null,
      tanjiCompanyId: input.tanjiCompanyId ?? null,
      legalRepresentative: input.legalRepresentative ?? null,
      regCapital: input.regCapital ?? null,
      foundTime: input.foundTime ?? null,
      operStatus: input.operStatus ?? null,
      industry: input.industry ?? null,
      scale: input.scale ?? null,
      province: input.province ?? null,
      city: input.city ?? null,
      district: input.district ?? null,
      address: input.address ?? null,
      businessScope: input.businessScope ?? null,
      homepage: input.homepage ?? null,
      phoneCount: input.phoneCount ?? null,
      emailCount: input.emailCount ?? null,
      contactCount: input.contactCount ?? null,
      tradeTags: input.tradeTags ?? [],
      extra: input.extra ?? null,
      sourceCount: input.sourceCount ?? 0,
      enrichmentStatus: input.enrichmentStatus ?? 'discovered',
      unlockStatus: input.unlockStatus ?? 'none',
      matchMeta: input.matchMeta ?? null,
      firstRunId: input.firstRunId ?? null,
      firstSeenAt: input.firstSeenAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
      mergedInto: null,
      version: input.version ?? 1,
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    };
    this.rows.set(id, company);
    return { ...company };
  }

  getById(id: string, opts: { includeMerged?: boolean } = {}): Company | null {
    const company = this.rows.get(id);
    if (!company) return null;
    if (!opts.includeMerged && company.mergedInto) return null;
    return { ...company };
  }

  findByUscc(uscc: string): Company | null {
    for (const company of this.rows.values()) {
      if (!company.mergedInto && company.uscc === uscc) return { ...company };
    }
    return null;
  }

  findByTanjiId(tanjiCompanyId: string): Company | null {
    for (const company of this.rows.values()) {
      if (!company.mergedInto && company.tanjiCompanyId === tanjiCompanyId) return { ...company };
    }
    return null;
  }

  findByNormalizedName(normalizedName: string, opts: { province?: string; city?: string } = {}): Company[] {
    const out: Company[] = [];
    for (const company of this.rows.values()) {
      if (company.mergedInto) continue;
      if (company.normalizedName !== normalizedName) continue;
      if (opts.province && company.province && normalizeRegionName(company.province) !== normalizeRegionName(opts.province)) continue;
      if (opts.city && company.city && normalizeRegionName(company.city) !== normalizeRegionName(opts.city)) continue;
      out.push({ ...company });
    }
    return out;
  }

  update(id: string, patch: CompanyPatch, opts: CompanyUpdateOptions = {}): Company {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`company not found: ${id}`);
    if (opts.expectedVersion !== undefined && existing.version !== opts.expectedVersion) {
      throw new LeadError('CONFLICT', `version conflict: ${id}`);
    }
    const next: Company = { ...existing };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      (next as unknown as Record<string, unknown>)[key] = value;
    }
    // 模拟 SQLite UNIQUE(uscc) / UNIQUE(tanji_company_id) 约束
    for (const [field, column] of [
      ['uscc', 'companies.uscc'],
      ['tanjiCompanyId', 'companies.tanji_company_id'],
    ] as const) {
      const value = next[field];
      if (!value) continue;
      for (const other of this.rows.values()) {
        if (other.id === id || other.mergedInto) continue;
        if (other[field] === value) throw new Error(`UNIQUE constraint failed: ${column}`);
      }
    }
    if (opts.bumpVersion !== false) next.version = existing.version + 1;
    next.updatedAt = tick();
    this.rows.set(id, next);
    return { ...next };
  }

  listKeyset(opts: CompanyListOptions = {}): CursorPage<Company> {
    let items = [...this.rows.values()].filter((c) => opts.includeMerged || !c.mergedInto);
    if (opts.province) items = items.filter((c) => c.province === opts.province);
    if (opts.city) items = items.filter((c) => c.city === opts.city);
    if (opts.enrichmentStatus) {
      const values = Array.isArray(opts.enrichmentStatus) ? opts.enrichmentStatus : [opts.enrichmentStatus];
      items = items.filter((c) => values.includes(c.enrichmentStatus));
    }
    if (opts.unlockStatus) {
      const values = Array.isArray(opts.unlockStatus) ? opts.unlockStatus : [opts.unlockStatus];
      items = items.filter((c) => values.includes(c.unlockStatus));
    }
    if (opts.q) items = items.filter((c) => c.name.includes(opts.q as string));
    items.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : b.updatedAt.localeCompare(a.updatedAt)));
    let start = 0;
    if (opts.cursor) {
      const parsed = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as { updatedAt: string; id: string };
      start = items.findIndex((c) => c.updatedAt === parsed.updatedAt && c.id === parsed.id) + 1;
      if (start <= 0) start = 0;
    }
    const limit = opts.limit ?? 20;
    const page = items.slice(start, start + limit);
    const hasMore = start + limit < items.length;
    const last = page[page.length - 1];
    return {
      items: page.map((c) => ({ ...c })),
      hasMore,
      nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id }), 'utf8').toString('base64url') : null,
    };
  }

  count(filter: Omit<CompanyListOptions, 'limit' | 'cursor'> = {}): number {
    let items = [...this.rows.values()].filter((c) => filter.includeMerged || !c.mergedInto);
    if (filter.enrichmentStatus) {
      const values = Array.isArray(filter.enrichmentStatus) ? filter.enrichmentStatus : [filter.enrichmentStatus];
      items = items.filter((c) => values.includes(c.enrichmentStatus));
    }
    return items.length;
  }
}

class FakeCompanySourcesRepo implements CompanySourcesRepoPort {
  readonly rows = new Map<string, CompanySource>();
  private seq = 0;

  upsert(input: NewCompanySource): { source: CompanySource; created: boolean } {
    const key = `${input.platform}:${input.platformCompanyId}`;
    const existing = this.rows.get(key);
    const now = tick();
    if (existing) {
      const source: CompanySource = {
        ...existing,
        companyId: input.companyId,
        sourceName: input.sourceName ?? existing.sourceName,
        sourceUrl: input.sourceUrl ?? existing.sourceUrl,
        cityName: input.cityName ?? existing.cityName,
        evidence: { ...existing.evidence, ...(input.evidence ?? {}) },
        lastSeenAt: now,
      };
      this.rows.set(key, source);
      return { source: { ...source }, created: false };
    }
    const source: CompanySource = {
      id: input.id ?? `csrc_${++this.seq}`,
      companyId: input.companyId,
      platform: input.platform,
      platformCompanyId: input.platformCompanyId,
      sourceName: input.sourceName ?? null,
      sourceUrl: input.sourceUrl ?? null,
      cityName: input.cityName ?? null,
      evidence: input.evidence ?? {},
      firstSeenAt: input.firstSeenAt ?? now,
      lastSeenAt: input.lastSeenAt ?? now,
    };
    this.rows.set(key, source);
    return { source: { ...source }, created: true };
  }

  listByCompany(companyId: string): CompanySource[] {
    return [...this.rows.values()].filter((s) => s.companyId === companyId).map((s) => ({ ...s }));
  }

  countByCompany(companyId: string): number {
    return this.listByCompany(companyId).length;
  }
}

class FakeContactsRepo implements ContactsRepoPort {
  readonly rows: Contact[] = [];
  private seq = 0;

  upsertMany(inputs: NewContact[]): Contact[] {
    const out: Contact[] = [];
    for (const input of inputs) {
      const existing = this.rows.find(
        (c) => c.companyId === input.companyId && c.type === input.type && c.value === input.value,
      );
      if (existing) {
        out.push({ ...existing });
        continue;
      }
      const now = tick();
      const contact: Contact = {
        id: `ct_${++this.seq}`,
        companyId: input.companyId,
        tanjiContactId: input.tanjiContactId ?? null,
        name: input.name ?? null,
        position: input.position ?? null,
        department: input.department ?? null,
        region: input.region ?? null,
        type: input.type,
        value: input.value,
        masked: input.masked ?? false,
        source: input.source ?? null,
        isKey: input.isKey ?? false,
        unlockedAt: input.unlockedAt ?? null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(contact);
      out.push({ ...contact });
    }
    return out;
  }

  listByCompany(companyId: string, opts: { type?: Contact['type']; limit?: number } = {}): Contact[] {
    let items = this.rows.filter((c) => c.companyId === companyId);
    if (opts.type) items = items.filter((c) => c.type === opts.type);
    if (opts.limit) items = items.slice(0, opts.limit);
    return items.map((c) => ({ ...c }));
  }

  countByCompany(companyId: string): number {
    return this.rows.filter((c) => c.companyId === companyId).length;
  }

  summarizeByCompany(companyId: string): { total: number; types: Record<string, number>; unlockedAt: string | null } {
    const items = this.rows.filter((c) => c.companyId === companyId);
    const types: Record<string, number> = {};
    for (const item of items) types[item.type] = (types[item.type] ?? 0) + 1;
    const unlocked = items.filter((c) => c.unlockedAt).map((c) => c.unlockedAt as string).sort();
    return { total: items.length, types, unlockedAt: unlocked[unlocked.length - 1] ?? null };
  }
}

class FakeJobsRepo implements PipelineJobsRepoPort {
  readonly rows = new Map<string, PipelineJob>();
  private seq = 0;

  enqueue(input: NewPipelineJob & { resetExisting?: boolean }): EnqueueResult {
    for (const job of this.rows.values()) {
      if (job.companyId === input.companyId && job.stage === input.stage && (job.platform ?? null) === (input.platform ?? null)) {
        if (input.resetExisting && ['done', 'failed', 'dead', 'cancelled'].includes(job.status)) {
          job.status = 'pending';
          job.attempts = 0;
          job.nextRetryAt = null;
          job.updatedAt = tick();
        }
        return { job: { ...job }, created: false };
      }
    }
    const now = tick();
    const job: PipelineJob = {
      id: input.id ?? `job_${++this.seq}`,
      companyId: input.companyId,
      platform: (input.platform as Platform | null | undefined) ?? null,
      runId: input.runId ?? null,
      stage: input.stage,
      status: input.status ?? 'pending',
      attempts: input.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextRetryAt: input.nextRetryAt ?? null,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(job.id, job);
    return { job: { ...job }, created: true };
  }

  getById(id: string): PipelineJob | null {
    const job = this.rows.get(id);
    return job ? { ...job } : null;
  }

  findByIdentity(companyId: string, stage: Stage, platform?: Platform | null): PipelineJob | null {
    for (const job of this.rows.values()) {
      if (job.companyId === companyId && job.stage === stage && (job.platform ?? null) === (platform ?? null)) return { ...job };
    }
    return null;
  }

  claimNext(opts: { workerId: string; leaseSec?: number; stages?: Stage[]; stage?: Stage }): PipelineJob | null {
    const due = [...this.rows.values()]
      .filter((j) => j.status === 'pending')
      .filter((j) => (opts.stage ? j.stage === opts.stage : true))
      .filter((j) => (opts.stages ? opts.stages.includes(j.stage) : true))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const job = due[0];
    if (!job) return null;
    job.status = 'running';
    job.attempts += 1;
    job.leaseOwner = opts.workerId;
    job.leaseUntil = tick();
    job.updatedAt = tick();
    return { ...job };
  }

  complete(id: string): PipelineJob | null {
    const job = this.rows.get(id);
    if (!job) return null;
    job.status = 'done';
    job.updatedAt = tick();
    return { ...job };
  }

  fail(id: string, opts: FailJobOptions = {}): PipelineJob | null {
    const job = this.rows.get(id);
    if (!job) return null;
    const retryable = opts.retryable !== false;
    job.status = retryable && job.attempts < job.maxAttempts ? 'failed' : 'dead';
    job.lastError = opts.error ?? opts.message ?? null;
    job.updatedAt = tick();
    return { ...job };
  }

  listByCompany(companyId: string): PipelineJob[] {
    return [...this.rows.values()].filter((j) => j.companyId === companyId).map((j) => ({ ...j }));
  }
}

class FakeChangeEventsRepo implements ChangeEventsRepoPort {
  readonly rows: ChangeEventRecord[] = [];
  private seq = 0;

  append(input: ChangeEventInput): ChangeEventRecord {
    const now = tick();
    const row: ChangeEventRecord = {
      seq: ++this.seq,
      companyId: input.companyId,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      version: input.version,
      eventType: input.eventType,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      valueType: input.valueType ?? null,
      source: input.source,
      runId: input.runId ?? null,
      actor: input.actor ?? null,
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    this.rows.push(row);
    return { ...row };
  }

  appendMany(inputs: ChangeEventInput[]): ChangeEventRecord[] {
    return inputs.map((input) => this.append(input));
  }

  listByCompany(companyId: string, opts: { limit?: number; afterSeq?: number } = {}): ChangeEventRecord[] {
    return this.rows
      .filter((r) => r.companyId === companyId && r.seq > (opts.afterSeq ?? 0))
      .slice(0, opts.limit ?? 100)
      .map((r) => ({ ...r }));
  }
}

class FakeSnapshotsRepo implements SnapshotsRepoPort {
  readonly rows: RawSnapshot[] = [];
  private seq = 0;

  listSnapshots(opts: SnapshotListOptions = {}): RawSnapshot[] {
    return this.rows
      .filter((s) => (opts.refType ? s.refType === opts.refType : true))
      .filter((s) => (opts.refId ? s.refId === opts.refId : true))
      .slice(-(opts.limit ?? 100))
      .reverse()
      .map((s) => ({ ...s }));
  }

  writeText(input: { kind: string; payload: unknown; platform?: string | null; refType?: string | null; refId?: string | null; fetchedAt?: string }): {
    snapshot: RawSnapshot;
    blobCreated: boolean;
  } {
    const now = tick();
    const snapshot: RawSnapshot = {
      id: ++this.seq,
      kind: input.kind,
      platform: input.platform ?? null,
      runId: null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      url: null,
      blobHash: `sha256:fake-${this.seq}`,
      fetchedAt: input.fetchedAt ?? now,
      archived: false,
      archivePath: null,
      archivedAt: null,
    };
    this.rows.push(snapshot);
    return { snapshot: { ...snapshot }, blobCreated: true };
  }
}

// ===========================================================================
// 测试世界
// ===========================================================================

interface World {
  companies: FakeCompaniesRepo;
  companySources: FakeCompanySourcesRepo;
  contacts: FakeContactsRepo;
  jobs: FakeJobsRepo;
  changeEvents: FakeChangeEventsRepo;
  snapshots: FakeSnapshotsRepo;
  deps: CompaniesServiceDeps;
}

function createWorld(): World {
  resetClock();
  const companies = new FakeCompaniesRepo();
  const companySources = new FakeCompanySourcesRepo();
  const contacts = new FakeContactsRepo();
  const jobs = new FakeJobsRepo();
  const changeEvents = new FakeChangeEventsRepo();
  const snapshots = new FakeSnapshotsRepo();
  const deps: CompaniesServiceDeps = {
    companies,
    companySources,
    contacts,
    jobs,
    changeEvents,
    snapshots,
    transaction: (fn) => fn(),
    now: tick,
  };
  configureCompaniesService(deps);
  return { companies, companySources, contacts, jobs, changeEvents, snapshots, deps };
}

function companyOf(world: World, id: string): Company {
  const company = world.companies.rows.get(id);
  if (!company) throw new Error(`missing company ${id}`);
  return company;
}

function makeExisting(overrides: Partial<ExistingCompanyView> & { id: string; name: string }): ExistingCompanyView {
  return {
    normalizedName: normalizeCompanyName(overrides.name),
    englishName: null,
    uscc: null,
    tanjiCompanyId: null,
    province: '河北省',
    city: '石家庄市',
    mergedInto: null,
    ...overrides,
  };
}

function identity(overrides: Partial<SourceIdentity> = {}): SourceIdentity {
  return {
    platform: 'boss',
    name: '河北测试机械有限公司',
    province: '河北省',
    city: '石家庄市',
    ...overrides,
  };
}

// ===========================================================================
// 1. dedupe 纯函数
// ===========================================================================

describe('dedupe: 去重决策（USCC / tanji_id / 名称+省市）', () => {
  it('USCC 精确优先（大小写/分隔符归一），confidence=1', () => {
    const plan = planCompanyAttach(
      identity({ uscc: '91130100 test-0000x1', name: '名称不同也无妨' }),
      [makeExisting({ id: 'cmp_1', name: '另一个名字有限公司', uscc: '91130100TEST0000X1' })],
    );
    expect(plan).toMatchObject({ action: 'link', companyId: 'cmp_1', reason: 'uscc', confidence: 1 });
  });

  it('tanji_company_id 命中 → 关联（合并信号）', () => {
    const plan = planCompanyAttach(
      identity({ tanjiCompanyId: 'tj_123' }),
      [makeExisting({ id: 'cmp_9', name: '任意名字', tanjiCompanyId: 'tj_123' })],
    );
    expect(plan).toMatchObject({ action: 'link', companyId: 'cmp_9', reason: 'tanji_id' });
  });

  it('归一化名称相同 + 同省同市 → 关联；不同省 → 新建', () => {
    const hit = planCompanyAttach(
      identity({ name: '河北测试机械有限公司', province: '河北省', city: '石家庄市' }),
      [makeExisting({ id: 'cmp_2', name: '河北测试机械有限责任公司', province: '河北省', city: '石家庄' })],
    );
    expect(hit).toMatchObject({ action: 'link', reason: 'normalized_name' });
    expect(hit.confidence).toBeGreaterThanOrEqual(0.8);

    const miss = planCompanyAttach(
      identity({ name: '河北测试机械有限公司', province: '河北省' }),
      [makeExisting({ id: 'cmp_3', name: '河北测试机械有限公司', province: '广东省', city: '广州市' })],
    );
    expect(miss.action).toBe('create');
  });

  it('英文抬头归一化后可去重（Ali/Mic，跨大小写/法律后缀）', () => {
    const keys = dedupeNameKeys({ name: '河北测试机械有限公司', englishName: 'Test Hebei Machinery Co., Ltd.' });
    expect(keys).toContain('test hebei machinery');
    const plan = planCompanyAttach(
      identity({ platform: 'mic', name: 'HEBEI TEST MACHINERY CO., LTD.', province: '河北省', city: '石家庄市' }),
      [makeExisting({ id: 'cmp_4', name: '河北测试机械有限公司', englishName: 'Hebei Test Machinery Co., Ltd.' })],
    );
    expect(plan).toMatchObject({ action: 'link', companyId: 'cmp_4', reason: 'normalized_name' });
  });

  it('已合并主体不参与去重', () => {
    const plan = planCompanyAttach(identity(), [
      makeExisting({ id: 'cmp_5', name: '河北测试机械有限公司', mergedInto: 'cmp_x' }),
      makeExisting({ id: 'cmp_6', name: '河北测试机械有限公司' }),
    ]);
    expect(plan.companyId).toBe('cmp_6');
  });

  it('planFieldPatch：空字段用新值，低权威不覆盖高权威，tanji 可覆盖', () => {
    const existing = { name: '旧名', uscc: null, province: '河北省' };
    const fill = planFieldPatch(existing, { name: '新名', uscc: '91130100TEST0000X1', legalRepresentative: '张三' }, 'source_detail');
    expect(fill.uscc).toBe('91130100TEST0000X1');
    expect(fill.legalRepresentative).toBe('张三');
    expect(fill.name).toBe('新名'); // source_detail 权威性允许覆盖平台搜索名

    const noOverride = planFieldPatch({ name: '旧名' }, { name: '旧名' }, 'source_search');
    expect(noOverride).toEqual({});

    const tanji = planFieldPatch({ uscc: 'WRONGUSCC000000001', name: '旧名' }, { uscc: '91130100TEST0000X1' }, 'tanji');
    expect(tanji.uscc).toBe('91130100TEST0000X1');
  });

  it('diffCompanyFields：只返回实际变化字段（undefined 不参与）', () => {
    const changes = diffCompanyFields(
      { name: '旧名', uscc: null, province: '河北省' },
      { name: '新名', uscc: null, province: '河北省', city: '石家庄市', legalRepresentative: undefined },
    );
    expect(changes.map((c) => c.field)).toEqual(['name', 'city']);
  });

  it('buildMatchMeta 最多保留 5 个候选并 clamp confidence', () => {
    const candidates: MatchCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      id: `c${i}`,
      name: `候选${i}`,
      uscc: null,
      score: 1 - i / 10,
    }));
    const meta: MatchMeta = buildMatchMeta({ method: 'name_fuzzy', confidence: 1.5, candidates });
    expect(meta.confidence).toBe(1);
    expect(meta.candidates).toHaveLength(5);
  });
});

// ===========================================================================
// 2. companies 服务
// ===========================================================================

describe('companies 服务: 来源 upsert / 去重 / 字段 diff / 合并', () => {
  it('首次来源 upsert → 新建公司 + company_sources + company.created 事件', async () => {
    const world = createWorld();
    const result = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'boss_123',
      name: '河北测试机械有限公司',
      uscc: '91130100TEST0000X1',
      province: '河北省',
      city: '石家庄市',
      sourceUrl: 'https://example.test/company/123',
      evidence: { keyword: '外贸' },
      runId: 'run_1',
    });

    expect(result.companyCreated).toBe(true);
    expect(result.sourceCreated).toBe(true);
    expect(result.company.sourceCount).toBe(1);
    expect(result.company.normalizedName).toBe(normalizeCompanyName('河北测试机械有限公司'));
    expect(world.companySources.rows.size).toBe(1);
    const createdEvents = world.changeEvents.rows.filter((e) => e.eventType === 'company.created');
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.companyId).toBe(result.company.id);

    // 同一 (platform, platform_company_id) 再次 upsert → 不重复建公司
    const again = await upsertSourceCompany({ platform: 'boss', platformCompanyId: 'boss_123', name: '河北测试机械有限公司' });
    expect(again.company.id).toBe(result.company.id);
    expect(again.companyCreated).toBe(false);
    expect(again.sourceCreated).toBe(false);
    expect(world.companies.rows.size).toBe(1);
  });

  it('不同平台同一 USCC → 关联同一主档（dedupe reason uscc）', async () => {
    const world = createWorld();
    const first = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'b1',
      name: '河北测试机械有限公司',
      uscc: '91130100TEST0000X1',
      province: '河北省',
    });
    const second = await upsertSourceCompany({
      platform: 'zhilian',
      platformCompanyId: 'z1',
      name: '河北测试机械有限责任公司',
      uscc: '91130100TEST0000X1',
      province: '河北省',
    });
    expect(second.companyCreated).toBe(false);
    expect(second.dedupe.reason).toBe('uscc');
    expect(second.company.id).toBe(first.company.id);
    const company = companyOf(world, first.company.id);
    expect(company.sourceCount).toBe(2);
    expect(world.companySources.rows.size).toBe(2);
    const sourceEvents = world.changeEvents.rows.filter((e) => e.companyId === company.id && e.field === 'sourceCount');
    expect(sourceEvents.length).toBeGreaterThan(0);
  });

  it('applyCompanyFields：字段级 diff → version+1 + 事件；无变化不递增', async () => {
    const world = createWorld();
    const { company } = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'b1',
      name: '河北测试机械有限公司',
      province: '河北省',
    });
    const first = await applyCompanyFields(
      company.id,
      { legalRepresentative: '张三', industry: '机械制造' },
      { source: 'tanji', runId: 'run_2' },
    );
    expect(first.changed.map((c) => c.field).sort()).toEqual(['industry', 'legalRepresentative']);
    expect(first.company.version).toBe(company.version + 1);
    const events = world.changeEvents.rows.filter(
      (e) => e.companyId === company.id && e.eventType === 'company.updated' && e.version === first.company.version,
    );
    expect(events).toHaveLength(2);
    expect(events[0]?.version).toBe(first.company.version);

    const second = await applyCompanyFields(company.id, { legalRepresentative: '张三' }, { source: 'tanji' });
    expect(second.changed).toHaveLength(0);
    expect(second.company.version).toBe(first.company.version);
  });

  it('mergeCompanies：字段补全 + 来源迁移 + 软删除 merged_into + company.merged 事件', async () => {
    const world = createWorld();
    const source = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'b1',
      name: '河北测试机械有限公司',
      province: '河北省',
      city: '石家庄市',
    });
    const target = await upsertSourceCompany({
      platform: 'ali',
      platformCompanyId: 'a1',
      name: 'Test Hebei Machinery Group Co., Ltd.',
      englishName: 'Test Hebei Machinery Group Co., Ltd.',
      province: '河北省',
    });
    // 让 source 有 target 缺失的字段
    await applyCompanyFields(source.company.id, { legalRepresentative: '李四', sourceCount: 1 }, { source: 'source:boss' });

    const merged = await mergeCompanies(source.company.id, target.company.id, { source: 'tanji', runId: 'run_3' });
    expect(merged.source.mergedInto).toBe(target.company.id);
    expect(merged.target.legalRepresentative).toBe('李四');
    expect(merged.target.sourceCount).toBe(2);
    const targetSources = world.companySources.listByCompany(target.company.id);
    expect(targetSources.map((s) => s.platform).sort()).toEqual(['ali', 'boss']);
    const mergeEvents = world.changeEvents.rows.filter((e) => e.eventType === 'company.merged');
    expect(mergeEvents.length).toBeGreaterThanOrEqual(1);
    // 被合并主体默认查询不可见
    const list = await listCompanies({});
    expect(list.items.some((c) => c.id === source.company.id)).toBe(false);
  });

  it('createRematchJob / createUnlockJob：只入队（解锁前置 tanjiCompanyId，绝不调用探迹）', async () => {
    const world = createWorld();
    const created = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'b1',
      name: '河北测试机械有限公司',
      province: '河北省',
    });
    const rematch = await createRematchJob(created.company.id, { note: 'manual' });
    expect(rematch.stage).toBe('tanji_match');
    expect(rematch.created).toBe(true);
    // 已存在 pending → created=false
    const again = await createRematchJob(created.company.id, {});
    expect(again.jobId).toBe(rematch.jobId);
    expect(again.created).toBe(false);

    await expect(createUnlockJob(created.company.id, {})).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    await applyCompanyFields(created.company.id, { tanjiCompanyId: 'tj_1', enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });
    const unlock = await createUnlockJob(created.company.id, { idempotencyKey: 'unlock:x:2026-11-16' });
    expect(unlock.stage).toBe('unlock');
    expect(unlock.status).toBe('pending');
    expect(world.jobs.rows.get(unlock.jobId)?.stage).toBe('unlock');
  });
});

describe('companies 服务: 查询', () => {
  it('listCompanies / getCompanyDetail / sources / contacts / changes', async () => {
    const world = createWorld();
    const created = await upsertSourceCompany({
      platform: 'boss',
      platformCompanyId: 'b1',
      name: '河北测试机械有限公司',
      province: '河北省',
      city: '石家庄市',
      evidence: { keyword: '外贸' },
    });
    await applyCompanyFields(created.company.id, { enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });

    const list = await listCompanies({ province: '河北省', limit: 10 });
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.sourcePlatforms).toEqual(['boss']);
    expect(list.total).toBe(1);

    const detail = await getCompanyDetail(created.company.id);
    expect(detail.company.id).toBe(created.company.id);
    expect(detail.sources).toHaveLength(1);
    expect(detail.contacts.total).toBe(0);
    expect(detail.recentChanges.length).toBeGreaterThan(0);

    const sources = await (await import('../../src/services/companies')).listCompanySources(created.company.id);
    expect(sources[0]?.platform).toBe('boss');

    await world.contacts.upsertMany([
      { companyId: created.company.id, type: 'mobile', value: '13800000000', masked: false, unlockedAt: tick() },
    ]);
    const contacts = await listCompanyContacts(created.company.id, {});
    expect(contacts.total).toBe(1);
    expect(contacts.items[0]?.value).toBe('13800000000');

    const changes = await listCompanyChanges(created.company.id, { limit: 10 });
    expect(changes.items.length).toBeGreaterThan(0);
    expect(changes.nextSeq).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. enrichment worker
// ===========================================================================

function candidateSummary(overrides: Partial<Parameters<typeof makeCandidate>[0]> & { id: string; name: string }) {
  return makeCandidate(overrides);
}
function makeCandidate(input: { id: string; name: string; uscc?: string | null; province?: string | null; city?: string | null; address?: string | null; score?: number | null }): {
  id: string;
  name: string;
  uscc: string | null;
  englishName: string | null;
  province: string | null;
  city: string | null;
  address: string | null;
  score: number | null;
  rankScore: number | null;
} {
  return {
    uscc: null,
    englishName: null,
    province: '河北省',
    city: null,
    address: null,
    score: 900,
    rankScore: null,
    ...input,
  };
}

class MockTanji implements TanjiEnrichmentPort {
  readonly searches: Array<{ name: string; field?: string }> = [];
  readonly detailCalls: string[] = [];
  readonly contactCalls: string[] = [];
  searchHandler: (name: string, field?: string) => { companies: ReturnType<typeof makeCandidate>[]; total: number } = () => ({
    companies: [],
    total: 0,
  });
  detail: TanjiCompanyDetail = makeTanjiDetail();
  contacts: TanjiContactsResult = { companyId: null, unlocked: false, contacts: [], counts: { mobile: 0, phone: 0, email: 0, total: 0 }, raw: null };
  detailError: unknown = null;

  async searchByName(params: { name: string; field?: 'name' | 'socialCreditCode' | 'address' | 'contact' }) {
    this.searches.push({ name: params.name, field: params.field });
    const result = this.searchHandler(params.name, params.field);
    return { companies: result.companies, total: result.total };
  }

  async getCompany(companyId: string): Promise<TanjiCompanyDetail> {
    this.detailCalls.push(companyId);
    if (this.detailError) throw this.detailError;
    return this.detail;
  }

  async getContacts(companyId: string): Promise<TanjiContactsResult> {
    this.contactCalls.push(companyId);
    return this.contacts;
  }
}

function makeTanjiDetail(overrides: Partial<TanjiCompanyDetail> = {}): TanjiCompanyDetail {
  return {
    id: 'tj_target',
    name: '河北测试机械有限公司',
    uscc: '91130100TEST0000X1',
    englishName: 'Test Hebei Machinery Co., Ltd.',
    legalRepresentative: '张三',
    regCapital: { amount: '500', unit: '万元', currency: '人民币' },
    foundTime: '2012-05-18',
    address: '河北省石家庄市桥西区测试路1号',
    province: '河北省',
    city: null,
    operStatus: '营业 > 存续',
    industry: { name: '机械制造' },
    scale: '100-499人',
    businessScope: '货物或技术进出口',
    homepage: 'https://example.test',
    phoneCount: 3,
    emailCount: 1,
    contactCount: 4,
    unlocked: false,
    tags: ['高新企业'],
    updatedAt: '2026-11-16T00:00:00.000Z',
    raw: { companyType: '有限责任公司', branchCount: 2 },
    ...overrides,
  };
}

function makeSourceDetail(): SourceDetailPort {
  return {
    async getCompanyDetail(platformCompanyId: string) {
      return {
        displayName: '河北测试机械有限公司',
        business: {
          companyName: '河北测试机械有限公司',
          uscc: '91130100TEST0000X1',
          legalRepresentative: '张三',
          foundedAt: '2012-05-18',
          registeredCapital: '500万人民币',
          registeredAddress: '河北省石家庄市桥西区测试路1号',
          businessStatus: '存续',
          businessScope: '货物或技术进出口',
          industry: '机械制造',
          city: '石家庄市',
          usccSource: 'boss_company_page_text',
          textDerived: true,
        },
        profile: { fullName: '河北测试机械有限公司', industry: '机械制造', scale: '100-499人', cityName: '石家庄市' },
        raw: { platformCompanyId },
      };
    },
  };
}

interface EnrichmentWorld extends World {
  tanji: MockTanji;
  worker: EnrichmentWorker;
  enrichmentDeps: EnrichmentWorkerDeps;
}

function createEnrichmentWorld(options: { sources?: EnrichmentWorkerDeps['sources'] } = {}): EnrichmentWorld {
  const world = createWorld() as EnrichmentWorld;
  world.tanji = new MockTanji();
  world.enrichmentDeps = {
    ...world.deps,
    tanji: world.tanji,
    sources: options.sources ?? { boss: makeSourceDetail(), zhilian: makeSourceDetail() },
    snapshotWrite: true,
  };
  world.worker = new EnrichmentWorker(world.enrichmentDeps, { workerId: 'test-worker', maxJobs: 5 });
  return world;
}

async function seedCompany(world: World, input: { platform?: Platform; name?: string; englishName?: string } = {}): Promise<Company> {
  const platform = input.platform ?? 'boss';
  const result = await upsertSourceCompany({
    platform,
    platformCompanyId: `${platform}_1`,
    name: input.name ?? '河北测试机械有限公司',
    englishName: input.englishName,
    province: '河北省',
    city: '石家庄市',
    evidence: { keyword: '外贸' },
  });
  return result.company;
}

describe('enrichment: 全链路（source_detail → tanji_match → tanji_detail → unlock 入队）', () => {
  it('Boss 公司：平台详情提示 → USCC 匹配 → 探迹详情补全 → 入队 unlock（未真实调用）', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world);
    world.jobs.enqueue({ companyId: company.id, stage: 'source_detail', platform: 'boss', runId: 'run_1' });
    world.tanji.searchHandler = () => ({ companies: [candidateSummary({ id: 'tj_target', name: '河北测试机械有限公司', uscc: '91130100TEST0000X1', province: '河北省', score: 1024 })], total: 1 });

    const stats = await world.worker.runUntilIdle(10);
    expect(stats.failed).toBe(0);
    expect(stats.claimed).toBeGreaterThanOrEqual(3); // source_detail + tanji_match + tanji_detail

    const enriched = companyOf(world, company.id);
    expect(enriched.enrichmentStatus).toBe('tanji_enriched');
    expect(enriched.tanjiCompanyId).toBe('tj_target');
    expect(enriched.legalRepresentative).toBe('张三');
    expect(enriched.regCapital).toBe('500万元人民币');
    expect(enriched.foundTime).toBe('2012-05-18');
    expect(enriched.city).toBe('石家庄市');
    expect(enriched.matchMeta?.method).toBe('uscc');
    expect(enriched.matchMeta?.confidence).toBe(1);
    expect(enriched.unlockStatus).toBe('pending');
    // 探迹详情/联系人被调用（mock，无真实网络）
    expect(world.tanji.detailCalls).toEqual(['tj_target']);
    expect(world.tanji.contactCalls).toEqual(['tj_target']);
    // unlock 仅入队，status=pending
    const unlockJob = world.jobs.findByIdentity(company.id, 'unlock');
    expect(unlockJob?.status).toBe('pending');
    // 事件与快照留痕
    expect(world.changeEvents.rows.some((e) => e.field === 'tanjiCompanyId')).toBe(true);
    expect(world.snapshots.rows.map((s) => s.kind)).toEqual(expect.arrayContaining(['source_company_detail', 'tanji_search', 'tanji_company_detail']));
  });

  it('无结果 → enrichmentStatus=unmatched，不入队 unlock、不拉详情', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world);
    world.jobs.enqueue({ companyId: company.id, stage: 'tanji_match', platform: null });
    world.tanji.searchHandler = () => ({ companies: [], total: 0 });

    const stats = await world.worker.runOnce();
    expect(stats.unmatched).toBe(1);
    const after = companyOf(world, company.id);
    expect(after.enrichmentStatus).toBe('unmatched');
    expect(world.jobs.findByIdentity(company.id, 'unlock')).toBeNull();
    expect(world.tanji.detailCalls).toEqual([]);
  });

  it('Ali 英文抬头：首次搜索用英文名 → method=english_name → 进入 tanji_detail', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world, {
      platform: 'ali',
      name: '河北测试机械有限公司',
      englishName: 'Test Hebei Machinery Co., Ltd.',
    });
    world.jobs.enqueue({ companyId: company.id, stage: 'tanji_match', platform: null });
    world.tanji.searchHandler = (name) => {
      if (name.startsWith('Test Hebei')) {
        return { companies: [candidateSummary({ id: 'tj_en', name: '河北测试机械有限公司', uscc: '91130100TEST0000X1', province: '河北省', address: '河北省石家庄市桥西区测试路1号', score: 466 })], total: 1 };
      }
      return { companies: [], total: 0 };
    };

    const result = await world.worker.processJob(world.jobs.claimNext({ workerId: 'w', stages: ['tanji_match'] })!);
    expect(result.outcome).toBe('done');
    expect(world.tanji.searches[0]?.name).toBe('Test Hebei Machinery Co., Ltd.');
    expect(world.tanji.searches[0]?.field).toBe('name');
    const matched = companyOf(world, company.id);
    expect(matched.tanjiCompanyId).toBe('tj_en');
    expect(matched.matchMeta?.method).toBe('english_name');
    expect(world.jobs.findByIdentity(company.id, 'tanji_detail')?.status).toBe('pending');
  });

  it('探迹主体已被其他公司占用 → 自动合并（merged_into + company.merged）', async () => {
    const world = createEnrichmentWorld();
    // 目标公司（已有 tanjiCompanyId）
    const target = await seedCompany(world, { platform: 'ali', name: '河北目标机械有限公司' });
    await applyCompanyFields(target.id, { tanjiCompanyId: 'tj_shared', enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });
    // 待匹配公司
    const incoming = await seedCompany(world, { platform: 'boss', name: '河北测试机械有限公司' });
    world.jobs.enqueue({ companyId: incoming.id, stage: 'tanji_match', platform: null });
    world.tanji.searchHandler = () => ({ companies: [candidateSummary({ id: 'tj_shared', name: '河北目标机械有限公司', province: '河北省', score: 900 })], total: 1 });

    const job = world.jobs.claimNext({ workerId: 'w', stages: ['tanji_match'] })!;
    const result = await world.worker.processJob(job);
    expect(result.outcome).toBe('done');
    expect(result.companyId).toBe(target.id);

    const mergedSource = companyOf(world, incoming.id);
    expect(mergedSource.mergedInto).toBe(target.id);
    const t = companyOf(world, target.id);
    expect(t.sourceCount).toBe(2);
    expect(world.companySources.listByCompany(target.id).map((s) => s.platform).sort()).toEqual(['ali', 'boss']);
    expect(world.changeEvents.rows.some((e) => e.eventType === 'company.merged')).toBe(true);
    expect(world.jobs.findByIdentity(target.id, 'tanji_detail')?.status).toBe('pending');
  });

  it('tanji_detail：contacts 显示已解锁 → 导入明文联系人、不排队 unlock', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world);
    world.jobs.enqueue({ companyId: company.id, stage: 'tanji_detail', platform: null });
    await applyCompanyFields(company.id, { tanjiCompanyId: 'tj_target', enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });
    world.tanji.contacts = {
      companyId: 'tj_target',
      unlocked: true,
      counts: { mobile: 1, phone: 0, email: 1, total: 2 },
      raw: {},
      contacts: [
        {
          contactId: 'ct_1',
          name: '王五',
          type: 'mobile',
          value: '13800000000',
          masked: false,
          department: '外贸部',
          position: '经理',
          region: '石家庄',
          source: '政务公示',
          isKeyLead: true,
          unlocked: true,
          raw: {},
        },
        {
          contactId: 'ct_2',
          name: '王五',
          type: 'email',
          value: 'wang@example.test',
          masked: false,
          department: null,
          position: null,
          region: null,
          source: null,
          isKeyLead: false,
          unlocked: true,
          raw: {},
        },
      ],
    };

    const job = world.jobs.claimNext({ workerId: 'w', stages: ['tanji_detail'] })!;
    const result = await world.worker.processJob(job);
    expect(result.outcome).toBe('done');

    const after = companyOf(world, company.id);
    expect(after.enrichmentStatus).toBe('tanji_enriched');
    expect(after.unlockStatus).toBe('unlocked');
    expect(after.contactCount).toBe(2);
    expect(world.contacts.rows).toHaveLength(2);
    expect(world.contacts.rows[0]?.masked).toBe(false);
    expect(world.jobs.findByIdentity(company.id, 'unlock')).toBeNull();
  });

  it('tanji_detail：探迹权威 USCC 已属于另一公司 → 自动合并到已有主体后补全', async () => {
    const world = createEnrichmentWorld();
    // 已有主体（其它来源先写入 USCC）
    const existing = await seedCompany(world, { platform: 'ali', name: '河北冒烟测试机械有限公司' });
    await applyCompanyFields(existing.id, { uscc: '91130100TEST0000X1', sourceCount: 1 }, { source: 'source:ali' });
    // 当前公司：已匹配同一探迹主体但尚无 USCC
    const current = await seedCompany(world, { platform: 'boss', name: '河北冒烟二号测试有限公司' });
    await applyCompanyFields(current.id, { tanjiCompanyId: 'tj_target', enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });
    world.jobs.enqueue({ companyId: current.id, stage: 'tanji_detail', platform: null });

    const job = world.jobs.claimNext({ workerId: 'w', stages: ['tanji_detail'] })!;
    const result = await world.worker.processJob(job);
    expect(result.outcome).toBe('done');

    // 当前公司软删除合并到已有主体
    expect(companyOf(world, current.id).mergedInto).toBe(existing.id);
    const target = companyOf(world, existing.id);
    expect(target.tanjiCompanyId).toBe('tj_target');
    expect(target.enrichmentStatus).toBe('tanji_enriched');
    expect(target.legalRepresentative).toBe('张三');
    expect(target.unlockStatus).toBe('pending');
    expect(world.jobs.findByIdentity(existing.id, 'unlock')?.status).toBe('pending');
    expect(world.changeEvents.rows.some((e) => e.eventType === 'company.merged' && e.companyId === existing.id)).toBe(true);
  });

  it('source_detail 适配器缺失/来源缺失 → 跳过详情继续匹配（不阻塞整条流水线）', async () => {
    const world = createEnrichmentWorld({ sources: {} });
    const company = await seedCompany(world);
    world.jobs.enqueue({ companyId: company.id, stage: 'source_detail', platform: 'boss' });
    world.tanji.searchHandler = () => ({ companies: [], total: 0 });

    const job = world.jobs.claimNext({ workerId: 'w', stages: ['source_detail'] })!;
    const result = await world.worker.processJob(job);
    expect(result.outcome).toBe('done');
    expect(result.enqueued).toContain('tanji_match');
    expect(companyOf(world, company.id).enrichmentStatus).toBe('source_detailed');
  });

  it('探迹详情失败（SOURCE_UNAVAILABLE）→ job failed 可重试，enrichmentStatus 不变', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world);
    await applyCompanyFields(company.id, { tanjiCompanyId: 'tj_target', enrichmentStatus: 'tanji_matched' }, { source: 'tanji' });
    world.jobs.enqueue({ companyId: company.id, stage: 'tanji_detail', platform: null });
    world.tanji.detailError = new LeadError('SOURCE_UNAVAILABLE', 'upstream down', { retryable: true });

    const job = world.jobs.claimNext({ workerId: 'w', stages: ['tanji_detail'] })!;
    const result = await world.worker.processJob(job);
    expect(result.outcome).toBe('failed');
    expect(result.errorCode).toBe('SOURCE_UNAVAILABLE');
    expect(companyOf(world, company.id).enrichmentStatus).toBe('tanji_matched');
    const failedJob = world.jobs.rows.get(job.id);
    expect(failedJob?.status).toBe('failed');
    expect(failedJob?.lastError).toBe('SOURCE_UNAVAILABLE');
  });

  it('低置信度仍自动匹配（用户决策）但 matchMeta.confidence 记录低分', async () => {
    const world = createEnrichmentWorld();
    const company = await seedCompany(world);
    world.jobs.enqueue({ companyId: company.id, stage: 'tanji_match', platform: null });
    // 名称相似度低 + 省份不匹配 → confidence < 0.55
    world.tanji.searchHandler = () => ({ companies: [candidateSummary({ id: 'tj_low', name: '广州南方纺织有限公司', province: '广东省', score: 30 })], total: 1 });

    const result = await world.worker.processJob(world.jobs.claimNext({ workerId: 'w', stages: ['tanji_match'] })!);
    expect(result.outcome).toBe('done');
    const after = companyOf(world, company.id);
    expect(after.tanjiCompanyId).toBe('tj_low');
    expect(after.matchMeta?.confidence).toBeLessThan(0.55);
    expect(world.jobs.findByIdentity(company.id, 'tanji_detail')?.status).toBe('pending');
  });
});

// ===========================================================================
// 4. 探迹字段映射工具
// ===========================================================================

describe('enrichment: 探迹字段映射工具', () => {
  it('regCapitalText / industryName / parseCityFromAddress', () => {
    expect(regCapitalText({ text: '500万人民币' })).toBe('500万人民币');
    expect(regCapitalText({ amount: 500, unit: '万元', currency: '人民币' })).toBe('500万元人民币');
    expect(regCapitalText(null)).toBeNull();
    expect(companyFieldsFromTanjiDetail(makeTanjiDetail()).industry).toBe('机械制造');
    expect(parseCityFromAddress('河北省唐山市丰南区')).toBe('唐山市');
    expect(parseCityFromAddress(null)).toBeNull();
  });

  it('contactInputsFromTanji 过滤空值并映射类型/关键联系人', () => {
    const contacts = contactInputsFromTanji('cmp_1', [
      {
        contactId: 'c1',
        name: '李四',
        type: 'mobile',
        value: '13900000000',
        masked: false,
        department: null,
        position: '经理',
        region: null,
        source: null,
        isKeyLead: true,
        unlocked: true,
        raw: {},
      },
      {
        contactId: 'c2',
        name: null,
        type: 'phone',
        value: '   ',
        masked: true,
        department: null,
        position: null,
        region: null,
        source: null,
        isKeyLead: false,
        unlocked: false,
        raw: {},
      },
    ]);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ companyId: 'cmp_1', type: 'mobile', isKey: true, tanjiContactId: 'c1' });
    expect(contacts[0]?.unlockedAt).toBeTruthy();
  });

  it('mergeCompanyViews：仅补空字段 + sourceCount 相加 + tags 并集', () => {
    const world = createWorld();
    const base = world.companies.create({
      id: 'cmp_base',
      name: '目标公司有限公司',
      province: '河北省',
      sourceCount: 2,
      tradeTags: ['a'],
    });
    const source: Company = {
      ...base,
      id: 'cmp_src',
      name: '来源公司有限公司',
      uscc: '91130100SRC000001',
      sourceCount: 1,
      tradeTags: ['b'],
      mergedInto: null,
    };
    const patch = mergeCompanyViews(source, base);
    expect(patch.uscc).toBe('91130100SRC000001');
    expect(patch.sourceCount).toBe(3);
    expect(patch.tradeTags?.sort()).toEqual(['a', 'b']);
  });
});

// ===========================================================================
// 5. 真实 SQLite 内存库集成（F2 repositories；验证服务端口与数据层契约一致）
// ===========================================================================

describe('真实 DB 集成：F2 repositories + companies 服务 + Enrichment Worker', () => {
  it('USCC 去重 / diff 事件 / 查询 / Enrichment 全链路（含 UNIQUE uscc 冲突合并）', async () => {
    const db = openMemoryDatabase({ migrate: true });
    try {
      const repos = createRepositories(db);
      const realDeps = companiesDepsFromRepositories(repos);

      // 1) USCC 去重：boss + zhilian 两条来源 → 同一主档
      const boss = await upsertSourceCompany(
        {
          platform: 'boss',
          platformCompanyId: 'real_b1',
          name: '河北真实库测试机械有限公司',
          uscc: '91130100REALDB0001',
          province: '河北省',
          city: '石家庄市',
          evidence: { keyword: '外贸' },
        },
        realDeps,
      );
      const zhilian = await upsertSourceCompany(
        {
          platform: 'zhilian',
          platformCompanyId: 'real_z1',
          name: '河北真实库测试机械有限责任公司',
          uscc: '91130100REALDB0001',
          province: '河北省',
        },
        realDeps,
      );
      expect(zhilian.company.id).toBe(boss.company.id);
      expect(repos.companySources.listByCompany(boss.company.id)).toHaveLength(2);

      // 2) 字段 diff → 真实 change_events（version 递增）
      const updated = await applyCompanyFields(
        boss.company.id,
        { legalRepresentative: '张三', industry: '机械制造' },
        { source: 'tanji', runId: 'run_real' },
        realDeps,
      );
      expect(updated.company.version).toBeGreaterThan(boss.company.version);
      const changes = await listCompanyChanges(boss.company.id, { limit: 50 }, realDeps);
      expect(changes.items.some((e) => e.field === 'legalRepresentative' && e.version === updated.company.version)).toBe(true);
      const detail = await getCompanyDetail(boss.company.id, {}, realDeps);
      expect(detail.sources).toHaveLength(2);

      // 3) Enrichment Worker（mock tanji）：匹配 → 详情 → USCC 冲突合并 → 入队 unlock
      const second = (
        await upsertSourceCompany(
          { platform: 'boss', platformCompanyId: 'real_b2', name: '河北真实库二号测试有限公司', province: '河北省' },
          realDeps,
        )
      ).company;
      const mockTanji: TanjiEnrichmentPort = {
        async searchByName() {
          return {
            companies: [
              { id: 'tj_real', name: '河北真实库测试机械有限公司', uscc: '91130100REALDB0001', province: '河北省', score: 1000 },
            ],
            total: 1,
          };
        },
        async getCompany(id: string) {
          return makeTanjiDetail({ id, name: '河北真实库测试机械有限公司', uscc: '91130100REALDB0001', legalRepresentative: '李四' });
        },
        async getContacts(id: string) {
          return { companyId: id, unlocked: false, contacts: [], counts: null, raw: {} };
        },
      };
      const worker = new EnrichmentWorker(
        { ...realDeps, tanji: mockTanji, sources: {} },
        { workerId: 'real-db-test', maxJobs: 5 },
      );
      repos.jobs.enqueue({ companyId: second.id, stage: 'tanji_match' });
      const stats = await worker.runUntilIdle(10);
      expect(stats.failed).toBe(0);

      const mergedAway = repos.companies.getById(second.id, { includeMerged: true });
      expect(mergedAway?.mergedInto).toBe(boss.company.id);
      const target = repos.companies.getById(boss.company.id);
      expect(target?.tanjiCompanyId).toBe('tj_real');
      expect(target?.enrichmentStatus).toBe('tanji_enriched');
      expect(target?.unlockStatus).toBe('pending');
      expect(repos.jobs.findByIdentity(boss.company.id, 'unlock')?.status).toBe('pending');
      expect(repos.companySources.listByCompany(boss.company.id)).toHaveLength(3);
    } finally {
      db.close();
    }
  });
});
