/**
 * 契约生成器：zod → JSON Schema(2020-12) → OpenAPI 3.1 / MCP tools / CLI commands。
 *
 * 同源：
 *  - REST 路由清单：src/http/routes/manifest.ts
 *  - MCP 工具清单：src/mcp/tools.ts
 *  - CLI 命令清单：src/cli/definitions.ts
 *
 * 运行期 /docs、/openapi.json、/mcp-tools.json 也使用本模块构建（spec/ 下生成物优先）。
 * scripts/gen.ts 负责落盘 + `--check` 漂移检测。
 */
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { ALL_ROUTES, API_ROUTES, type ApiRoute } from '../http/routes/manifest.js';
import { MCP_TOOLS, toolPathParams } from '../mcp/tools.js';
import { CLI_COMMANDS } from '../cli/definitions.js';

export const API_VERSION = '0.1.0';
export const OPENAPI_VERSION = '3.1.0';
export const DEFAULT_BASE_URL = 'http://127.0.0.1:8793';
export const SCHEMA_VERSION = '1.0';

type JsonObject = Record<string, unknown>;

/* ------------------------------------------------------------------ */
/* zod → JSON Schema（OpenAPI 3.1 兼容，2020-12 子集）                    */
/* ------------------------------------------------------------------ */

function convertString(def: JsonObject): JsonObject {
  const out: JsonObject = { type: 'string' };
  const checks = (def.checks as Array<Record<string, unknown>> | undefined) ?? [];
  for (const check of checks) {
    const kind = check.kind as string;
    if (kind === 'min' && typeof check.value === 'number') out.minLength = check.value;
    else if (kind === 'max' && typeof check.value === 'number') out.maxLength = check.value;
    else if (kind === 'length' && typeof check.value === 'number') {
      out.minLength = check.value;
      out.maxLength = check.value;
    } else if (kind === 'regex') {
      const re = check.regex as RegExp | undefined;
      if (re) out.pattern = re.source;
    } else if (kind === 'email') out.format = 'email';
    else if (kind === 'url') out.format = 'uri';
    else if (kind === 'uuid') out.format = 'uuid';
    else if (kind === 'datetime') out.format = 'date-time';
    else if (kind === 'ip') out.format = 'ip';
    else if (kind === 'trim' || kind === 'toLowerCase' || kind === 'toUpperCase') continue;
    else if (kind === 'startsWith' && typeof check.value === 'string') out.pattern = `^${escapeRegExp(check.value)}`;
    else if (kind === 'endsWith' && typeof check.value === 'string') out.pattern = `${escapeRegExp(check.value)}$`;
  }
  if (typeof def.description === 'string') out.description = def.description;
  return out;
}

