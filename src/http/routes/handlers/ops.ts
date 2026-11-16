/** 路由 handlers：Webhooks / Jobs / Runtime(sources,quota,stats) / Admin。 */
import { LeadError } from '../../../shared/errors.js';
import type { HandlerContext, RouteHandler } from '../helpers.js';
import { paged } from '../helpers.js';

function pickId(ctx: HandlerContext): string {
  return String(ctx.params.id ?? '');
}

function itemsResult(result: unknown, extra?: Record<string, unknown>): unknown {
  if (Array.isArray(result)) return { items: result, total: result.length, ...extra };
  const rec = (result ?? {}) as Record<string, unknown>;
  if (Array.isArray(rec.items)) return { ...rec, ...extra };
  return { items: [], ...extra };
}

export const webhookHandlers: Record<string, RouteHandler> = {
  'webhooks.create': async (ctx) => {
    const created = await ctx.services.webhooks.create((ctx.body ?? {}) as Record<string, unknown>);
    return { data: created, status: 201 };
  },

  'webhooks.list': async (ctx) => {
    const result = await ctx.services.webhooks.list();
    return { data: itemsResult(result) };
  },

  'webhooks.update': async (ctx) => {
    const id = pickId(ctx);
    const updated = await ctx.services.webhooks.update(id, (ctx.body ?? {}) as Record<string, unknown>);
    return { data: updated };
  },

  'webhooks.delete': async (ctx) => {
    const id = pickId(ctx);
    await ctx.services.webhooks.remove(id);
    return { data: { id, deleted: true } };
  },

  'webhooks.deliveries': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.webhooks.listDeliveries(id, ctx.query);
    return paged(result);
  },

  'webhooks.replay': async (ctx) => {
    const id = pickId(ctx);
    const deliveryId = String(ctx.params.deliveryId ?? '');
    const result = await ctx.services.webhooks.replayDelivery(id, deliveryId);
    if (result && typeof result === 'object') {
      return { data: { replayed: true, ...(result as Record<string, unknown>) }, status: 202 };
    }
    return { data: { deliveryId, replayed: true }, status: 202 };
  },
};

export const jobHandlers: Record<string, RouteHandler> = {
  'jobs.list': async (ctx) => {
    const result = await ctx.services.jobs.list(ctx.query);
    return paged(result);
  },

  'jobs.get': async (ctx) => {
    const id = pickId(ctx);
    const job = await ctx.services.jobs.get(id);
    if (!job) throw new LeadError('NOT_FOUND', `job not found: ${id}`);
    return { data: job };
  },

  'jobs.retry': async (ctx) => {
    const id = pickId(ctx);
    const job = await ctx.services.jobs.retry(id);
    return { data: job, status: 202 };
  },
};

export const runtimeHandlers: Record<string, RouteHandler> = {
  'sources.list': async (ctx) => {
    const result = await ctx.services.ops.listSources();
    return { data: itemsResult(result) };
  },

  'quota.get': async (ctx) => {
    const result = await ctx.services.ops.getQuota();
    return { data: result };
  },

  'stats.get': async (ctx) => {
    const result = await ctx.services.ops.getStats(ctx.query);
    return { data: result };
  },
};
