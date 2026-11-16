/**
 * 轮询等待 helper（worker 异步推进、Run 完成、事件投递等场景）。
 */
import { sleep } from './tmp.js';

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** 失败/超时的描述（用于报错信息） */
  label?: string;
}

export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitTimeoutError';
  }
}

/** 轮询直到 fn 返回真值；返回该真值。超时抛 WaitTimeoutError。 */
export async function waitFor<T>(fn: () => T | Promise<T>, opts: WaitOptions = {}): Promise<NonNullable<T> | T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 50;
  const label = opts.label ?? 'condition';
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) {
      const suffix = lastError ? `（最后一次错误: ${lastError instanceof Error ? lastError.message : String(lastError)}）` : '';
      throw new WaitTimeoutError(`等待超时 ${timeoutMs}ms: ${label}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

/** 轮询直到 fn 不再抛错（用于等待资源就绪） */
export async function waitUntilNoThrow(fn: () => Promise<unknown>, opts: WaitOptions = {}): Promise<void> {
  await waitFor(async () => {
    await fn();
    return true;
  }, opts);
}

/** 健康检查等待（接受任意 2xx/3xx/4xx：4xx 说明服务已路由但鉴权生效） */
export async function waitForHttp(url: string, opts: WaitOptions = {}): Promise<Response> {
  return waitFor(
    async () => {
      const res = await fetch(url, { method: 'GET' });
      return res;
    },
    { timeoutMs: opts.timeoutMs ?? 15_000, intervalMs: opts.intervalMs ?? 100, label: opts.label ?? `GET ${url}` },
  );
}

/** 断言某个条件在窗口内始终成立（用于限流/不重复调用断言） */
export async function assertStays<T>(fn: () => T | Promise<T>, predicate: (value: T) => boolean, opts: WaitOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 600;
  const intervalMs = opts.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (!predicate(value)) {
      throw new Error(`${opts.label ?? 'condition'} 在观察窗口内不再成立: ${JSON.stringify(value)}`);
    }
    await sleep(intervalMs);
  }
}
