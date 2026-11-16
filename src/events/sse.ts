/**
 * SSE 事件流：进程内广播 hub + change_events 增量 tailer + Fastify 连接 handler。
 *
 * 契约（docs/02 §14.3、docs/03 §5）：
 * - `GET /v1/events/stream?types=a,b`：text/event-stream，事件 data 为 EventEnvelope JSON；
 * - 断线重连携带 `Last-Event-ID`（= seq），服务端从 DB 补发 seq 之后的事件；
 * - 实时事件由 EventStreamService 轮询 change_events 后广播（与 webhook 分发解耦）。
 *
 * 注意：路由挂载带 Bearer 鉴权（由 http 层负责），本模块只管流与广播。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { EventEnvelope } from '../shared/domain.js';
import { buildEventEnvelope, matchesEventTypes } from './envelope.js';
import type { EventsStore, SseBroadcastResult, SseSink, SseSubscriber } from './types.js';

/** SSE 文本帧：id 为全局 seq，event 为事件类型，data 为完整 envelope JSON */
export function formatSseEvent(envelope: EventEnvelope): string {
  return `id: ${envelope.seq}\nevent: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`;
}

export const SSE_HEARTBEAT_FRAME = ': ping\n\n';

/** 进程内 SSE 订阅者管理（多连接广播 + 类型过滤 + 断线清理） */
export class EventSseHub {
  private readonly clients = new Map<string, SseSubscriber>();
  private seq = 0;

  addClient(sink: SseSink, opts: { id?: string; types?: string[] } = {}): string {
    this.seq += 1;
    const id = opts.id ?? `sse_${Date.now()}_${this.seq}`;
    this.clients.set(id, { id, sink, types: normalizeSseTypes(opts.types) });
    return id;
  }

  removeClient(id: string): boolean {
    return this.clients.delete(id);
  }

  get size(): number {
    return this.clients.size;
  }

  /** 广播事件；返回实际写入的订阅者数（按 types 过滤） */
  broadcast(envelope: EventEnvelope): SseBroadcastResult {
    const frame = formatSseEvent(envelope);
    let sent = 0;
    for (const client of this.clients.values()) {
      if (!matchesSseFilter(client.types, envelope.type)) continue;
      try {
        client.sink.send(frame);
        sent += 1;
      } catch {
        // 连接已断：移除，避免影响其他订阅者
        this.clients.delete(client.id);
      }
    }
    return { sent, subscribers: this.clients.size };
  }

  /** 给单连接补发历史事件（Last-Event-ID 续传） */
  replay(clientId: string, envelopes: EventEnvelope[]): number {
    const client = this.clients.get(clientId);
    if (!client) return 0;
    let sent = 0;
    for (const envelope of envelopes) {
      if (!matchesSseFilter(client.types, envelope.type)) continue;
      try {
        client.sink.send(formatSseEvent(envelope));
        sent += 1;
      } catch {
        this.clients.delete(clientId);
        break;
      }
    }
    return sent;
  }

  ping(): void {
    for (const client of this.clients.values()) {
      try {
        client.sink.send(SSE_HEARTBEAT_FRAME);
      } catch {
        this.clients.delete(client.id);
      }
    }
  }

