/** 哈希 / 签名工具（冻结） */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function contentHash(text: string): string {
  return `sha256:${sha256Hex(text)}`;
}

export function hmacSha256Hex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}