function convertNumber(def: JsonObject): JsonObject {
  const out: JsonObject = { type: 'number' };
  const checks = (def.checks as Array<Record<string, unknown>> | undefined) ?? [];
  let isInt = false;
  for (const check of checks) {
    const kind = check.kind as string;
    if (kind === 'int') isInt = true;
    else if (kind === 'min' && typeof check.value === 'number') out.minimum = check.value;
    else if (kind === 'max' && typeof check.value === 'number') out.maximum = check.value;
    else if (kind === 'multipleOf' && typeof check.value === 'number') out.multipleOf = check.value;
  }
  if (isInt) out.type = 'integer';
  if (typeof def.description === 'string') out.description = def.description;
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function convertLiteral(value: unknown): JsonObject {
  if (value === null) return { type: 'null' };
  return { const: value as string | number | boolean };
}

function isRequiredProperty(schema: ZodTypeAny): boolean {
  const def = (schema as unknown as { _def: JsonObject })._def;
  if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodCatch') return false;
  if (def.typeName === 'ZodNullable') return true;
  try {
    return !schema.isOptional();
  } catch {
    return true;
  }
}

/** zod schema → JSON Schema（仅覆盖本项目用到的构造器；未知类型退化为 {}） */
export function zodToJsonSchema(schema: ZodTypeAny, depth = 0): JsonObject {
  if (depth > 12) return {};
  const def = (schema as unknown as { _def: JsonObject })._def;
  const typeName = def.typeName as string;
  const describe = (s: string | undefined): JsonObject => (s ? { description: s } : {});
  switch (typeName) {
    case 'ZodString':
      return convertString(def);
    case 'ZodNumber':
    case 'ZodNaN':
      return convertNumber(def);
    case 'ZodBoolean':
      return { type: 'boolean', ...describe(typeof def.description === 'string' ? def.description : undefined) };
    case 'ZodBigInt':
      return { type: 'integer' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodNull':
      return { type: 'null' };
    case 'ZodUndefined':
    case 'ZodVoid':
      return {};
    case 'ZodAny':
    case 'ZodUnknown':
      return {};
    case 'ZodNever':
      return { not: {} };
    case 'ZodLiteral':
      return convertLiteral(def.value);
    case 'ZodEnum': {
      const values = (def.values as string[]) ?? [];
      return { type: 'string', enum: values };
    }
    case 'ZodNativeEnum': {
      const raw = (def.values as Record<string, unknown>) ?? {};
      const values = Object.values(raw).filter((v) => typeof v === 'string' || typeof v === 'number');
      return values.every((v) => typeof v === 'string') ? { type: 'string', enum: values } : { enum: values };
    }
    case 'ZodArray': {
      const out: JsonObject = { type: 'array', items: zodToJsonSchema(def.type as ZodTypeAny, depth + 1) };
      const checks = (def.exactLength as unknown) ?? null;
      const minLength = typeof def.minLength === 'number' ? (def.minLength as JsonObject['minLength']) : undefined;
      const maxLength = typeof def.maxLength === 'number' ? (def.maxLength as JsonObject['maxLength']) : undefined;
      if (minLength !== undefined) out.minItems = minLength;
      if (maxLength !== undefined) out.maxItems = maxLength;
      if (checks) {
        /* noop: zod 3 把 length 放在 minLength/maxLength */
      }
      return out;
    }
    case 'ZodTuple': {
      const items = (def.items as ZodTypeAny[]) ?? [];
      return {
        type: 'array',
        prefixItems: items.map((item) => zodToJsonSchema(item, depth + 1)),
        minItems: items.length,
        ...(def.rest ? { items: zodToJsonSchema(def.rest as ZodTypeAny, depth + 1) } : { maxItems: items.length }),
      };
    }
    case 'ZodObject':
    case 'ZodEffects': {
      if (typeName === 'ZodEffects') return zodToJsonSchema(def.schema as ZodTypeAny, depth + 1);
      const shapeFactory = def.shape as () => Record<string, ZodTypeAny>;
      const shape = shapeFactory();
      const properties: JsonObject = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value, depth + 1);
        if (isRequiredProperty(value)) required.push(key);
      }
      const unknownKeys = def.unknownKeys as string | undefined;
      const out: JsonObject = { type: 'object', properties };
      if (required.length) out.required = required;
      if (unknownKeys === 'strict') out.additionalProperties = false;
      else if (unknownKeys === 'passthrough') out.additionalProperties = true;
      else out.additionalProperties = false;
      if (typeof def.description === 'string') out.description = def.description;
      return out;
    }
    case 'ZodRecord': {
      const keyType = def.keyType as ZodTypeAny;
      const keyDef = (keyType as unknown as { _def: JsonObject })._def;
      const out: JsonObject = { type: 'object' };
      if (keyDef?.typeName === 'ZodEnum') {
        const keys = (keyDef.values as string[]) ?? [];
        out.propertyNames = { enum: keys };
      }
      out.additionalProperties = zodToJsonSchema(def.valueType as ZodTypeAny, depth + 1);
      return out;
    }
    case 'ZodUnion': {
      const options = (def.options as ZodTypeAny[]) ?? [];
      return { anyOf: options.map((o) => zodToJsonSchema(o, depth + 1)) };
    }
    case 'ZodDiscriminatedUnion': {
      const rawOptions = def.options as unknown;
      const options: ZodTypeAny[] = Array.isArray(rawOptions)
        ? (rawOptions as ZodTypeAny[])
        : Array.from((rawOptions as Map<unknown, ZodTypeAny>)?.values?.() ?? []);
      return { anyOf: options.map((o) => zodToJsonSchema(o, depth + 1)) };
    }
    case 'ZodIntersection':
      return {
        allOf: [zodToJsonSchema(def.left as ZodTypeAny, depth + 1), zodToJsonSchema(def.right as ZodTypeAny, depth + 1)],
      };
    case 'ZodLazy': {
      const getter = def.getter as () => ZodTypeAny;
      return zodToJsonSchema(getter(), depth + 1);
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly': {
      const inner = zodToJsonSchema(
        (def.innerType ?? def.type) as ZodTypeAny,
        depth + 1,
      );
      if (typeName === 'ZodNullable') return { anyOf: [inner, { type: 'null' }] };
      return inner;
    }
    case 'ZodDefault': {
      const inner = zodToJsonSchema(def.innerType as ZodTypeAny, depth + 1);
      try {
        const dv = typeof def.defaultValue === 'function' ? (def.defaultValue as () => unknown)() : undefined;
        if (dv !== undefined && ['string', 'number', 'boolean', 'object'].includes(typeof dv) && JSON.stringify(dv) !== undefined) {
          return { ...inner, default: dv };
        }
      } catch {
        /* ignore */
      }
      return inner;
    }
    case 'ZodCatch':
    case 'ZodBranded':
      return zodToJsonSchema((def.innerType ?? def.type) as ZodTypeAny, depth + 1);
    case 'ZodPipeline':
      return zodToJsonSchema((def.in ?? def.out) as ZodTypeAny, depth + 1);
    case 'ZodPromise':
      return zodToJsonSchema(def.type as ZodTypeAny, depth + 1);
    case 'ZodFunction':
    case 'ZodMap':
    case 'ZodSet':
      return {};
    default:
      return {};
  }
}