  closeAll(): void {
    for (const client of this.clients.values()) {
      try {
        client.sink.close();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

export function normalizeSseTypes(types: string[] | null | undefined): string[] {
  if (!types || types.length === 0) return [];
  return types.map((t) => t.trim()).filter(Boolean);
}

export function matchesSseFilter(types: string[], eventType: string): boolean {
  if (types.length === 0) return true;
  return types.includes('*') || types.includes(eventType);
}

export interface EventStreamServiceOptions {
  store: EventsStore;
  hub: EventSseHub;
  pollMs?: number;
  batchSize?: number;
  logger?: { info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void };
}

/**
 * change_events tailer → hub 广播。
 * 启动时从当前最大 seq 开始（只推实时事件；历史由 Last-Event-ID 按连接补发）。
 */
export class EventStreamService {
  private readonly store: EventsStore;
  private readonly hub: EventSseHub;
  private readonly pollMs: number;
  private readonly batchSize: number;
  private readonly logger: NonNullable<EventStreamServiceOptions['logger']>;
  private cursor = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(opts: EventStreamServiceOptions) {
    this.store = opts.store;
    this.hub = opts.hub;
    this.pollMs = opts.pollMs ?? 1000;
    this.batchSize = opts.batchSize ?? 500;
    this.logger = opts.logger ?? { info() {}, warn() {} };
  }

  get lastSeq(): number {
    return this.cursor;
  }

  /** 启动常驻 tail（幂等） */
  start(): void {
    if (this.timer) return;
    if (this.cursor === 0) this.cursor = this.store.changeEvents.maxSeq();
    const run = (): void => {
      void this.tick().catch((err: unknown) => this.logger.warn('sse tail tick failed', { err: String(err) }));
    };
    this.timer = setInterval(run, Math.max(200, this.pollMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.logger.info('sse stream service started', { pollMs: this.pollMs, cursor: this.cursor });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 广播一批增量事件；返回广播条数 */
  async tick(): Promise<number> {
    const records = this.store.changeEvents.listAfter(this.cursor, { limit: this.batchSize });
    let broadcast = 0;
    for (const record of records) {
      this.cursor = record.seq;
      const result = this.hub.broadcast(buildEventEnvelope(record));
      if (result.sent > 0) broadcast += result.sent;
    }
    return broadcast;
  }

  /** 手动发布一个事件（测试/进程内事件） */
  publish(record: Parameters<typeof buildEventEnvelope>[0]): SseBroadcastResult {
    this.cursor = Math.max(this.cursor, record.seq);
    return this.hub.broadcast(buildEventEnvelope(record));
  }
}

export interface EventStreamHandlerOptions {
  store: EventsStore;
  hub: EventSseHub;
  heartbeatMs?: number;
  /** 单连接补发上限（防 Last-Event-ID=0 时全量回放） */
  replayLimit?: number;
  logger?: { warn(msg: string, fields?: Record<string, unknown>): void };
}

/** 解析 `?types=company.created,contact.unlocked` */
export function parseTypesParam(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  return normalizeSseTypes(raw.split(','));
}

/**
 * Fastify-compatible SSE handler：`app.get('/v1/events/stream', createEventStreamHandler(...))`。
 * 会 hijack reply 直接写 raw socket（Fastify 流式响应标准做法）。
 */
export function createEventStreamHandler(
  opts: EventStreamHandlerOptions,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { store, hub } = opts;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const replayLimit = opts.replayLimit ?? 1000;
  const logger = opts.logger ?? { warn() {} };

  return async function eventStreamHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const types = parseTypesParam(query.types);
    const headerLastId = req.headers['last-event-id'];
    const queryLastId = query.lastEventId ?? query.lastEventID ?? query.sinceSeq;
    const rawLastId = Array.isArray(headerLastId) ? headerLastId[0] : headerLastId ?? String(queryLastId ?? '');
    const lastEventId = Number(rawLastId);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');

    const sink: SseSink = {
      send: (raw: string) => {
        if (!res.writableEnded) res.write(raw);
      },
      close: () => {
        if (!res.writableEnded) res.end();
      },
    };
    const clientId = hub.addClient(sink, { types });

    // Last-Event-ID 断点补发：只补 seq 之后的事件
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      try {
        const records = store.changeEvents.listAfter(Math.floor(lastEventId), {
          limit: replayLimit,
          types: types.length > 0 && !types.includes('*') ? types : undefined,
        });
        hub.replay(clientId, records.map(buildEventEnvelope));
      } catch (err) {
        logger.warn('sse replay failed', { err: String(err), lastEventId });
      }
    }

    const heartbeat = setInterval(() => {
      try {
        res.write(SSE_HEARTBEAT_FRAME);
      } catch {
        /* ignore */
      }
    }, Math.max(1000, heartbeatMs));
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    const cleanup = (): void => {
      clearInterval(heartbeat);
      hub.removeClient(clientId);
      sink.close();
    };
    req.raw.once('close', cleanup);
    req.raw.once('error', cleanup);
  };
}

export function createSseHub(): EventSseHub {
  return new EventSseHub();
}


// ---------------------------------------------------------------------------
// 默认 wiring（懒绑定全局 F2 repositories；main.ts 启动轮询 tail + 注册 SSE 路由）
// ---------------------------------------------------------------------------

let defaultHub: EventSseHub | null = null;
let defaultStreamService: EventStreamService | null = null;

export function getSseHub(): EventSseHub {
  defaultHub ??= new EventSseHub();
  return defaultHub;
}

export function setSseHub(hub: EventSseHub | null): void {
  defaultHub = hub;
}

/** 获取（并启动）全局 change_events tail 服务 */
export async function startDefaultEventStreamer(pollMs = 1000): Promise<EventStreamService> {
  if (!defaultStreamService) {
    const { getDefaultEventsStore } = await import('./f2Store.js');
    defaultStreamService = new EventStreamService({ store: getDefaultEventsStore(), hub: getSseHub(), pollMs });
  }
  defaultStreamService.start();
  return defaultStreamService;
}

export async function stopDefaultEventStreamer(): Promise<void> {
  defaultStreamService?.stop();
  defaultStreamService = null;
}

/** 便捷：注册 Fastify SSE 路由（由 http 层在鉴权作用域内调用） */
export async function registerEventStreamRoute(
  app: { get: (path: string, handler: (req: FastifyRequest, reply: FastifyReply) => Promise<void>) => unknown },
  opts: { heartbeatMs?: number; replayLimit?: number } = {},
): Promise<void> {
  const { getDefaultEventsStore } = await import('./f2Store.js');
  const handler = createEventStreamHandler({ store: getDefaultEventsStore(), hub: getSseHub(), ...opts });
  app.get('/v1/events/stream', handler);
}
