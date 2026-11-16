/**
 * D3 MCP / 契约生成测试：
 *  - MCP 工具清单与 REST 路径映射完整、无重复、包含任务要求工具；
 *  - OpenAPI 3.1 覆盖 ALL_ROUTES，handler 全部注册；
 *  - spec/ 提交物与运行时构建一致（等价 npm run gen:check）；
 *  - MCP 工具 → REST 请求映射（路径/query/body）与代理调用（mock fetch）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCliCommandsSpec, buildMcpToolsSpec, buildOpenApi, zodRawShapeToJsonSchema, zodToJsonSchema } from '../../src/api/spec.js';
import { ALL_ROUTES, API_ROUTES } from '../../src/http/routes/manifest.js';
import { ROUTE_HANDLERS } from '../../src/http/routes/handlers/index.js';
import { MCP_TOOLS, MCP_TOOLS_BY_NAME, toolPathParams } from '../../src/mcp/tools.js';
import { CLI_COMMANDS } from '../../src/cli/definitions.js';
import { buildToolRequest, createMcpServer } from '../../src/mcp/server.js';
import { RestClient } from '../../src/api/restClient.js';
import { z } from 'zod';

const ROOT = path.resolve(__dirname, '../..');

const REQUIRED_TOOLS = [
  'lead_status',
  'lead_quota',
  'lead_sources',
  'lead_goals_list',
  'lead_goal_get',
  'lead_goal_create',
  'lead_goal_update',
  'lead_goal_run',
  'lead_runs_list',
  'lead_run_get',
  'lead_companies_list',
  'lead_company_get',
  'lead_company_contacts',
  'lead_company_changes',
  'lead_company_platforms',
  'lead_company_jobs',
  'lead_company_customs',
  'lead_changes',
  'lead_events_tail',
  'lead_jobs_list',
  'lead_job_retry',
  'lead_webhooks_list',
];

function normalize(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function readSpec(name: string): unknown {
  const file = path.join(ROOT, 'spec', name);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

describe('REST 契约清单', () => {
  it('operationId / handler / method+path 唯一', () => {
    const opIds = API_ROUTES.map((r) => r.operationId);
    expect(new Set(opIds).size).toBe(opIds.length);
    const routes = API_ROUTES.map((r) => `${r.method} ${normalize(r.path)}`);
    expect(new Set(routes).size).toBe(routes.length);
    for (const route of API_ROUTES) {
      expect(route.handler, route.path).toBeTruthy();
      expect(typeof ROUTE_HANDLERS[route.handler as string]).toBe('function');
    }
    // foundation 路由只进契约不注册 handler
    for (const route of ALL_ROUTES.filter((r) => r.external)) {
      expect(route.handler).toBeUndefined();
    }
  });

  it('zod → JSON Schema 覆盖 object/enum/record/optional', () => {
    const schema = zodToJsonSchema(
      z.object({
        name: z.string().min(1),
        platform: z.enum(['boss', 'ali']),
        meta: z.record(z.string(), z.unknown()).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      }),
    );
    expect(schema.type).toBe('object');
    expect((schema.properties as Record<string, unknown>).name).toMatchObject({ type: 'string', minLength: 1 });
    expect((schema.properties as Record<string, unknown>).platform).toMatchObject({ enum: ['boss', 'ali'] });
    expect((schema.properties as Record<string, unknown>).meta).toMatchObject({ type: 'object' });
    expect((schema.properties as Record<string, unknown>).limit).toMatchObject({ type: 'integer', minimum: 1 });
    expect(schema.required).toEqual(['name', 'platform']);
  });
});

describe('OpenAPI 3.1', () => {
  const openapi = buildOpenApi() as {
    openapi: string;
    info: { title: string; version: string };
    servers: Array<{ url: string }>;
    paths: Record<string, Record<string, unknown>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  it('版本/服务器/安全方案正确', () => {
    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi.info.title).toContain('LeadPlatform');
    expect(openapi.servers[0]?.url).toBe('http://127.0.0.1:8793');
    expect(openapi.components.securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('覆盖全部路由（含 foundation 的 health/status）与统一错误响应', () => {
    for (const route of ALL_ROUTES) {
      const item = openapi.paths[normalize(route.path)];
      expect(item, `${route.method} ${route.path}`).toBeTruthy();
      const op = item?.[route.method.toLowerCase()] as Record<string, unknown>;
      expect(op).toBeTruthy();
      expect(op.operationId).toBe(route.operationId);
      expect(op.responses).toMatchObject({
        '400': expect.any(Object),
        '401': expect.any(Object),
        '500': expect.any(Object),
      });
    }
    expect(openapi.paths['/v1/health']?.['get']).toBeTruthy();
    expect(openapi.paths['/v1/status']?.['get']).toBeTruthy();
  });

  it('public 路由无 security 覆盖，其它要求 Bearer', () => {
    const health = openapi.paths['/v1/health']?.['get'] as Record<string, unknown>;
    expect(health.security).toEqual([]);
    const companies = openapi.paths['/v1/companies']?.['get'] as Record<string, unknown>;
    expect(companies.security).toBeUndefined();
    expect(Object.keys(openapi.paths['/v1/companies'] ?? {})).toContain('get');
  });

  it('spec/openapi.json 与运行时构建一致（无漂移）', () => {
    expect(readSpec('openapi.json')).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
  });
});

describe('MCP 工具契约', () => {
  it('包含任务要求的全部工具，且唯一/命名规范', () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_TOOLS) expect(names, required).toContain(required);
    for (const name of names) expect(name.startsWith('lead_')).toBe(true);
  });

  it('每个工具映射到已存在的 REST 路由，路径参数与入参一致', () => {
    const patterns = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalize(r.path)}`));
    for (const tool of MCP_TOOLS) {
      const pattern = `${tool.rest.method} ${normalize(tool.rest.path)}`;
      expect(patterns.has(pattern), `${tool.name} → ${pattern}`).toBe(true);
      for (const param of toolPathParams(tool)) {
        expect(tool.inputSchema[param], `${tool.name} path param ${param}`).toBeTruthy();
      }
      // 入参 schema 可序列化
      const json = zodRawShapeToJsonSchema(tool.inputSchema) as { type: string; properties?: Record<string, unknown> };
      expect(json.type).toBe('object');
      for (const key of Object.keys(tool.inputSchema)) expect(json.properties?.[key]).toBeTruthy();
    }
  });

  it('spec/mcp-tools.json 与运行时构建一致', () => {
    expect(readSpec('mcp-tools.json')).toEqual(JSON.parse(JSON.stringify(buildMcpToolsSpec())));
  });

  it('MCP 工具 → REST 请求映射正确', () => {
    const goalGet = buildToolRequest(MCP_TOOLS_BY_NAME.lead_goal_get!, { id: 'goal_1' });
    expect(goalGet.path).toBe('/v1/goals/goal_1');
    expect(goalGet.method).toBeUndefined();

    const list = buildToolRequest(MCP_TOOLS_BY_NAME.lead_goals_list!, { enabled: true, limit: 20, offset: 0 });
    expect(list.path).toBe('/v1/goals');
    expect(list.query).toEqual({ enabled: true, limit: 20, offset: 0 });

    const create = buildToolRequest(MCP_TOOLS_BY_NAME.lead_goal_create!, {
      name: '河北省-外贸线索',
      region: { province: '河北省' },
    });
    expect(create.body).toMatchObject({ name: '河北省-外贸线索', region: { province: '河北省' } });

    const jobs = buildToolRequest(MCP_TOOLS_BY_NAME.lead_company_jobs!, {
      id: 'cmp_1',
      platform: 'boss',
      status: 'active',
      limit: 10,
    });
    expect(jobs.path).toBe('/v1/companies/cmp_1/platforms/boss/jobs');
    expect(jobs.query).toEqual({ status: 'active', limit: 10 });

    const unlock = buildToolRequest(MCP_TOOLS_BY_NAME.lead_company_unlock!, { id: 'cmp_1', idempotencyKey: 'k1' });
    expect(unlock.path).toBe('/v1/companies/cmp_1/unlock');
    expect(unlock.body).toEqual({ idempotencyKey: 'k1' });
  });

  it('MCP server 注册全部工具（可代理 REST）', () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          ok: true,
          data: { service: 'lead-platform' },
          meta: { schemaVersion: '1.0', requestId: 'r', timestamp: new Date().toISOString(), tookMs: 1 },
          error: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const server = createMcpServer({ client: new RestClient({ baseUrl: 'http://127.0.0.1:8793', token: 't', fetchImpl }) });
    const registry = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools;
    expect(registry).toBeTruthy();
    expect(Object.keys(registry ?? {}).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    void calls;
  });
});

describe('CLI 契约清单', () => {
  it('spec/cli-commands.json 与运行时清单一致，且每个 REST 映射存在', () => {
    expect(readSpec('cli-commands.json')).toEqual(JSON.parse(JSON.stringify(buildCliCommandsSpec())));
    const patterns = new Set(ALL_ROUTES.map((r) => `${r.method} ${normalize(r.path)}`));
    for (const cmd of CLI_COMMANDS) {
      if (!cmd.rest) continue;
      expect(patterns.has(`${cmd.rest.method} ${normalize(cmd.rest.path)}`), cmd.path).toBe(true);
    }
  });
});
