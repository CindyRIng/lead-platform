#!/usr/bin/env node
/**
 * MCP server（stdio）：把 lead_* 工具代理到本地 REST（默认 127.0.0.1:8793）。
 *
 * - 不另起浏览器/DB，不真实访问上游；只发本机 HTTP；
 * - 服务未启动 → 工具返回 SERVICE_UNAVAILABLE（isError）；
 * - 工具清单与 REST 映射见 src/mcp/tools.ts（scripts/gen.ts 生成 spec/mcp-tools.json）。
 *
 * 运行：node dist/mcp/server.js（或 npm exec -- tsx src/mcp/server.ts）；在 MCP 客户端里配置该命令为 stdio server。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRestClient, RestClientError, type RestClient } from '../api/restClient.js';
import { MCP_TOOLS, toolPathParams, type McpToolDef } from './tools.js';

export const MCP_SERVER_INFO = { name: 'lead-platform', version: '0.1.0' } as const;

export interface McpServerOptions {
  client?: RestClient;
  /** 默认单请求超时 */
  timeoutMs?: number;
}

interface ToolArgs {
  [key: string]: unknown;
}

export function buildToolRequest(tool: McpToolDef, args: ToolArgs): {
  path: string;
  query: Record<string, unknown>;
  body: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
} {
  const pathParams = toolPathParams(tool);
  let path = tool.rest.path;
  for (const param of pathParams) {
    const value = args[param];
    if (value === undefined || value === null) {
      throw new RestClientError('VALIDATION_ERROR', `missing required path param: ${param}`);
    }
    path = path.replace(`:${param}`, encodeURIComponent(String(value)));
  }
  const query: Record<string, unknown> = {};
  for (const key of tool.queryParams ?? []) {
    const value = args[key];
    if (value !== undefined && value !== null && value !== '') query[key] = value;
  }
  const skip = new Set([...pathParams, ...(tool.queryParams ?? [])]);
  const bodyFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (skip.has(key)) continue;
    if (tool.sse && (key === tool.sse.timeoutKey || key === tool.sse.maxEventsKey)) continue;
    if (value !== undefined) bodyFields[key] = value;
  }
  const method = tool.rest.method;
  const body = method === 'GET' || Object.keys(bodyFields).length === 0 ? undefined : bodyFields;
  return { path, query, body };
}

function textResult(text: string, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

async function tailEvents(
  client: RestClient,
  tool: McpToolDef,
  args: ToolArgs,
  query: Record<string, unknown>,
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const sse = tool.sse;
  const timeoutSec = Math.max(1, Math.min(120, Number(args[sse?.timeoutKey ?? 'timeoutSec'] ?? sse?.defaultTimeoutSec ?? 5) || 5));
  const maxEvents = Math.max(1, Math.min(1000, Number(args[sse?.maxEventsKey ?? 'maxEvents'] ?? sse?.defaultMaxEvents ?? 50) || 50));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const items: unknown[] = [];
  try {
    const iterator = client.stream(tool.rest.path, { query, signal: controller.signal });
    for await (const event of iterator) {
      if (event.parsed !== null && typeof event.parsed === 'object') items.push(event.parsed);
      else items.push({ data: event.data });
      if (items.length >= maxEvents) break;
    }
  } catch (err) {
    if (err instanceof RestClientError) {
      return textResult(`${err.code}: ${err.message}`, true);
    }
    const name = (err as Error)?.name;
    if (name !== 'AbortError') {
      return textResult(`SERVICE_UNAVAILABLE: ${(err as Error)?.message ?? String(err)}`, true);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return textResult(
    JSON.stringify(
      {
        ok: true,
        data: { items, count: items.length, windowSec: timeoutSec, truncated: items.length >= maxEvents },
        note: 'SSE 截断窗口；事件与 REST /v1/changes 的 ChangeView 一致，建议持久化 seq 后用 sinceSeq 续传。',
      },
      null,
      2,
    ),
  );
}

/** 创建 MCP server（不连接 transport，便于单测） */
export function createMcpServer(opts: McpServerOptions = {}): McpServer {
  const client = opts.client ?? createRestClient();
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const server = new McpServer({ ...MCP_SERVER_INFO });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (rawArgs: unknown) => {
        const args = (rawArgs ?? {}) as ToolArgs;
        try {
          const request = buildToolRequest(tool, args);
          if (tool.sse) return await tailEvents(client, tool, args, request.query);
          const response = await client.request(tool.rest.method, request.path, {
            query: request.query,
            body: request.body,
            timeoutMs,
          });
          if (response.envelope && !response.envelope.ok) {
            const err = response.envelope.error;
            return textResult(`${err.code}: ${err.message}`, true);
          }
          const payload = response.envelope ? response.envelope : { ok: true, data: response.text };
          return textResult(JSON.stringify(payload, null, 2));
        } catch (err) {
          if (err instanceof RestClientError) return textResult(`${err.code}: ${err.message}`, true);
          return textResult(`INTERNAL_ERROR: ${(err as Error)?.message ?? String(err)}`, true);
        }
      },
    );
  }

  return server;
}

/** stdio 入口 */
export async function runStdioServer(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[lead-mcp] ready (${MCP_TOOLS.length} tools) baseUrl=${createRestClient().baseUrl}\n`);
}

const isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return /(^|\/)mcp\/server\.(js|ts)$/.test(entry) || /(^|\/)mcp-server\.(js|ts)$/.test(entry);
  } catch {
    return false;
  }
})();

if (isMain) {
  void runStdioServer().catch((err) => {
    process.stderr.write(`[lead-mcp] failed: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  });
}
