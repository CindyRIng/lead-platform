/** webhook_subscriptions / webhook_deliveries（订阅 CRUD + 投递队列/重试/死信） */
import { randomSecret } from '../shared/crypto.js';
import { LeadError } from '../shared/errors.js';
import { newDeliveryId, newWebhookId } from '../shared/ids.js';
import { isoPlusSeconds, nowIso } from '../shared/time.js';
import { all, countRows, fromDbBoolRequired, fromJsonArray, one, run, toJson, type DbConnection } from './sql.js';
import type {
  DeliveryListOptions,
  MarkDeliveredInput,
  MarkDeliveryFailedInput,
  NewWebhookDelivery,
  NewWebhookSubscription,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookSubscription,
} from './types.js';

interface SubscriptionRow {
  id: string;
  url: string;
  secret: string;
  event_types: string;
  active: number;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface DeliveryRow {
  id: string;
  subscription_id: string;
  event_seq: number;
  event_type: string;
  status: string;
  attempts: number;
  next_retry_at: string | null;
  response_status: number | null;
  response_body_head: string | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

function mapSubscription(row: SubscriptionRow): WebhookSubscription {
  return {
    id: row.id,
    url: row.url,
    secret: row.secret,
    eventTypes: fromJsonArray<string>(row.event_types),
    active: fromDbBoolRequired(row.active),
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    eventSeq: Number(row.event_seq),
    eventType: row.event_type,
    status: row.status as WebhookDeliveryStatus,
    attempts: Number(row.attempts ?? 0),
    nextRetryAt: row.next_retry_at,
    responseStatus: row.response_status,
    responseBodyHead: row.response_body_head,
    lastError: row.last_error,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/** 失败重试退避：10s/1m/5m/30m/2h/6h（docs/02 §14.2，最多 maxAttempts 次） */
const DELIVERY_BACKOFF_SEC = [10, 60, 300, 1800, 7200, 21600];

export interface WebhooksRepositoryOptions {
  maxAttempts?: number;
}

export class WebhooksRepository {
  private readonly maxAttempts: number;

  constructor(
    private readonly db: DbConnection,
    opts: WebhooksRepositoryOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 8;
  }

  // -------------------------------------------------------------------------
  // subscriptions
  // -------------------------------------------------------------------------

  createSubscription(input: NewWebhookSubscription): WebhookSubscription {
    const id = input.id ?? newWebhookId();
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO webhook_subscriptions(
        id, url, secret, event_types, active, description, created_at, updated_at
      ) VALUES(?,?,?,?,?,?,?,?)`,
      [
        id,
        input.url,
        input.secret ?? randomSecret(32),
        toJson(input.eventTypes ?? []),
        (input.active ?? true) ? 1 : 0,
        input.description ?? null,
        input.createdAt ?? now,
        input.updatedAt ?? now,
      ],
    );
    return this.requireSubscription(id);
  }

  getSubscription(id: string): WebhookSubscription | null {
    const row = one<SubscriptionRow>(this.db, 'SELECT * FROM webhook_subscriptions WHERE id = ?', [id]);
    return row ? mapSubscription(row) : null;
  }

  listSubscriptions(opts: { activeOnly?: boolean } = {}): WebhookSubscription[] {
    const where = opts.activeOnly ? 'WHERE active = 1' : '';
    return all<SubscriptionRow>(
      this.db,
      `SELECT * FROM webhook_subscriptions ${where} ORDER BY created_at ASC`,
    ).map(mapSubscription);
  }

  listActiveSubscriptions(): WebhookSubscription[] {
    return this.listSubscriptions({ activeOnly: true });
  }

  updateSubscription(
    id: string,
    patch: {
      url?: string;
      secret?: string;
      eventTypes?: string[];
      active?: boolean;
      description?: string | null;
    },
  ): WebhookSubscription {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.url !== undefined) push('url', patch.url);
    if (patch.secret !== undefined) push('secret', patch.secret);
    if (patch.eventTypes !== undefined) push('event_types', toJson(patch.eventTypes));
    if (patch.active !== undefined) push('active', patch.active ? 1 : 0);
    if (patch.description !== undefined) push('description', patch.description);
    if (sets.length === 0) return this.requireSubscription(id);
    push('updated_at', nowIso());
    const result = run(this.db, `UPDATE webhook_subscriptions SET ${sets.join(', ')} WHERE id = ?`, [
      ...params,
      id,
    ]);
    if (result.changes === 0) throw new LeadError('NOT_FOUND', `webhook subscription not found: ${id}`);
    return this.requireSubscription(id);
  }

  setSubscriptionActive(id: string, active: boolean): WebhookSubscription {
    return this.updateSubscription(id, { active });
  }

  deleteSubscription(id: string): boolean {
    return this.db.transaction(() => {
      run(this.db, 'DELETE FROM webhook_deliveries WHERE subscription_id = ?', [id]);
      return run(this.db, 'DELETE FROM webhook_subscriptions WHERE id = ?', [id]).changes > 0;
    });
  }

  // -------------------------------------------------------------------------
  // deliveries
  // -------------------------------------------------------------------------

  createDelivery(input: NewWebhookDelivery): WebhookDelivery {
    const id = input.id ?? newDeliveryId();
    const now = nowIso();
    run(
      this.db,
      `INSERT INTO webhook_deliveries(
        id, subscription_id, event_seq, event_type, status, attempts, next_retry_at,
        response_status, response_body_head, last_error, created_at, delivered_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.subscriptionId,
        input.eventSeq,
        input.eventType,
        input.status ?? 'pending',
        input.attempts ?? 0,
        input.nextRetryAt ?? null,
        input.responseStatus ?? null,
        input.responseBodyHead ?? null,
        input.lastError ?? null,
        input.createdAt ?? now,
        input.deliveredAt ?? null,
      ],
    );
    const delivery = this.getDelivery(id);
    if (!delivery) throw new LeadError('INTERNAL_ERROR', 'webhook delivery insert failed');
    return delivery;
  }

  /** 批量创建投递（单事务；同一事件分发到多个订阅） */
  createDeliveries(inputs: NewWebhookDelivery[]): WebhookDelivery[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => inputs.map((input) => this.createDelivery(input)));
  }

  getDelivery(id: string): WebhookDelivery | null {
    const row = one<DeliveryRow>(this.db, 'SELECT * FROM webhook_deliveries WHERE id = ?', [id]);
    return row ? mapDelivery(row) : null;
  }

  listDeliveries(opts: DeliveryListOptions = {}): WebhookDelivery[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.subscriptionId) {
      where.push('subscription_id = ?');
      params.push(opts.subscriptionId);
    }
    if (opts.status !== undefined) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const offset = Math.max(0, opts.offset ?? 0);
    return all<DeliveryRow>(
      this.db,
      `SELECT * FROM webhook_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ).map(mapDelivery);
  }

  listDeliveriesBySubscription(subscriptionId: string, opts: DeliveryListOptions = {}): WebhookDelivery[] {
    return this.listDeliveries({ ...opts, subscriptionId });
  }

  /** 待投递：pending/failed 且 next_retry_at 到期（created_at ASC 保证 FIFO） */
  listDueDeliveries(opts: { now?: Date; limit?: number } = {}): WebhookDelivery[] {
    const now = (opts.now ?? new Date()).toISOString();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    return all<DeliveryRow>(
      this.db,
      `SELECT * FROM webhook_deliveries
       WHERE status IN ('pending','failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      [now, limit],
    ).map(mapDelivery);
  }

  countDeliveries(opts: Pick<DeliveryListOptions, 'subscriptionId' | 'status'> = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.subscriptionId) {
      where.push('subscription_id = ?');
      params.push(opts.subscriptionId);
    }
    if (opts.status !== undefined) {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM webhook_deliveries ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
  }

  countDeliveriesByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM webhook_deliveries GROUP BY status',
    )) {
      out[row.status] = Number(row.n);
    }
    return out;
  }

  markDelivered(id: string, input: MarkDeliveredInput = {}): WebhookDelivery | null {
    const result = run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'delivered', delivered_at = ?, response_status = ?,
         response_body_head = ?, last_error = NULL, next_retry_at = NULL
       WHERE id = ?`,
      [
        input.deliveredAt ?? nowIso(),
        input.responseStatus ?? null,
        input.responseBodyHead ?? null,
        id,
      ],
    );
    return result.changes > 0 ? this.getDelivery(id) : null;
  }

  /**
   * 标记一次投递失败：内部 attempts+1 并计算退避；
   * status 'dead' 或 nextRetryAt:null → 死信；否则 failed + next_retry_at。
   */
  markDeliveryFailed(id: string, input: MarkDeliveryFailedInput = {}): WebhookDelivery | null {
    return this.db.transaction(() => {
      const current = this.getDelivery(id);
      if (!current) return null;
      const attempts = current.attempts + 1;
      const now = new Date();
      const explicitNext = Object.prototype.hasOwnProperty.call(input, 'nextRetryAt');
      const dead =
        input.status === 'dead' ||
        (explicitNext && input.nextRetryAt === null) ||
        (input.retryable === false) ||
        attempts >= this.maxAttempts;
      const status: WebhookDeliveryStatus = dead ? 'dead' : 'failed';
      let nextRetryAt: string | null = null;
      if (!dead) {
        if (explicitNext && input.nextRetryAt) nextRetryAt = input.nextRetryAt;
        else {
          const idx = Math.min(Math.max(attempts - 1, 0), DELIVERY_BACKOFF_SEC.length - 1);
          nextRetryAt = isoPlusSeconds(DELIVERY_BACKOFF_SEC[idx] ?? 21600, now);
        }
      }
      run(
        this.db,
        `UPDATE webhook_deliveries SET status = ?, attempts = ?, next_retry_at = ?,
           response_status = ?, response_body_head = ?, last_error = ?
         WHERE id = ?`,
        [
          status,
          attempts,
          nextRetryAt,
          input.responseStatus ?? current.responseStatus,
          input.responseBodyHead ?? current.responseBodyHead,
          input.error ?? current.lastError,
          id,
        ],
      );
      return this.getDelivery(id);
    });
  }

  /** 重放：复位为 pending、attempts=0、清退避（死信处理/手动重放） */
  replayDelivery(id: string): WebhookDelivery | null {
    const result = run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_retry_at = NULL,
         last_error = NULL, response_status = NULL, response_body_head = NULL, delivered_at = NULL
       WHERE id = ?`,
      [id],
    );
    return result.changes > 0 ? this.getDelivery(id) : null;
  }

  /** 把某订阅下 failed/pending 全部置死信（禁用订阅时用） */
  killDeliveriesForSubscription(subscriptionId: string): number {
    return run(
      this.db,
      `UPDATE webhook_deliveries SET status = 'dead', next_retry_at = NULL
       WHERE subscription_id = ? AND status IN ('pending','failed')`,
      [subscriptionId],
    ).changes;
  }

  private requireSubscription(id: string): WebhookSubscription {
    const subscription = this.getSubscription(id);
    if (!subscription) throw new LeadError('NOT_FOUND', `webhook subscription not found: ${id}`);
    return subscription;
  }
}
