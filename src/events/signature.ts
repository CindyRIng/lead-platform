/**
 * Webhook 签名与重试退避（纯函数，无 DB/网络依赖）。
 *
 * 签名契约（docs/02 §14.2、docs/03 §5）：
 *   X-Lead-Event:     <event type>
 *   X-Lead-Delivery:  <delivery id>
 *   X-Lead-Timestamp: <unix seconds>
 *   X-Lead-Signature: sha256=HMAC-SHA256(secret, `${timestamp}.${rawBody}`) 的 hex
 */
import { hmacSha256Hex } from '../shared/crypto.js';
import { safeEqual } from '../shared/crypto.js';

export const WEBHOOK_HEADER_EVENT = 'X-Lead-Event';
export const WEBHOOK_HEADER_DELIVERY = 'X-Lead-Delivery';
export const WEBHOOK_HEADER_TIMESTAMP = 'X-Lead-Timestamp';
export const WEBHOOK_HEADER_SIGNATURE = 'X-Lead-Signature';

/** 失败重试退避：10s / 1m / 5m / 30m / 2h / 6h / 24h（最多 8 次尝试，第 8 次失败即 dead） */
export const WEBHOOK_BACKOFF_SECONDS: readonly number[] = [10, 60, 300, 1800, 7200, 21600, 86400];

export const DEFAULT_WEBHOOK_MAX_ATTEMPTS = 8;

export function signWebhookPayload(secret: string, timestamp: number | string, rawBody: string): string {
  return `sha256=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
}

export interface VerifyWebhookInput {
  secret: string;
  timestamp: number | string;
  rawBody: string;
  /** 支持带 `sha256=` 前缀或裸 hex */
  signature: string;
  /** 可选时钟偏差容忍（秒）；不传则不做时间窗校验 */
  toleranceSeconds?: number;
  nowSeconds?: number;
}

/**
 * 校验投递签名（消费方 SDK/测试用；服务端只负责签名）。
 * 常量时间比较，避免时序侧信道。
 */
export function verifyWebhookSignature(input: VerifyWebhookInput): boolean {
  if (!input.signature) return false;
  const expected = signWebhookPayload(input.secret, input.timestamp, input.rawBody);
  const provided = input.signature.startsWith('sha256=') ? input.signature : `sha256=${input.signature}`;
  if (!safeEqual(expected, provided)) return false;
  if (input.toleranceSeconds != null) {
    const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const ts = Number(input.timestamp);
    if (!Number.isFinite(ts)) return false;
    if (Math.abs(now - ts) > input.toleranceSeconds) return false;
  }
  return true;
}

/**
 * 计算第 attemptsFailed 次失败后的下一次重试时间（ISO）。
 * 返回 null 表示已达最大尝试次数 → 进入 dead（死信）。
 *
 * @param attemptsFailed 已失败次数（含本次），从 1 开始
 * @param maxAttempts    最大尝试次数（默认 8）
 * @param nowMs          当前时间（测试可注入）
 */
export function nextRetryAtIso(attemptsFailed: number, maxAttempts = DEFAULT_WEBHOOK_MAX_ATTEMPTS, nowMs = Date.now()): string | null {
  if (attemptsFailed >= maxAttempts) return null;
  const idx = Math.min(Math.max(attemptsFailed - 1, 0), WEBHOOK_BACKOFF_SECONDS.length - 1);
  const delaySec = WEBHOOK_BACKOFF_SECONDS[idx] ?? WEBHOOK_BACKOFF_SECONDS[WEBHOOK_BACKOFF_SECONDS.length - 1]!;
  return new Date(nowMs + delaySec * 1000).toISOString();
}

/** 第 attemptsFailed 次失败后应等待的秒数；已达上限返回 null */
export function backoffSecondsFor(attemptsFailed: number, maxAttempts = DEFAULT_WEBHOOK_MAX_ATTEMPTS): number | null {
  if (attemptsFailed >= maxAttempts) return null;
  const idx = Math.min(Math.max(attemptsFailed - 1, 0), WEBHOOK_BACKOFF_SECONDS.length - 1);
  return WEBHOOK_BACKOFF_SECONDS[idx] ?? null;
}

/** 响应体只保留头部，避免 DB 膨胀；同时去掉控制字符 */
export function truncateResponseBody(text: string, maxLen = 500): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen)}…`;
}
