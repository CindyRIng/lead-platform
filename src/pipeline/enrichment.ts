/**
 * Enrichment Worker（P3）：消费 pipeline_jobs(stage=source_detail / tanji_match / tanji_detail)，
 * 完成「平台详情 → 探迹匹配 → 探迹工商详情 → 解锁入队」。
 *
 * 契约：
 * - docs/02 §7.2（公司状态机）、§8（去重合并）、§9（探迹匹配）、§11（解锁入队）
 * - docs/04 §3.5/§5（探迹字段映射）、§7（错误归一）
 * - docs/01 FR-5/FR-6、BR-18（Ali/Mic 英文抬头匹配）
 *
 * 设计：
 * - 依赖注入：窄仓库端口（与 F2 repositories 兼容）+ 探迹端口 + Boss/智联详情端口；
 *   单测全部 mock，不访问网络、不调用真实 unlock。
 * - 每个 stage 结束后入队下一阶段（tanji_match / tanji_detail / unlock），失败按
 *   retryable 交给 pipeline_jobs 退避/死信；QUOTA 不在此模块产生（解锁 worker 负责）。
 * - tanji_matched 若发现 tanji_company_id 已被其他公司占用 → 触发公司合并（docs/02 §8.2c）。
 * - tanji_detail 先查探迹 contacts 判断是否已解锁（docs/09 §2.5：以 contacts 接口为准）：
 *   unlocked=true 直接拉联系人入库（不耗额度、不排 unlock）；否则入队 unlock。
 * - raw_snapshots 记录 tanji_search / tanji_company_detail（摘要 + 原始 payload，若端口可用）。
 */
import type {
  Company,
  Contact,
  EnrichmentStatus,
  MatchMeta,
  Stage,
  UnlockStatus,
} from '../shared/domain.js';
import { LeadError, toLeadError } from '../shared/errors.js';
import { HEBEI_CITIES } from '../shared/constants.js';
import { asRecord } from '../shared/json.js';
import { nowIso } from '../shared/time.js';
import { normalizeRegionName } from '../domain/normalize.js';
import { buildMatchMeta, normalizeUsccKey } from '../domain/dedupe.js';
import { matchCompany, type MatchCandidateSource, type MatchOptions, type MatchResult } from '../domain/matching.js';
import type { TanjiCompanyDetail, TanjiContactItem, TanjiContactsResult } from '../adapters/tanji.js';
import type { NewContact, PipelineJob } from '../repositories/types.js';
import {
  applyCompanyFields,
  createUnlockJob,
  mergeCompanies,
  mergeCompanies as mergeCompanyRecords,
  recordMatchResult,
  type CompaniesServiceDeps,
} from '../services/companies.js';

// ---------------------------------------------------------------------------
// 端口 / 类型
// ---------------------------------------------------------------------------

/** 探迹端口（T1 `TanjiClient` 结构化满足；单测注入 mock） */
export interface TanjiEnrichmentPort {
  searchByName(params: {
    name: string;
    field?: 'name' | 'socialCreditCode' | 'address' | 'contact';
    pageSize?: number;
    maxPages?: number;
  }): Promise<{ companies: MatchCandidateSource[]; total?: number; hasMore?: boolean; warnings?: string[] }>;
  getCompany(companyId: string, opts?: { refresh?: boolean }): Promise<TanjiCompanyDetail>;
  getContacts(companyId: string): Promise<TanjiContactsResult>;
}

/** 平台详情中的工商提示（Boss/智联文本推导） */
export interface BusinessHintLike {
  companyName?: string | null;
  uscc?: string | null;
  legalRepresentative?: string | null;
  foundedAt?: string | null;
  registeredCapital?: string | null;
  registeredAddress?: string | null;
  businessStatus?: string | null;
  businessScope?: string | null;
  industry?: string | null;
  city?: string | null;
  usccSource?: string | null;
  textDerived?: boolean;
}

