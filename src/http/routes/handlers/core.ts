/** 路由 handlers：Goals / Runs / Changes / SSE。 */
import { LeadError } from '../../../shared/errors.js';
import type { HandlerContext, RouteHandler, RouteResult } from '../helpers.js';
import { getRequestId, offsetPaged, paged } from '../helpers.js';
import { csvList } from '../helpers.js';
import { getPipelineRuntime, triggerGoalRun } from '../../../pipeline/runtimeRegistry.js';

type GoalListQuery = { enabled?: string; limit: number; offset: number };
type GoalRunsQuery = { limit: number; offset: number };
type RunListQuery = { goalId?: string; status?: string; limit: number; offset: number };
type ChangesQuery = { sinceSeq: number; types?: string[]; companyId?: string; limit: number; cursor?: string };
type StreamQuery = { types?: string[]; sinceSeq?: number; companyId?: string };

function pickId(ctx: HandlerContext): string {
  return String(ctx.params.id ?? '');
}

export const goalHandlers: Record<string, RouteHandler> = {
  'goals.create': async (ctx) => {
    const goal = await ctx.services.goals.create(ctx.body);
    return { data: goal, status: 201 };
  },

  'goals.list': async (ctx) => {
    const q = ctx.query as unknown as GoalListQuery;
    const enabled = q.enabled === undefined ? undefined : ['true', '1'].includes(String(q.enabled));
    const result = await ctx.services.goals.list({ enabled, limit: q.limit, offset: q.offset });
    return offsetPaged(result);
  },

  'goals.get': async (ctx) => {
    const id = pickId(ctx);
    const goal = await ctx.services.goals.get(id);
    if (!goal) throw new LeadError('NOT_FOUND', `goal not found: ${id}`);
    return { data: goal };
  },

  'goals.update': async (ctx) => {
    const id = pickId(ctx);
    const goal = await ctx.services.goals.update(id, ctx.body);
    return { data: goal };
  },

  'goals.archive': async (ctx) => {
    const id = pickId(ctx);
    await ctx.services.goals.archive(id);
    return { data: { id, archived: true } };
  },

  'goals.run': async (ctx) => {
    const id = pickId(ctx);
    // 生产路径：通过 PipelineRuntime.scheduler 真正创建 Run 并启动 orchestrator
    if (getPipelineRuntime()) {
      const run = await triggerGoalRun(id, 'manual', 'api');
      return { data: run, status: 202 };
    }
    // 单测/无 runtime 环境：退化为创建 pending Run（不启动后台执行）
    const run = await ctx.services.runs.create(id, 'manual', 'api');
    return { data: run, status: 202 };
  },

  'goals.runs': async (ctx) => {
    const id = pickId(ctx);
    const q = ctx.query as unknown as GoalRunsQuery;
    const result = await ctx.services.runs.list({ goalId: id, limit: q.limit, offset: q.offset });
    return offsetPaged(result);
  },
};

export const runHandlers: Record<string, RouteHandler> = {
  'runs.list': async (ctx) => {
    const q = ctx.query as unknown as RunListQuery;
    const result = await ctx.services.runs.list({
      goalId: q.goalId,
      status: q.status,
      limit: q.limit,
      offset: q.offset,
    });
    return offsetPaged(result);
  },

  'runs.get': async (ctx) => {
    const id = pickId(ctx);
    const run = await ctx.services.runs.get(id);
    if (!run) throw new LeadError('NOT_FOUND', `run not found: ${id}`);
    return { data: run };
  },

  'runs.cancel': async (ctx) => {
    const id = pickId(ctx);
    const run = await ctx.services.runs.cancel(id);
    return { data: run, status: 202 };
  },
};

function normalizeChangesResult(result: unknown): RouteResult {
  if (Array.isArray(result)) {
    const items = result as Array<{ seq?: number }>;
    const lastSeq = items.length ? Number(items[items.length - 1]?.seq ?? 0) : 0;
    return { data: { items, nextSeq: lastSeq, hasMore: false } };
  }
  const rec = (result ?? {}) as Record<string, unknown>;
  const items = Array.isArray(rec.items) ? rec.items : [];
  const lastSeq = items.length ? Number((items[items.length - 1] as { seq?: number })?.seq ?? 0) : 0;
  const nextSeq = typeof rec.nextSeq === 'number' ? rec.nextSeq : lastSeq;
  const hasMore = typeof rec.hasMore === 'boolean' ? rec.hasMore : false;
  const nextCursor = (rec.nextCursor as string | null | undefined) ?? null;
  return { data: { items, nextSeq, hasMore }, meta: { nextCursor } };
}

export const changeHandlers: Record<string, RouteHandler> = {
  'changes.list': async (ctx) => {
    const q = ctx.query as unknown as ChangesQuery;
    const result = await ctx.services.events.listChanges({
      sinceSeq: q.sinceSeq,
      types: q.types,
      companyId: q.companyId,
      limit: q.limit,
      cursor: q.cursor,
    });
    return normalizeChangesResult(result);
  },

  'events.stream': async (ctx) => {
    const q = ctx.query as unknown as StreamQuery;
    const types = q.types ?? csvList(q.types);
    const companyId = q.companyId;
    let sinceSeq = Number(q.sinceSeq ?? 0) || 0;
    const lastEventIdHeader = ctx.req.headers['last-event-id'];
    const lastEventId = Number(Array.isArray(lastEventIdHeader) ? lastEventIdHeader[0] : lastEventIdHeader);
    if (Number.isFinite(lastEventId) && lastEventId > sinceSeq) sinceSeq = lastEventId;

    ctx.reply.hijack();
    const raw = ctx.reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    raw.write(`retry: 3000\n\n`);
    raw.write(`: connected requestId=${getRequestId(ctx.req)}\n\n`);

    let closed = false;
    let polling = false;
    const timers: NodeJS.Timeout[] = [];

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      for (const t of timers) clearInterval(t);
      try {
        raw.end();
      } catch {
        /* ignore */
      }
    };
    ctx.req.raw.on('close', cleanup);
    ctx.req.raw.on('error', cleanup);

    const poll = async (): Promise<void> => {
      if (closed || polling) return;
      polling = true;
      try {
        const result = await ctx.services.events.listChanges({
          sinceSeq,
          types,
          companyId,
          limit: 200,
        });
        const items = Array.isArray((result as { items?: unknown[] })?.items)
          ? ((result as { items: unknown[] }).items as Array<Record<string, unknown>>)
          : [];
        for (const ev of items) {
          if (closed) break;
          const seq = Number(ev.seq ?? 0);
          raw.write(`id: ${seq}\nevent: ${String(ev.type ?? 'message')}\ndata: ${JSON.stringify(ev)}\n\n`);
          if (Number.isFinite(seq) && seq > sinceSeq) sinceSeq = seq;
        }
      } catch (err) {
        if (!closed) {
          const e = err instanceof LeadError ? err : new LeadError('INTERNAL_ERROR', String((err as Error)?.message ?? err));
          raw.write(`event: error\ndata: ${JSON.stringify({ code: e.code, message: e.message })}\n\n`);
        }
      } finally {
        polling = false;
      }
    };

    void poll();
    timers.push(setInterval(() => void poll(), 1000));
    timers.push(setInterval(() => {
      if (!closed) raw.write(`: hb ${Date.now()}\n\n`);
    }, 15000));
    return;
  },
};
