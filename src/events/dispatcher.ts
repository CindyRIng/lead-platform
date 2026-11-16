/**
 * Webhook 投递调度器（fanout + 投递 + 指数退避 + 死信 + 重放）。
 *
 * 职责：
 * 1. fanout：从 change_events 增量读取事件，按订阅 event_types 生成 webhook_deliveries；
 * 2. deliver：取到期投递，按 docs/02 §14.2 发送 HMAC-SHA256 签名请求；
 *    2xx → delivered；失败按 10s/1m/5m/30m/2h/6h/24h 退避，达 maxAttempts → dead；
 * 3. replay：死信/失败的投递重置后立即重投。
 *
 * 依赖 EventsStore 端口（F2 repositories 适配），不直接访问 DB；fetchImpl 可注入（测试 mock server）。
 * 设计为 at-least-once：进程崩溃可能重复投递，消费方按 eventId/seq 去重（docs/02 §14.2）。
 */
import { LeadError } from '../shared/errors.js';
import { newDeliveryId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import type { EventEnvelope } from '../shared/domain.js';
import { buildEventEnvelope, matchesEventTypes } from './envelope.js';
import {
  DEFAULT_WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_HEADER_DELIVERY,
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  nextRetryAtIso,
  signWebhookPayload,
  truncateResponseBody,
} from './signature.js';
import type { ChangeEventRecord, EventsStore, WebhookDeliveryRecord, WebhookSubscriptionRecord } from './types.js';

/** 分发游标（meta 表 key）：已处理到的 change_events.seq */
export const WEBHOOK_DISPATCH_CURSOR_KEY = 'webhook_dispatch_seq';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DispatcherLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface WebhookDispatcherDeps {
  store: EventsStore;
  fetchImpl?: FetchLike;
  now?: () => Date;
  maxAttempts?: number;
  /** 单次 deliver 最多处理多少条到期投递 */
  deliveryBatchSize?: number;
  /** 单次 fanout 最多扫描多少条变更事件 */
  fanoutBatchSize?: number;
  /** 单请求超时（ms） */
  requestTimeoutMs?: number;
  logger?: DispatcherLogger;
  /** 可选 URL 白名单校验（默认允许 http/https 任意主机；服务仅监听 127.0.0.1） */
  isUrlAllowed?: (url: string) => boolean;
}

export interface FanoutResult {
  scanned: number;
  created: number;
  cursor: number;
  subscriptions: number;
}

export interface DeliverTickResult {
  attempted: number;
  delivered: number;
  retried: number;
  dead: number;
  skipped: number;
}

export interface DispatchTickResult {
  fanout: FanoutResult;
  deliveries: DeliverTickResult;
}

const DELIVERY_STATUSES = new Set(['pending', 'delivered', 'failed', 'dead']);

/**
 * 订阅过滤：event_types 支持 `*`（全选）与精确类型。
 * 只投递给「订阅创建于事件发生之后」的订阅，避免新订阅被历史事件轰炸。
 */
export function shouldDeliverToSubscription(
  subscription: Pick<WebhookSubscriptionRecord, 'eventTypes' | 'createdAt' | 'active'>,
  event: Pick<ChangeEventRecord, 'eventType' | 'createdAt'>,
): boolean {
  if (!subscription.active) return false;
  if (!matchesEventTypes(subscription.eventTypes, event.eventType)) return false;
  const subAt = Date.parse(subscription.createdAt);
  const evAt = Date.parse(event.createdAt);
  if (Number.isFinite(subAt) && Number.isFinite(evAt) && evAt < subAt) return false;
  return true;
}

function deliveryHeaders(event: EventEnvelope, deliveryId: string, timestamp: number, signature: string): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'user-agent': 'lead-platform-webhook/0.1',
    [WEBHOOK_HEADER_EVENT]: event.type,
    [WEBHOOK_HEADER_DELIVERY]: deliveryId,
    [WEBHOOK_HEADER_TIMESTAMP]: String(timestamp),
    [WEBHOOK_HEADER_SIGNATURE]: signature,
  };
}

