/**
 * fuma-platform 海关数据 mock（`:17890`）。响应形状对齐 docs/04 §6.6 / docs/08 与 exploration 实测样例。
 *
 * 覆盖：
 *  - `companyFlag=1/2` 两路查询 + 分页；
 *  - 本地缓存（同参数 24h 内 `cached=true`，`forceRefresh=true` 绕过）；
 *  - 无数据（totalNum=0）；
 *  - 账号无权限（`CUSTOMS_PERMISSION_DENIED`）；
 *  - 名称匹配：英文抬头 / 中文名均可命中 fixture。
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { findCustomsFixtureByQueryName, type CustomsFlag } from '../fixtures/customs.js';
import {
  MOCK_APP_OPTIONS,
  applyGate,
  installControlRoutes,
  sendErr,
  sendOk,
} from './common.js';
import type { FumaCacheEntry, MockWorld } from './state.js';

const SOURCE = 'fuma';

const ACCOUNT_ID = 'acct_01';
const CACHE_TTL_MS = 24 * 3600_000;

function nowIso(): string {
  return new Date().toISOString();
}

function cacheKey(accountId: string, inputCompany: string, flag: number, page: number, pageSize: number): string {
  return `${accountId}|${inputCompany.trim().toUpperCase()}|${flag}|${page}|${pageSize}`;
}

export function createFumaMock(world: MockWorld): FastifyInstance {
  const app = Fastify(MOCK_APP_OPTIONS);
  installControlRoutes(app, world, SOURCE);

  app.get('/v1/status', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const denied = world.scenario.fumaPermissionDenied;
    return sendOk(reply, {
      status: 'ok',
      version: '1.1.0-mock',
      specVersion: '2026-11-15.1',
      uptimeSeconds: 3600,
      db: 'ok',
      schemaVersion: 2,
      accounts: 1,
      onlineAccounts: denied ? 0 : 1,
      pid: 1000,
      now: nowIso(),
      accountsDetail: [
        {
          accountId: ACCOUNT_ID,
          name: '示例账号',
          status: denied ? 'no_permission' : 'active',
          ownerName: '示例账号',
        },
      ],
      pool: {},
      sync: { succeeded: 1 },
      tasks: {},
    });
  });

  app.post('/v1/customs/query', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const body = (req.body ?? {}) as {
      accountId?: string;
      inputCompany?: string;
      companyFlag?: number;
      page?: number;
      pageSize?: number;
      forceRefresh?: boolean;
      allowStale?: boolean;
    };
    if (world.scenario.fumaPermissionDenied) {
      return sendErr(reply, 403, 'CUSTOMS_PERMISSION_DENIED', 'permission_denied: account has no customs data permission', {
        retryable: false,
        details: { accountId: body.accountId ?? null },
      });
    }
    if ((body.accountId ?? '') !== ACCOUNT_ID) {
      return sendErr(reply, 403, 'CUSTOMS_PERMISSION_DENIED', `permission_denied: unknown or unauthorized accountId ${body.accountId ?? ''}`, {
        retryable: false,
      });
    }
    const inputCompany = String(body.inputCompany ?? '').trim();
    if (inputCompany.length < 2) {
      return sendErr(reply, 400, 'UPSTREAM_BAD_REQUEST', 'inputCompany must be at least 2 characters');
    }
    const flag = (body.companyFlag === 2 ? 2 : 1) as CustomsFlag;
    const page = Math.max(1, Number(body.page ?? 1) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(body.pageSize ?? 20) || 20));
    const forceRefresh = body.forceRefresh === true;
    const key = cacheKey(ACCOUNT_ID, inputCompany, flag, page, pageSize);
    const now = Date.now();
    const cached = world.scenario.fumaCache.get(key) as FumaCacheEntry | undefined;

    if (!forceRefresh && cached && Date.parse(cached.expiresAt) > now) {
      const payload = JSON.parse(JSON.stringify(cached.body)) as Record<string, unknown>;
      payload['cached'] = true;
      payload['source'] = 'cache';
      payload['cachedAt'] = cached.cachedAt;
      payload['expiresAt'] = cached.expiresAt;
      return sendOk(reply, payload);
    }

    const fixture = findCustomsFixtureByQueryName(inputCompany);
    const totalNum = fixture?.totals[flag] ?? 0;
    const allRecords = fixture?.records[flag] ?? [];
    const start = (page - 1) * pageSize;
    const list = allRecords.slice(start, start + pageSize);
    const fetchedAt = nowIso();
    const expiresAt = new Date(now + CACHE_TTL_MS).toISOString();
    world.scenario.fumaUpstreamQueries += 1;

    const payload: Record<string, unknown> = {
      list,
      totalNum,
      exactCount: 0,
      allCount: totalNum,
      source: 'upstream',
      cached: false,
      cachedAt: null,
      expiresAt,
      stale: false,
      upstreamVersion: '2026-11-16.mock',
      page,
      pageSize,
    };
    world.scenario.fumaCache.set(key, { body: JSON.parse(JSON.stringify(payload)), cachedAt: fetchedAt, expiresAt });
    return sendOk(reply, payload);
  });

  app.get('/v1/customs/cache/stats', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    return sendOk(reply, {
      entries: world.scenario.fumaCache.size,
      hits: 0,
      misses: world.scenario.fumaUpstreamQueries,
      bytes: world.scenario.fumaCache.size * 1024,
      upstreamQueries: world.scenario.fumaUpstreamQueries,
    });
  });

  app.get('/v1/customs/dictionaries', async (req, reply) => {
    const gated = await applyGate(world, SOURCE, req, reply);
    if (gated) return gated;
    const q = (req.query ?? {}) as { kind?: string };
    const kind = q.kind ?? 'countries';
    const items =
      kind === 'hscode'
        ? [
            { code: '8482', name: 'Ball or roller bearings' },
            { code: '7307', name: 'Pipe fittings' },
          ]
        : kind === 'sources'
          ? [{ key: 'US', name: 'United States' }, { key: 'UA', name: 'Ukraine' }]
          : [
              { code: 'US', nameEn: 'United States', nameZh: '美国' },
              { code: 'UA', nameEn: 'Ukraine', nameZh: '乌克兰' },
              { code: 'DE', nameEn: 'Germany', nameZh: '德国' },
            ];
    return sendOk(reply, { kind, items, total: items.length, updatedAt: nowIso() });
  });

  return app;
}
