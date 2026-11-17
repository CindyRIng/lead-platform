/** Fastify 服务构建（Lead 基线）：envelope / 鉴权 / 错误 / requestId / 路由注册 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { config } from '../config.js';
import { fail, ok } from '../shared/envelope.js';
import { LeadError, toLeadError } from '../shared/errors.js';
import { newRequestId } from '../shared/ids.js';
import { logger } from '../logger.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerStatusRoutes } from './routes/status.js';
import { registerLeadRoutes } from './routes/leads.js';
import { registerRoutes } from './routes/index.js';

const PUBLIC_PATHS = ['/v1/health', '/health', '/docs', '/openapi.json', '/mcp-tools.json', '/favicon.ico'];

export interface BuildServerOptions {
  register?: (app: FastifyInstance) => void | Promise<void>;
  logger?: boolean;
}

export function requestIdOf(req: FastifyRequest): string {
  const h = req.headers['x-request-id'];
  return typeof h === 'string' && h.length > 0 && h.length <= 128 ? h : newRequestId();
}

export function isPublicPath(url: string): boolean {
  const path = url.split('?')[0] ?? url;
  if (PUBLIC_PATHS.includes(path)) return true;
  // 文档/契约的带斜杠变体也视为公开（/docs/、/openapi.json/ 等）
  if (path.startsWith('/docs')) return true;
  return false;
}

export async function buildServer(opts: BuildServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' ? String(req.headers['x-request-id']) : newRequestId()),
    bodyLimit: 2 * 1024 * 1024,
    disableRequestLogging: true,
  });

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const requestId = requestIdOf(req);
    (req as unknown as { leadRequestId: string }).leadRequestId = requestId;
    reply.header('x-request-id', requestId);
    if (isPublicPath(req.url)) return;
    const auth = req.headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token || token !== config.apiToken) {
      await reply.status(401).send(fail(new LeadError('UNAUTHORIZED', 'missing or invalid bearer token'), requestId));
    }
  });

  app.setErrorHandler(async (err, req, reply) => {
    const requestId = (req as unknown as { leadRequestId?: string }).leadRequestId ?? requestIdOf(req);
    if (err instanceof ZodError) {
      const details = { issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
      await reply.status(400).send(fail(new LeadError('VALIDATION_ERROR', 'request validation failed', { details }), requestId));
      return;
    }
    const leadErr = toLeadError(err);
    if (leadErr.code === 'INTERNAL_ERROR') logger.error('unhandled request error', { requestId, err: leadErr.message, stack: leadErr.stack });
    await reply.status(leadErr.httpStatus).send(fail(leadErr, requestId));
  });

  app.setNotFoundHandler(async (req, reply) => {
    const requestId = (req as unknown as { leadRequestId?: string }).leadRequestId ?? requestIdOf(req);
    await reply.status(404).send(fail(new LeadError('NOT_FOUND', `route not found: ${req.method} ${req.url}`), requestId));
  });

  app.addHook('onResponse', async (req, reply) => {
    logger.info('http', { requestId: (req as unknown as { leadRequestId?: string }).leadRequestId, method: req.method, url: req.url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) });
  });

  app.get('/', async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/plain; charset=utf-8').send('LeadPlatform is running. See /v1/health, /docs, /openapi.json');
  });

  await app.register(async (scope) => {
    registerHealthRoutes(scope);
    registerStatusRoutes(scope);
  });

  // /v1/** 业务路由 + /docs /openapi.json /mcp-tools.json（api-dev 的 registerRoutes）
  await registerRoutes(app);
  await app.register(async (scope) => { registerLeadRoutes(scope); });

  if (opts.register) await opts.register(app);
  return app;
}

/** 给路由 handler 用的 envelope helpers（其他模块可复用） */
export function sendOk<T>(reply: FastifyReply, requestId: string, data: T, startedMs?: number, meta?: Record<string, unknown>) {
  return reply.send(ok(data, requestId, { startedMs, meta }));
}

export function sendCreated<T>(reply: FastifyReply, requestId: string, data: T, startedMs?: number) {
  return reply.status(201).send(ok(data, requestId, { startedMs }));
}