/** zod raw shape（MCP 入参）→ JSON Schema object */
export function zodRawShapeToJsonSchema(shape: Record<string, ZodTypeAny>): JsonObject {
  return zodToJsonSchema(z.object(shape));
}

/* ------------------------------------------------------------------ */
/* OpenAPI 3.1                                                         */
/* ------------------------------------------------------------------ */

const REF_META: JsonObject = { $ref: '#/components/schemas/Meta' };
const REF_ERROR_ENVELOPE: JsonObject = { $ref: '#/components/schemas/ErrorEnvelope' };

const META_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    schemaVersion: { type: 'string', const: SCHEMA_VERSION },
    requestId: { type: 'string' },
    timestamp: { type: 'string', format: 'date-time' },
    tookMs: { type: 'number', minimum: 0 },
    warnings: { type: 'array', items: { type: 'string' } },
    nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['schemaVersion', 'requestId', 'timestamp', 'tookMs'],
};

const ERROR_SCHEMA: JsonObject = {
  type: 'object',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    retryable: { type: 'boolean' },
    details: { type: 'object', additionalProperties: true },
  },
  required: ['code', 'message', 'retryable'],
};

function okEnvelope(dataSchema: JsonObject): JsonObject {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean', const: true },
      data: dataSchema,
      meta: REF_META,
      error: { type: 'null' },
    },
    required: ['ok', 'data', 'meta', 'error'],
  };
}

function errEnvelope(): JsonObject {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean', const: false },
      data: { type: 'null' },
      meta: META_SCHEMA,
      error: ERROR_SCHEMA,
    },
    required: ['ok', 'data', 'meta', 'error'],
  };
}

function pathParamNames(path: string): string[] {
  return Array.from(path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);
}

