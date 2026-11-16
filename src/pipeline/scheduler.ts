/**
 * 进程内 Scheduler（FR-2，docs/02 §12.1）。
 *
 * - 按 Goal 的 cron（默认 `0 2 * * *` Asia/Shanghai）触发采集 Run；tick 默认 30s；
 * - 同一 Goal 不重叠：由 RunOrchestrator.startRun 抛 RUN_IN_PROGRESS（默认拒绝，不排队）；
 * - 支持时间窗（schedule.timeWindow，如 02:00-08:00；跨零点也支持）；
 * - 单轮最长 6h（orchestrator 内部 deadline）；
 * - 进程退出前优雅停止：停止发放新 Run、等待在飞 Run（≤30s）；
 * - 启动时恢复中断 Run（进程崩溃遗留 running/pending → partial）。
 */
import type { Goal, GoalRun } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { isWithinTimeWindow, nextCronTick, parseCron, type ParsedCron } from './cron.js';
import type { PipelineRepos } from './ports.js';
import type { RunExecutionResult } from './orchestrator.js';
import type { ServiceLogger } from '../services/context.js';

export interface SchedulerExecutor {
  startRun(goalId: string, trigger: 'cron' | 'manual', actor?: string): Promise<{ run: GoalRun; execution: Promise<RunExecutionResult> }>;
  executeRun(runId: string): Promise<RunExecutionResult>;
}

export interface SchedulerDeps {
  repos: PipelineRepos;
  executor: SchedulerExecutor;
  logger?: ServiceLogger | null;
  now?: () => Date;
  /** tick 间隔，默认 30000ms */
  tickMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** 单进程 leader 锁（可选；返回 false 则不触发 cron，避免多实例重复跑） */
  acquireLeader?: () => Promise<boolean> | boolean;
  /** 优雅停止等待在飞 Run 的上限（默认 30s，docs/02 §3） */
  gracefulStopMs?: number;
  /** 默认时区（Goal 未配置时） */
  defaultTimeZone?: string;
  enabled?: boolean;
}

export interface SchedulerNextRun {
  goalId: string;
  goalName: string;
  at: string;
}

export interface SchedulerStatus {
  enabled: boolean;
  started: boolean;
  nextRuns: SchedulerNextRun[];
  inFlight: string[];
  lastTickAt: string | null;
}

export class Scheduler {
  private readonly deps: SchedulerDeps;
  private readonly now: () => Date;
  private started = false;
  private stopped = false;
  private timer: unknown = null;
  private ticking = false;
  private lastTickAt: string | null = null;
  private readonly nextRunAtMs = new Map<string, number>();
  private readonly cronCache = new Map<string, ParsedCron>();
  private readonly inFlight = new Map<string, Promise<RunExecutionResult>>();

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isEnabled(): boolean {
    return this.deps.enabled !== false;
  }

