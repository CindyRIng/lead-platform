/** health 路由（免鉴权，毫秒级） */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ok } from '../../shared/envelope.js';
import { newRequestId } from '../../shared/ids.js';

const startedAt = Date.now();

export function registerHealthRoutes(app: FastifyInstance): void {
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req as unknown as { leadRequestId?: string }).leadRequestId ?? newRequestId();
    return reply.send(
      ok(
        {
          status: 'ok',
          service: 'lead-platform',
          version: process.env.npm_package_version ?? '0.1.0',
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          time: new Date().toISOString(),
        },
        id,
      ),
    );
  };
  app.get('/v1/health', handler);
  app.get('/health', handler);
}
