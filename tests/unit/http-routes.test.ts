/**
 * D1 REST 路由单元测试（Fastify inject，不依赖服务层/DB/上游）。
 *
 * 覆盖：免鉴权 docs、401、zod 400、201/202、游标分页 meta、详情结构、
 * UNSUPPORTED/404、changes、webhooks、jobs、quota、admin、SSE 兜底实现。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerRoutes } from '../../src/http/routes/index.js';
import { resetRouteServicesForTests, setRouteServices, type RouteServices } from '../../src/http/routes/services.js';
import { resetExpectedTokenForTests } from '../../src/http/routes/helpers.js';
import { resetDocsCacheForTests } from '../../src/http/routes/docs.js';

const TOKEN = 'test-token-0123456789abcdef';

function sampleCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cmp_1',
    name: '河北测试机械有限公司',
    uscc: '91130100TEST000001',
    province: '河北省',
    city: '石家庄市',
    sourceCount: 2,
    platforms: ['boss', 'ali'],
    enrichmentStatus: 'tanji_enriched',
    unlockStatus: 'unlocked',
    tradeTags: ['source_keyword:外贸'],
    contactCount: 2,
    ...overrides,
  };
}

function createFakeServices(): RouteServices {
  const run = {
    id: 'run_1',
    goalId: 'goal_1',
    trigger: 'manual',
    status: 'running',
    startedAt: '2026-11-16T02:00:00.000Z',
    finishedAt: null,
    stats: {},
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-11-16T02:00:00.000Z',
  };
  return {
    goals: {
      create: vi.fn(async (input: unknown) => ({ id: 'goal_1', ...(input as Record<string, unknown>), version: 1 })),
      list: vi.fn(async () => ({
        items: [{ id: 'goal_1', name: '河北省-外贸线索' }, { id: 'goal_2', name: '测试' }],
        total: 2,
      })),
      get: vi.fn(async (id: string) =>
        id === 'goal_missing' ? null : { id, name: '河北省-外贸线索', resolvedCities: [], recentRuns: [] },
      ),
      update: vi.fn(async (id: string, patch: unknown) => ({ id, ...(patch as Record<string, unknown>) })),
      archive: vi.fn(async () => undefined),
    },
    runs: {
      create: vi.fn(async () => run),
      list: vi.fn(async () => ({ items: [run], total: 1 })),
      get: vi.fn(async (id: string) => (id === 'run_missing' ? null : { ...run, id })),
      cancel: vi.fn(async () => ({ ...run, status: 'cancelled' })),
      coverage: vi.fn(async () => ({ uniqueCompanies: 10 })),
    },
    companies: {
      list: vi.fn(async () => ({ items: [sampleCompany()], nextCursor: 'cur-2', hasMore: true })),
      get: vi.fn(async (id: string) =>
        id === 'cmp_missing'
          ? null
          : {
              company: sampleCompany({ id }),
              sources: [{ platform: 'boss', platformCompanyId: 'b1' }],
              contacts: { total: 2, unlocked: 2, items: [{ type: 'mobile', value: '13800000000' }] },
              recentChanges: [{ seq: 1, type: 'company.created' }],
            },
      ),
      sources: vi.fn(async () => [{ platform: 'boss', platformCompanyId: 'b1' }]),
      snapshots: vi.fn(async () => ({ items: [{ id: 1, kind: 'search_page', blobHash: 'h1' }], nextCursor: null })),
      contacts: vi.fn(async () => ({ items: [{ type: 'mobile', value: '13800000000', masked: false }], total: 1, unlocked: 1 })),
      changes: vi.fn(async () => ({
        items: [{ seq: 3, type: 'company.updated', companyId: 'cmp_1', version: 2, field: 'phoneCount' }],
        nextCursor: null,
      })),
      rematch: vi.fn(async () => ({ jobId: 'job_rematch_1' })),
      unlock: vi.fn(async () => ({ jobId: 'job_unlock_1' })),
    },
    platforms: {
      list: vi.fn(async () => [{ platform: 'boss', platformStatus: 'active', jobCount: 12 }]),
      get: vi.fn(async (_id: string, platform: string) =>
        platform === 'missing' ? null : { platform, displayName: '河北测试机械有限公司', store: null },
      ),
      jobs: vi.fn(async () => ({ items: [{ title: '外贸业务员', salaryText: '6-10K' }], nextCursor: null })),
      changes: vi.fn(async () => ({ items: [{ seq: 4, field: 'platforms.boss.jobCount' }], nextCursor: null })),
      refresh: vi.fn(async () => ({ jobId: 'job_refresh_1' })),
    },
    customs: {
      get: vi.fn(async (id: string) =>
        id === 'cmp_nocustoms'
          ? null
          : {
              confidence: 'high',
              sampled: true,
              englishName: 'Test Hebei Machinery Co., Ltd.',
              totals: {},
              topDestinations: [{ key: 'United States', count: 10 }],
            },
      ),
      refresh: vi.fn(async () => ({ jobId: 'job_customs_1' })),
    },
    events: {
      listChanges: vi.fn(async () => ({
        items: [{ seq: 5, type: 'company.created', companyId: 'cmp_1', version: 1, occurredAt: '2026-11-16T02:00:00.000Z' }],
        nextSeq: 5,
        hasMore: false,
        nextCursor: null,
      })),
      listCompanyChanges: vi.fn(async () => ({ items: [], nextCursor: null })),
    },
    webhooks: {
      create: vi.fn(async (input: Record<string, unknown>) => ({
        id: 'whk_1',
        url: input.url,
        eventTypes: input.eventTypes,
        active: true,
        secret: 'secret-once',
      })),
      list: vi.fn(async () => [{ id: 'whk_1', url: 'http://127.0.0.1:1/hook', eventTypes: ['company.created'], active: true, secretMasked: '****' }]),
      update: vi.fn(async (id: string, patch: Record<string, unknown>) => ({ id, ...patch })),
      remove: vi.fn(async () => undefined),
      listDeliveries: vi.fn(async () => ({ items: [{ id: 'dlv_1', status: 'delivered' }], nextCursor: null })),
      replayDelivery: vi.fn(async () => ({ deliveryId: 'dlv_1', replayed: true as const })),
    },
    jobs: {
      list: vi.fn(async () => ({ items: [{ id: 'job_1', stage: 'unlock', status: 'dead' }], nextCursor: null })),
      get: vi.fn(async (id: string) => (id === 'job_missing' ? null : { id, stage: 'unlock', status: 'dead' })),
      retry: vi.fn(async (id: string) => ({ id, stage: 'unlock', status: 'pending', attempts: 0 })),
    },
    ops: {
      listSources: vi.fn(async () => ({ items: [{ platform: 'boss', state: 'ok', loggedIn: true }], updatedAt: '2026-11-16T00:00:00.000Z' })),
      getStats: vi.fn(async () => ({ kind: 'summary', companies: { total: 10 } })),
      getQuota: vi.fn(async () => ({
        daily: { limit: 100, used: 10, remaining: 90, unit: '点' },
        monthly: { limit: 1500, used: 200, remaining: 1300, unit: '点' },
        settlementDay: 11,
        nearlySevenDayUnlockCount: 12,
        observedAt: '2026-11-16T00:00:00.000Z',
      })),
    },
    admin: {
      backup: vi.fn(async () => ({ ok: true, path: '/tmp/backup.db', bytes: 1024 })),
      archive: vi.fn(async () => ({ dryRun: false, snapshotCount: 2, blobCount: 1, bytes: 100, months: [] })),
      listManifests: vi.fn(async () => [{ month: '2026-08', path: '/tmp/archive/2026-08/manifest.json', snapshotCount: 2, blobCount: 1, bytes: 100 }]),
      verify: vi.fn(async () => ({ ok: true, months: [] })),
      restore: vi.fn(async () => ({ dryRun: false, months: ['2026-08'], restoredSnapshots: 2, restoredBlobs: 2 })),
      dbStats: vi.fn(async () => ({ dbPath: '/tmp/lead.db', schemaVersion: 1, tables: { companies: 10 } })),
    },
  };
}

let app: FastifyInstance;
let fake: RouteServices;

beforeAll(async () => {
  process.env.LEAD_API_TOKEN = TOKEN;
  resetExpectedTokenForTests();
  resetDocsCacheForTests();
  fake = createFakeServices();
  app = Fastify({ logger: false });
  app.setNotFoundHandler(async (_req, reply) =>
    reply.code(404).send({ ok: false, data: null, meta: {}, error: { code: 'NOT_FOUND', message: 'route not found', retryable: false } }),
  );
  await registerRoutes(app, { services: fake });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setRouteServices(null);
  resetRouteServicesForTests();
  resetExpectedTokenForTests();
  resetDocsCacheForTests();
  delete process.env.LEAD_API_TOKEN;
});

const auth = { authorization: `Bearer ${TOKEN}` };

describe('公开契约路由（免鉴权）', () => {
  it('GET /openapi.json 返回 OpenAPI 3.1 且包含核心路径', async () => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { openapi: string; paths: Record<string, unknown> };
    expect(body.openapi).toBe('3.1.0');
    expect(Object.keys(body.paths)).toEqual(expect.arrayContaining(['/v1/goals', '/v1/companies/{id}', '/v1/changes']));
  });

  it('GET /mcp-tools.json 返回工具清单', async () => {
    const res = await app.inject({ method: 'GET', url: '/mcp-tools.json' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tools: Array<{ name: string }> };
    expect(body.tools.map((t) => t.name)).toEqual(expect.arrayContaining(['lead_status', 'lead_goals_list', 'lead_changes']));
  });

  it('GET /docs 返回自包含 HTML 且无外部 CDN', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('LeadPlatform API');
    expect(res.body).not.toMatch(/https?:\/\/cdn\./);
    expect(res.body).not.toMatch(/<script[^>]+src=/);
  });
});

describe('鉴权', () => {
  it('无 token → 401 UNAUTHORIZED envelope', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/goals' });
    expect(res.statusCode).toBe(401);
    const body = res.json() as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  it('错误 token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/goals', headers: { authorization: 'Bearer wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('正确 token → 200 且 envelope 完整', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/goals', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; data: { items: unknown[]; total: number }; meta: { requestId: string; tookMs: number }; error: null };
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.meta.requestId).toBeTruthy();
    expect(typeof body.meta.tookMs).toBe('number');
    expect(body.data.items).toHaveLength(2);
    expect(body.data.total).toBe(2);
  });
});

describe('Goals', () => {
  it('POST /v1/goals 缺 name → 400 VALIDATION_ERROR（带 field）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: auth,
      payload: { region: { province: '河北省' } },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details: { field: string } } };
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.field).toBe('name');
  });

  it('POST /v1/goals 合法 → 201 + Goal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: auth,
      payload: {
        name: '河北省-外贸线索',
        region: { province: '河北省' },
        platforms: ['boss', 'zhilian', 'ali', 'mic'],
        keywords: { boss: ['外贸'], ali: ['machinery'] },
        schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai' },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; name: string } };
    expect(body.data.id).toBe('goal_1');
    expect(fake.goals.create).toHaveBeenCalled();
  });

  it('GET /v1/goals/:id 不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/goals/goal_missing', headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('POST /v1/goals/:id/run → 202 + Run', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/goals/goal_1/run', headers: auth });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.id).toBe('run_1');
  });

  it('POST /v1/goals 无效 cron → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/goals',
      headers: auth,
      payload: { name: 'x', region: { province: '河北省' }, schedule: { cron: 'bad cron' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Companies / Platforms / Customs', () => {
  it('GET /v1/companies 游标分页 → data.items + meta.nextCursor', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies?limit=2', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { items: Array<{ id: string }>; hasMore: boolean }; meta: { nextCursor: string | null } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBe('cur-2');
  });

  it('GET /v1/companies?limit=999 超上限 → 400', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies?limit=999', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('GET /v1/companies/:id 返回详情结构', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_1?include=platforms,customs', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { company: { id: string }; sources: unknown[]; contacts: { total: number }; recentChanges: unknown[] } };
    expect(body.data.company.id).toBe('cmp_1');
    expect(body.data.sources).toHaveLength(1);
    expect(body.data.contacts.total).toBe(2);
    expect(body.data.recentChanges).toHaveLength(1);
    // include=platforms,customs 由路由层聚合并附加卡片
    expect(body.data.platforms).toHaveLength(1);
    expect((body.data.customs as { confidence?: string }).confidence).toBe('high');
    // include 透传给服务层（服务层可自行裁剪）
    expect(fake.companies.get).toHaveBeenCalledWith('cmp_1', { include: ['platforms', 'customs'] });
  });

  it('GET /v1/companies/:id 不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_missing', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/companies/:id/contacts 返回 total/unlocked/items', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_1/contacts?unlockedOnly=true', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { items: unknown[]; total: number; unlocked: number } };
    expect(body.data.items).toHaveLength(1);
    expect(body.data.unlocked).toBe(1);
  });

  it('GET /v1/companies/:id/platforms/ali/jobs → 400 UNSUPPORTED', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_1/platforms/ali/jobs', headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('UNSUPPORTED');
  });

  it('GET /v1/companies/:id/platforms/boss/jobs → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_1/platforms/boss/jobs?status=active', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { items: Array<{ title: string }> } };
    expect(body.data.items[0]?.title).toBe('外贸业务员');
  });

  it('GET /v1/companies/:id/customs 无画像 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_nocustoms/customs', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/companies/:id/customs 返回画像', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/companies/cmp_1/customs', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { confidence: string; sampled: boolean } };
    expect(body.data.confidence).toBe('high');
    expect(body.data.sampled).toBe(true);
  });

  it('POST /v1/companies/:id/rematch → 202 + jobId', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/companies/cmp_1/rematch', headers: auth, payload: {} });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { data: { jobId: string; queued: boolean } };
    expect(body.data.jobId).toBe('job_rematch_1');
    expect(body.data.queued).toBe(true);
  });

  it('POST /v1/companies/:id/unlock → 202 + jobId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/companies/cmp_1/unlock',
      headers: auth,
      payload: { idempotencyKey: 'cmp_1:2026-11-16' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().data.jobId).toBe('job_unlock_1');
    expect(fake.companies.unlock).toHaveBeenCalledWith('cmp_1', { idempotencyKey: 'cmp_1:2026-11-16' });
  });
});

describe('Changes / Webhooks / Jobs / Runtime / Admin', () => {
  it('GET /v1/changes 返回 items + nextSeq', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/changes?sinceSeq=0&limit=10', headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { items: Array<{ seq: number }>; nextSeq: number } };
    expect(body.data.items[0]?.seq).toBe(5);
    expect(body.data.nextSeq).toBe(5);
  });

  it('POST /v1/webhooks 合法 → 201（secret 明文仅创建返回）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth,
      payload: { url: 'http://127.0.0.1:9999/hook', eventTypes: ['company.created', 'contact.unlocked'] },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { data: { id: string; secret: string } };
    expect(body.data.id).toBe('whk_1');
    expect(body.data.secret).toBe('secret-once');
  });

  it('POST /v1/webhooks 非法 url → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks',
      headers: auth,
      payload: { url: 'not-a-url', eventTypes: ['company.created'] },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /v1/webhooks/:id/deliveries 分页', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/webhooks/whk_1/deliveries?status=dead', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.items).toHaveLength(1);
  });

  it('POST /v1/jobs/:id/retry → 202', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/jobs/job_1/retry', headers: auth });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { data: { status: string } };
    expect(body.data.status).toBe('pending');
  });

  it('GET /v1/jobs/:id 不存在 → 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/jobs/job_missing', headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('GET /v1/sources /v1/quota /v1/stats 正常', async () => {
    const sources = await app.inject({ method: 'GET', url: '/v1/sources', headers: auth });
    expect(sources.statusCode).toBe(200);
    expect(sources.json().data.items).toHaveLength(1);

    const quota = await app.inject({ method: 'GET', url: '/v1/quota', headers: auth });
    expect(quota.statusCode).toBe(200);
    expect(quota.json().data.monthly.remaining).toBe(1300);

    const stats = await app.inject({ method: 'GET', url: '/v1/stats?kind=coverage', headers: auth });
    expect(stats.statusCode).toBe(200);
    expect(fake.ops.getStats).toHaveBeenCalledWith(expect.objectContaining({ kind: 'coverage' }));
  });

  it('admin 路由：backup / archive / manifests / verify / restore / db-stats', async () => {
    for (const [method, url] of [
      ['POST', '/v1/admin/backup'],
      ['POST', '/v1/admin/archive'],
      ['GET', '/v1/admin/archive/manifests'],
      ['GET', '/v1/admin/verify'],
      ['POST', '/v1/admin/restore'],
      ['GET', '/v1/admin/db-stats'],
    ] as const) {
      const res = await app.inject({ method, url, headers: auth, payload: method === 'POST' ? {} : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
      expect(res.json().ok).toBe(true);
    }
  });
});

describe('SSE 兜底实现（/v1/events/stream）', () => {
  it('无 token → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/events/stream' });
    expect(res.statusCode).toBe(401);
  });

  it('带 token 能收到事件帧', async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    try {
      const resp = await fetch(`${address}/v1/events/stream?types=company.created`, {
        headers: { authorization: `Bearer ${TOKEN}`, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get('content-type')).toContain('text/event-stream');
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !text.includes('data:')) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      expect(text).toContain('data:');
      expect(text).toContain('company.created');
    } finally {
      controller.abort();
      await app.close();
    }
  });
});