function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function buildParameters(def: ApiRoute): JsonObject[] {
  const params: JsonObject[] = [];
  const pathNames = pathParamNames(def.path);
  if (pathNames.length) {
    const paramSchemaRoot = def.params ? zodToJsonSchema(def.params) : {};
    const properties = (paramSchemaRoot.properties as JsonObject | undefined) ?? {};
    const required = (paramSchemaRoot.required as string[] | undefined) ?? pathNames;
    for (const name of pathNames) {
      params.push({
        name,
        in: 'path',
        required: true,
        schema: (properties[name] as JsonObject | undefined) ?? { type: 'string' },
      });
    }
    if (!properties || Object.keys(properties).length === 0) {
      // 无显式 params schema 时补默认字符串
    }
    void required;
  }
  if (def.query) {
    const root = zodToJsonSchema(def.query);
    const properties = (root.properties as JsonObject | undefined) ?? {};
    const required = new Set((root.required as string[] | undefined) ?? []);
    for (const [name, schema] of Object.entries(properties)) {
      params.push({
        name,
        in: 'query',
        required: required.has(name),
        schema,
        ...(typeof (schema as JsonObject).description === 'string'
          ? { description: (schema as JsonObject).description as string }
          : {}),
      });
    }
  }
  return params;
}

function buildResponses(def: ApiRoute): JsonObject {
  const successStatus = def.successStatus ?? 200;
  const responses: JsonObject = {};
  if (def.stream) {
    responses['200'] = {
      description: 'SSE 事件流（text/event-stream；每条事件 data 为 ChangeView JSON，id 为 seq）',
      content: {
        'text/event-stream': { schema: { type: 'string' } },
      },
    };
  } else {
    responses[String(successStatus)] = {
      description: successStatus === 201 ? 'Created' : successStatus === 202 ? 'Accepted' : 'OK',
      content: {
        'application/json': { schema: okEnvelope(zodToJsonSchema(def.response)) },
      },
    };
  }
  const common: Array<[string, string]> = [
    ['400', 'VALIDATION_ERROR / UNSUPPORTED'],
    ['401', 'UNAUTHORIZED'],
    ['404', 'NOT_FOUND'],
    ['409', 'CONFLICT / RUN_IN_PROGRESS / QUOTA_EXHAUSTED / SOURCE_SESSION_INVALID'],
    ['429', 'UPSTREAM_RATE_LIMITED / RATE_LIMITED'],
    ['500', 'INTERNAL_ERROR'],
    ['503', 'SOURCE_UNAVAILABLE'],
  ];
  for (const [status, description] of common) {
    responses[status] = {
      description,
      content: { 'application/json': { schema: REF_ERROR_ENVELOPE } },
    };
  }
  return responses;
}

