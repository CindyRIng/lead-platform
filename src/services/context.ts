/** 服务层进程级依赖上下文（module-level 便捷函数使用；测试可 reset 后注入 fake）。 */
import type { PipelineRepos } from '../pipeline/ports.js';
import type { RegionRegistry } from '../region/registry.js';
import type { SourceAdapterRegistry } from '../adapters/sources/types.js';

export interface ServiceLogger {
  info?: (msg: string, meta?: Record<string, unknown>) => void;
  warn?: (msg: string, meta?: Record<string, unknown>) => void;
  error?: (msg: string, meta?: Record<string, unknown>) => void;
  debug?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface ServiceContext {
  repos: PipelineRepos;
  registry: RegionRegistry;
  adapters?: Partial<SourceAdapterRegistry>;
  logger?: ServiceLogger | null;
  /** 时钟注入（测试） */
  now?: () => Date;
  /** 单轮最长时长（小时），默认 6 */
  runMaxHours?: number;
}

let current: ServiceContext | null = null;

export function initServiceContext(ctx: ServiceContext): ServiceContext {
  current = ctx;
  return ctx;
}

export function getServiceContext(): ServiceContext {
  if (!current) {
    throw new Error('ServiceContext 未初始化：请在启动时调用 initPipelineRuntime()/initServiceContext()');
  }
  return current;
}

export function tryGetServiceContext(): ServiceContext | null {
  return current;
}

export function resetServiceContext(): void {
  current = null;
}

export function ctxNow(ctx?: ServiceContext): string {
  return (ctx?.now?.() ?? new Date()).toISOString();
}