export interface ProfileFieldsLike {
  fullName?: string | null;
  industry?: string | null;
  scale?: string | null;
  cityName?: string | null;
  address?: string | null;
}

/** Boss/智联详情端口（S2 `RecruitmentSource` 结构子集） */
export interface SourceDetailPort {
  getCompanyDetail(platformCompanyId: string): Promise<{
    business?: BusinessHintLike | null;
    displayName?: string | null;
    profile?: ProfileFieldsLike | null;
    raw?: unknown;
  }>;
}

export interface EnrichmentWorkerDeps extends CompaniesServiceDeps {
  tanji: TanjiEnrichmentPort;
  /** Boss/智联详情适配器（source_detail 阶段；缺省时跳过平台详情直接匹配） */
  sources?: { boss?: SourceDetailPort | null; zhilian?: SourceDetailPort | null };
  /** 匹配算法选项（阈值等） */
  matchingOptions?: MatchOptions;
  /** 批量快照上限（默认不额外限制） */
  snapshotWrite?: boolean;
  now?: () => string;
  logger?: EnrichmentLogger;
}

export interface EnrichmentLogger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export interface EnrichmentWorkerOptions {
  workerId?: string;
  leaseSec?: number;
  /** 单次 runOnce 最多处理任务数 */
  maxJobs?: number;
  stages?: Stage[];
}

export type JobOutcome = 'done' | 'unmatched' | 'failed' | 'skipped';

export interface EnrichmentJobResult {
  jobId: string;
  companyId: string;
  stage: Stage;
  outcome: JobOutcome;
  enqueued: Stage[];
  errorCode?: string;
  detail?: Record<string, unknown>;
}

export interface EnrichmentRunStats {
  claimed: number;
  done: number;
  unmatched: number;
  failed: number;
  skipped: number;
  enqueued: Record<string, number>;
}

export const ENRICHMENT_STAGES: Stage[] = ['source_detail', 'tanji_match', 'tanji_detail'];

// ---------------------------------------------------------------------------
// 字段映射（docs/04 §5）
// ---------------------------------------------------------------------------

/** 注册资本对象 → 可读文本（含币种），无法识别时返回 null */
export function regCapitalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const rec = asRecord(value);
  for (const key of ['text', 'display', 'readable', 'label', 'value']) {
    const text = rec[key];
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  const amount = rec['amount'] ?? rec['registeredCapital'] ?? rec['value'];
  const currency = rec['currency'] ?? rec['currencyName'];
  const unit = rec['unit'];
  if (typeof amount === 'string' || typeof amount === 'number') {
    const parts = [String(amount)];
    if (typeof unit === 'string' && unit) parts.push(unit);
    if (typeof currency === 'string' && currency) parts.push(currency);
    const text = parts.join('');
    return text.trim() === '' ? null : text;
  }
  return null;
}

/** 行业对象 → 主行业名 */
export function industryName(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = industryName(item);
      if (name) return name;
    }
    return null;
  }
  const rec = asRecord(value);
  for (const key of ['name', 'primary', 'nameZh', 'label', 'industry', 'text']) {
    const text = rec[key];
    if (typeof text === 'string' && text.trim() !== '') return text.trim();
  }
  return null;
}

/** 规范省名：`河北` → `河北省`（其它省原样） */
export function canonicalProvinceName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  const short = normalizeRegionName(text);
  if (short === '河北') return '河北省';
  return text;
}

/** 从地址解析河北地级市（规范市名，如「唐山市」） */
export function parseCityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const text = address.replace(/\s+/g, '');
  for (const city of HEBEI_CITIES) {
    const short = city.name.replace(/市$/, '');
    if (text.includes(city.name) || text.includes(short)) return city.name;
  }
  return null;
}

