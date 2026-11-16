/**
 * 路由注册入口（D1，api-dev 维护）。
 *
 * 由 src/http/server.ts 在 health/status 之后调用：
 *   await registerRoutes(app);
 *
 * 组成：
 *  1) docs 路由（免鉴权、非 envelope）：/docs、/openapi.json、/mcp-tools.json；
 *  2) /v1/** 业务路由：遍历 API_ROUTES（单一契约源），统一 envelope + zod 校验 + 错误码 + 分页；
 *  3) 兜底 Bearer 鉴权（foundation 的全局 auth 插件为主；单测/独立挂载时也能验证 401）；
 *  4) SSE：优先使用 events 模块的实时 hub（Last-Event-ID 补发），不可用时退回轮询式 handler。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_ROUTES } from './manifest.js';
import { ROUTE_HANDLERS } from './handlers/index.js';
import { buildRouteHandler, fallbackAuthHook } from './helpers.js';
import { getRouteServices, setRouteServices, type RouteServices } from './services.js';
import { registerDocsRoutes } from './docs.js';

export interface RegisterRoutesOptions {
  /** 覆盖服务容器（测试注入）；默认使用动态桥接 */
  services?: RouteServices | null;
  /** 是否注册兜底鉴权，默认 true（与 foundation 全局鉴权重复无害） */
  fallbackAuth?: boolean;
}

interface SseRegistrar {
  registerEventStreamRoute?: (
    app: { get: (path: string, handler: unknown) => unknown },
    opts?: { heartbeatMs?: number; replayLimit?: number },
  ) => Promise<void>;
}

/** 尝试用 events/sse.ts 的实时 hub 注册 /v1/events/stream；失败返回 false（走轮询兜底） */
async function tryRegisterSseHub(scope: FastifyInstance): Promise<boolean> {
  try {
    const spec = '../../events/sse.js';
    const mod = (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as unknown as SseRegistrar;
    if (typeof mod.registerEventStreamRoute !== 'function') return false;
    await mod.registerEventStreamRoute(scope as unknown as { get: (path: string, handler: unknown) => unknown });
    return true;
  } catch {
    return false;
  }
}

export async function registerRoutes(app: FastifyInstance, opts: RegisterRoutesOptions = {}): Promise<void> {
  if (opts.services !== undefined) {
    setRouteServices(opts.services ?? null);
  }

  // 公开契约/文档路由（非 envelope；server 的 PUBLIC_PATHS 已放行）
  registerDocsRoutes(app);

  await app.register(async (scope) => {
    if (opts.fallbackAuth !== false) scope.addHook('preHandler', fallbackAuthHook);
    scope.addHook('onRequest', async (req: FastifyRequest) => {
      (req as unknown as { routeServices: unknown }).routeServices = getRouteServices();
    });

    let sseRegistered = false;
    for (const def of API_ROUTES) {
      if (def.stream) {
        sseRegistered = await tryRegisterSseHub(scope);
        if (sseRegistered) continue;
      }
      scope.route({
        method: def.method,
        url: def.path,
        handler: buildRouteHandler(def, ROUTE_HANDLERS),
      });
    }
  });
}

export { API_ROUTES, ALL_ROUTES } from './manifest.js';
export type { ApiRoute as ApiRouteDef } from './manifest.js';
export { getRouteServices, setRouteServices } from './services.js';
