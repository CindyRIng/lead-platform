/**
 * Webhook 订阅 / 投递查询服务（依赖 EventsStore 端口，不直接访问 DB）。
 *
 * 对外视图 secret 一律脱敏；创建订阅时额外返回一次明文 secret（文档随后可重新生成）。
 */
import { LeadError } from '../shared/errors.js';
import { randomSecret } from '../shared/crypto.js';
import { newWebhookId } from '../shared/ids.js';
import { nowIso } from '../shared/time.js';
import { EVENT_TYPES } from '../shared/constants.js';
import type {
  EventsStore,
  PageResult,
  PublicWebhookSubscription,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookSubscriptionRecord,
} from './types.js';

export const ALL_EVENT_TYPES = '*';

export interface DeliveryView {
  id: string;
  subscriptionId: string;
  eventSeq: number;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextRetryAt: string | null;
  responseStatus: number | null;
  responseBodyHead: string | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface SubscriptionView extends PublicWebhookSubscription {
  /** 仅 createSubscription 返回值中包含明文 secret；列表/更新返回 undefined */
  secret?: string;
}

export interface CreateSubscriptionInput {
  url: string;
  eventTypes: string[];
  secret?: string;
  description?: string | null;
  active?: boolean;
}

export interface UpdateSubscriptionInput {
  url?: string;
  eventTypes?: string[];
  description?: string | null;
  active?: boolean;
}

export interface SubscriptionServiceDeps {
  store: EventsStore;
  now?: () => Date;
  /** 测试注入确定性 secret 生成器；默认 32 字节随机 hex */
  secretFactory?: () => string;
}

/** secret 脱敏：仅保留末 4 位，如 `****a1b2` */
export function maskSecret(secret: string): string {
  if (!secret) return '****';
  const tail = secret.length <= 4 ? secret.slice(-2) : secret.slice(-4);
  return `****${tail}`;
}

export function toPublicSubscription(record: WebhookSubscriptionRecord): PublicWebhookSubscription {
  return {
    id: record.id,
    url: record.url,
    secretMasked: maskSecret(record.secret),
    eventTypes: record.eventTypes,
    active: record.active,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toDeliveryView(record: WebhookDeliveryRecord): DeliveryView {
  return {
    id: record.id,
    subscriptionId: record.subscriptionId,
    eventSeq: record.eventSeq,
    eventType: record.eventType,
    status: record.status,
    attempts: record.attempts,
    nextRetryAt: record.nextRetryAt,
    responseStatus: record.responseStatus,
    responseBodyHead: record.responseBodyHead,
    lastError: record.lastError,
    createdAt: record.createdAt,
    deliveredAt: record.deliveredAt,
  };
}

/** 校验 webhook URL：仅允许 http/https，禁止携带凭据 */
export function assertWebhookUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new LeadError('VALIDATION_ERROR', `无效的 webhook url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new LeadError('VALIDATION_ERROR', `webhook url 仅支持 http/https: ${url}`);
  }
  if (parsed.username || parsed.password) {
    throw new LeadError('VALIDATION_ERROR', 'webhook url 不得包含用户名/密码');
  }
}

/** 校验并规范化事件类型列表；`*` 表示全选 */
export function normalizeEventTypes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new LeadError('VALIDATION_ERROR', 'eventTypes 必须是非空数组');
  }
  const types = input.map((v) => String(v));
  if (types.includes(ALL_EVENT_TYPES)) return [ALL_EVENT_TYPES];
  const known = new Set<string>(EVENT_TYPES);
  const unknown = types.filter((t) => !known.has(t));
  if (unknown.length > 0) {
    throw new LeadError('VALIDATION_ERROR', `未知事件类型: ${unknown.join(',')}`, {
      details: { allowed: [...known], unknown },
    });
  }
  return [...new Set(types)];
}

/** 投递记录游标（offset 编码，与 `/v1/changes` 的 seq 游标不同） */
export function encodeDeliveryCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: Math.max(0, Math.floor(offset)) }), 'utf8').toString('base64url');
}

export function decodeDeliveryCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number };
    const offset = Number(parsed.o);
    return Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  } catch {
    throw new LeadError('VALIDATION_ERROR', '无效的 cursor');
  }
}

export class SubscriptionService {
  private readonly store: EventsStore;
  private readonly now: () => Date;
  private readonly secretFactory: () => string;

  constructor(deps: SubscriptionServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.secretFactory = deps.secretFactory ?? (() => randomSecret(32));
  }

  async create(input: CreateSubscriptionInput): Promise<SubscriptionView> {
    if (!input.url) throw new LeadError('VALIDATION_ERROR', 'url 不能为空');
    assertWebhookUrl(input.url);
    const eventTypes = normalizeEventTypes(input.eventTypes);
    const secret = input.secret && input.secret.trim().length > 0 ? input.secret.trim() : this.secretFactory();
    if (secret.length < 16) throw new LeadError('VALIDATION_ERROR', 'secret 长度至少 16 字符');
    const now = this.now().toISOString();
    const record = this.store.subscriptions.create({
      id: newWebhookId(),
      url: input.url,
      secret,
      eventTypes,
      active: input.active ?? true,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { ...toPublicSubscription(record), secret: record.secret };
  }

  async list(): Promise<PublicWebhookSubscription[]> {
    return this.store.subscriptions.list().map(toPublicSubscription);
  }

  async get(id: string): Promise<PublicWebhookSubscription> {
    return toPublicSubscription(this.mustGet(id));
  }

  async update(id: string, patch: UpdateSubscriptionInput): Promise<PublicWebhookSubscription> {
    this.mustGet(id);
    const next: Record<string, unknown> = { updatedAt: this.now().toISOString() };
    if (patch.url !== undefined) {
      assertWebhookUrl(patch.url);
      next.url = patch.url;
    }
    if (patch.eventTypes !== undefined) next.eventTypes = normalizeEventTypes(patch.eventTypes);
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.active !== undefined) next.active = patch.active === true;
    const updated = this.store.subscriptions.update(id, next as Parameters<EventsStore['subscriptions']['update']>[1]);
    if (!updated) throw new LeadError('NOT_FOUND', `webhook 订阅不存在: ${id}`);
    return toPublicSubscription(updated);
  }

  async remove(id: string): Promise<void> {
    this.mustGet(id);
    if (!this.store.subscriptions.remove(id)) throw new LeadError('NOT_FOUND', `webhook 订阅不存在: ${id}`);
  }

  /** 重新生成 secret；旧 secret 立即失效（返回一次明文） */
  async rotateSecret(id: string): Promise<SubscriptionView> {
    this.mustGet(id);
    const secret = this.secretFactory();
    const updated = this.store.subscriptions.update(id, { secret, updatedAt: this.now().toISOString() });
    if (!updated) throw new LeadError('NOT_FOUND', `webhook 订阅不存在: ${id}`);
    return { ...toPublicSubscription(updated), secret: updated.secret };
  }

  async listDeliveries(
    subscriptionId: string,
    query: { status?: WebhookDeliveryStatus; limit?: number; cursor?: string | null } = {},
  ): Promise<PageResult<DeliveryView>> {
    this.mustGet(subscriptionId);
    const limit = clampLimit(query.limit, 100, 500);
    const offset = decodeDeliveryCursor(query.cursor);
    const page = this.store.deliveries.listBySubscription(subscriptionId, {
      status: query.status,
      limit,
      offset,
    });
    return {
      items: page.items.map(toDeliveryView),
      nextCursor: page.nextCursor ?? (page.hasMore ? encodeDeliveryCursor(offset + limit) : null),
      hasMore: page.hasMore,
    };
  }

  async replayDelivery(subscriptionId: string, deliveryId: string): Promise<{ deliveryId: string; replayed: true }> {
    this.mustGet(subscriptionId);
    const delivery = this.store.deliveries.get(deliveryId);
    if (!delivery || delivery.subscriptionId !== subscriptionId) {
      throw new LeadError('NOT_FOUND', `投递记录不存在: ${deliveryId}`);
    }
    this.store.deliveries.replay(deliveryId, { nowIso: this.now().toISOString() });
    return { deliveryId, replayed: true };
  }

  private mustGet(id: string): WebhookSubscriptionRecord {
    const record = this.store.subscriptions.get(id);
    if (!record) throw new LeadError('NOT_FOUND', `webhook 订阅不存在: ${id}`);
    return record;
  }
}

export function clampLimit(value: number | undefined, def: number, max: number): number {
  if (value === undefined || value === null) return def;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}


// ---------------------------------------------------------------------------
// HTTP/CLI 便捷入口（懒绑定全局 F2 repositories；测试/其他模块可显式用 SubscriptionService）
// ---------------------------------------------------------------------------

let defaultService: SubscriptionService | null = null;

/** 默认服务（首次调用时通过 F2 全局 repositories 构建） */
export async function getSubscriptionService(): Promise<SubscriptionService> {
  if (!defaultService) {
    const { getDefaultEventsStore } = await import('./f2Store.js');
    defaultService = new SubscriptionService({ store: getDefaultEventsStore() });
  }
  return defaultService;
}

/** 测试/自定义 wiring 覆盖默认服务 */
export function setDefaultSubscriptionService(service: SubscriptionService | null): void {
  defaultService = service;
}

export async function createSubscription(input: CreateSubscriptionInput): Promise<SubscriptionView> {
  return (await getSubscriptionService()).create(input);
}

export async function listSubscriptions(): Promise<PublicWebhookSubscription[]> {
  return (await getSubscriptionService()).list();
}

export async function getSubscription(id: string): Promise<PublicWebhookSubscription> {
  return (await getSubscriptionService()).get(id);
}

export async function updateSubscription(id: string, patch: UpdateSubscriptionInput): Promise<PublicWebhookSubscription> {
  return (await getSubscriptionService()).update(id, patch);
}

export async function deleteSubscription(id: string): Promise<void> {
  return (await getSubscriptionService()).remove(id);
}

export async function listDeliveries(
  subscriptionId: string,
  query: { status?: WebhookDeliveryStatus; limit?: number; cursor?: string | null } = {},
): Promise<PageResult<DeliveryView>> {
  return (await getSubscriptionService()).listDeliveries(subscriptionId, query);
}

export async function replayDelivery(subscriptionId: string, deliveryId: string): Promise<{ deliveryId: string; replayed: true }> {
  return (await getSubscriptionService()).replayDelivery(subscriptionId, deliveryId);
}
