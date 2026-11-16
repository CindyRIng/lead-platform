/**
 * HTTP / envelope 测试 helper。
 *
 * 断言统一 envelope（docs/03 §1.3）：`{ok,data,meta,error}`；
 * 失败响应必须 `ok=false` 且 `error.code` 为契约错误码。
 */
import type { Envelope, ErrEnvelope, OkEnvelope } from '../../src/shared/envelope.js';

export interface ApiResponse<T = unknown> {
  status: number;
  body: Envelope<T>;
  headers: Headers;
  rawText: string;
}

export interface RequestOptions {
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
}

export class ApiAssertionError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiAssertionError';
    this.status = status;
    this.body = body;
  }
}

function preview(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 800);
  } catch {
    return String(value);
  }
}

export class TestApiClient {
  readonly baseUrl: string;
  token: string | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  withToken(token: string | null): TestApiClient {
    return new TestApiClient(this.baseUrl, token);
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    const token = opts.token === undefined ? this.token : opts.token;
    if (token) headers.authorization = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    const methodUpper = method.toUpperCase();
    const hasBody = opts.body !== undefined;
    if (hasBody || (methodUpper !== 'GET' && methodUpper !== 'HEAD' && methodUpper !== 'DELETE')) {
      headers['content-type'] = 'application/json';
      // POST/PATCH 等写请求即使无 body 也发 `{}`，避免 Fastify 对空 JSON body 报 500
      init.body = JSON.stringify(hasBody ? opts.body : {});
    }
    const res = await fetch(`${this.baseUrl}${path}`, init);
    const rawText = await res.text();
    let body: Envelope<T>;
    try {
      body = JSON.parse(rawText) as Envelope<T>;
    } catch {
      throw new ApiAssertionError(`响应不是 JSON（${method} ${path}，HTTP ${res.status}）: ${rawText.slice(0, 500)}`, res.status, rawText);
    }
    return { status: res.status, body, headers: res.headers, rawText };
  }

  get<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, opts);
  }
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { ...opts, body });
  }
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, { ...opts, body });
  }
  delete<T = unknown>(path: string, opts?: RequestOptions): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, opts);
  }

  /** 断言 ok=true 并返回 data；失败时抛错（含 error/meta 便于定位） */
  async ok<T = unknown>(method: string, path: string, opts?: RequestOptions): Promise<T> {
    const res = await this.request<T>(method, path, opts);
    const env = res.body;
    if (!env || env.ok !== true) {
      throw new ApiAssertionError(
        `期望 ok=true（${method} ${path}），实际 HTTP ${res.status}: ${preview(env)}`,
        res.status,
        env,
      );
    }
    return (env as OkEnvelope<T>).data;
  }

  getOk<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.ok<T>('GET', path, opts);
  }
  postOk<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.ok<T>('POST', path, { ...opts, body });
  }
  patchOk<T = unknown>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
    return this.ok<T>('PATCH', path, { ...opts, body });
  }
  deleteOk<T = unknown>(path: string, opts?: RequestOptions): Promise<T> {
    return this.ok<T>('DELETE', path, opts);
  }

  /** 断言失败 envelope，返回 {status, code, message} */
  async err(
    method: string,
    path: string,
    opts?: RequestOptions,
  ): Promise<{ status: number; code: string; message: string; body: ErrEnvelope }> {
    const res = await this.request(method, path, opts);
    const env = res.body;
    if (!env || env.ok !== false) {
      throw new ApiAssertionError(
        `期望 ok=false（${method} ${path}），实际 HTTP ${res.status}: ${preview(env)}`,
        res.status,
        env,
      );
    }
    const err = (env as ErrEnvelope).error;
    return { status: res.status, code: err.code, message: err.message, body: env as ErrEnvelope };
  }
}

/** 检查 envelope 基础结构（供 AC 断言使用） */
export function assertEnvelopeShape(body: unknown): asserts body is Envelope<unknown> {
  if (!body || typeof body !== 'object') throw new Error('envelope 不是对象');
  const env = body as Record<string, unknown>;
  if (typeof env.ok !== 'boolean') throw new Error('envelope.ok 不是 boolean');
  const meta = env.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== 'object') throw new Error('envelope.meta 缺失');
  if (typeof meta.schemaVersion !== 'string') throw new Error('meta.schemaVersion 缺失');
  if (typeof meta.requestId !== 'string') throw new Error('meta.requestId 缺失');
  if (typeof meta.timestamp !== 'string') throw new Error('meta.timestamp 缺失');
  if (typeof meta.tookMs !== 'number') throw new Error('meta.tookMs 缺失');
}

/** 普通 fetch JSON（用于 webhook 接收端等非 LeadPlatform 接口） */
export async function fetchJson<T = unknown>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body: body as T };
}
