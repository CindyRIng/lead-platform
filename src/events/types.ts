/**
 * 事件模块的领域记录与存储端口（port）。
 *
 * 设计说明：本模块不直接依赖数据库实现，而是依赖下方窄接口 `EventsStore`。
 * 生产环境由 `src/events/f2Store.ts`（数据层 F2 repositories 的薄适配器）实现；
 * 单元测试使用内存 fake 或临时 DB 适配器，二者均满足同一接口。
 */
import type { EventEnvelope } from '../shared/domain.js';

/** change_events 表的一行（camelCase 领域视图） */
export interface ChangeEventRecord {
  seq: number;
  companyId: string;
  entityType: string;
  entityId: string | null;
  version: number;
  eventType: string;
  field: string | null;
  /** 已解析的 JS 值（F2 repositories 输出 json 字段已 parse；新增时 old 为 null） */
  oldValue: unknown;
  newValue: unknown;
  valueType: string | null;
  source: string;
  runId: string | null;
  actor: string | null;
  occurredAt: string;
  createdAt: string;
}

export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead';

export interface WebhookSubscriptionRecord {
  id: string;
  url: string;
  /** HMAC 密钥明文，仅存在于服务端；对外一律脱敏 */
  secret: string;
  eventTypes: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewWebhookSubscription {
  id: string;
  url: string;
  secret: string;
  eventTypes: string[];
  active?: boolean;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscriptionPatch {
  url?: string;
  secret?: string;
  eventTypes?: string[];
  active?: boolean;
  description?: string | null;
  updatedAt?: string;
}

export interface WebhookDeliveryRecord {
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

export interface NewWebhookDelivery {
  id: string;
  subscriptionId: string;
  eventSeq: number;
  eventType: string;
  status?: WebhookDeliveryStatus;
  attempts?: number;
  nextRetryAt?: string | null;
  createdAt: string;
}

export interface WebhookDeliveryPatch {
  status?: WebhookDeliveryStatus;
  /** 注意：attempts 为「已尝试次数」，由 dispatcher 传入绝对值 */
  attempts?: number;
  nextRetryAt?: string | null;
  responseStatus?: number | null;
  responseBodyHead?: string | null;
  lastError?: string | null;
  deliveredAt?: string | null;
}

export interface MarkDeliveredPatch {
  responseStatus?: number | null;
  responseBodyHead?: string | null;
  deliveredAt?: string;
}

export interface MarkDeliveryFailedPatch {
  error: string;
  retryable?: boolean;
  /** status='failed' 时的下次重试时间；status='dead' 忽略 */
  nextRetryAt?: string | null;
  status?: 'failed' | 'dead';
  responseStatus?: number | null;
  responseBodyHead?: string | null;
}

export interface PageResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * 事件模块所需的全部数据访问能力（由 F2 repositories 适配）。
 * 所有查询都返回领域记录（camelCase），不暴露 SQL 细节。
 */
export interface EventsStore {
  changeEvents: {
    /** seq 严格大于 sinceSeq，按 seq 升序；可选事件类型 / 公司过滤 */
    listAfter(sinceSeq: number, opts?: { limit?: number; types?: string[]; companyId?: string }): ChangeEventRecord[];
    /** 单公司变更历史（可按 version/seq 过滤），按 seq 升序 */
    listByCompany(companyId: string, opts?: { sinceVersion?: number; sinceSeq?: number; limit?: number }): ChangeEventRecord[];
    getBySeq(seq: number): ChangeEventRecord | null;
    /** 当前最大 seq；空表返回 0 */
    maxSeq(): number;
  };
  subscriptions: {
    list(opts?: { activeOnly?: boolean }): WebhookSubscriptionRecord[];
    get(id: string): WebhookSubscriptionRecord | null;
    create(input: NewWebhookSubscription): WebhookSubscriptionRecord;
    update(id: string, patch: WebhookSubscriptionPatch): WebhookSubscriptionRecord | null;
    remove(id: string): boolean;
  };
  deliveries: {
    create(input: NewWebhookDelivery): WebhookDeliveryRecord;
    get(id: string): WebhookDeliveryRecord | null;
    /**
     * 到期可投递记录：status IN ('pending','failed') 且 (next_retry_at IS NULL OR next_retry_at <= nowIso)，
     * 按 created_at/next_retry_at 升序。
     */
    listDue(nowIso: string, limit: number): WebhookDeliveryRecord[];
    listBySubscription(subscriptionId: string, opts?: { status?: WebhookDeliveryStatus; limit?: number; offset?: number }): PageResult<WebhookDeliveryRecord>;
    /** 投递成功：status=delivered、deliveredAt、响应摘要 */
    markDelivered(id: string, patch: MarkDeliveredPatch): void;
    /**
     * 投递失败：attempts + 1（由存储层自增），写入 lastError/响应摘要；
     * status='failed' 时按 nextRetryAt 重试，status='dead' 进入死信。
     */
    markFailed(id: string, patch: MarkDeliveryFailedPatch): void;
    /** 重放：状态重置为 pending、attempts=0、nextRetryAt=now（死信可重放） */
    replay(id: string, opts: { nowIso: string }): void;
  };
  meta: {
    get(key: string): string | null;
    set(key: string, value: string): void;
  };
}

/** Webhook 对外订阅视图（secret 脱敏） */
export interface PublicWebhookSubscription {
  id: string;
  url: string;
  secretMasked: string;
  eventTypes: string[];
  active: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SSE 事件流端口：HTTP 层（api-dev 的 /v1/events/stream 路由）实现 send/close，
 * hub 负责按订阅过滤与广播。
 */
export interface SseSink {
  send(rawEvent: string): void;
  close(): void;
}

export interface SseSubscriber {
  id: string;
  sink: SseSink;
  /** 空 = 全部类型；'*' 亦表示全部 */
  types: string[];
}

export interface SseBroadcastResult {
  /** 实际写入的订阅者数 */
  sent: number;
  /** 订阅者数 */
  subscribers: number;
}

/** 事件过滤选项（/v1/changes 与 SSE 共用） */
export interface EventFilter {
  sinceSeq?: number;
  types?: string[];
  companyId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ChangesPage {
  items: EventEnvelope[];
  nextSeq: number;
  nextCursor: string | null;
  hasMore: boolean;
}
