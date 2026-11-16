#!/usr/bin/env -S node --experimental-sqlite --import tsx
/**
 * 契约生成：zod 唯一契约源 → spec/
 *   spec/openapi.json      OpenAPI 3.1
 *   spec/mcp-tools.json    MCP 工具清单
 *   spec/cli-commands.json CLI 命令清单
 *
 * 用法：
 *   npm run gen        生成/更新
 *   npm run gen:check  漂移检测（CI；不一致退出码 1）
 *
 * 同时做契约一致性校验：
 *  - operationId / handler 唯一且已注册；
 *  - MCP 工具映射的 REST 路径必须存在于 REST 清单；
 *  - CLI 命令映射的 REST 路径必须存在于 REST 清单；
 *  - 路径参数名必须出现在路径模板中。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCliCommandsSpec, buildMcpToolsSpec, buildOpenApi } from '../src/api/spec.js';
import { ALL_ROUTES, API_ROUTES } from '../src/http/routes/manifest.js';
import { ROUTE_HANDLERS } from '../src/http/routes/handlers/index.js';
import { MCP_TOOLS, toolPathParams } from '../src/mcp/tools.js';
import { CLI_COMMANDS } from '../src/cli/definitions.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SPEC_DIR = path.join(ROOT, 'spec');

interface GeneratedFile {
  name: string;
  content: string;
}

interface Problem {
  source: string;
  message: string;
}

function normalizeRestPath(p: string): string {
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function patternOf(p: string): string {
  return normalizeRestPath(p);
}

function validate(): Problem[] {
  const problems: Problem[] = [];
  const operationIds = new Set<string>();
  const handlers = new Set<string>();
  const routePatterns = new Set<string>();

  for (const route of ALL_ROUTES) {
    const key = `${route.method} ${normalizeRestPath(route.path)}`;
    if (routePatterns.has(key)) problems.push({ source: 'manifest', message: `duplicate route: ${key}` });
    routePatterns.add(key);

    if (operationIds.has(route.operationId)) {
      problems.push({ source: 'manifest', message: `duplicate operationId: ${route.operationId}` });
    }
    operationIds.add(route.operationId);

    if (route.external) {
      if (!route.public && route.operationId === 'getHealth') {
        problems.push({ source: 'manifest', message: '/v1/health must be public' });
      }
    } else {
      if (!route.handler) {
        problems.push({ source: 'manifest', message: `handler missing: ${route.method} ${route.path}` });
      } else {
        if (handlers.has(route.handler)) {
          problems.push({ source: 'manifest', message: `duplicate handler key: ${route.handler}` });
        }
        handlers.add(route.handler);
        if (typeof ROUTE_HANDLERS[route.handler] !== 'function') {
          problems.push({
            source: 'manifest',
            message: `handler not implemented: ${route.handler} (${route.method} ${route.path})`,
          });
        }
      }
    }
    const pathParams = Array.from(route.path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);
    if (route.params) {
      for (const name of pathParams) {
        const shape = (route.params as unknown as { shape?: Record<string, unknown> }).shape;
        if (shape && !(name in shape)) {
          problems.push({ source: 'manifest', message: `path param ${name} not declared in params schema: ${key}` });
        }
      }
    }
    if (route.stream && !route.query) {
      problems.push({ source: 'manifest', message: `stream route should declare query schema: ${key}` });
    }
  }

  const knownPatterns = routePatterns;
  for (const tool of MCP_TOOLS) {
    const pattern = `${tool.rest.method} ${patternOf(tool.rest.path)}`;
    if (!knownPatterns.has(pattern)) {
      problems.push({ source: 'mcp', message: `${tool.name}: REST route not found: ${pattern}` });
    }
    for (const param of toolPathParams(tool)) {
      if (!tool.inputSchema[param]) {
        problems.push({ source: 'mcp', message: `${tool.name}: path param ${param} missing in inputSchema` });
      }
    }
    if (tool.name.startsWith('lead_') === false) {
      problems.push({ source: 'mcp', message: `${tool.name}: tool name should start with lead_` });
    }
  }
  const toolNames = new Set<string>();
  for (const tool of MCP_TOOLS) {
    if (toolNames.has(tool.name)) problems.push({ source: 'mcp', message: `duplicate tool name: ${tool.name}` });
    toolNames.add(tool.name);
  }

  for (const cmd of CLI_COMMANDS) {
    if (cmd.rest) {
      const pattern = `${cmd.rest.method} ${patternOf(cmd.rest.path)}`;
      if (!knownPatterns.has(pattern)) {
        problems.push({ source: 'cli', message: `command "${cmd.path}": REST route not found: ${pattern}` });
      }
    }
  }

  const requiredTools = [
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
  for (const name of requiredTools) {
    if (!toolNames.has(name)) problems.push({ source: 'mcp', message: `required MCP tool missing: ${name}` });
  }

  const requiredCommands = [
    'status',
    'quota',
    'sources',
    'goal list',
    'goal show',
    'goal create',
    'goal update',
    'goal run',
    'run list',
    'run show',
    'run cancel',
    'company list',
    'company show',
    'company contacts',
    'company changes',
    'company snapshots',
    'company platforms',
    'company platform',
    'company jobs',
    'company refresh',
    'company customs',
    'company customs-refresh',
    'company rematch',
    'company unlock',
    'changes',
    'events tail',
    'webhook list',
    'webhook create',
    'webhook delete',
    'webhook deliveries',
    'webhook replay',
    'job list',
    'job retry',
    'admin backup',
    'admin archive',
    'admin verify',
    'admin restore',
  ];
  const commandPaths = new Set(CLI_COMMANDS.map((c) => c.path.replace(/ <[^>]+>/g, '').trim()));
  for (const required of requiredCommands) {
    if (!commandPaths.has(required)) problems.push({ source: 'cli', message: `required CLI command missing: ${required}` });
  }

  return problems;
}

function buildFiles(): GeneratedFile[] {
  const openapi = buildOpenApi();
  const mcpTools = buildMcpToolsSpec();
  const cliCommands = buildCliCommandsSpec();
  return [
    { name: 'openapi.json', content: JSON.stringify(openapi, null, 2) + '\n' },
    { name: 'mcp-tools.json', content: JSON.stringify(mcpTools, null, 2) + '\n' },
    { name: 'cli-commands.json', content: JSON.stringify(cliCommands, null, 2) + '\n' },
  ];
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const problems = validate();
  if (problems.length > 0) {
    console.error(`[gen] 契约校验失败（${problems.length} 项）：`);
    for (const p of problems) console.error(`  - [${p.source}] ${p.message}`);
    process.exitCode = 1;
    return;
  }

  const files = buildFiles();
  const drift: string[] = [];
  if (checkMode) {
    for (const file of files) {
      const target = path.join(SPEC_DIR, file.name);
      let current = '';
      try {
        current = fs.readFileSync(target, 'utf8');
      } catch {
        drift.push(`missing: spec/${file.name}`);
        continue;
      }
      if (current !== file.content) drift.push(`drift: spec/${file.name}`);
    }
    if (drift.length > 0) {
      console.error('[gen:check] 生成物与实现不一致：');
      for (const d of drift) console.error(`  - ${d}`);
      console.error('  运行 `npm run gen` 重新生成并提交 spec/。');
      process.exitCode = 1;
      return;
    }
    console.log(
      `[gen:check] OK：openapi ${ALL_ROUTES.length} 路由 / ${MCP_TOOLS.length} MCP 工具 / ${CLI_COMMANDS.length} CLI 命令，无漂移。`,
    );
    return;
  }

  fs.mkdirSync(SPEC_DIR, { recursive: true });
  for (const file of files) {
    const target = path.join(SPEC_DIR, file.name);
    fs.writeFileSync(target, file.content, 'utf8');
    console.log(`[gen] wrote spec/${file.name} (${file.content.length} bytes)`);
  }
  console.log(
    `[gen] OK：openapi ${ALL_ROUTES.length} 路由 / ${MCP_TOOLS.length} MCP 工具 / ${CLI_COMMANDS.length} CLI 命令。`,
  );
}

main();
