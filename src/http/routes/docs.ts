/**
 * 契约/文档路由（免鉴权，非 envelope）：
 *   GET /openapi.json   OpenAPI 3.1（优先 spec/ 生成物，缺失时运行时构建）
 *   GET /mcp-tools.json MCP 工具清单
 *   GET /docs           自包含 HTML（无外部 CDN，内嵌 Try it）
 *
 * 生成物由 `npm run gen` 写入 spec/；`npm run gen:check` 防漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildDocsHtml, buildMcpToolsSpec, buildOpenApi } from '../../api/spec.js';

interface DocsBundle {
  openapi: unknown;
  mcpTools: unknown;
  html: string;
}

/** 依次尝试：仓库根 spec/（dist 与 src 下相对层级一致）、cwd/spec */
function specDirs(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.resolve(here, '../../../spec'), path.resolve(process.cwd(), 'spec')];
}

function readJsonIfExists(name: string): unknown | null {
  for (const dir of specDirs()) {
    try {
      const raw = fs.readFileSync(path.join(dir, name), 'utf8');
      return JSON.parse(raw) as unknown;
    } catch {
      /* 继续尝试下一个目录 */
    }
  }
  return null;
}

let bundle: DocsBundle | null = null;

function loadBundle(): DocsBundle {
  if (bundle) return bundle;
  const openapi = readJsonIfExists('openapi.json') ?? buildOpenApi();
  const mcpTools = readJsonIfExists('mcp-tools.json') ?? buildMcpToolsSpec();
  const html = buildDocsHtml(openapi as Record<string, unknown>, mcpTools as Record<string, unknown>);
  bundle = { openapi, mcpTools, html };
  return bundle;
}

/** 测试/开发热更新用：清除缓存 */
export function resetDocsCacheForTests(): void {
  bundle = null;
}

export function registerDocsRoutes(app: FastifyInstance): void {
  app.get('/openapi.json', async (_req: FastifyRequest, reply: FastifyReply) => {
    const b = loadBundle();
    return reply
      .header('cache-control', 'no-cache')
      .type('application/json; charset=utf-8')
      .send(b.openapi);
  });

  app.get('/mcp-tools.json', async (_req: FastifyRequest, reply: FastifyReply) => {
    const b = loadBundle();
    return reply
      .header('cache-control', 'no-cache')
      .type('application/json; charset=utf-8')
      .send(b.mcpTools);
  });

  app.get('/docs', async (_req: FastifyRequest, reply: FastifyReply) => {
    const b = loadBundle();
    return reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(b.html);
  });

  app.get('/docs/', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.redirect('/docs', 302);
  });
}
