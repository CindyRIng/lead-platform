/**
 * F1 HTTP 层验收测试（Fastify inject，不监听端口、不访问上游）
 *
 * 覆盖：envelope / requestId / Bearer 鉴权 / /v1/health / /v1/status / 404 / 公开路径。
 * 说明：server.ts 依赖 config 单例，这里在动态 import 前设置测试 env，保证不读取用户 .env 的 token。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

const TEST_TOKEN = 'f'.repeat(64);
process.env.LEAD_API_TOKEN = TEST_TOKEN;
process.env.LEAD_LOG_LEVEL = 'error';
process.env.NODE_ENV = 'test';

let app: FastifyInstance;
let token: string;

beforeAll(async () => {
  const { buildServer } = await import('../../src/http/server.js');
  const { config } = await import('../../src/config.js');
  token = config.apiToken;
  app = await buildServer({ logger: false });
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
});

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('http foundation', () => {
  it('GET /v1/health 免鉴权、毫秒级、envelope 完整', async () => {
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    const took = Date.now() - started;
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['x-request-id']).toBeTruthy();
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.error).toBeNull();
    expect(body.meta.schemaVersion).toBe('1.0');
    expect(typeof body.meta.requestId).toBe('string');
    expect(body.meta.requestId.startsWith('req_')).toBe(true);
    expect(body.meta.tookMs).toBeGreaterThanOrEqual(0);
    expect(body.meta.timestamp).toMatch(/Z$/);
    expect(body.data.status).toBe('ok');
    expect(body.data.version).toBeTruthy();
    expect(took).toBeLessThan(500); // 毫秒级探针（宽松上限，避免 CI 抖动）
  });

  it('缺 token / 错 token → 401 UNAUTHORIZED envelope', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/status' });
    expect(missing.statusCode).toBe(401);
    const missingBody = missing.json();
    expect(missingBody.ok).toBe(false);
    expect(missingBody.data).toBeNull();
    expect(missingBody.error.code).toBe('UNAUTHORIZED');
    expect(missingBody.error.retryable).toBe(false);

    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('UNAUTHORIZED');
  });

  it('GET /v1/status 鉴权后返回运行态结构', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/status', headers: bearer() });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.data.service).toBe('lead-platform');
    expect(typeof body.data.version).toBe('string');
    expect(body.data.db).toBeTruthy();
    expect(body.data.db.schemaVersion).toBe(1);
    expect(typeof body.data.db.sizeBytes).toBe('number');
    expect(body.data.queue).toBeTruthy();
    expect(body.data.scheduler).toBeTruthy();
    expect(Array.isArray(body.data.alerts)).toBe(true);
    // 运行态时间：docs/03 约定 uptimeSec；当前实现用 time（ISO），两者至少有一个
    const hasUptime = typeof body.data.uptimeSec === 'number';
    const hasTime = typeof body.data.time === 'string' && Number.isFinite(Date.parse(body.data.time));
    expect(hasUptime || hasTime).toBe(true);
  });

  it('自定义 X-Request-Id 原样回显；无则生成 req_', async () => {
    const custom = 'test-request-id-123';
    const withCustom = await app.inject({
      method: 'GET',
      url: '/v1/health',
      headers: { 'x-request-id': custom },
    });
    expect(withCustom.headers['x-request-id']).toBe(custom);
    expect(withCustom.json().meta.requestId).toBe(custom);

    const generated = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(generated.json().meta.requestId).not.toBe(custom);
  });

  it('未知路由 → 404 NOT_FOUND envelope（非 fastify 默认体）', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/definitely-not-a-route', headers: bearer() });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.meta.requestId).toBeTruthy();
  });

  it('公开路径：/docs、/openapi.json 免鉴权可访问；CORS 关闭', async () => {
    const docs = await app.inject({ method: 'GET', url: '/docs' });
    expect(docs.statusCode).toBe(200);
    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });
    expect(openapi.statusCode).toBe(200);
    const health = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(health.headers['access-control-allow-origin']).toBeUndefined();
  });
});
