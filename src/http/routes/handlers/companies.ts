/** 路由 handlers：Companies / Platforms / Customs。 */
import { LeadError } from '../../../shared/errors.js';
import { PLATFORMS } from '../../../shared/constants.js';
import type { HandlerContext, RouteHandler } from '../helpers.js';
import { paged } from '../helpers.js';

function pickId(ctx: HandlerContext): string {
  return String(ctx.params.id ?? '');
}

function pickPlatform(ctx: HandlerContext): string {
  return String(ctx.params.platform ?? '');
}

/** 把「数组 / {items} / {items,total}」归一为列表 data */
function itemsResult(result: unknown, extra?: Record<string, unknown>): unknown {
  if (Array.isArray(result)) return { items: result, total: result.length, ...extra };
  const rec = (result ?? {}) as Record<string, unknown>;
  if (Array.isArray(rec.items)) return { ...rec, ...extra };
  return { items: [], ...extra };
}

/** 把手工干预动作结果归一为 {jobId, queued, ...} */
function acceptedResult(result: unknown, fallbackStatus = 'pending'): unknown {
  if (typeof result === 'string') return { jobId: result, queued: true, status: fallbackStatus };
  if (result && typeof result === 'object') {
    const rec = result as Record<string, unknown>;
    return { queued: true, status: fallbackStatus, ...rec };
  }
  return { queued: true, status: fallbackStatus };
}

function isPlatform(value: string): value is (typeof PLATFORMS)[number] {
  return (PLATFORMS as string[]).includes(value);
}

export const companyHandlers: Record<string, RouteHandler> = {
  'companies.list': async (ctx) => {
    const result = await ctx.services.companies.list(ctx.query);
    const normalized = paged(result);
    // 契约字段 platforms（来源平台列表）兼容服务层的 sourcePlatforms
    const data = normalized.data as { items?: unknown[] } | undefined;
    if (data && Array.isArray(data.items)) {
      data.items = data.items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const rec = item as Record<string, unknown>;
        if (rec.platforms === undefined && Array.isArray(rec.sourcePlatforms)) rec.platforms = rec.sourcePlatforms;
        return rec;
      });
    }
    return normalized;
  },

  'companies.get': async (ctx) => {
    const id = pickId(ctx);
    const include = (ctx.query.include as string[] | undefined) ?? undefined;
    const wanted = new Set((include ?? []).map((s) => String(s).toLowerCase()));
    const detail = await ctx.services.companies.get(id, { include });
    if (!detail) throw new LeadError('NOT_FOUND', `company not found: ${id}`);
    const includeDrafts = ['true', '1', 'yes'].includes(String(ctx.query.includeDrafts ?? '').toLowerCase());
    const verified = (detail as { company?: { verified?: boolean } }).company?.verified;
    if (verified === false && !includeDrafts) {
      throw new LeadError('NOT_FOUND', `company not verified by tanji: ${id}`, { details: { hint: '该记录仅为线索/草稿，请用 /v1/leads 查询；确需草稿详情加 includeDrafts=true' } });
    }
    const data: Record<string, unknown> =
      detail && typeof detail === 'object' ? { ...(detail as Record<string, unknown>) } : { company: detail };

    // include=platforms → 平台卡片摘要；include=all 等价全带（docs/03 §4）
    if (wanted.has('all') || wanted.has('platforms')) {
      try {
        const cards = await ctx.services.platforms.list(id);
        const list = Array.isArray(cards)
          ? cards
          : Array.isArray((cards as { items?: unknown[] })?.items)
            ? ((cards as { items: unknown[] }).items as unknown[])
            : [];
        if (list.length > 0 || wanted.has('all')) data.platforms = list;
      } catch (err) {
        if (err instanceof LeadError && err.code === 'NOT_FOUND') {
          data.platforms = [];
        } else {
          throw err;
        }
      }
    }
    if (wanted.has('all') || wanted.has('customs')) {
      const customs = await ctx.services.customs.get(id);
      data.customs = customs;
    }
    return { data };
  },

  'companies.sources': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.sources(id);
    return { data: itemsResult(result) };
  },

  'companies.snapshots': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.snapshots(id, ctx.query);
    return paged(result);
  },

  'companies.contacts': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.contacts(id, ctx.query);
    if (Array.isArray(result)) {
      const items = result as Array<{ unlockedAt?: string | null; masked?: boolean }>;
      const unlocked = items.filter((c) => c.masked === false || c.unlockedAt != null).length;
      return { data: { items, total: items.length, unlocked } };
    }
    const rec = (result ?? {}) as Record<string, unknown>;
    const items = Array.isArray(rec.items) ? (rec.items as Array<{ unlockedAt?: string | null; masked?: boolean }>) : [];
    const total = typeof rec.total === 'number' ? rec.total : items.length;
    const unlocked =
      typeof rec.unlocked === 'number'
        ? rec.unlocked
        : items.filter((c) => c.masked === false || c.unlockedAt != null).length;
    return { data: { ...rec, items, total, unlocked } };
  },

  'companies.changes': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.changes(id, ctx.query);
    return paged(result);
  },

  'companies.rematch': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.rematch(id, (ctx.body ?? {}) as Record<string, unknown>);
    return { data: acceptedResult(result), status: 202 };
  },

  'companies.unlock': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.companies.unlock(id, (ctx.body ?? {}) as Record<string, unknown>);
    return { data: acceptedResult(result), status: 202 };
  },
};

export const platformHandlers: Record<string, RouteHandler> = {
  'platforms.list': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.platforms.list(id);
    return { data: itemsResult(result) };
  },

  'platforms.get': async (ctx) => {
    const id = pickId(ctx);
    const platform = pickPlatform(ctx);
    const result = await ctx.services.platforms.get(id, platform);
    if (!result) {
      throw new LeadError('NOT_FOUND', `platform profile not found: ${id}/${platform}`);
    }
    return { data: result };
  },

  'platforms.jobs': async (ctx) => {
    const id = pickId(ctx);
    const platform = pickPlatform(ctx);
    if (!isPlatform(platform) || (platform !== 'boss' && platform !== 'zhilian')) {
      throw new LeadError('UNSUPPORTED', `jobs are only supported for boss/zhilian, got: ${platform}`, {
        details: { platform, supported: ['boss', 'zhilian'] },
      });
    }
    const result = await ctx.services.platforms.jobs(id, platform, ctx.query);
    return paged(result);
  },

  'platforms.changes': async (ctx) => {
    const id = pickId(ctx);
    const platform = pickPlatform(ctx);
    const result = await ctx.services.platforms.changes(id, platform, ctx.query);
    const normalized = paged(result);
    return normalized;
  },

  'platforms.refresh': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.platforms.refresh(id, (ctx.body ?? {}) as Record<string, unknown>);
    return { data: acceptedResult(result), status: 202 };
  },
};

export const customsHandlers: Record<string, RouteHandler> = {
  'customs.get': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.customs.get(id);
    if (!result) {
      throw new LeadError('NOT_FOUND', `customs profile not available for company: ${id}`, {
        details: { hint: '仅 Ali/Mic 公司有海关画像' },
      });
    }
    return { data: result };
  },

  'customs.refresh': async (ctx) => {
    const id = pickId(ctx);
    const result = await ctx.services.customs.refresh(id);
    return { data: acceptedResult(result), status: 202 };
  },
};