  /** 启动调度（若 enabled=false 只记录状态不注册定时器） */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    if (!this.isEnabled) return;
    const tickMs = this.deps.tickMs ?? 30_000;
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = setTimer(() => {
      void this.tick();
    }, tickMs);
    const handle = this.timer as { unref?: () => void } | null;
    handle?.unref?.();
    this.log('info', 'scheduler.started', { tickMs });
    void this.tick();
  }

  /** 优雅停止：不再触发新 Run，等待在飞 Run（≤ gracefulStopMs） */
  async stop(): Promise<void> {
    this.stopped = true;
    this.started = false;
    if (this.timer !== null) {
      const clearTimer = this.deps.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
      clearTimer(this.timer);
      this.timer = null;
    }
    const gracefulStopMs = this.deps.gracefulStopMs ?? 30_000;
    if (this.inFlight.size > 0) {
      const all = Promise.allSettled([...this.inFlight.values()]);
      await Promise.race([all, new Promise((resolve) => setTimeout(resolve, gracefulStopMs))]);
    }
    this.log('info', 'scheduler.stopped', { inFlight: this.inFlight.size });
  }

  /** 单次调度检查：计算到期 Goal 并触发（手动调用便于测试） */
  async tick(): Promise<void> {
    if (!this.started || this.stopped) return;
    if (this.ticking) return;
    this.ticking = true;
    this.lastTickAt = nowIso();
    try {
      const leaderOk = (await this.deps.acquireLeader?.()) ?? true;
      if (!leaderOk) return;
      const now = this.now();
      let goals: Goal[] = [];
      try {
        const result = await this.deps.repos.goals.list({ enabled: true, limit: 200 });
        goals = Array.isArray(result) ? result : (result.items ?? []);
      } catch (err) {
        this.log('warn', 'scheduler.listGoals.failed', { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const activeGoalIds = new Set(goals.map((g) => g.id));
      for (const goalId of [...this.nextRunAtMs.keys()]) {
        if (!activeGoalIds.has(goalId)) this.nextRunAtMs.delete(goalId);
      }
      for (const goal of goals) {
        await this.maybeTriggerGoal(goal, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async maybeTriggerGoal(goal: Goal, now: Date): Promise<void> {
    const timeZone = goal.schedule.timeZone || this.deps.defaultTimeZone || 'Asia/Shanghai';
    let parsed: ParsedCron;
    try {
      parsed = this.cronCache.get(goal.schedule.cron) ?? parseCron(goal.schedule.cron);
      this.cronCache.set(goal.schedule.cron, parsed);
    } catch (err) {
      this.log('warn', 'scheduler.invalidCron', { goalId: goal.id, cron: goal.schedule.cron, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    let due = this.nextRunAtMs.get(goal.id);
    if (due === undefined) {
      // 首次：从现在计算下一次，避免服务重启后立即补跑历史 cron
      due = nextCronTick(parsed, now, timeZone).getTime();
      this.nextRunAtMs.set(goal.id, due);
      return;
    }
    if (now.getTime() < due) return;
    if (!isWithinTimeWindow(goal.schedule.timeWindow, now, timeZone)) {
      this.nextRunAtMs.set(goal.id, nextCronTick(parsed, now, timeZone).getTime());
      this.log('info', 'scheduler.skip.outsideWindow', { goalId: goal.id, timeWindow: goal.schedule.timeWindow });
      return;
    }
    this.nextRunAtMs.set(goal.id, nextCronTick(parsed, now, timeZone).getTime());
    try {
      const { run, execution } = await this.deps.executor.startRun(goal.id, 'cron');
      this.trackExecution(run.id, execution);
      this.log('info', 'scheduler.run.started', { goalId: goal.id, runId: run.id });
    } catch (err) {
      if (err instanceof LeadError && (err.code === 'RUN_IN_PROGRESS' || err.code === 'CONFLICT' || err.code === 'NOT_FOUND')) {
        this.log('warn', 'scheduler.run.rejected', { goalId: goal.id, code: err.code, message: err.message });
        return;
      }
      this.log('error', 'scheduler.run.failed', { goalId: goal.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /** 手动触发（POST /v1/goals/{id}/run）；返回 run 与后台执行 promise */
  async triggerGoal(goalId: string, trigger: 'cron' | 'manual' = 'manual', actor?: string): Promise<{ run: GoalRun; execution: Promise<RunExecutionResult> }> {
    const { run, execution } = await this.deps.executor.startRun(goalId, trigger, actor);
    const tracked = this.trackExecution(run.id, execution);
    return { run, execution: tracked };
  }

  private trackExecution(runId: string, execution: Promise<RunExecutionResult>): Promise<RunExecutionResult> {
    const tracked = execution.finally(() => {
      this.inFlight.delete(runId);
    });
    this.inFlight.set(runId, tracked);
    return tracked;
  }

  /** 恢复进程崩溃遗留的 pending/running Run → partial */
  async recoverInterruptedRuns(): Promise<number> {
    let interrupted: GoalRun[] = [];
    try {
      interrupted = (await this.deps.repos.runs.findInterrupted()) ?? [];
    } catch {
      return 0;
    }
    let count = 0;
    for (const run of interrupted) {
      try {
        const updated = await this.deps.repos.runs.updateStatus(run.id, 'partial', {
          finishedAt: nowIso(),
          errorCode: 'INTERRUPTED',
          errorMessage: '进程重启/崩溃导致 Run 中断（已入队任务继续由 worker 执行）',
          stats: run.stats ?? {},
        });
        if (updated) count += 1;
      } catch {
        // 单条恢复失败不影响其它
      }
    }
    if (count > 0) this.log('warn', 'scheduler.recoveredInterrupted', { count });
    return count;
  }

  status(): SchedulerStatus {
    const nextRuns: SchedulerNextRun[] = [];
    for (const [goalId, at] of this.nextRunAtMs.entries()) {
      nextRuns.push({ goalId, goalName: '', at: new Date(at).toISOString() });
    }
    nextRuns.sort((a, b) => a.at.localeCompare(b.at));
    return {
      enabled: this.isEnabled,
      started: this.started,
      nextRuns: nextRuns.slice(0, 20),
      inFlight: [...this.inFlight.keys()],
      lastTickAt: this.lastTickAt,
    };
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
    this.deps.logger?.[level]?.(msg, meta);
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  return new Scheduler(deps);
}
