/**
 * EventsStore 的 F2 repositories 适配器（事件/Webhook 模块唯一的 DB 绑定层）。
 *
 * 所有读写通过 `Repositories`（`src/repositories/index.ts`）完成；
 * 本文件只做形状归一（如 JSON 字段解析差异、分页/游标）。
 */
import type { Repositories } from '../repositories/index.js';
import { getRepositories } from '../repositories/index.js';
import type {
  ChangeEventRecord as F2ChangeEventRecord,
  WebhookDelivery as F2Delivery,
  WebhookSubscription as F2Subscription,
} from '../repositories/types.js';
import type {
  ChangeEventRecord,
  EventsStore,
  WebhookDeliveryRecord,
  WebhookDeliveryStatus,
  WebhookSubscriptionRecord,
} from './types.js';

function toChangeEvent(record: F2ChangeEventRecord): ChangeEventRecord {
  return {
    seq: record.seq,
    companyId: record.companyId,
    entityType: record.entityType,
    entityId: record.entityId,
    version: record.version,
    eventType: record.eventType,
    field: record.field,
    oldValue: record.oldValue,
    newValue: record.newValue,
    valueType: record.valueType,
    source: record.source,
    runId: record.runId,
    actor: record.actor,
    occurredAt: record.occurredAt,
    createdAt: record.createdAt,
  };
}

function toSubscription(record: F2Subscription): WebhookSubscriptionRecord {
  return {
    id: record.id,
    url: record.url,
    secret: record.secret,
    eventTypes: record.eventTypes,
    active: record.active,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toDelivery(record: F2Delivery): WebhookDeliveryRecord {
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

export function createEventsStore(repos: Repositories): EventsStore {
  return {
    changeEvents: {
      listAfter: (sinceSeq, opts) =>
        repos.changeEvents
          .listSince(sinceSeq, { types: opts?.types, companyId: opts?.companyId, limit: opts?.limit })
          .map(toChangeEvent),
      listByCompany: (companyId, opts) =>
        repos.changeEvents
          .listByCompany(companyId, { limit: opts?.limit, afterSeq: opts?.sinceSeq })
          .map(toChangeEvent),
      getBySeq: (seq) => {
        const record = repos.changeEvents.getBySeq(seq);
        return record ? toChangeEvent(record) : null;
      },
      maxSeq: () => repos.changeEvents.maxSeq(),
    },
    subscriptions: {
      list: (opts) => repos.webhooks.listSubscriptions({ activeOnly: opts?.activeOnly }).map(toSubscription),
      get: (id) => {
        const record = repos.webhooks.getSubscription(id);
        return record ? toSubscription(record) : null;
      },
      create: (input) =>
        toSubscription(
          repos.webhooks.createSubscription({
            id: input.id,
            url: input.url,
            secret: input.secret,
            eventTypes: input.eventTypes,
            active: input.active,
            description: input.description,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
          }),
        ),
      update: (id, patch) => {
        const record = repos.webhooks.updateSubscription(id, {
          url: patch.url,
          secret: patch.secret,
          eventTypes: patch.eventTypes,
          active: patch.active,
          description: patch.description,
        });
        return record ? toSubscription(record) : null;
      },
      remove: (id) => repos.webhooks.deleteSubscription(id),
    },
    deliveries: {
      create: (input) =>
        toDelivery(
          repos.webhooks.createDelivery({
            id: input.id,
            subscriptionId: input.subscriptionId,
            eventSeq: input.eventSeq,
            eventType: input.eventType,
            status: input.status,
            attempts: input.attempts,
            nextRetryAt: input.nextRetryAt,
            createdAt: input.createdAt,
          }),
        ),
      get: (id) => {
        const record = repos.webhooks.getDelivery(id);
        return record ? toDelivery(record) : null;
      },
      listDue: (nowIso, limit) =>
        repos.webhooks.listDueDeliveries({ now: new Date(nowIso), limit }).map(toDelivery),
      listBySubscription: (subscriptionId, opts) => {
        const limit = opts?.limit ?? 100;
        const offset = opts?.offset ?? 0;
        const rows = repos.webhooks.listDeliveries({
          subscriptionId,
          status: opts?.status as WebhookDeliveryStatus | undefined,
          limit: limit + 1,
          offset,
        });
        const hasMore = rows.length > limit;
        return {
          items: rows.slice(0, limit).map(toDelivery),
          nextCursor: null,
          hasMore,
        };
      },
      markDelivered: (id, patch) => {
        repos.webhooks.markDelivered(id, {
          responseStatus: patch.responseStatus,
          responseBodyHead: patch.responseBodyHead,
          deliveredAt: patch.deliveredAt,
        });
      },
      markFailed: (id, patch) => {
        repos.webhooks.markDeliveryFailed(id, {
          error: patch.error,
          retryable: patch.retryable,
          nextRetryAt: patch.nextRetryAt,
          status: patch.status,
          responseStatus: patch.responseStatus,
          responseBodyHead: patch.responseBodyHead,
        });
      },
      replay: (id) => {
        repos.webhooks.replayDelivery(id);
      },
    },
    meta: {
      get: (key) => repos.meta.get(key),
      set: (key, value) => {
        repos.meta.set(key, value);
      },
    },
  };
}

let defaultStore: EventsStore | null = null;

/** 全局默认（main.ts initRepositories 后可用）；测试可 setDefaultEventsStore(fake) */
export function getDefaultEventsStore(): EventsStore {
  defaultStore ??= createEventsStore(getRepositories());
  return defaultStore;
}

export function setDefaultEventsStore(store: EventsStore | null): void {
  defaultStore = store;
}
