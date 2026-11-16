/** 管理/归档路由 handlers（D4）：backup / archive / manifests / verify / restore / db-stats。 */
import type { RouteHandler } from './helpers.js';

function itemsResult(result: unknown, extra?: Record<string, unknown>): unknown {
  if (Array.isArray(result)) return { items: result, total: result.length, ...extra };
  const rec = (result ?? {}) as Record<string, unknown>;
  if (Array.isArray(rec.items)) return { ...rec, ...extra };
  return { items: [], ...extra };
}

export const adminHandlers: Record<string, RouteHandler> = {
  'admin.backup': async (ctx) => {
    const result = await ctx.services.admin.backup();
    return { data: result };
  },

  'admin.archive': async (ctx) => {
    const body = (ctx.body ?? {}) as { afterDays?: number; dryRun?: boolean };
    const result = await ctx.services.admin.archive(body);
    return { data: result };
  },

  'admin.manifests': async (ctx) => {
    const result = await ctx.services.admin.listManifests();
    return { data: itemsResult(result) };
  },

  'admin.verify': async (ctx) => {
    const query = ctx.query as { month?: string };
    const result = await ctx.services.admin.verify({ month: query.month });
    return { data: result };
  },

  'admin.restore': async (ctx) => {
    const body = (ctx.body ?? {}) as { month?: string; dryRun?: boolean };
    const result = await ctx.services.admin.restore(body);
    return { data: result };
  },

  'admin.dbStats': async (ctx) => {
    const result = await ctx.services.admin.dbStats();
    return { data: result };
  },
};
