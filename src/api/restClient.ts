/**
 * REST 客户端（CLI 与 MCP 共用）：只走 HTTP，不直接持有 DB/浏览器。
 *
 * 配置解析优先级：显式参数 > 环境变量 > ~/.lead-platform/config.json > 默认 loopback:8793。
 *  - baseUrl: LEAD_BASE_URL / config.baseUrl / http://127.0.0.1:<config.port | LEAD_PORT | 8793>
 *  - token:   LEAD_API_TOKEN / config.apiToken | config.token
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Envelope } from '../shared/envelope.js';

export interface RestClientConfig {
  baseUrl: string;
  token: string | null;
}

export interface ResolveOptions {
  baseUrl?: string;
  token?: string | null;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function readConfigFile(homeDir?: string): Record<string, unknown> {
  const home = homeDir ?? os.homedir();
  try {
    const raw = fs.readFileSync(path.join(home, '.lead-platform', 'config.json'), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringField(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function resolveRestClientConfig(opts: ResolveOptions = {}): RestClientConfig {
  const env = opts.env ?? process.env;
  const file = readConfigFile(opts.homeDir);
  const port = env.LEAD_PORT ?? stringField(file, ['port']) ?? '8793';
  const baseUrl =
    opts.baseUrl ??
    env.LEAD_BASE_URL ??
    stringField(file, ['baseUrl', 'base_url', 'url']) ??
    `http://127.0.0.1:${port}`;
  const token =
    (opts.token !== undefined ? opts.token : undefined) ??
    env.LEAD_API_TOKEN ??
    stringField(file, ['apiToken', 'api_token', 'token']) ??
    null;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

export class RestClientError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, opts: { status?: number | null; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'RestClientError';
    this.code = code;
    this.status = opts.status ?? null;
    this.details = opts.details;
  }
}

export interface RequestOptions {
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface RestResponse {
  status: number;
  envelope: Envelope<unknown> | null;
  text: string;
}

export interface SseEvent {
  id: string | null;
  event: string | null;
  data: string;
  parsed: unknown;
}

function buildUrl(baseUrl: string, requestPath: string, query?: Record<string, unknown>): string {
  const url = new URL(requestPath.startsWith('http') ? requestPath : `${baseUrl}${requestPath.startsWith('/') ? '' : '/'}${requestPath}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) {
        if (value.length === 0) continue;
        url.searchParams.set(key, value.map(String).join(','));
      } else if (typeof value === 'boolean') {
        url.searchParams.set(key, value ? 'true' : 'false');
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

function isEnvelope(value: unknown): value is Envelope<unknown> {
  return !!value && typeof value === 'object' && 'ok' in (value as Record<string, unknown>);
}

export class RestClient {
  readonly baseUrl: string;
  readonly token: string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: Partial<RestClientConfig> & ResolveOptions & { fetchImpl?: typeof fetch } = {}) {
    const resolved = resolveRestClientConfig(opts);
    this.baseUrl = opts.baseUrl ?? resolved.baseUrl;
    this.token = opts.token !== undefined ? opts.token : resolved.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', ...(extra ?? {}) };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    return headers;
  }

  async request(method: string, requestPath: string, opts: RequestOptions = {}): Promise<RestResponse> {
    const url = buildUrl(this.baseUrl, requestPath, opts.query);
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const init: RequestInit = {
        method,
        headers: this.headers({
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.headers ?? {}),
        }),
        signal: controller.signal,
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const resp = await this.fetchImpl(url, init);
      const text = await resp.text();
      let envelope: Envelope<unknown> | null = null;
      try {
        const parsed = JSON.parse(text) as unknown;
        envelope = isEnvelope(parsed) ? parsed : null;
      } catch {
        envelope = null;
      }
      return { status: resp.status, envelope, text };
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        throw new RestClientError('SERVICE_UNAVAILABLE', `request timed out after ${timeoutMs}ms: ${method} ${requestPath}`);
      }
      throw new RestClientError(
        'SERVICE_UNAVAILABLE',
        `cannot reach LeadPlatform at ${this.baseUrl}: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 请求并返回 data；失败抛 RestClientError（带 REST 错误码） */
  async requestData<T = unknown>(method: string, requestPath: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.request(method, requestPath, opts);
    if (res.envelope) {
      if (res.envelope.ok) return res.envelope.data as T;
      const err = res.envelope.error;
      throw new RestClientError(err.code, err.message, { status: res.status, details: err.details });
    }
    throw new RestClientError(
      'INTERNAL_ERROR',
      `unexpected non-envelope response (HTTP ${res.status}): ${res.text.slice(0, 300)}`,
      { status: res.status },
    );
  }

  /** 订阅 SSE（text/event-stream），逐个 yield 解析后的事件 */
  async *stream(
    requestPath: string,
    opts: RequestOptions = {},
  ): AsyncGenerator<SseEvent, void, undefined> {
    const url = buildUrl(this.baseUrl, requestPath, opts.query);
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    opts.signal?.addEventListener('abort', onAbort);
    try {
      const resp = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers({ accept: 'text/event-stream', ...(opts.headers ?? {}) }),
        signal: controller.signal,
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text().catch(() => '');
        let code = 'INTERNAL_ERROR';
        let message = `SSE HTTP ${resp.status}: ${text.slice(0, 300)}`;
        try {
          const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
          if (parsed.error?.code) code = parsed.error.code;
          if (parsed.error?.message) message = parsed.error.message;
        } catch {
          /* ignore */
        }
        throw new RestClientError(code, message, { status: resp.status });
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          idx = buffer.indexOf('\n\n');
        }
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }
}

export function parseSseFrame(frame: string): SseEvent | null {
  const lines = frame.split('\n');
  let id: string | null = null;
  let event: string | null = null;
  const dataLines: string[] = [];
  let sawAny = false;
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    sawAny = true;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (!sawAny || dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  let parsed: unknown = data;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    /* keep string */
  }
  return { id, event, data, parsed };
}

export function createRestClient(opts: ResolveOptions & { fetchImpl?: typeof fetch } = {}): RestClient {
  return new RestClient(opts);
}
