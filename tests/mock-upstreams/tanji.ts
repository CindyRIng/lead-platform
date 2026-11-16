/**
 * 探迹（tanji-client）mock（`:8787`）。响应形状对齐 docs/04 §3.5 与 exploration 实测样例。
 *
 * **绝不访问真实上游、绝不消耗真实额度**：unlock 只作用于内存状态。
 * 覆盖：
 *  - USCC 精确匹配 / 名称匹配 / 英文抬头匹配 / 无结果；
 *  - 额度（daily/monthly/enterprise）与 QUOTA_EXHAUSTED；
 *  - 解锁前置检查（contacts.unlocked=true → 不扣额度）、idempotencyKey 幂等。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import {
  findTanjiById,
  findTanjiByUscc,
  searchTanji,
  tanjiCompanies,
  type SyntheticCompany,
} from '../fixtures/companies.js';
import {
  MOCK_APP_OPTIONS,
  applyGate,
  installControlRoutes,
  mockQueryId,
  sendErr,
  sendOk,
} from './common.js';
import type { MockWorld } from './state.js';

const SOURCE = 'tanji';

function nowIso(): string {
  return new Date().toISOString();
}

interface StoredUnlockResult {
  response: Record<string, unknown>;
  at: string;
}

function unlockIdempotencyCache(world: MockWorld): Map<string, StoredUnlockResult> {
  const flags = world.scenario.flags as Record<string, unknown>;
  let cache = flags['tanjiUnlockIdempotency'] as Map<string, StoredUnlockResult> | undefined;
  if (!cache) {
    cache = new Map();
    flags['tanjiUnlockIdempotency'] = cache;
  }
  return cache;
}

function tanjiCompanySummary(world: MockWorld, company: SyntheticCompany, score: number) {
  const t = company.tanji!;
  const contactCount = t.contacts.length;
  return {
    id: t.id,
    name: t.name,
    entityType: 'enterprise',
    uscc: t.uscc,
    legalRepresentative: t.legalRepresentative,
    regCapital: { value: t.regCapital.value, coinType: t.regCapital.coinType },
    foundTime: t.foundTime,
    address: t.address,
    province: t.province,
    operStatus: t.operStatus,
    industry: t.industry,
    scale: t.scale,
    phoneCount: contactCount,
    emailCount: contactCount,
    contactCount,
    unlocked: isUnlocked(world, company),
    tags: t.tags,
    listedTags: [],
    score,
    rankScore: score,
    highlight: { name: [`<strong>${t.name}</strong>`] },
  };
}

function isUnlocked(world: MockWorld, company: SyntheticCompany): boolean {
  const id = company.tanji?.id;
  if (!id) return false;
  if (company.tanji?.contactsUnlocked) return true;
  return world.scenario.tanjiUnlocked.has(id);
}

function quotaBuckets(world: MockWorld) {
  const q = world.scenario.tanjiQuota;
  if (world.scenario.tanjiQuotaExhausted) {
    return {
      daily: { limit: q.daily.limit, used: q.daily.limit, remaining: 0, unit: q.daily.unit },
      monthly: { limit: q.monthly.limit, used: q.monthly.limit, remaining: 0, unit: q.monthly.unit },
      enterpriseMonthly: { limit: q.enterpriseMonthly.limit, used: q.enterpriseMonthly.limit, remaining: 0, unit: q.enterpriseMonthly.unit },
      settlementDay: q.settlementDay,
      nearlySevenDayUnlockCount: 0,
    };
  }
  return JSON.parse(
    JSON.stringify({
      daily: q.daily,
      monthly: q.monthly,
      enterpriseMonthly: q.enterpriseMonthly,
      settlementDay: q.settlementDay,
      nearlySevenDayUnlockCount: 0,
    }),
  ) as Record<string, unknown>;
}

function contactsPayload(company: SyntheticCompany, unlocked: boolean) {
  const t = company.tanji!;
  const total = t.contacts.length;
  if (!unlocked) {
    return {
      companyId: t.id,
      unlocked: false,
      contactCount: total,
      counts: { mobile: total, phone: 0, email: 0, total },
      contacts: [] as unknown[],
    };
  }
  return {
    companyId: t.id,
    unlocked: true,
    contactCount: total,
    counts: {
      mobile: t.contacts.filter((c) => c.type === 'mobile').length,
      phone: t.contacts.filter((c) => c.type === 'phone').length,
      email: t.contacts.filter((c) => c.type === 'email').length,
      total,
    },
    contacts: t.contacts.map((c) => ({
      contactId: c.contactId,
      name: c.name,
      position: c.position,
      department: c.department,
      region: c.region,
      type: c.type,
      value: c.value,
      masked: c.masked,
      isKeyLead: c.isKeyLead,
      source: c.source,
      unlocked: true,
    })),
  };
}

function companyDetail(world: MockWorld, company: SyntheticCompany) {
  const t = company.tanji!;
  return {
    id: t.id,
    name: t.name,
    entityType: 'enterprise',
    uscc: t.uscc,
    legalRepresentative: t.legalRepresentative,
    regCapital: { value: t.regCapital.value, coinType: t.regCapital.coinType, text: t.regCapital.text },
    foundTime: t.foundTime,
    address: t.address,
    province: t.province,
    operStatus: t.operStatus,
    industry: t.industry,
    scale: t.scale,
    unlocked: isUnlocked(world, company),
    tags: t.tags,
    listedTags: [],
    businessScope: t.businessScope,
    homepage: t.homepage,
    registrationAuthority: '示例区市场监督管理局',
    companyType: '有限责任公司（自然人投资或控股）',
    organizationCode: `${t.uscc.slice(8, 17)}-${t.uscc.slice(17)}`,
    insuredCount: 12,
    operatingPeriod: `${t.foundTime} 至 长期`,
    branchCount: 0,
    investmentCount: 0,
    changeCount: 0,
    annualReportYears: [],
    formerNames: [],
    englishName: company.englishName,
    extra: {
      blog: { name: '合成测试数据' },
      tanjiUpdatedAt: nowIso(),
    },
  };
}

export function createTanjiMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/v1/status', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const invalid = world.platforms.tanji.sessionInvalid;
    return sendOk(reply, {
      loggedIn: !invalid,
      health: invalid ? 'session_invalid' : 'ok',
      quota: quotaBuckets(world),
      session: {
        headless: true,
        profileDir: '/tmp/mock-tanji/profile',
        startedAt: nowIso(),
        lastHeartbeatAt: nowIso(),
        lastLoginAt: nowIso(),
      },
      upstream: { baseUrl: 'https://example.invalid/tungee', productLine: 'financial', portalUrl: 'https://example.invalid/portal' },
      lastCheckedAt: nowIso(),
    });
  });

  app.get('/v1/accounts', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    return sendOk(reply, {
      accounts: [{ id: 'main', name: '示例账号', active: true, isDefault: true }],
      total: 1,
    });
  });

  app.post('/v1/search/name', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const body = (req.body ?? {}) as {
      name?: string;
      field?: 'name' | 'socialCreditCode';
      pageSize?: number;
      maxPages?: number;
    };
    const name = String(body.name ?? '').trim();
    const field = body.field === 'socialCreditCode' ? 'socialCreditCode' : 'name';
    const pageSize = Math.max(1, Math.min(50, Number(body.pageSize ?? 20)));
    const queryId = mockQueryId('tanji');
    const forceEmpty = world.platforms.tanji.forceEmpty;

    let matched: Array<{ company: SyntheticCompany; score: number }> = [];
    if (!forceEmpty && name) {
      if (field === 'socialCreditCode') {
        const c = findTanjiByUscc(name);
        if (c) matched = [{ company: c, score: 500 }];
      } else {
        // 精确名优先，其次英文抬头/包含匹配（mock 的 searchTanji 已按分数排序）
        matched = searchTanji(name, 'name');
      }
    }
    const total = matched.length;
    const companies = matched.slice(0, pageSize).map((m) => tanjiCompanySummary(world, m.company, Math.round(m.score * 100) / 100));
    const pagesFetched = total > 0 ? 1 : 0;
    return sendOk(reply, {
      queryId,
      companies,
      total,
      page: 1,
      pageSize,
      hasMore: total > pageSize,
      pagesFetched,
      cached: false,
      tookMs: 1,
      warnings: [],
    });
  });

  app.get('/v1/companies/:id', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { id } = req.params as { id: string };
    const company = findTanjiById(decodeURIComponent(id));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `tanji company not found: ${id}`);
    return sendOk(reply, companyDetail(world, company));
  });

  app.get('/v1/companies/:id/contacts', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { id } = req.params as { id: string };
    const company = findTanjiById(decodeURIComponent(id));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `tanji company not found: ${id}`);
    return sendOk(reply, contactsPayload(company, isUnlocked(world, company)));
  });

  app.post('/v1/companies/:id/unlock', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const { id } = req.params as { id: string };
    const company = findTanjiById(decodeURIComponent(id));
    if (!company) return sendErr(reply, 404, 'NOT_FOUND', `tanji company not found: ${id}`);

    const body = (req.body ?? {}) as { confirm?: boolean; quota?: boolean; contacts?: boolean; idempotencyKey?: string };
    const t = company.tanji!;
    world.scenario.tanjiUnlockCalls += 1;
    world.scenario.tanjiUnlockRequests.push({ at: nowIso(), companyId: t.id, idempotencyKey: body.idempotencyKey });

    // idempotencyKey 幂等：重复请求返回同一结果，不再扣额度
    const cache = unlockIdempotencyCache(world);
    if (body.idempotencyKey && cache.has(body.idempotencyKey)) {
      const stored = cache.get(body.idempotencyKey)!;
      return sendOk(reply, { ...stored.response, alreadyUnlocked: true, quotaCost: 0 });
    }

    const quota = world.scenario.tanjiQuota;
    const already = isUnlocked(world, company);
    const before = quota.daily.remaining;
    if (already) {
      const response = {
        companyId: t.id,
        companyName: t.name,
        alreadyUnlocked: true,
        unlockedBy: 'mock',
        unlockedAt: nowIso(),
        quotaCost: 0,
        quotaBefore: before,
        quotaAfter: before,
        contacts: contactsPayload(company, true).contacts,
      };
      if (body.idempotencyKey) cache.set(body.idempotencyKey, { response, at: nowIso() });
      return sendOk(reply, response);
    }

    if (world.scenario.tanjiQuotaExhausted || quota.daily.remaining <= 0) {
      return sendErr(reply, 409, 'QUOTA_EXHAUSTED', '探迹额度不足（mock 注入）', { retryable: false });
    }

    // 扣 1 点额度（日/月/企业月同步）
    quota.daily.remaining -= 1;
    quota.daily.used += 1;
    quota.monthly.remaining = Math.max(0, quota.monthly.remaining - 1);
    quota.monthly.used += 1;
    quota.enterpriseMonthly.remaining = Math.max(0, quota.enterpriseMonthly.remaining - 1);
    quota.enterpriseMonthly.used += 1;
    world.scenario.tanjiQuotaConsumed += 1;
    world.scenario.tanjiUnlocked.add(t.id);

    const response = {
      companyId: t.id,
      companyName: t.name,
      alreadyUnlocked: false,
      unlockedBy: 'mock',
      unlockedAt: nowIso(),
      quotaCost: 1,
      quotaBefore: before,
      quotaAfter: quota.daily.remaining,
      contacts: contactsPayload(company, true).contacts,
    };
    if (body.idempotencyKey) cache.set(body.idempotencyKey, { response, at: nowIso() });
    return sendOk(reply, response);
  });

  app.get('/v1/filters/registry', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const categories = [
      { key: 'business', label: '工商信息' },
      { key: 'contact', label: '联系方式' },
      { key: 'recruiting', label: '招聘' },
      { key: 'qualification', label: '资质' },
      { key: 'customs', label: '海关' },
    ];
    return sendOk(reply, { categories, total: categories.length });
  });

  return app;
}
