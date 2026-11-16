/**
 * 本地 Webhook 接收端（测试用，node:http 实现，无外部依赖）。
 *
 * 能力：
 *  - 收集投递请求（headers/rawBody/JSON）并可查询；
 *  - 可注入失败（前 N 次返回 5xx，用于验证重试/死信）；
 *  - 校验 HMAC 签名：`X-Lead-Signature: sha256=<hex>`，签名内容 `<X-Lead-Timestamp>.<rawBody>`
 *    （与 src/events/signature.ts 的 signWebhookPayload 一致）。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface ReceivedWebhook {
  at: string;
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  body: unknown;
  eventId: string | null;
  deliveryId: string | null;
  eventType: string | null;
  timestamp: string | null;
  signature: string | null;
  signatureValid: boolean | null;
}

export interface WebhookReceiverOptions {
  /** 密钥；用于签名校验（缺省不校验） */
  secret?: string | null;
  /** 前 N 次投递返回 500（验证重试） */
  failTimes?: number;
  /** 失败时返回的 HTTP 状态码（默认 500） */
  failStatus?: number;
}

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a.replace(/^sha256=/, ''), 'hex');
  const bb = Buffer.from(b.replace(/^sha256=/, ''), 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class WebhookReceiver {
  private server: http.Server | null = null;
  private readonly options: WebhookReceiverOptions;
  readonly received: ReceivedWebhook[] = [];
  private remainingFailures: number;
  url = '';

  constructor(options: WebhookReceiverOptions = {}) {
    this.options = options;
    this.remainingFailures = options.failTimes ?? 0;
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? (address as AddressInfo).port : 0;
  }

  /** 让接下来 n 次投递失败（5xx） */
  failNext(n = 1): void {
    this.remainingFailures = n;
  }

  reset(): void {
    this.received.length = 0;
    this.remainingFailures = 0;
  }

  /** 某事件类型的成功投递次数 */
  countByType(eventType: string): number {
    return this.received.filter((r) => r.eventType === eventType).length;
  }

  findByDelivery(deliveryId: string): ReceivedWebhook | undefined {
    return this.received.find((r) => r.deliveryId === deliveryId);
  }

  async start(port = 0): Promise<string> {
    if (this.server) return this.url;
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const headers = req.headers;
        const eventId = typeof headers['x-lead-event'] === 'string' ? headers['x-lead-event'] : null;
        const deliveryId = typeof headers['x-lead-delivery'] === 'string' ? headers['x-lead-delivery'] : null;
        const timestamp = typeof headers['x-lead-timestamp'] === 'string' ? headers['x-lead-timestamp'] : null;
        const signature = typeof headers['x-lead-signature'] === 'string' ? headers['x-lead-signature'] : null;
        let body: unknown = null;
        try {
          body = rawBody ? JSON.parse(rawBody) : null;
        } catch {
          body = rawBody;
        }
        let signatureValid: boolean | null = null;
        if (this.options.secret && signature && timestamp) {
          try {
            signatureValid = safeEqualHex(signature, computeWebhookSignature(this.options.secret, timestamp, rawBody));
          } catch {
            signatureValid = false;
          }
        }
        const eventType =
          (body && typeof body === 'object' && typeof (body as Record<string, unknown>).type === 'string'
            ? ((body as Record<string, unknown>).type as string)
            : null) ?? null;
        this.received.push({
          at: new Date().toISOString(),
          method: req.method ?? 'POST',
          url: req.url ?? '',
          headers,
          rawBody,
          body,
          eventId,
          deliveryId,
          eventType,
          timestamp,
          signature,
          signatureValid,
        });
        if (this.remainingFailures > 0) {
          this.remainingFailures -= 1;
          res.writeHead(this.options.failStatus ?? 500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'injected webhook failure' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    this.url = `http://127.0.0.1:${this.port}/webhook`;
    return this.url;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