export function buildOpenApi(opts: { baseUrl?: string; version?: string } = {}): JsonObject {
  const paths: JsonObject = {};
  for (const def of ALL_ROUTES) {
    const oasPath = toOpenApiPath(def.path);
    const method = def.method.toLowerCase();
    const entry: JsonObject = {
      operationId: def.operationId,
      summary: def.summary,
      tags: [def.tag],
      ...(def.description ? { description: def.description } : {}),
      ...(def.public ? { security: [] } : {}),
      responses: buildResponses(def),
    };
    const parameters = buildParameters(def);
    if (parameters.length) entry.parameters = parameters;
    if (def.body) {
      entry.requestBody = {
        required: true,
        content: { 'application/json': { schema: zodToJsonSchema(def.body) } },
      };
    }
    const pathItem = (paths[oasPath] as JsonObject | undefined) ?? {};
    pathItem[method] = entry;
    paths[oasPath] = pathItem;
  }

  const tags = Array.from(new Set(ALL_ROUTES.map((r) => r.tag))).map((name) => ({ name }));

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'LeadPlatform API',
      version: opts.version ?? API_VERSION,
      description:
        '河北外贸线索聚合平台：Goal 驱动的四源采集 → 探迹工商/联系人补全 → 海关画像 → 变更事件/Webhook/SSE。' +
        '所有 /v1/** 接口使用统一 envelope；除 /v1/health、/docs、/openapi.json、/mcp-tools.json 外均需 Bearer 鉴权。',
      license: { name: 'MIT' },
    },
    servers: [{ url: opts.baseUrl ?? DEFAULT_BASE_URL, description: '本机 loopback' }],
    tags,
    security: [{ bearerAuth: [] }],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'LEAD_API_TOKEN',
          description: 'Authorization: Bearer <LEAD_API_TOKEN>（常量时间比较；缺失/错误 → 401 UNAUTHORIZED）',
        },
      },
      schemas: {
        Meta: META_SCHEMA,
        Error: ERROR_SCHEMA,
        ErrorEnvelope: errEnvelope(),
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* MCP tools / CLI commands 契约                                         */
/* ------------------------------------------------------------------ */

export function buildMcpToolsSpec(): JsonObject {
  return {
    schemaVersion: SCHEMA_VERSION,
    server: { name: 'lead-platform', version: API_VERSION, transport: 'stdio' },
    note: 'MCP 默认代理 REST（不直接持有 DB）；服务未启动时返回 SERVICE_UNAVAILABLE。',
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: zodRawShapeToJsonSchema(tool.inputSchema),
      rest: { method: tool.rest.method, path: toOpenApiPath(tool.rest.path) },
      pathParams: toolPathParams(tool),
      queryParams: tool.queryParams ?? [],
      ...(tool.sse ? { sse: tool.sse } : {}),
    })),
  };
}