/** 探迹工商详情 → 公司主档字段（docs/04 §5；权威性最高） */
export function companyFieldsFromTanjiDetail(detail: TanjiCompanyDetail): Partial<Company> {
  const raw = detail.raw ?? {};
  const extra: Record<string, unknown> = {};
  const extraKeys = [
    'companyType',
    'registrationAuthority',
    'approvedAt',
    'englishName',
    'formerNames',
    'organizationCode',
    'insuredCount',
    'branchCount',
    'annualTurnover',
    'annualReportYears',
    'keyPeople',
    'shareholders',
    'officeAddresses',
    'tags',
    'listedTags',
  ];
  for (const key of extraKeys) {
    const value = (raw as Record<string, unknown>)[key];
    if (value !== undefined && value !== null) extra[key] = value;
  }
  if (detail.updatedAt) extra.tanjiUpdatedAt = detail.updatedAt;
  const address = detail.address ?? null;
  return {
    name: detail.name,
    uscc: detail.uscc,
    englishName: detail.englishName ?? (typeof (raw as Record<string, unknown>).englishName === 'string' ? ((raw as Record<string, unknown>).englishName as string) : null),
    legalRepresentative: detail.legalRepresentative,
    regCapital: regCapitalText(detail.regCapital),
    foundTime: detail.foundTime,
    operStatus: detail.operStatus,
    industry: industryName(detail.industry),
    scale: detail.scale,
    province: canonicalProvinceName(detail.province),
    city: detail.city ?? parseCityFromAddress(address),
    address,
    businessScope: detail.businessScope,
    homepage: detail.homepage,
    phoneCount: detail.phoneCount,
    emailCount: detail.emailCount,
    contactCount: detail.contactCount,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
}

/** Boss/智联工商提示 → 公司主档字段（只补空/权威覆盖由 planFieldPatch 决定） */
export function companyFieldsFromBusinessHint(hint: BusinessHintLike | null | undefined): Partial<Company> {
  if (!hint) return {};
  return {
    uscc: hint.uscc ?? undefined,
    legalRepresentative: hint.legalRepresentative ?? undefined,
    regCapital: hint.registeredCapital ?? undefined,
    foundTime: hint.foundedAt ?? undefined,
    operStatus: hint.businessStatus ?? undefined,
    businessScope: hint.businessScope ?? undefined,
    industry: hint.industry ?? undefined,
    address: hint.registeredAddress ?? undefined,
    city: hint.city ? (parseCityFromAddress(hint.city) ?? hint.city) : undefined,
  };
}

function contactType(value: string): Contact['type'] {
  return value === 'mobile' || value === 'email' || value === 'phone' ? value : 'phone';
}

/** 探迹联系人 → company_contacts 写入结构 */
export function contactInputsFromTanji(companyId: string, contacts: TanjiContactItem[], unlockedAt: string = nowIso()): NewContact[] {
  const out: NewContact[] = [];
  for (const contact of contacts) {
    const value = contact.value?.trim();
    if (!value) continue;
    out.push({
      companyId,
      tanjiContactId: contact.contactId || null,
      name: contact.name,
      position: contact.position,
      department: contact.department,
      region: contact.region,
      type: contactType(contact.type),
      value,
      masked: contact.masked,
      source: contact.source ?? 'tanji',
      isKey: contact.isKeyLead,
      unlockedAt: contact.unlocked ? unlockedAt : null,
    });
  }
  return out;
}

/** 探迹匹配结果 → match_meta */
export function matchMetaFromResult(result: MatchResult): MatchMeta {
  return buildMatchMeta({
    method: result.method,
    confidence: result.confidence,
    candidates: result.candidates,
    matchedAt: nowIso(),
  });
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_ID = 'enrichment-worker';
const DEFAULT_MAX_JOBS = 20;

export class EnrichmentWorker {
  private readonly deps: EnrichmentWorkerDeps;
  private readonly options: Required<Pick<EnrichmentWorkerOptions, 'workerId' | 'leaseSec' | 'maxJobs' | 'stages'>>;

  constructor(deps: EnrichmentWorkerDeps, options: EnrichmentWorkerOptions = {}) {
    this.deps = deps;
    this.options = {
      workerId: options.workerId ?? DEFAULT_WORKER_ID,
      leaseSec: options.leaseSec ?? 120,
      maxJobs: options.maxJobs ?? DEFAULT_MAX_JOBS,
      stages: options.stages ?? ENRICHMENT_STAGES,
    };
  }

  private require(port: unknown, name: string): void {
    if (!port) {
      throw new LeadError('INTERNAL_ERROR', `Enrichment Worker 缺少依赖端口：${name}`, {
        details: { integrationPoints: ['src/pipeline/enrichment.ts#EnrichmentWorkerDeps'] },
      });
    }
  }

  private now(): string {
    return this.deps.now ? this.deps.now() : nowIso();
  }

  private getCompany(companyId: string): Company {
    const company = this.deps.companies.getById(companyId);
    if (!company) throw new LeadError('NOT_FOUND', `公司不存在：${companyId}`, { retryable: false });
    return company;
  }

  /** 识别公司来源平台（Ali/Mic 优先：英文抬头匹配路径，BR-18） */
  private sourcePlatformOf(companyId: string): 'boss' | 'zhilian' | 'ali' | 'mic' | null {
    if (!this.deps.companySources) return null;
    const platforms = new Set(this.deps.companySources.listByCompany(companyId).map((s) => s.platform));
    if (platforms.has('ali')) return 'ali';
    if (platforms.has('mic')) return 'mic';
    if (platforms.has('boss')) return 'boss';
    if (platforms.has('zhilian')) return 'zhilian';
    return null;
  }

  private writeSnapshot(input: {
    kind: string;
    payload: unknown;
    platform?: string | null;
    companyId: string;
    runId?: string | null;
    url?: string | null;
  }): void {
    const snapshots = this.deps.snapshots;
    if (!snapshots?.writeText) return;
    try {
      snapshots.writeText({
        kind: input.kind,
        payload: input.payload,
        platform: input.platform ?? null,
        runId: input.runId ?? null,
        refType: 'company',
        refId: input.companyId,
        url: input.url ?? null,
        fetchedAt: this.now(),
      });
    } catch (err) {
      this.deps.logger?.warn?.('enrichment snapshot write failed', {
        companyId: input.companyId,
        kind: input.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private enqueue(companyId: string, stage: Stage, runId?: string | null): Stage[] {
    const jobs = this.deps.jobs;
    if (!jobs) return [];
    jobs.enqueue({ companyId, stage, platform: null, runId: runId ?? null });
    return [stage];
  }

  /** 处理单个已领取任务（不负责 claim/complete 的业务失败回写由内部完成） */
  async processJob(job: PipelineJob): Promise<EnrichmentJobResult> {
    const base: EnrichmentJobResult = {
      jobId: job.id,
      companyId: job.companyId,
      stage: job.stage,
      outcome: 'done',
      enqueued: [],
    };
    try {
      switch (job.stage) {
        case 'source_detail':
          return await this.handleSourceDetail(job, base);
        case 'tanji_match':
          return await this.handleTanjiMatch(job, base);
        case 'tanji_detail':
          return await this.handleTanjiDetail(job, base);
        default:
          this.deps.jobs?.complete(job.id);
          return { ...base, outcome: 'skipped', detail: { reason: `unsupported_stage:${job.stage}` } };
      }
    } catch (err) {
      const lead = toLeadError(err);
      this.deps.logger?.error?.('enrichment job failed', {
        jobId: job.id,
        companyId: job.companyId,
        stage: job.stage,
        code: lead.code,
        message: lead.message,
      });
      this.deps.jobs?.fail(job.id, {
        error: lead.code,
        message: lead.message,
        retryable: lead.retryable,
      });
      return { ...base, outcome: 'failed', errorCode: lead.code, detail: { message: lead.message } };
    }
  }

  // -- source_detail --------------------------------------------------------

  private async handleSourceDetail(job: PipelineJob, base: EnrichmentJobResult): Promise<EnrichmentJobResult> {
    const company = this.getCompany(job.companyId);
    const platform = job.platform ?? null;

    // Ali/Mic 无平台工商详情（docs/02 §7.2 discovered → tanji_matched），直接进入匹配
    if (platform !== 'boss' && platform !== 'zhilian') {
      const enqueued = this.enqueue(company.id, 'tanji_match', job.runId);
      this.deps.jobs?.complete(job.id);
      return { ...base, enqueued };
    }

    const adapter = this.deps.sources?.[platform] ?? null;
    const source = this.deps.companySources?.listByCompany(company.id).find((s) => s.platform === platform);
    if (!adapter || !source) {
      // 适配器/来源缺失：不阻塞整体流水线，跳过详情直接匹配
      if (company.enrichmentStatus === 'discovered') {
        await applyCompanyFields(
          company.id,
          { enrichmentStatus: 'source_detailed' },
          { source: `source:${platform}`, runId: job.runId, actor: 'enrichment-worker' },
          this.deps,
        );
      }
      const enqueued = this.enqueue(company.id, 'tanji_match', job.runId);
      this.deps.jobs?.complete(job.id);
      return {
        ...base,
        enqueued,
        detail: { skippedSourceDetail: !adapter ? 'adapter_unavailable' : 'source_record_missing' },
      };
    }

    const detail = await adapter.getCompanyDetail(source.platformCompanyId);
    const hint = detail.business ?? null;

    // 1) 工商提示写主档（source_detail 权威性中：仅补空字段；USCC 提示只在公司无 USCC 时写入）
    const incoming: Partial<Company> = {};
    for (const [key, value] of Object.entries(companyFieldsFromBusinessHint(hint))) {
      if (value !== undefined) (incoming as Record<string, unknown>)[key] = value;
    }
    if (!company.uscc && hint?.uscc) incoming.uscc = hint.uscc;
    if (Object.keys(incoming).length > 0) {
      await applyCompanyFields(
        company.id,
        incoming,
        { source: `source:${platform}`, runId: job.runId, actor: 'enrichment-worker', eventType: 'company.updated' },
        this.deps,
      );
    }

    // 2) 来源证据补充（业务提示 + profile 摘要，不覆盖已有值）
    this.deps.companySources?.upsert({
      companyId: company.id,
      platform,
      platformCompanyId: source.platformCompanyId,
      sourceName: source.sourceName,
      sourceUrl: source.sourceUrl,
      cityName: source.cityName,
      evidence: {
        ...source.evidence,
        businessHint: hint
          ? {
              uscc: hint.uscc,
              usccSource: hint.usccSource ?? null,
              legalRepresentative: hint.legalRepresentative,
              foundedAt: hint.foundedAt,
              businessStatus: hint.businessStatus,
              textDerived: hint.textDerived ?? true,
            }
          : null,
        profileSummary: detail.profile
          ? {
              fullName: detail.profile.fullName ?? null,
              industry: detail.profile.industry ?? null,
              scale: detail.profile.scale ?? null,
              cityName: detail.profile.cityName ?? null,
            }
          : null,
        sourceDetailFetchedAt: this.now(),
      },
      lastSeenAt: this.now(),
    });

    this.writeSnapshot({
      kind: 'source_company_detail',
      payload: detail.raw ?? detail,
      platform,
      companyId: company.id,
      runId: job.runId,
    });

    // 3) 下一阶段：探迹匹配
    const enqueued = this.enqueue(company.id, 'tanji_match', job.runId);
    const enriched = this.deps.companies.getById(company.id);
    if (enriched && enriched.enrichmentStatus === 'discovered') {
      await applyCompanyFields(
        company.id,
        { enrichmentStatus: 'source_detailed' },
        { source: `source:${platform}`, runId: job.runId, actor: 'enrichment-worker' },
        this.deps,
      );
    }
    this.deps.jobs?.complete(job.id);
    return { ...base, enqueued, detail: { usccHint: hint?.uscc ?? null } };
  }

  // -- tanji_match ----------------------------------------------------------

  private async handleTanjiMatch(job: PipelineJob, base: EnrichmentJobResult): Promise<EnrichmentJobResult> {
    const company = this.getCompany(job.companyId);
    // 幂等：已匹配过则直接进入详情
    if (company.tanjiCompanyId && (company.enrichmentStatus === 'tanji_matched' || company.enrichmentStatus === 'tanji_enriched')) {
      const enqueued = this.enqueue(company.id, 'tanji_detail', job.runId);
      this.deps.jobs?.complete(job.id);
      return { ...base, enqueued, detail: { skipped: 'already_matched' } };
    }

    const platform = this.sourcePlatformOf(company.id);
    const result = await matchCompany(
      {
        name: company.name,
        englishName: company.englishName,
        uscc: company.uscc,
        province: company.province,
        city: company.city,
        platform,
        queries: null,
      },
      this.deps.tanji,
      this.deps.matchingOptions,
    );

    this.writeSnapshot({
      kind: 'tanji_search',
      payload: {
        input: {
          name: company.name,
          englishName: company.englishName,
          uscc: company.uscc,
          province: company.province,
          city: company.city,
          platform,
        },
        result: {
          matched: result.matched,
          method: result.method,
          confidence: result.confidence,
          queryName: result.queryName,
          candidates: result.candidates,
          searches: result.searches,
        },
      },
      platform: 'tanji',
      companyId: company.id,
      runId: job.runId,
    });

    if (!result.matched || !result.best) {
      // 无结果：unmatched，不消耗额度、不入队解锁；下一轮 Run 可 rematch 重试
      await applyCompanyFields(
        company.id,
        { enrichmentStatus: 'unmatched' as EnrichmentStatus, matchMeta: matchMetaFromResult(result) },
        { source: 'tanji', runId: job.runId, actor: 'enrichment-worker' },
        this.deps,
      );
      this.deps.jobs?.complete(job.id);
      return { ...base, outcome: 'unmatched', detail: { queryName: result.queryName, searches: result.searches.length } };
    }

    const best = result.best;
    let targetCompany = company;

    // 目标 tanji 主体已存在 → 合并两条公司记录（docs/02 §8.2c）
    const occupied = this.deps.companies.findByTanjiId(best.id);
    if (occupied && occupied.id !== company.id) {
      const merged = await mergeCompanyRecords(
        company.id,
        occupied.id,
        { source: 'tanji', runId: job.runId, actor: 'enrichment-worker', eventType: 'company.merged' },
        this.deps,
      );
      targetCompany = merged.target;
      this.writeSnapshot({
        kind: 'tanji_match_merge',
        payload: { sourceCompanyId: company.id, targetCompanyId: occupied.id, movedSources: merged.movedSources },
        platform: 'tanji',
        companyId: targetCompany.id,
        runId: job.runId,
      });
    } else {
      const updated = await recordMatchResult(
        company.id,
        {
          tanjiCompanyId: best.id,
          method: result.method,
          confidence: result.confidence,
          candidates: result.candidates,
          source: 'tanji',
          runId: job.runId,
          actor: 'enrichment-worker',
        },
        this.deps,
      );
      targetCompany = updated.company;
    }

    // 匹配成功后统一置状态（合并/人工 rematch 也走同一状态机）
    if (targetCompany.enrichmentStatus !== 'tanji_matched' && targetCompany.enrichmentStatus !== 'tanji_enriched') {
      const updated = await applyCompanyFields(
        targetCompany.id,
        { enrichmentStatus: 'tanji_matched' as EnrichmentStatus },
        { source: 'tanji', runId: job.runId, actor: 'enrichment-worker' },
        this.deps,
      );
      targetCompany = updated.company;
    }

    const enqueued = this.enqueue(targetCompany.id, 'tanji_detail', job.runId);
    this.deps.jobs?.complete(job.id);
    return {
      ...base,
      companyId: targetCompany.id,
      enqueued,
      detail: {
        method: result.method,
        confidence: result.confidence,
        lowConfidence: result.lowConfidence,
        tanjiCompanyId: best.id,
        merged: targetCompany.id !== company.id,
      },
    };
  }

  // -- tanji_detail ---------------------------------------------------------

  private async handleTanjiDetail(job: PipelineJob, base: EnrichmentJobResult): Promise<EnrichmentJobResult> {
    const company = this.getCompany(job.companyId);
    const tanjiId = company.tanjiCompanyId;
    if (!tanjiId) {
      throw new LeadError('VALIDATION_ERROR', '公司缺少 tanjiCompanyId，无法拉取探迹详情', {
        retryable: false,
        details: { companyId: company.id },
      });
    }

    // 1) 解锁状态以 contacts 接口为准（docs/09 §2.5），先查联系人可省额度
    const contactsResult = await this.deps.tanji.getContacts(tanjiId).catch((err: unknown) => {
      const lead = toLeadError(err);
      if (lead.code === 'NOT_FOUND') return null;
      throw err;
    });
    const contactsUnlocked = contactsResult?.unlocked === true;

    // 2) 工商详情
    const detail = await this.deps.tanji.getCompany(tanjiId);

    // 2.1) USCC 冲突处理（docs/02 §8.2a）：探迹权威 USCC 已属于另一条公司记录 → 合并
    //      （另一来源已先写入同一 USCC 时，避免 companies.uscc UNIQUE 冲突并收敛主档）
    let target = company;
    const detailUscc = normalizeUsccKey(detail.uscc);
    if (detailUscc.length >= 8) {
      const existing = this.deps.companies.findByUscc(detailUscc);
      if (existing && existing.id !== company.id) {
        const merged = await mergeCompanyRecords(
          company.id,
          existing.id,
          { source: 'tanji', runId: job.runId, actor: 'enrichment-worker', eventType: 'company.merged' },
          this.deps,
        );
        target = merged.target;
        this.writeSnapshot({
          kind: 'tanji_detail_merge',
          payload: { sourceCompanyId: company.id, targetCompanyId: target.id, uscc: detailUscc },
          platform: 'tanji',
          companyId: target.id,
          runId: job.runId,
        });
      }
    }
    const effectiveCompanyId = target.id;
    const unlockStatus: UnlockStatus = contactsUnlocked ? 'unlocked' : 'pending';
    const fields = companyFieldsFromTanjiDetail(detail);
    const updated = await applyCompanyFields(
      effectiveCompanyId,
      { ...fields, unlockStatus, enrichmentStatus: 'tanji_enriched' as EnrichmentStatus },
      { source: 'tanji', runId: job.runId, actor: 'enrichment-worker' },
      this.deps,
    );

    // 3) 已解锁 → 直接导入明文联系人（不扣额度、不排 unlock 任务）
    let importedContacts = 0;
    if (contactsUnlocked && contactsResult) {
      const inputs = contactInputsFromTanji(updated.company.id, contactsResult.contacts, this.now());
      if (inputs.length > 0 && this.deps.contacts?.upsertMany) {
        this.deps.contacts.upsertMany(inputs);
        importedContacts = inputs.length;
      }
      if (updated.company.contactCount !== inputs.length && inputs.length > 0) {
        await applyCompanyFields(
          updated.company.id,
          { contactCount: inputs.length },
          { source: 'tanji', runId: job.runId, actor: 'enrichment-worker' },
          this.deps,
        );
      }
    }

    this.writeSnapshot({
      kind: 'tanji_company_detail',
      payload: { detail: detail.raw ?? detail, contacts: contactsResult?.raw ?? null, contactsUnlocked },
      platform: 'tanji',
      companyId: updated.company.id,
      runId: job.runId,
      url: null,
    });

    // 4) 未解锁 → 入队 unlock（仅入队，绝不在此调用真实 unlock；额度由 Unlock Worker 管控）
    let enqueued: Stage[] = [];
    if (!contactsUnlocked) {
      if (this.deps.jobs) {
        const result = await createUnlockJob(
          updated.company.id,
          { idempotencyKey: `enrich:${updated.company.id}:${this.now().slice(0, 10)}` },
          this.deps,
        );
        enqueued = [result.stage];
        if (result.created) this.deps.logger?.debug?.('unlock job enqueued', { companyId: updated.company.id, jobId: result.jobId });
      }
    }

    this.deps.jobs?.complete(job.id);
    return {
      ...base,
      enqueued,
      detail: {
        tanjiCompanyId: target.tanjiCompanyId ?? tanjiId,
        contactsUnlocked,
        contactsImported: importedContacts,
        mergedInto: target.id !== company.id ? target.id : null,
        changedFields: updated.changed.map((c) => c.field),
      },
    };
  }

  // -- 批处理 ---------------------------------------------------------------

  /** 领取并处理至多 maxJobs 个任务；无任务可领时提前返回 */
  async runOnce(maxJobs?: number): Promise<EnrichmentRunStats> {
    this.require(this.deps.jobs, 'jobs');
    const limit = Math.max(1, Math.min(maxJobs ?? this.options.maxJobs, 1000));
    const stats: EnrichmentRunStats = { claimed: 0, done: 0, unmatched: 0, failed: 0, skipped: 0, enqueued: {} };
    for (let i = 0; i < limit; i++) {
      const job = this.deps.jobs!.claimNext({
        workerId: this.options.workerId,
        leaseSec: this.options.leaseSec,
        stages: this.options.stages,
      });
      if (!job) break;
      stats.claimed += 1;
      const result = await this.processJob(job);
      if (result.outcome === 'done') stats.done += 1;
      else if (result.outcome === 'unmatched') stats.unmatched += 1;
      else if (result.outcome === 'skipped') stats.skipped += 1;
      else stats.failed += 1;
      for (const stage of result.enqueued) stats.enqueued[stage] = (stats.enqueued[stage] ?? 0) + 1;
    }
    return stats;
  }

  /** 处理队列直至空闲（最多 maxJobs 保护，避免 worker 永不退出） */
  async runUntilIdle(maxJobs = 500): Promise<EnrichmentRunStats> {
    const total: EnrichmentRunStats = { claimed: 0, done: 0, unmatched: 0, failed: 0, skipped: 0, enqueued: {} };
    let processed = 0;
    while (processed < maxJobs) {
      const batch = await this.runOnce(Math.min(this.options.maxJobs, maxJobs - processed));
      if (batch.claimed === 0) break;
      processed += batch.claimed;
      total.claimed += batch.claimed;
      total.done += batch.done;
      total.unmatched += batch.unmatched;
      total.failed += batch.failed;
      total.skipped += batch.skipped;
      for (const [stage, count] of Object.entries(batch.enqueued)) {
        total.enqueued[stage] = (total.enqueued[stage] ?? 0) + count;
      }
    }
    return total;
  }
}

export function createEnrichmentWorker(deps: EnrichmentWorkerDeps, options?: EnrichmentWorkerOptions): EnrichmentWorker {
  return new EnrichmentWorker(deps, options);
}

/** 兼容别名（main.ts wiring 可任选） */
export { mergeCompanies as mergeCompanyRecords };

// 重新导出服务入口，方便 wiring 只 import 本文件
export {
  applyCompanyFields,
  createUnlockJob,
  recordMatchResult,
  upsertSourceCompany,
  mergeCompanies,
  configureCompaniesService,
  type CompaniesServiceDeps,
} from '../services/companies.js';
