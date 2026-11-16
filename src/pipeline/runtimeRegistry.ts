/** 进程级 PipelineRuntime 注册表（Lead 集成用；避免 handlers 直接 import main） */
import type { PipelineRuntime } from './wiring.js';
import type { GoalRun } from '../shared/domain.js';

let runtime: PipelineRuntime | null = null;

export function setPipelineRuntime(rt: PipelineRuntime | null): void {
  runtime = rt;
}

export function getPipelineRuntime(): PipelineRuntime | null {
  return runtime;
}

export async function triggerGoalRun(
  goalId: string,
  trigger: 'cron' | 'manual' = 'manual',
  actor?: string,
): Promise<GoalRun> {
  const rt = runtime;
  if (!rt) {
    const err = new Error('PipelineRuntime 未初始化');
    (err as unknown as { code?: string }).code = 'INTERNAL_ERROR';
    throw err;
  }
  const { run, execution } = await rt.scheduler.triggerGoal(goalId, trigger, actor);
  // 后台执行；错误写入日志，不阻塞返回 202
  void execution.catch((e) => {
    const logger = rt.ctx?.logger;
    const msg = e instanceof Error ? e.message : String(e);
    try { logger?.error?.('run.execution.failed', { goalId, runId: run.id, error: msg }); } catch { /* ignore */ }
  });
  return run;
}