export class WebhookDispatcher {
  private readonly store: EventsStore;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly deliveryBatchSize: number;
  private readonly fanoutBatchSize: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: DispatcherLogger;
  private readonly isUrlAllowed: (url: string) => boolean;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: WebhookDispatcherDeps) {
    this.store = deps.store;
    this.fetchImpl = deps.fetchImpl ?? ((input, init) => fetch(input, init));
    this.now = deps.now ?? (() => new Date());
    this.maxAttempts = deps.maxAttempts ?? DEFAULT_WEBHOOK_MAX_ATTEMPTS;
    this.deliveryBatchSize = deps.deliveryBatchSize ?? 50;
    this.fanoutBatchSize = deps.fanoutBatchSize ?? 500;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? 10_000;
    this.logger = deps.logger ?? { info() {}, warn() {}, error() {} };
    this.isUrlAllowed = deps.isUrlAllowed ?? (() => true);
  }

  /** 1) 从 change_events 生成投递记录（按订阅类型过滤） */
  async fanoutOnce(): Promise<FanoutResult> {
    const subscriptions = this.store.subscriptions.list({ activeOnly: true });
    const rawCursor = this.store.meta.get(WEBHOOK_DISPATCH_CURSOR_KEY);
    const cursor = Number.isFinite(Number(rawCursor)) ? Math.max(0, Math.floor(Number(rawCursor))) : 0;

    if (subscriptions.length === 0) {
      // 无订阅时直接推进游标，避免后续新增订阅时回灌历史事件
      const max = this.store.changeEvents.maxSeq();
      if (max > cursor) this.store.meta.set(WEBHOOK_DISPATCH_CURSOR_KEY, String(max));
      return { scanned: 0, created: 0, cursor: Math.max(cursor, max), subscriptions: 0 };
    }

    const events = this.store.changeEvents.listAfter(cursor, { limit: this.fanoutBatchSize });
    let created = 0;
    let lastSeq = cursor;
    for (const event of events) {
      lastSeq = event.seq;
      for (const sub of subscriptions) {
        if (!shouldDeliverToSubscription(sub, event)) continue;
        this.store.deliveries.create({
          id: newDeliveryId(),
          subscriptionId: sub.id,
          eventSeq: event.seq,
          eventType: event.eventType,
          status: 'pending',
          attempts: 0,
          nextRetryAt: this.now().toISOString(),
          createdAt: this.now().toISOString(),
        });
        created += 1;
      }
    }
    if (events.length > 0) this.store.meta.set(WEBHOOK_DISPATCH_CURSOR_KEY, String(lastSeq));
    return { scanned: events.length, created, cursor: lastSeq, subscriptions: subscriptions.length };
  }

  /** 2) 处理到期投递（含退避重试与死信判定） */
  async deliverDueOnce(): Promise<DeliverTickResult> {
    const now = this.now();
    const due = this.store.deliveries.listDue(now.toISOString(), this.deliveryBatchSize);
    const result: DeliverTickResult = { attempted: 0, delivered: 0, retried: 0, dead: 0, skipped: 0 };
    for (const delivery of due) {
      const outcome = await this.deliverOne(delivery, now);
      result.attempted += 1;
      if (outcome === 'delivered') result.delivered += 1;
      else if (outcome === 'retried') result.retried += 1;
      else if (outcome === 'dead') result.dead += 1;
      else result.skipped += 1;
    }
    return result;
  }

  /** fanout + deliver（后台循环单次 tick） */
  async tick(): Promise<DispatchTickResult> {
    const fanout = await this.fanoutOnce();
    const deliveries = await this.deliverDueOnce();
    return { fanout, deliveries };
  }

  /** 后台常驻循环 */
  start(intervalMs = 1000): void {
    if (this.timer) return;
    const run = (): void => {
      void this.tick().catch((err: unknown) => this.logger.error('webhook dispatch tick failed', { err: String(err) }));
    };
    this.timer = setInterval(run, Math.max(200, intervalMs));
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 重放单条投递（死信/失败均可）：重置后立即投递一次 */
  async replayDelivery(deliveryId: string): Promise<WebhookDeliveryRecord> {
    const delivery = this.store.deliveries.get(deliveryId);
    if (!delivery) throw new LeadError('NOT_FOUND', `投递记录不存在: ${deliveryId}`);
    this.store.deliveries.replay(deliveryId, { nowIso: this.now().toISOString() });
    const reset = this.store.deliveries.get(deliveryId);
    if (!reset) throw new LeadError('NOT_FOUND', `投递记录不存在: ${deliveryId}`);
    await this.deliverOne(reset, this.now());
    return this.store.deliveries.get(deliveryId) ?? reset;
  }

  /**
   * 投递一条记录并落库状态。
   * @returns delivered / retried / dead / skipped
   */
  private async deliverOne(
    delivery: WebhookDeliveryRecord,
    now: Date,
  ): Promise<'delivered' | 'retried' | 'dead' | 'skipped'> {
    if (!DELIVERY_STATUSES.has(delivery.status)) {
      return 'skipped';
    }
    const subscription = this.store.subscriptions.get(delivery.subscriptionId);
    if (!subscription || !subscription.active) {
      this.markDead(delivery, 'subscription_inactive');
      return 'dead';
    }
    if (!this.isUrlAllowed(subscription.url)) {
      this.markDead(delivery, 'url_not_allowed');
      return 'dead';
    }
    const eventRecord = this.store.changeEvents.getBySeq(delivery.eventSeq);
    if (!eventRecord) {
      this.markDead(delivery, 'event_missing');
      return 'dead';
    }
    const envelope = buildEventEnvelope(eventRecord);
    const rawBody = JSON.stringify(envelope);
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = signWebhookPayload(subscription.secret, timestamp, rawBody);

    let response: Response;
    try {
      response = await this.fetchImpl(subscription.url, {
        method: 'POST',
        headers: deliveryHeaders(envelope, delivery.id, timestamp, signature),
        body: rawBody,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.markFailure(delivery, now, `network_error: ${message}`, null, null);
    }

    let bodyHead: string | null = null;
    try {
      const text = await response.text();
      bodyHead = text ? truncateResponseBody(text) : null;
    } catch {
      bodyHead = null;
    }

    if (response.status >= 200 && response.status < 300) {
      this.store.deliveries.markDelivered(delivery.id, {
        responseStatus: response.status,
        responseBodyHead: bodyHead,
        deliveredAt: now.toISOString(),
      });
      this.logger.info('webhook delivered', { deliveryId: delivery.id, subscriptionId: subscription.id, eventSeq: delivery.eventSeq, status: response.status });
      return 'delivered';
    }
    return this.markFailure(delivery, now, `http_error: ${response.status}`, response.status, bodyHead);
  }

  private markFailure(
    delivery: WebhookDeliveryRecord,
    now: Date,
    error: string,
    responseStatus: number | null,
    responseBodyHead: string | null,
  ): 'retried' | 'dead' {
    const attemptsFailed = delivery.attempts + 1;
    const nextRetryAt = nextRetryAtIso(attemptsFailed, this.maxAttempts, now.getTime());
    if (nextRetryAt === null) {
      this.markDead(delivery, error, responseStatus, responseBodyHead);
      return 'dead';
    }
    this.store.deliveries.markFailed(delivery.id, {
      error,
      retryable: true,
      nextRetryAt,
      status: 'failed',
      responseStatus,
      responseBodyHead,
    });
    this.logger.warn('webhook delivery failed, retry scheduled', {
      deliveryId: delivery.id,
      subscriptionId: delivery.subscriptionId,
      eventSeq: delivery.eventSeq,
      attempts: attemptsFailed,
      nextRetryAt,
      error,
    });
    return 'retried';
  }

  private markDead(
    delivery: WebhookDeliveryRecord,
    error: string,
    responseStatus: number | null = null,
    responseBodyHead: string | null = null,
  ): void {
    this.store.deliveries.markFailed(delivery.id, {
      error,
      retryable: false,
      nextRetryAt: null,
      status: 'dead',
      responseStatus,
      responseBodyHead,
    });
    this.logger.warn('webhook delivery dead', { deliveryId: delivery.id, subscriptionId: delivery.subscriptionId, eventSeq: delivery.eventSeq, error });
  }
}

/** 便捷函数：单次 fanout（供手动触发/测试） */
export async function fanoutOnce(dispatcher: WebhookDispatcher): Promise<FanoutResult> {
  return dispatcher.fanoutOnce();
}

/** 便捷函数：单次投递（供手动触发/测试） */
export async function deliverDueOnce(dispatcher: WebhookDispatcher): Promise<DeliverTickResult> {
  return dispatcher.deliverDueOnce();
}

/** 当前时间 ISO（便于测试断言） */
export function dispatcherNowIso(): string {
  return nowIso();
}

export type { EventEnvelope };


// ---------------------------------------------------------------------------
// 默认 wiring（懒绑定全局 F2 repositories；main.ts 可在启动后调用 startWebhookDispatcher）
// ---------------------------------------------------------------------------

let defaultDispatcher: WebhookDispatcher | null = null;

function envMaxAttempts(): number {
  const raw = process.env.LEAD_WEBHOOK_MAX_ATTEMPTS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_WEBHOOK_MAX_ATTEMPTS;
}

export async function getDefaultWebhookDispatcher(): Promise<WebhookDispatcher> {
  if (!defaultDispatcher) {
    const { getDefaultEventsStore } = await import('./f2Store.js');
    defaultDispatcher = new WebhookDispatcher({ store: getDefaultEventsStore(), maxAttempts: envMaxAttempts() });
  }
  return defaultDispatcher;
}

export function setDefaultWebhookDispatcher(dispatcher: WebhookDispatcher | null): void {
  defaultDispatcher = dispatcher;
}

/** 单次分发（手动触发/测试）：fanout + deliver */
export async function dispatchWebhooksOnce(): Promise<DispatchTickResult> {
  return (await getDefaultWebhookDispatcher()).tick();
}

/** 重放一条投递（/v1/webhooks/{id}/deliveries/{did}/replay 调用后由 dispatcher 立即投递） */
export async function replayWebhookDelivery(deliveryId: string): Promise<WebhookDeliveryRecord> {
  return (await getDefaultWebhookDispatcher()).replayDelivery(deliveryId);
}
