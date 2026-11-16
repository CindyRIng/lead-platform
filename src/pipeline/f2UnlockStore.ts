/**
 * UnlockStore 的 F2 repositories 适配器。
 *
 * 所有实际 DB 读写都通过 `Repositories`（`src/repositories/index.ts`）完成；
 * 本文件只做「领域端口 ↔ F2 记录」的形状归一与解锁优先级信号装载。
 */
import type { Repositories } from '../repositories/index.js';
import type {
  ChangeEventRecord as F2ChangeEventRecord,
  CompanySource,
  CustomsProfileRecord,
  PipelineJob,
  PlatformProfileRecord,
} from '../repositories/types.js';
import { getRepositories } from '../repositories/index.js';
import type { Company } from '../shared/domain.js';
import {
  type UnlockCandidate,
  type UnlockCompanyRecord,
  type UnlockContactInput,
  type UnlockEventInput,
  type UnlockJobRecord,
  type UnlockLedgerInput,
  type UnlockSignals,
  type UnlockStore,
  type QuotaObservationSnapshot,
  type QuotaViewStore,
  UNLOCK_STAGE,
  hasCustomsRecords,
  isPaidMemberStore,
} from './unlock.js';

function toJobRecord(job: PipelineJob): UnlockJobRecord {
  return {
    id: job.id,
    companyId: job.companyId,
    platform: job.platform,
    runId: job.runId,
    stage: job.stage,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextRetryAt: job.nextRetryAt,
    leaseOwner: job.leaseOwner,
    leaseUntil: job.leaseUntil,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function toCompanyRecord(company: Company): UnlockCompanyRecord {
  return {
    id: company.id,
    name: company.name,
    tanjiCompanyId: company.tanjiCompanyId,
    enrichmentStatus: company.enrichmentStatus,
    unlockStatus: company.unlockStatus,
    firstSeenAt: company.firstSeenAt,
  };
}

interface SignalSourceData {
  sourcesByCompany: Map<string, Set<string>>;
  profilesByCompany: Map<string, PlatformProfileRecord[]>;
  activeJobsByCompany: Map<string, number>;
  customsByCompany: Map<string, CustomsProfileRecord>;
}

function emptySignals(): UnlockSignals {
  return { hasRecruiting: false, isPaidMember: false, hasCustomsRecord: false };
}

function indexSignals(
  sources: CompanySource[],
  profiles: PlatformProfileRecord[],
  activeJobs: Map<string, number>,
  customs: CustomsProfileRecord[],
): SignalSourceData {
  const sourcesByCompany = new Map<string, Set<string>>();
  for (const source of sources) {
    let set = sourcesByCompany.get(source.companyId);
    if (!set) {
      set = new Set<string>();
      sourcesByCompany.set(source.companyId, set);
    }
    set.add(source.platform);
  }
  const profilesByCompany = new Map<string, PlatformProfileRecord[]>();
  for (const profile of profiles) {
    const list = profilesByCompany.get(profile.companyId) ?? [];
    list.push(profile);
    profilesByCompany.set(profile.companyId, list);
  }
  const customsByCompany = new Map<string, CustomsProfileRecord>();
  for (const profile of customs) customsByCompany.set(profile.companyId, profile);
  return { sourcesByCompany, profilesByCompany, activeJobsByCompany: activeJobs, customsByCompany };
}

function signalsFor(companyId: string, data: SignalSourceData): UnlockSignals {
  const sources = data.sourcesByCompany.get(companyId);
  const profiles = data.profilesByCompany.get(companyId) ?? [];
  const recruitingSource = sources?.has('boss') === true || sources?.has('zhilian') === true;
  const activeJobs = data.activeJobsByCompany.get(companyId) ?? 0;
  const jobCountOnProfiles = profiles
    .filter((p) => p.platform === 'boss' || p.platform === 'zhilian')
    .reduce((sum, p) => sum + (p.jobCount ?? 0), 0);
  const hasRecruiting = recruitingSource && (activeJobs > 0 || jobCountOnProfiles > 0);
  const isPaidMember = profiles.some((p) => (p.platform === 'ali' || p.platform === 'mic') && isPaidMemberStore(p.platform, p.store ?? null));
  const hasCustomsRecord = hasCustomsRecords(data.customsByCompany.get(companyId) ?? null);
  return { hasRecruiting, isPaidMember, hasCustomsRecord };
}

export function createUnlockStore(repos: Repositories): UnlockStore {
  const loadSignalsFor = async (companyIds: string[]): Promise<Map<string, UnlockSignals>> => {
    const result = new Map<string, UnlockSignals>();
    if (companyIds.length === 0) return result;
    const [sources, profiles, activeJobs, customs] = await Promise.all([
      Promise.resolve(repos.companySources.listByCompanyIds(companyIds)),
      Promise.resolve(repos.platformProfiles.listByCompanyIds(companyIds)),
      Promise.resolve(repos.platformJobs.countActiveByCompanyIds(companyIds)),
      Promise.resolve(repos.customs.listByCompanyIds(companyIds)),
    ]);
    const data = indexSignals(sources, profiles, activeJobs, customs);
    for (const id of companyIds) result.set(id, signalsFor(id, data));
    return result;
  };

  return {
    ensureJob: (input) => {
      const result = repos.jobs.enqueue({ companyId: input.companyId, stage: UNLOCK_STAGE, platform: null, runId: input.runId ?? null });
      return { job: toJobRecord(result.job), created: result.created };
    },
    claimJob: (id, opts) => {
      const job = repos.jobs.claimById(id, { workerId: opts.workerId, leaseSec: opts.leaseSec, now: opts.now });
      return job ? toJobRecord(job) : null;
    },
    completeJob: (id) => {
      repos.jobs.complete(id);
    },
    failJob: (id, opts) => {
      repos.jobs.fail(id, {
        errorCode: opts.errorCode,
        error: opts.error,
        retryable: opts.retryable,
        ...(opts.nextRetryAt !== undefined ? { nextRetryAt: opts.nextRetryAt } : {}),
        now: opts.now,
      });
    },
    waitForQuota: (id, opts) => {
      const job = repos.jobs.waitForQuota(id, { reason: opts?.reason });
      // company.unlock_status 同步为 waiting_quota（schema 枚举含该状态，便于 /v1/companies?unlockStatus 观测）
      if (job) repos.companies.updateUnlockStatus(job.companyId, 'waiting_quota');
    },
    wakeWaitingQuota: (opts) => {
      // F2 wakeWaitingQuota 单次上限 limit（默认 1000）；这里循环到全部唤醒（最多 20 批 = 2 万），
      // 避免额度恢复后队列要等多次 poll 才全部续跑。
      const limit = opts?.limit ?? 1000;
      let total = 0;
      for (let batch = 0; batch < 20; batch++) {
        const waiting = repos.jobs.list({ status: 'waiting_quota', stage: UNLOCK_STAGE, limit });
        if (waiting.length === 0) break;
        const resumed = repos.jobs.wakeWaitingQuota({ limit, now: opts?.now });
        total += resumed;
        // 恢复的公司回 pending（已解锁/失败的不覆盖）
        for (const job of waiting) {
          const company = repos.companies.getById(job.companyId);
          if (company && company.unlockStatus === 'waiting_quota') repos.companies.updateUnlockStatus(company.id, 'pending');
        }
        if (resumed < limit) break;
      }
      return total;
    },
    pausePending: (opts) => {
      const jobs = repos.jobs.list({ stage: UNLOCK_STAGE, status: 'pending', limit: opts?.limit ?? 1000 });
      let paused = 0;
      for (const job of jobs) {
        repos.jobs.waitForQuota(job.id, { reason: 'quota_exhausted' });
        repos.companies.updateUnlockStatus(job.companyId, 'waiting_quota');
        paused += 1;
      }
      return paused;
    },
    listCandidates: (limit) => {
      // listFifo：只取 pending 且 next_retry_at 到期（退避中的任务不进入候选）
      const jobs = repos.jobs.listFifo({ stage: UNLOCK_STAGE, limit });
      if (jobs.length === 0) return [];
      const companyIds = [...new Set(jobs.map((j) => j.companyId))];
      const companies = repos.companies.getManyByIds(companyIds);
      const companyById = new Map(companies.map((c) => [c.id, c]));
      const signalsPromise = loadSignalsFor(companyIds);
      const build = (signalsMap: Map<string, UnlockSignals>): UnlockCandidate[] => {
        const out: UnlockCandidate[] = [];
        for (const job of jobs) {
          const company = companyById.get(job.companyId);
          if (!company) continue;
          out.push({
            job: toJobRecord(job),
            company: toCompanyRecord(company),
            signals: signalsMap.get(company.id) ?? emptySignals(),
          });
        }
        return out;
      };
      if (signalsPromise instanceof Promise) {
        return signalsPromise.then(build);
      }
      return build(signalsPromise);
    },
    listEligibleCompanies: (limit) => {
      const companies = repos.companies.list({
        enrichmentStatus: 'tanji_enriched',
        unlockStatus: ['none', 'pending'],
        limit,
      });
      return companies
        .filter((company) => company.mergedInto === null && company.tanjiCompanyId !== null)
        .map(toCompanyRecord);
    },
    loadSignals: (companyIds) => loadSignalsFor(companyIds),
    getCompany: (id) => {
      const company = repos.companies.getById(id);
      return company ? toCompanyRecord(company) : null;
    },
    updateUnlockStatus: (companyId, status) => {
      repos.companies.updateUnlockStatus(companyId, status);
    },
    upsertContacts: (companyId, contacts: UnlockContactInput[], unlockedAt) => {
      if (contacts.length === 0) return 0;
      const inputs = contacts.map((contact) => ({
        companyId,
        tanjiContactId: contact.tanjiContactId ?? null,
        name: contact.name ?? null,
        position: contact.position ?? null,
        department: contact.department ?? null,
        region: contact.region ?? null,
        type: contact.type,
        value: contact.value,
        masked: contact.masked === true,
        source: contact.source ?? null,
        isKey: contact.isKey === true,
        unlockedAt,
      }));
      repos.contacts.upsertMany(inputs);
      return contacts.length;
    },
    insertLedger: (input: UnlockLedgerInput) => {
      repos.unlockLedger.insertIfAbsent({
        companyId: input.companyId,
        tanjiCompanyId: input.tanjiCompanyId,
        result: input.result,
        quotaCost: input.quotaCost,
        quotaBefore: input.quotaBefore,
        quotaAfter: input.quotaAfter,
        accountId: input.accountId,
        idempotencyKey: input.idempotencyKey,
        errorCode: input.errorCode ?? null,
        requestedAt: input.requestedAt,
        finishedAt: input.finishedAt,
      });
    },
    latestQuotaObservation: () => {
      const observation = repos.quota.latest();
      if (!observation) return null;
      return {
        observedAt: observation.observedAt,
        dailyLimit: observation.dailyLimit,
        dailyRemaining: observation.dailyRemaining,
        monthlyLimit: observation.monthlyLimit,
        monthlyRemaining: observation.monthlyRemaining,
        enterpriseLimit: observation.enterpriseLimit,
        enterpriseRemaining: observation.enterpriseRemaining,
        settlementDay: observation.settlementDay,
        raw: observation.raw,
      };
    },
    insertQuotaObservation: (input: QuotaObservationSnapshot) => {
      repos.quota.insertObservation({
        observedAt: input.observedAt,
        dailyLimit: input.dailyLimit,
        dailyRemaining: input.dailyRemaining,
        monthlyLimit: input.monthlyLimit,
        monthlyRemaining: input.monthlyRemaining,
        enterpriseLimit: input.enterpriseLimit,
        enterpriseRemaining: input.enterpriseRemaining,
        settlementDay: input.settlementDay,
        raw: input.raw ?? null,
      });
    },
    sumQuotaCostSince: (iso) => repos.unlockLedger.sumQuotaCostSince(iso),
    appendChangeEvent: (input: UnlockEventInput) => {
      const appended: F2ChangeEventRecord = repos.changeEvents.append({
        companyId: input.companyId,
        entityType: input.entityType ?? 'company',
        entityId: input.entityId ?? null,
        version: input.version,
        eventType: input.eventType,
        field: input.field ?? null,
        oldValue: input.oldValue ?? null,
        newValue: input.newValue ?? null,
        valueType: input.valueType ?? null,
        source: input.source,
        runId: input.runId ?? null,
        ...(input.actor ? { actor: input.actor } : {}),
        occurredAt: input.occurredAt,
      });
      return { seq: appended.seq };
    },
  };
}

/** /v1/quota 使用的只读适配器 */
export function createQuotaViewStore(repos: Repositories): QuotaViewStore {
  return {
    latestQuotaObservation: () => {
      const observation = repos.quota.latest();
      if (!observation) return null;
      return {
        observedAt: observation.observedAt,
        dailyLimit: observation.dailyLimit,
        dailyRemaining: observation.dailyRemaining,
        monthlyLimit: observation.monthlyLimit,
        monthlyRemaining: observation.monthlyRemaining,
        enterpriseLimit: observation.enterpriseLimit,
        enterpriseRemaining: observation.enterpriseRemaining,
        settlementDay: observation.settlementDay,
        raw: observation.raw,
      };
    },
    listRecentLedger: (limit) =>
      repos.unlockLedger.listRecent(limit).map((entry) => ({
        result: entry.result,
        quotaCost: entry.quotaCost,
        requestedAt: entry.requestedAt,
      })),
  };
}

let defaultStore: UnlockStore | null = null;

/** 全局默认（main.ts 启动后 initRepositories 即可用；测试可 setDefaultUnlockStore 覆盖） */
export function getDefaultUnlockStore(): UnlockStore {
  defaultStore ??= createUnlockStore(getRepositories());
  return defaultStore;
}

export function setDefaultUnlockStore(store: UnlockStore | null): void {
  defaultStore = store;
}

let defaultQuotaViewStore: QuotaViewStore | null = null;

export function getDefaultQuotaViewStore(): QuotaViewStore {
  defaultQuotaViewStore ??= createQuotaViewStore(getRepositories());
  return defaultQuotaViewStore;
}

export function setDefaultQuotaViewStore(store: QuotaViewStore | null): void {
  defaultQuotaViewStore = store;
}
