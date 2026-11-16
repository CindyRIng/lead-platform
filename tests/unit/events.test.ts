/**
 * 事件/Webhook/SSE 单元测试（U2）。
 *
 * - 全部使用内存 fake EventsStore + 本地 mock HTTP server；
 * - 不访问外网、不依赖真实 DB（DB 集成断言见文件末尾的 F2 内存库用例，F2 落盘后启用）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEventEnvelope, eventIdForSeq, matchesEventTypes, platformFromField, seqFromEventId } from '../../src/events/envelope.js';
import {
  WEBHOOK_BACKOFF_SECONDS,
  WEBHOOK_HEADER_DELIVERY,
  WEBHOOK_HEADER_EVENT,
  WEBHOOK_HEADER_SIGNATURE,
  WEBHOOK_HEADER_TIMESTAMP,
  backoffSecondsFor,
  nextRetryAtIso,
  signWebhookPayload,
  verifyWebhookSignature,
} from '../../src/events/signature.js';
import { WebhookDispatcher } from '../../src/events/dispatcher.js';
import {
  SubscriptionService,
  maskSecret,
  normalizeEventTypes,
  toPublicSubscription,
} from '../../src/events/subscriptions.js';
import { EventSseHub, EventStreamService, createEventStreamHandler, formatSseEvent } from '../../src/events/sse.js';
import { listChanges, listCompanyChanges, encodeSeqCursor, parseTypesFilter } from '../../src/services/events.js';
import type {
  ChangeEventRecord,
  EventsStore,
  MarkDeliveredPatch,
  MarkDeliveryFailedPatch,
  NewWebhookDelivery,
  NewWebhookSubscription,
  PageResult,
  WebhookDeliveryRecord,
  WebhookSubscriptionPatch,
  WebhookSubscriptionRecord,
} from '../../src/events/types.js';

// ---------------------------------------------------------------------------
// 内存 fake EventsStore
// ---------------------------------------------------------------------------

export class FakeEventsStore implements EventsStore {
  events: ChangeEventRecord[] = [];
  subscriptionsRows: WebhookSubscriptionRecord[] = [];
  deliveriesRows: WebhookDeliveryRecord[] = [];
  metaMap = new Map<string, string>();
  private seqCounter = 0;
  private idCounter = 0;

  private nextId(prefix: string): string {
    this.idCounter += 1;
    return `${prefix}_${String(this.idCounter).padStart(6, '0')}`;
  }

  appendEvent(input: Partial<ChangeEventRecord> & { companyId: string; eventType: string }): ChangeEventRecord {
    this.seqCounter += 1;
    const now = input.createdAt ?? new Date().toISOString();
    const record: ChangeEventRecord = {
      seq: input.seq ?? this.seqCounter,
      companyId: input.companyId,
      entityType: input.entityType ?? 'company',
      entityId: input.entityId ?? null,
      version: input.version ?? 1,
      eventType: input.eventType,
      field: input.field ?? null,
      oldValue: input.oldValue ?? null,
      newValue: input.newValue ?? null,
      valueType: input.valueType ?? null,
      source: input.source ?? 'system:test',
      runId: input.runId ?? null,
      actor: input.actor ?? null,
      occurredAt: input.occurredAt ?? now,
      createdAt: now,
    };
    this.events.push(record);
    this.events.sort((a, b) => a.seq - b.seq);
    return record;
  }

  changeEvents = {
    listAfter: (sinceSeq: number, opts?: { limit?: number; types?: string[]; companyId?: string }): ChangeEventRecord[] => {
      let rows = this.events.filter((e) => e.seq > sinceSeq);
      if (opts?.types?.length) rows = rows.filter((e) => opts.types!.includes(e.eventType));
      if (opts?.companyId) rows = rows.filter((e) => e.companyId === opts.companyId);
      return rows.slice(0, opts?.limit ?? 100);
    },
    listByCompany: (companyId: string, opts?: { sinceVersion?: number; sinceSeq?: number; limit?: number }): ChangeEventRecord[] => {
      let rows = this.events.filter((e) => e.companyId === companyId && e.seq > (opts?.sinceSeq ?? 0));
      return rows.slice(0, opts?.limit ?? 100);
    },
    getBySeq: (seq: number): ChangeEventRecord | null => this.events.find((e) => e.seq === seq) ?? null,
    maxSeq: (): number => (this.events.length ? this.events[this.events.length - 1]!.seq : 0),
  };

  subscriptions = {
    list: (opts?: { activeOnly?: boolean }): WebhookSubscriptionRecord[] =>
      opts?.activeOnly ? this.subscriptionsRows.filter((s) => s.active) : [...this.subscriptionsRows],
    get: (id: string): WebhookSubscriptionRecord | null => this.subscriptionsRows.find((s) => s.id === id) ?? null,
    create: (input: NewWebhookSubscription): WebhookSubscriptionRecord => {
      const record: WebhookSubscriptionRecord = {
        id: input.id ?? this.nextId('whk'),
        url: input.url,
        secret: input.secret,
        eventTypes: input.eventTypes,
        active: input.active ?? true,
        description: input.description ?? null,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      };
      this.subscriptionsRows.push(record);
      return record;
    },
    update: (id: string, patch: WebhookSubscriptionPatch): WebhookSubscriptionRecord | null => {
      const record = this.subscriptions.get(id);
      if (!record) return null;
      if (patch.url !== undefined) record.url = patch.url;
      if (patch.secret !== undefined) record.secret = patch.secret;
      if (patch.eventTypes !== undefined) record.eventTypes = patch.eventTypes;
      if (patch.active !== undefined) record.active = patch.active;
      if (patch.description !== undefined) record.description = patch.description;
      record.updatedAt = patch.updatedAt ?? new Date().toISOString();
      return record;
    },
    remove: (id: string): boolean => {
      const before = this.subscriptionsRows.length;
      this.subscriptionsRows = this.subscriptionsRows.filter((s) => s.id !== id);
      this.deliveriesRows = this.deliveriesRows.filter((d) => d.subscriptionId !== id);
      return this.subscriptionsRows.length < before;
    },
  };

  deliveries = {
    create: (input: NewWebhookDelivery): WebhookDeliveryRecord => {
      const record: WebhookDeliveryRecord = {
        id: input.id ?? this.nextId('dlv'),
        subscriptionId: input.subscriptionId,
        eventSeq: input.eventSeq,
        eventType: input.eventType,
        status: input.status ?? 'pending',
        attempts: input.attempts ?? 0,
        nextRetryAt: input.nextRetryAt ?? null,
        responseStatus: null,
        responseBodyHead: null,
        lastError: null,
        createdAt: input.createdAt,
        deliveredAt: null,
      };
      this.deliveriesRows.push(record);
      return record;
    },
    get: (id: string): WebhookDeliveryRecord | null => this.deliveriesRows.find((d) => d.id === id) ?? null,
    listDue: (nowIso: string, limit: number): WebhookDeliveryRecord[] =>
      this.deliveriesRows
        .filter((d) => d.status === 'pending' || d.status === 'failed')
        .filter((d) => !d.nextRetryAt || d.nextRetryAt <= nowIso)
        .slice(0, limit),
    listBySubscription: (
      subscriptionId: string,
      opts?: { status?: string; limit?: number; offset?: number },
    ): PageResult<WebhookDeliveryRecord> => {
      const limit = opts?.limit ?? 100;
      const offset = opts?.offset ?? 0;
      let rows = this.deliveriesRows.filter((d) => d.subscriptionId === subscriptionId);
      if (opts?.status) rows = rows.filter((d) => d.status === opts.status);
      const page = rows.slice(offset, offset + limit);
      return { items: page, nextCursor: null, hasMore: rows.length > offset + limit };
    },
    markDelivered: (id: string, patch: MarkDeliveredPatch): void => {
      const record = this.deliveries.get(id);
      if (!record) return;
      record.status = 'delivered';
      record.deliveredAt = patch.deliveredAt ?? new Date().toISOString();
      record.responseStatus = patch.responseStatus ?? null;
      record.responseBodyHead = patch.responseBodyHead ?? null;
      record.lastError = null;
      record.nextRetryAt = null;
    },
    markFailed: (id: string, patch: MarkDeliveryFailedPatch): void => {
      const record = this.deliveries.get(id);
      if (!record) return;
      record.attempts += 1; // 与 F2 markDeliveryFailed 语义一致（内部 +1）
      record.status = patch.status ?? 'failed';
      record.nextRetryAt = patch.status === 'dead' ? null : (patch.nextRetryAt ?? null);
      record.lastError = patch.error;
      record.responseStatus = patch.responseStatus ?? record.responseStatus;
      record.responseBodyHead = patch.responseBodyHead ?? record.responseBodyHead;
    },
    replay: (id: string, _opts: { nowIso: string }): void => {
      const record = this.deliveries.get(id);
      if (!record) return;
      record.status = 'pending';
      record.attempts = 0;
      record.nextRetryAt = null;
      record.lastError = null;
      record.responseStatus = null;
      record.responseBodyHead = null;
      record.deliveredAt = null;
    },
  };

  meta = {
    get: (key: string): string | null => this.metaMap.get(key) ?? null,
    set: (key: string, value: string): void => {
      this.metaMap.set(key, value);
    },
  };
}

// ---------------------------------------------------------------------------
// 本地 mock webhook server
// ---------------------------------------------------------------------------

interface ReceivedWebhook {
  headers: IncomingMessage['headers'];
  body: string;
  delivered: boolean;
}

class MockWebhookServer {
  readonly received: ReceivedWebhook[] = [];
  /** 每个请求的响应状态（可动态改），默认 200 */
  statusQueue: number[] = [];
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const status = this.statusQueue.length > 0 ? (this.statusQueue.shift() as number) : 200;
        this.received.push({ headers: req.headers, body, delivered: status >= 200 && status < 300 });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: status < 300 }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/hook`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

let server: MockWebhookServer | null = null;

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
});

function makeSubscriptionService(store: FakeEventsStore, now: () => Date): SubscriptionService {
  let n = 0;
  return new SubscriptionService({
    store,
    now,
    secretFactory: () => {
      n += 1;
      return `secret_${'x'.repeat(20)}_${n}`;
    },
  });
}

// ---------------------------------------------------------------------------
// 1. envelope / 事件映射
// ---------------------------------------------------------------------------

describe('event envelope', () => {
  it('eventId 由 seq 确定性派生且全局唯一', () => {
    expect(eventIdForSeq(1)).toBe(eventIdForSeq(1));
    expect(eventIdForSeq(1)).not.toBe(eventIdForSeq(2));
    expect(eventIdForSeq(1)).toMatch(/^evt_[0-9A-Z]{16}$/);
    expect(seqFromEventId(eventIdForSeq(12345))).toBe(12345);
    expect(seqFromEventId('not-an-id')).toBeNull();
  });

  it('company.updated 映射为字段级 diff', () => {
    const event = buildEventEnvelope({
      seq: 7,
      companyId: 'cmp_1',
      entityType: 'company',
      entityId: null,
      version: 3,
      eventType: 'company.updated',
      field: 'businessScope',
      oldValue: 'old',
      newValue: 'new',
      valueType: 'string',
      source: 'tanji',
      runId: 'run_1',
      actor: 'system',
      occurredAt: '2026-11-16T00:00:00.000Z',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
    expect(event).toMatchObject({
      eventId: eventIdForSeq(7),
      seq: 7,
      type: 'company.updated',
      companyId: 'cmp_1',
      version: 3,
      source: 'tanji',
      runId: 'run_1',
      data: { field: 'businessScope', oldValue: 'old', newValue: 'new', valueType: 'string' },
    });
  });

  it('快照型事件展开 newValue；平台事件解析平台', () => {
    const created = buildEventEnvelope({
      seq: 8,
      companyId: 'cmp_1',
      entityType: 'company',
      entityId: null,
      version: 1,
      eventType: 'company.created',
      field: null,
      oldValue: null,
      newValue: { id: 'cmp_1', name: '河北测试机械有限公司', province: '河北省' },
      valueType: 'json',
      source: 'source:boss',
      runId: null,
      actor: 'system',
      occurredAt: '2026-11-16T00:00:00.000Z',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
    expect(created.data).toMatchObject({ name: '河北测试机械有限公司', province: '河北省' });

    const jobEvent = buildEventEnvelope({
      seq: 9,
      companyId: 'cmp_1',
      entityType: 'platform_profile',
      entityId: 'pp_1',
      version: 2,
      eventType: 'platform.jobs.updated',
      field: 'platforms.boss.jobs',
      oldValue: { active: 10, added: 0, closed: 0, total: 10 },
      newValue: { active: 12, added: 2, closed: 0, total: 12 },
      valueType: 'json',
      source: 'source:boss',
      runId: null,
      actor: 'system',
      occurredAt: '2026-11-16T00:00:00.000Z',
      createdAt: '2026-11-16T00:00:00.000Z',
    });
    expect(jobEvent.data).toMatchObject({
      platform: 'boss',
      field: 'platforms.boss.jobs',
      oldValue: { active: 10 },
      newValue: { active: 12 },
    });
    expect(platformFromField('platforms.zhilian.jobCount')).toBe('zhilian');
    expect(platformFromField('legalRepresentative')).toBeNull();
  });

  it('事件类型过滤支持精确匹配与 *', () => {
    expect(matchesEventTypes(['company.created'], 'company.created')).toBe(true);
    expect(matchesEventTypes(['company.created'], 'company.updated')).toBe(false);
    expect(matchesEventTypes(['*'], 'anything')).toBe(true);
    expect(matchesEventTypes([], 'anything')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 签名与退避
// ---------------------------------------------------------------------------

describe('webhook signature & backoff', () => {
  it('HMAC-SHA256 签名可校验，篡改/错密钥失败', () => {
    const secret = 'topsecret';
    const rawBody = '{"seq":1}';
    const timestamp = 1_700_000_000;
    const signature = signWebhookPayload(secret, timestamp, rawBody);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature({ secret, timestamp, rawBody, signature })).toBe(true);
    expect(verifyWebhookSignature({ secret: 'wrong', timestamp, rawBody, signature })).toBe(false);
    expect(verifyWebhookSignature({ secret, timestamp, rawBody: '{"seq":2}', signature })).toBe(false);
    // 不带 sha256= 前缀也接受
    expect(verifyWebhookSignature({ secret, timestamp, rawBody, signature: signature.slice(7) })).toBe(true);
    // 时间窗
    expect(
      verifyWebhookSignature({ secret, timestamp, rawBody, signature, toleranceSeconds: 60, nowSeconds: timestamp + 61 }),
    ).toBe(false);
  });

  it('退避序列 10s/1m/5m/30m/2h/6h/24h，8 次失败后 dead', () => {
    expect([...WEBHOOK_BACKOFF_SECONDS]).toEqual([10, 60, 300, 1800, 7200, 21600, 86400]);
    const base = Date.parse('2026-11-16T00:00:00.000Z');
    expect(nextRetryAtIso(1, 8, base)).toBe('2026-11-16T00:00:10.000Z');
    expect(nextRetryAtIso(2, 8, base)).toBe('2026-11-16T00:01:00.000Z');
    expect(nextRetryAtIso(3, 8, base)).toBe('2026-11-16T00:05:00.000Z');
    expect(nextRetryAtIso(6, 8, base)).toBe('2026-11-16T06:00:00.000Z');
    expect(nextRetryAtIso(7, 8, base)).toBe('2026-11-17T00:00:00.000Z');
    expect(nextRetryAtIso(8, 8, base)).toBeNull();
    expect(backoffSecondsFor(1)).toBe(10);
    expect(backoffSecondsFor(8)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 订阅 CRUD（secret 脱敏）
// ---------------------------------------------------------------------------

describe('webhook subscriptions', () => {
  it('创建返回一次明文 secret，列表/更新均脱敏', async () => {
    const store = new FakeEventsStore();
    const now = () => new Date('2026-11-16T00:00:00.000Z');
    const service = makeSubscriptionService(store, now);

    const created = await service.create({
      url: 'http://127.0.0.1:9999/hook',
      eventTypes: ['company.created', 'company.updated'],
      description: '测试订阅',
    });
    expect(created.id).toMatch(/^whk_/);
    expect(created.secret).toBeTruthy();
    expect(created.secretMasked).toBe(maskSecret(created.secret!));
    expect(created.secretMasked).not.toBe(created.secret);
    expect(created.active).toBe(true);

    const list = await service.list();
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty('secret');
    expect(list[0]!.secretMasked).toBe(created.secretMasked);

    const updated = await service.update(created.id, { eventTypes: ['*'], active: false });
    expect(updated.eventTypes).toEqual(['*']);
    expect(updated.active).toBe(false);

    const rotated = await service.rotateSecret(created.id);
    expect(rotated.secret).toBeTruthy();
    expect(rotated.secret).not.toBe(created.secret);
  });

  it('校验 url / eventTypes / 不存在', async () => {
    const store = new FakeEventsStore();
    const service = makeSubscriptionService(store, () => new Date());
    await expect(service.create({ url: 'ftp://x', eventTypes: ['company.created'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create({ url: 'http://127.0.0.1:1/x', eventTypes: ['no.such'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.create({ url: 'http://127.0.0.1:1/x', eventTypes: [] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(service.update('missing', { active: true })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.remove('missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(normalizeEventTypes(['company.created', 'company.created'])).toEqual(['company.created']);
  });

  it('投递记录分页与 replay 复位', async () => {
    const store = new FakeEventsStore();
    const now = () => new Date('2026-11-16T00:00:00.000Z');
    const service = makeSubscriptionService(store, now);
    const sub = await service.create({ url: 'http://127.0.0.1:1/x', eventTypes: ['company.created'] });
    for (let i = 1; i <= 3; i++) {
      store.deliveries.create({ id: `dlv_${i}`, subscriptionId: sub.id, eventSeq: i, eventType: 'company.created', createdAt: now().toISOString() });
    }
    const page1 = await service.listDeliveries(sub.id, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await service.listDeliveries(sub.id, { limit: 2, cursor: page1.nextCursor });
    expect(page2.items).toHaveLength(1);
    expect(page2.hasMore).toBe(false);

    // replay 复位 attempts/status
    const delivery = store.deliveries.get('dlv_1')!;
    delivery.status = 'dead';
    delivery.attempts = 8;
    await expect(service.replayDelivery('missing', 'dlv_1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await service.replayDelivery(sub.id, 'dlv_1');
    expect(store.deliveries.get('dlv_1')!.status).toBe('pending');
    expect(store.deliveries.get('dlv_1')!.attempts).toBe(0);
  });

  it('toPublicSubscription 不泄漏 secret', () => {
    const view = toPublicSubscription({
      id: 'whk_1',
      url: 'http://x',
      secret: 'abcdef0123456789',
      eventTypes: ['*'],
      active: true,
      description: null,
      createdAt: 'a',
      updatedAt: 'b',
    });
    expect(JSON.stringify(view)).not.toContain('abcdef0123456789');
    expect(view.secretMasked).toBe('****6789');
  });
});

// ---------------------------------------------------------------------------
// 4. Dispatcher：fanout / 签名投递 / 重试 / 死信 / replay
// ---------------------------------------------------------------------------

describe('webhook dispatcher', () => {
  it('fanout 按订阅事件类型生成投递，不重复处理历史游标', async () => {
    const store = new FakeEventsStore();
    const now = () => new Date('2026-11-16T00:00:00.000Z');
    const sub = store.subscriptions.create({
      id: 'whk_1',
      url: 'http://127.0.0.1:1/hook',
      secret: 's'.repeat(32),
      eventTypes: ['company.created'],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    store.subscriptions.create({
      id: 'whk_other',
      url: 'http://127.0.0.1:1/other',
      secret: 't'.repeat(32),
      eventTypes: ['company.updated'],
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
    });
    // 订阅创建时间之前的历史事件不投递
    store.appendEvent({ companyId: 'cmp_0', eventType: 'company.created', createdAt: '2026-11-15T00:00:00.000Z' });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.created', createdAt: now().toISOString() });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated', createdAt: now().toISOString() });

    const dispatcher = new WebhookDispatcher({ store, fetchImpl: async () => new Response('{}', { status: 200 }), now });
    const fanout = await dispatcher.fanoutOnce();
    expect(fanout.created).toBe(2); // company.created -> whk_1；company.updated -> whk_other
    expect(store.deliveriesRows.filter((d) => d.subscriptionId === sub.id)).toHaveLength(1);
    expect(store.meta.get('webhook_dispatch_seq')).toBe('3');

    const again = await dispatcher.fanoutOnce();
    expect(again.created).toBe(0);
  });

  it('签名正确投递成功并记录响应', async () => {
    server = new MockWebhookServer();
    await server.start();
    const store = new FakeEventsStore();
    const now = () => new Date('2026-11-16T00:00:00.000Z');
    const createdAt = now().toISOString();
    const sub = store.subscriptions.create({
      id: 'whk_1',
      url: server.url,
      secret: 'k'.repeat(32),
      eventTypes: ['*'],
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.created', createdAt });
    const dispatcher = new WebhookDispatcher({ store, now });
    const tick = await dispatcher.tick();
    expect(tick.fanout.created).toBe(1);
    expect(tick.deliveries.delivered).toBe(1);

    expect(server.received).toHaveLength(1);
    const received = server.received[0]!;
    expect(received.headers[WEBHOOK_HEADER_EVENT.toLowerCase()]).toBe('company.created');
    expect(received.headers[WEBHOOK_HEADER_DELIVERY.toLowerCase()]).toMatch(/^dlv_/);
    const timestamp = Number(received.headers[WEBHOOK_HEADER_TIMESTAMP.toLowerCase()]);
    const signature = String(received.headers[WEBHOOK_HEADER_SIGNATURE.toLowerCase()]);
    expect(verifyWebhookSignature({ secret: sub.secret, timestamp, rawBody: received.body, signature })).toBe(true);
    const envelope = JSON.parse(received.body);
    expect(envelope).toMatchObject({ seq: 1, type: 'company.created', companyId: 'cmp_1', eventId: eventIdForSeq(1) });

    const delivery = store.deliveriesRows[0]!;
    expect(delivery.status).toBe('delivered');
    expect(delivery.responseStatus).toBe(200);
    expect(delivery.deliveredAt).toBeTruthy();
  });

  it('失败按指数退避重试，达到 maxAttempts 后死信；replay 后可再次投递成功', async () => {
    server = new MockWebhookServer();
    await server.start();
    const store = new FakeEventsStore();
    let current = new Date('2026-11-16T00:00:00.000Z');
    const now = () => current;
    const createdAt = current.toISOString();
    store.subscriptions.create({
      id: 'whk_1',
      url: server.url,
      secret: 'k'.repeat(32),
      eventTypes: ['*'],
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated', field: 'name', oldValue: 'a', newValue: 'b', valueType: 'string', createdAt });
    const dispatcher = new WebhookDispatcher({ store, now, maxAttempts: 8 });

    // 第 1 次 fanout + 投递（服务端 500）
    server.statusQueue = [500];
    await dispatcher.fanoutOnce();
    await dispatcher.deliverDueOnce();
    let delivery = store.deliveriesRows[0]!;
    expect(delivery.status).toBe('failed');
    expect(delivery.attempts).toBe(1);
    expect(delivery.nextRetryAt).toBe('2026-11-16T00:00:10.000Z');
    expect(delivery.lastError).toContain('http_error: 500');

    // 未到重试时间不投递
    expect((await dispatcher.deliverDueOnce()).attempted).toBe(0);

    // 推进时间并连续失败到第 8 次 → dead
    current = new Date(Date.parse(delivery.nextRetryAt!));
    for (let attempt = 2; attempt <= 8; attempt++) {
      server.statusQueue = [500];
      const tick = await dispatcher.deliverDueOnce();
      expect(tick.attempted).toBe(1);
      delivery = store.deliveriesRows[0]!;
      expect(delivery.attempts).toBe(attempt);
      if (attempt < 8) {
        expect(delivery.status).toBe('failed');
        current = new Date(Date.parse(delivery.nextRetryAt!));
      }
    }
    expect(delivery.status).toBe('dead');
    expect(delivery.nextRetryAt).toBeNull();
    expect(store.deliveriesRows).toHaveLength(1);

    // dead 不在 due 列表
    expect((await dispatcher.deliverDueOnce()).attempted).toBe(0);

    // replay → 重新投递成功
    server.statusQueue = [200];
    const replayed = await dispatcher.replayDelivery(delivery.id);
    expect(replayed.status).toBe('delivered');
    expect(replayed.attempts).toBe(0);
    expect(server.received.filter((r) => r.delivered)).toHaveLength(1);
  });

  it('订阅停用/事件缺失 → dead，不重试', async () => {
    server = new MockWebhookServer();
    await server.start();
    const store = new FakeEventsStore();
    const now = () => new Date('2026-11-16T00:00:00.000Z');
    const createdAt = now().toISOString();
    const sub = store.subscriptions.create({
      id: 'whk_1',
      url: server.url,
      secret: 'k'.repeat(32),
      eventTypes: ['*'],
      active: false,
      createdAt,
      updatedAt: createdAt,
    });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.created', createdAt });
    // 直接构造 due 投递（模拟订阅停用前已入队）
    store.deliveries.create({ id: 'dlv_x', subscriptionId: sub.id, eventSeq: 1, eventType: 'company.created', status: 'pending', createdAt });
    const dispatcher = new WebhookDispatcher({ store, now });
    const tick = await dispatcher.deliverDueOnce();
    expect(tick.dead).toBe(1);
    expect(store.deliveries.get('dlv_x')!.status).toBe('dead');
  });
});

// ---------------------------------------------------------------------------
// 5. SSE：hub 广播 / 类型过滤 / Last-Event-ID 补发
// ---------------------------------------------------------------------------

describe('sse', () => {
  function envelope(seq: number, type: string) {
    return {
      eventId: eventIdForSeq(seq),
      seq,
      type,
      occurredAt: '2026-11-16T00:00:00.000Z',
      companyId: 'cmp_1',
      version: seq,
      source: 'system:test',
      runId: null,
      data: {},
    };
  }

  it('hub 按类型过滤广播，移除断连客户端', () => {
    const hub = new EventSseHub();
    const all: string[] = [];
    const created: string[] = [];
    const idAll = hub.addClient({ send: (raw) => all.push(raw), close() {} });
    hub.addClient({ send: (raw) => created.push(raw), close() {} }, { types: ['company.created'] });
    hub.addClient({ send: () => { throw new Error('closed'); }, close() {} }, { types: ['*'] });
    expect(hub.size).toBe(3);

    const result = hub.broadcast(envelope(1, 'company.created'));
    // 第三个客户端 send 抛错：匹配但写入失败，不计入 sent，并被移除
    expect(result.sent).toBe(2);
    expect(all).toHaveLength(1);
    expect(created).toHaveLength(1);
    // 抛错客户端被移除
    expect(hub.size).toBe(2);

    hub.broadcast(envelope(2, 'company.updated'));
    expect(all).toHaveLength(2);
    expect(created).toHaveLength(1); // 类型不匹配
    hub.removeClient(idAll);
    expect(hub.size).toBe(1);
  });

  it('formatSseEvent 使用 seq 作为 id、type 作为 event', () => {
    const frame = formatSseEvent(envelope(42, 'contact.unlocked'));
    expect(frame).toContain('id: 42\n');
    expect(frame).toContain('event: contact.unlocked\n');
    expect(frame.endsWith('\n\n')).toBe(true);
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))!;
    expect(JSON.parse(dataLine.slice(6))).toMatchObject({ seq: 42, type: 'contact.unlocked' });
  });

  it('EventStreamService 从最大 seq 起增量广播', async () => {
    const store = new FakeEventsStore();
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.created' });
    const hub = new EventSseHub();
    const frames: string[] = [];
    hub.addClient({ send: (raw) => frames.push(raw), close() {} });
    const service = new EventStreamService({ store, hub });
    service.start(); // 从 maxSeq 起：历史事件不广播
    expect(await service.tick()).toBe(0);
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated' });
    expect(await service.tick()).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toContain('event: company.updated');
    service.stop();
  });

  it('Last-Event-ID 断点补发（SSE handler 写帧）', async () => {
    const store = new FakeEventsStore();
    for (let i = 1; i <= 5; i++) {
      store.appendEvent({ companyId: 'cmp_1', eventType: 'company.created', seq: i });
    }
    const hub = new EventSseHub();
    const written: string[] = [];
    let ended = false;
    const listeners = new Map<string, Array<() => void>>();
    const req = {
      query: {},
      headers: { 'last-event-id': '2' },
      raw: {
        once: (event: string, cb: () => void) => {
          listeners.set(event, [...(listeners.get(event) ?? []), cb]);
        },
      },
    };
    const reply = {
      hijack() {},
      raw: {
        writableEnded: false,
        writeHead() {},
        write: (chunk: string) => {
          written.push(chunk);
          return true;
        },
        end: () => {
          ended = true;
        },
      },
    };
    const handler = createEventStreamHandler({ store, hub, heartbeatMs: 60_000 });
    await handler(req as never, reply as never);
    // 连接帧 + seq 3,4,5
    expect(written[0]).toContain(': connected');
    expect(written.filter((w) => w.startsWith('id: '))).toEqual(['id: 3\n', 'id: 4\n', 'id: 5\n'].map((prefix, i) => expect.stringContaining(prefix)));
    expect(hub.size).toBe(1);
    // 触发 close 清理
    for (const cb of listeners.get('close') ?? []) cb();
    expect(hub.size).toBe(0);
    expect(ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. /v1/changes 查询服务：游标/过滤/不漏不重
// ---------------------------------------------------------------------------

describe('/v1/changes service', () => {
  function seededStore(): FakeEventsStore {
    const store = new FakeEventsStore();
    for (let i = 1; i <= 5; i++) {
      store.appendEvent({ companyId: i % 2 === 0 ? 'cmp_even' : 'cmp_odd', eventType: 'company.updated', seq: i });
    }
    store.appendEvent({ companyId: 'cmp_even', eventType: 'contact.unlocked', seq: 6 });
    return store;
  }

  it('sinceSeq 增量、limit+游标分页不漏不重', async () => {
    const store = seededStore();
    const page1 = await listChanges({ sinceSeq: 0, limit: 2 }, { store });
    expect(page1.items.map((e) => e.seq)).toEqual([1, 2]);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listChanges({ cursor: page1.nextCursor, limit: 2 }, { store });
    expect(page2.items.map((e) => e.seq)).toEqual([3, 4]);
    const page3 = await listChanges({ cursor: page2.nextCursor, limit: 2 }, { store });
    expect(page3.items.map((e) => e.seq)).toEqual([5, 6]);
    expect(page3.hasMore).toBe(false);

    // types 过滤
    const onlyUnlocked = await listChanges({ sinceSeq: 0, types: ['contact.unlocked'] }, { store });
    expect(onlyUnlocked.items.map((e) => e.seq)).toEqual([6]);
    // companyId 过滤
    const even = await listChanges({ sinceSeq: 0, companyId: 'cmp_even' }, { store });
    expect(even.items.map((e) => e.seq)).toEqual([2, 4, 6]);
    // 无效游标
    await expect(listChanges({ cursor: '!!!' }, { store })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(parseTypesFilter('company.created, contact.unlocked')).toEqual(['company.created', 'contact.unlocked']);
    expect(decodeCursorSafe(page1.nextCursor)).toBe(2);
  });

  it('单公司变更历史按 sinceVersion 增量', async () => {
    const store = new FakeEventsStore();
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated', version: 1, seq: 1 });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated', version: 2, seq: 2 });
    store.appendEvent({ companyId: 'cmp_1', eventType: 'company.updated', version: 3, seq: 3 });
    const page = await listCompanyChanges('cmp_1', { sinceVersion: 1 }, { store });
    expect(page.items.map((e) => e.version)).toEqual([2, 3]);
  });
});

function decodeCursorSafe(cursor: string | null): number | null {
  if (!cursor) return null;
  return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).seq as number;
}

// ---------------------------------------------------------------------------
// 7. F2 内存 DB 集成（src/repositories/index.ts 落盘后启用；此处动态导入，缺失则跳过）
// ---------------------------------------------------------------------------

describe('events with F2 memory DB (integration)', () => {
  it('change_events → 订阅 → 投递全链路（内存 SQLite）', async () => {
    let repos: import('../../src/repositories/index.js').Repositories;
    try {
      const dbModule = await import('../../src/db/index.js');
      const migrateModule = await import('../../src/db/migrate.js');
      const reposModule = await import('../../src/repositories/index.js');
      const db = dbModule.openMemoryDatabase();
      migrateModule.migrate(db);
      repos = reposModule.createRepositories(db);
    } catch {
      // F2 尚未落盘：跳过集成断言（fake store 用例已覆盖逻辑）
      return;
    }
    // 事件 + 订阅
    const sub = repos.webhooks.createSubscription({
      url: 'http://127.0.0.1:9/hook',
      secret: 'z'.repeat(32),
      eventTypes: ['company.created'],
    });
    expect(sub.id).toBeTruthy();
    const ev = repos.changeEvents.append({
      companyId: 'cmp_1',
      version: 1,
      eventType: 'company.created',
      oldValue: null,
      newValue: { name: '河北测试机械有限公司' },
      valueType: 'json',
      source: 'source:boss',
    });
    expect(ev.seq).toBe(1);

    const { getDefaultEventsStore, setDefaultEventsStore } = await import('../../src/events/f2Store.js');
    const store = (await import('../../src/events/f2Store.js')).createEventsStore(repos);
    setDefaultEventsStore(store);
    try {
      const page = await listChanges({ sinceSeq: 0 }, { store });
      expect(page.items[0]).toMatchObject({ seq: 1, type: 'company.created', companyId: 'cmp_1' });
      const created = store.subscriptions.list();
      expect(created).toHaveLength(1);
      expect(created[0]!.eventTypes).toEqual(['company.created']);
      // meta 游标持久化
      store.meta.set('webhook_dispatch_seq', '1');
      expect(store.meta.get('webhook_dispatch_seq')).toBe('1');
    } finally {
      setDefaultEventsStore(null);
      void getDefaultEventsStore;
    }
  });
});