export function buildCliCommandsSpec(): JsonObject {
  return {
    schemaVersion: SCHEMA_VERSION,
    bin: 'lead',
    defaultBaseUrl: DEFAULT_BASE_URL,
    globalOptions: [
      { flags: '--json', description: '输出与 REST data 一致的 JSON' },
      { flags: '--base-url <url>', description: `服务地址（默认 ${DEFAULT_BASE_URL}）` },
      { flags: '--token <token>', description: 'Bearer token（缺省读 LEAD_API_TOKEN / config.json）' },
    ],
    env: ['LEAD_API_TOKEN', 'LEAD_BASE_URL'],
    commands: CLI_COMMANDS.map((cmd) => ({
      path: cmd.path,
      group: cmd.group,
      description: cmd.description,
      ...(cmd.usage ? { usage: cmd.usage } : {}),
      args: cmd.args ?? [],
      options: cmd.options ?? [],
      ...(cmd.rest ? { rest: cmd.rest } : { transport: 'sse' }),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* 自包含 /docs HTML                                                    */
/* ------------------------------------------------------------------ */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function schemaSummary(schema: JsonObject | undefined, depth = 0): string {
  if (!schema || depth > 4) return '…';
  if (typeof schema.$ref === 'string') return String(schema.$ref).split('/').pop() ?? 'ref';
  const type = schema.type as string | undefined;
  if (type === 'array') return `Array<${schemaSummary(schema.items as JsonObject, depth + 1)}>`;
  if (type === 'object') {
    const props = (schema.properties as JsonObject | undefined) ?? {};
    const required = new Set((schema.required as string[] | undefined) ?? []);
    const entries = Object.entries(props);
    if (!entries.length) return 'object';
    return `{ ${entries
      .map(([k, v]) => `${k}${required.has(k) ? '' : '?'}: ${schemaSummary(v as JsonObject, depth + 1)}`)
      .join('; ')} }`;
  }
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonObject[]).map((s) => schemaSummary(s, depth + 1)).join(' | ');
  }
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).map((v) => JSON.stringify(v)).join(' | ');
  if ('const' in schema) return JSON.stringify(schema.const);
  return type ?? 'any';
}

export function buildDocsHtml(openapi: JsonObject, mcpTools: JsonObject): string {
  const info = (openapi.info ?? {}) as JsonObject;
  const tags = ((openapi.tags as JsonObject[] | undefined) ?? []).map((t) => String(t.name));
  const paths = (openapi.paths ?? {}) as Record<string, Record<string, JsonObject>>;
  const servers = (openapi.servers as JsonObject[] | undefined) ?? [];
  const baseUrl = String(servers[0]?.url ?? DEFAULT_BASE_URL);

  const grouped: Record<string, Array<{ path: string; method: string; op: JsonObject }>> = {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== 'object') continue;
      const tag = String(((op.tags as string[] | undefined) ?? ['Other'])[0]);
      (grouped[tag] ??= []).push({ path, method, op });
    }
  }
  const tagOrder = [...new Set([...tags, ...Object.keys(grouped)])].filter((t) => grouped[t]?.length);

  const navItems = tagOrder
    .map((tag) => `<a class="nav-item" href="#tag-${encodeURIComponent(tag)}">${escapeHtml(tag)} <span class="count">${grouped[tag].length}</span></a>`)
    .join('\n');

  const sections = tagOrder
    .map((tag) => {
      const ops = grouped[tag]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map(({ path, method, op }) => {
          const operationId = String(op.operationId ?? '');
          const params = ((op.parameters as JsonObject[] | undefined) ?? []).map((p) => {
            const schema = (p.schema ?? {}) as JsonObject;
            return `<tr><td><code>${escapeHtml(String(p.name))}</code></td><td>${escapeHtml(String(p.in))}</td><td>${p.required ? '是' : '否'}</td><td>${escapeHtml(schemaSummary(schema))}</td><td>${escapeHtml(String(p.description ?? ''))}</td></tr>`;
          });
          const body = op.requestBody ? (op.requestBody as JsonObject) : undefined;
          const bodySchema = body
            ? ((body.content as JsonObject | undefined)?.['application/json'] as JsonObject | undefined)?.schema
            : undefined;
          const okResp = ((op.responses as JsonObject | undefined)?.[String(200)] ??
            (op.responses as JsonObject | undefined)?.[String(201)] ??
            (op.responses as JsonObject | undefined)?.[String(202)]) as JsonObject | undefined;
          const respContent = okResp?.content as JsonObject | undefined;
          const respSchema = respContent?.['application/json'] as JsonObject | undefined;
          const dataSchema = respSchema ? ((respSchema.schema as JsonObject | undefined)?.properties as JsonObject | undefined)?.data : undefined;
          const examplePath = path.replace(/\{([A-Za-z0-9_]+)\}/g, (_m, p1) => `<${p1}>`);
          return `<div class="op" id="op-${escapeHtml(operationId)}">
  <div class="op-head"><span class="method ${method.toLowerCase()}">${method.toUpperCase()}</span><code class="path">${escapeHtml(path)}</code><span class="opid">${escapeHtml(operationId)}</span></div>
  <div class="op-summary">${escapeHtml(String(op.summary ?? ''))}</div>
  ${op.description ? `<div class="op-desc">${escapeHtml(String(op.description))}</div>` : ''}
  ${params.length ? `<h4>参数</h4><table class="params"><thead><tr><th>名称</th><th>位置</th><th>必填</th><th>类型</th><th>说明</th></tr></thead><tbody>${params.join('')}</tbody></table>` : ''}
  ${bodySchema ? `<h4>请求体</h4><pre class="schema">${escapeHtml(JSON.stringify(bodySchema, null, 2))}</pre>` : ''}
  <h4>响应 data</h4><pre class="schema">${escapeHtml(schemaSummary(dataSchema as JsonObject))}</pre>
  <div class="try">
    <input class="try-path" data-method="${method.toUpperCase()}" data-path="${escapeHtml(path)}" placeholder="请求路径（可替换 :param）" value="${escapeHtml(path.replace(/\{([A-Za-z0-9_]+)\}/g, (m) => m))}" />
    <button class="try-btn" data-method="${method.toUpperCase()}" data-path="${escapeHtml(path)}">Try it</button>
    <pre class="try-out" data-out-for="${escapeHtml(operationId)}">—</pre>
  </div>
  <div class="rest">REST: <code>${method.toUpperCase()} ${escapeHtml(examplePath)}</code></div>
</div>`;
        })
        .join('\n');
      return `<section class="tag" id="tag-${encodeURIComponent(tag)}"><h2>${escapeHtml(tag)}</h2>${ops}</section>`;
    })
    .join('\n');

  const tools = ((mcpTools.tools as JsonObject[] | undefined) ?? [])
    .map((t) => `<tr><td><code>${escapeHtml(String(t.name))}</code></td><td>${escapeHtml(String(t.description ?? ''))}</td><td><code>${escapeHtml(JSON.stringify(t.rest))}</code></td></tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(String(info.title ?? 'LeadPlatform API'))} · API Docs</title>
<style>
:root{--bg:#0f1419;--panel:#171d25;--panel2:#1f2732;--text:#e6edf3;--muted:#9aa7b4;--border:#2b3542;--accent:#4ea1ff;--green:#3fb950;--orange:#d29922;--red:#f85149;--purple:#bc8cff}
*{box-sizing:border-box}
body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
header{padding:22px 28px;border-bottom:1px solid var(--border);background:linear-gradient(180deg,#161d26,#0f1419)}
header h1{margin:0 0 6px;font-size:22px}
header .sub{color:var(--muted)}
header .meta{margin-top:10px;color:var(--muted);font-size:12px}
header .meta code{color:var(--accent)}
.layout{display:flex;align-items:flex-start}
nav{position:sticky;top:0;height:100vh;overflow:auto;width:270px;flex:0 0 270px;padding:18px 14px;border-right:1px solid var(--border);background:var(--panel)}
nav h3{margin:0 0 10px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.nav-item{display:flex;justify-content:space-between;padding:6px 8px;border-radius:6px;color:var(--text);text-decoration:none;font-size:13px}
.nav-item:hover{background:var(--panel2)}
.count{color:var(--muted)}
main{flex:1;min-width:0;padding:22px 28px 80px}
section.tag{margin-bottom:34px}
section.tag>h2{border-bottom:1px solid var(--border);padding-bottom:6px;font-size:18px}
.op{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:14px 0}
.op-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.method{font:600 11px/1 monospace;padding:5px 8px;border-radius:5px;background:var(--panel2);border:1px solid var(--border)}
.method.get{color:var(--green)}.method.post{color:var(--accent)}.method.patch{color:var(--orange)}.method.delete{color:var(--red)}
.path{font-size:14px;color:var(--text)}
.opid{color:var(--muted);font-size:11px;margin-left:auto}
.op-summary{margin-top:8px;font-weight:600}
.op-desc{color:var(--muted);margin-top:4px;font-size:13px}
h4{margin:14px 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{border:1px solid var(--border);padding:5px 8px;text-align:left;vertical-align:top}
th{background:var(--panel2);color:var(--muted);font-weight:600}
pre.schema,pre.try-out{background:#0b0f14;border:1px solid var(--border);border-radius:6px;padding:10px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c9d1d9;max-height:320px}
.try{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-start;margin-top:10px}
.try-path{flex:1 1 320px;background:#0b0f14;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 9px;font:12px ui-monospace,monospace}
.try-btn{background:var(--accent);color:#04121f;border:0;border-radius:6px;padding:8px 14px;font-weight:600;cursor:pointer}
.try-btn:hover{filter:brightness(1.1)}
.try-out{flex:1 1 100%;margin:0;display:none}
.rest{color:var(--muted);font-size:11.5px;margin-top:8px}
#authbar{position:sticky;top:0;z-index:5;background:var(--panel);padding:10px 28px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#authbar input{flex:1 1 360px;background:#0b0f14;border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 9px;font:12px ui-monospace,monospace}
#authbar button{background:var(--panel2);border:1px solid var(--border);color:var(--text);border-radius:6px;padding:7px 12px;cursor:pointer}
#authbar .hint{color:var(--muted);font-size:12px}
footer{color:var(--muted);font-size:12px;padding:20px 28px;border-top:1px solid var(--border)}
.anchor{color:var(--muted);text-decoration:none;margin-right:6px}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(String(info.title ?? 'LeadPlatform API'))} <span class="method get">v${escapeHtml(String(info.version ?? API_VERSION))}</span></h1>
  <div class="sub">${escapeHtml(String(info.description ?? ''))}</div>
  <div class="meta">Base URL: <code>${escapeHtml(baseUrl)}</code> · Envelope: <code>{ ok, data, meta, error }</code> · 鉴权: <code>Authorization: Bearer &lt;LEAD_API_TOKEN&gt;</code></div>
</header>
<div id="authbar">
  <input id="token" type="password" placeholder="LEAD_API_TOKEN（仅保存在本浏览器 localStorage，用于 Try it）" autocomplete="off" />
  <button id="save-token">保存 Token</button>
  <button id="clear-token">清除</button>
  <span class="hint">/v1/health、/docs、/openapi.json、/mcp-tools.json 免鉴权；本页无外部 CDN。</span>
</div>
<div class="layout">
<nav>
  <h3>API 分组</h3>
  ${navItems}
  <h3 style="margin-top:18px">MCP 工具</h3>
  <a class="nav-item" href="#mcp-tools">MCP 工具清单 <span class="count">${((mcpTools.tools as unknown[] | undefined) ?? []).length}</span></a>
  <h3 style="margin-top:18px">其它</h3>
  <a class="nav-item" href="/openapi.json">OpenAPI 3.1 JSON</a>
  <a class="nav-item" href="/mcp-tools.json">MCP 工具 JSON</a>
</nav>
<main>
  ${sections}
  <section class="tag" id="mcp-tools"><h2>MCP 工具（lead_*）</h2>
  <p class="op-desc">MCP server 通过 stdio 暴露以下工具，全部代理 REST；服务未启动时返回 SERVICE_UNAVAILABLE。</p>
  <table class="params"><thead><tr><th>工具</th><th>说明</th><th>对应 REST</th></tr></thead><tbody>${tools}</tbody></table>
  </section>
</main>
</div>
<footer>LeadPlatform ${escapeHtml(API_VERSION)} · 本页由 <code>npm run gen</code> / 运行时构建，自包含（无外部资源）。</footer>
<script>
(function(){
  var tokenKey = 'leadplatform.apiToken';
  var tokenInput = document.getElementById('token');
  try { var saved = localStorage.getItem(tokenKey); if (saved) tokenInput.value = saved; } catch (e) {}
  document.getElementById('save-token').addEventListener('click', function(){ try{ localStorage.setItem(tokenKey, tokenInput.value.trim()); }catch(e){} alert('已保存到 localStorage'); });
  document.getElementById('clear-token').addEventListener('click', function(){ try{ localStorage.removeItem(tokenKey); }catch(e){} tokenInput.value=''; });
  document.querySelectorAll('.try-btn').forEach(function(btn){
    btn.addEventListener('click', async function(){
      var op = btn.closest('.op');
      var input = op.querySelector('.try-path');
      var out = op.querySelector('.try-out');
      out.style.display = 'block';
      var method = btn.getAttribute('data-method');
      var path = input.value || btn.getAttribute('data-path');
      var headers = { 'Accept': 'application/json' };
      var token = ''; try { token = localStorage.getItem(tokenKey) || ''; } catch(e) {}
      if (token) headers['Authorization'] = 'Bearer ' + token;
      var opts = { method: method, headers: headers };
      try {
        var resp = await fetch(path, opts);
        var text = await resp.text();
        try { text = JSON.stringify(JSON.parse(text), null, 2); } catch(e) {}
        out.textContent = 'HTTP ' + resp.status + '\\n' + text;
      } catch (err) { out.textContent = '请求失败: ' + err; }
    });
  });
})();
</script>
</body>
</html>`;
}
