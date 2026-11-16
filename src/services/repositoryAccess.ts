/**
 * 服务层 repositories 访问入口。
 *
 * - main 启动时调用 `setDefaultRepositories(repos)`（或 F2 的 initRepositories）后，REST 路由可直接调用服务函数；
 * - 单测可注入 fake；未注入时 lazy 解析 F2 `getRepositories()` 全局单例（见 src/repositories/index.ts）。
 */
import type { Repositories } from '../repositories/index.js';
import { LeadError } from '../shared/errors.js';

let injected: Repositories | null = null;

/** 注入/覆盖全局 repositories（传 null 清除）。 */
export function setDefaultRepositories(repos: Repositories | null): void {
  injected = repos;
}

export function getInjectedRepositories(): Repositories | null {
  return injected;
}

const REPOSITORIES_MODULE = '../repositories/index.js';

interface RepositoriesModuleLike {
  getRepositories?: () => Repositories;
  tryGetRepositories?: () => Repositories | null;
}

/** 取 repositories：注入优先，否则 lazy import F2 单例；未初始化时抛 INTERNAL_ERROR。 */
export async function getDefaultRepositories(): Promise<Repositories> {
  if (injected) return injected;
  try {
    const mod = (await import(/* @vite-ignore */ REPOSITORIES_MODULE)) as RepositoriesModuleLike;
    if (typeof mod.getRepositories === 'function') return mod.getRepositories();
    if (typeof mod.tryGetRepositories === 'function') {
      const repos = mod.tryGetRepositories();
      if (repos) return repos;
    }
  } catch {
    // 模块尚未生成 / 未初始化：落到下面的统一错误
  }
  throw new LeadError('INTERNAL_ERROR', 'repositories 未初始化：请在 main 中 initRepositories()/setRepositories()');
}

// ---------------------------------------------------------------------------
// 游标（base64url JSON；与服务层分页约定一致）
// ---------------------------------------------------------------------------

export interface OffsetCursor {
  offset: number;
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset: Math.max(0, Math.trunc(offset)) }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as OffsetCursor;
    const offset = Number(parsed?.offset);
    return Number.isFinite(offset) && offset >= 0 ? Math.trunc(offset) : 0;
  } catch {
    return 0;
  }
}

export function clampLimit(limit: number | null | undefined, fallback = 50, max = 500): number {
  const n = Number(limit ?? fallback);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.trunc(n), max);
}
