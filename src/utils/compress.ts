/**
 * 压缩 / 内容哈希工具（供 raw_blobs 快照层使用）
 *
 * - 默认 brotli（实测压缩比 ≈10x）；兼容 gzip / plain 读取
 * - hash 固定为 `sha256:<hex>`，对被压缩的「原始字节」计算，用于内容去重
 * - 解压支持 encodings: brotli / gzip / plain；`decompressAuto` 会在编码未知时按
 *   magic/尝试顺序探测（历史数据或手工写入的 blob 容错）
 */
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants as zlibConstants,
  gzipSync,
  gunzipSync,
} from 'node:zlib';
import { sha256Hex } from '../shared/crypto.js';

export type CompressionEncoding = 'brotli' | 'gzip' | 'plain';

export interface CompressedPayload {
  /** 内容哈希，格式 `sha256:<hex>`（基于原始未压缩字节） */
  hash: string;
  /** 压缩后字节（plain 时等于原始字节） */
  body: Buffer;
  encoding: CompressionEncoding;
  /** 原始字节数 */
  originalBytes: number;
  /** 压缩后字节数 */
  storedBytes: number;
}

export interface DecompressedPayload {
  data: Buffer;
  encoding: CompressionEncoding;
}

const DEFAULT_BROTLI_QUALITY = 5;

export function isCompressionEncoding(value: unknown): value is CompressionEncoding {
  return value === 'brotli' || value === 'gzip' || value === 'plain';
}

/** 把任意 payload（string / Buffer / 可 JSON 序列化对象）转成 buffer */
export function toBuffer(payload: unknown): Buffer {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (typeof payload === 'string') return Buffer.from(payload, 'utf8');
  if (payload === null || payload === undefined) return Buffer.from('null', 'utf8');
  return Buffer.from(JSON.stringify(payload), 'utf8');
}

/** `sha256:<hex>` 内容哈希 */
export function contentHash(payload: unknown): string {
  return `sha256:${sha256Hex(toBuffer(payload))}`;
}

/** 仅计算压缩结果与 hash；不写 DB */
export function compressBody(
  payload: unknown,
  encoding: CompressionEncoding = 'brotli',
  opts?: { brotliQuality?: number },
): CompressedPayload {
  const raw = toBuffer(payload);
  const hash = `sha256:${sha256Hex(raw)}`;
  let body: Buffer;
  switch (encoding) {
    case 'brotli':
      body = brotliCompressSync(raw, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: opts?.brotliQuality ?? DEFAULT_BROTLI_QUALITY,
        },
      });
      break;
    case 'gzip':
      body = gzipSync(raw);
      break;
    case 'plain':
      body = raw;
      break;
    default: {
      const never: never = encoding;
      throw new Error(`unsupported compression encoding: ${String(never)}`);
    }
  }
  return { hash, body, encoding, originalBytes: raw.length, storedBytes: body.length };
}

/** compressBody 的简化形式：返回 hash + body */
export function compressPayload(
  payload: unknown,
  encoding: CompressionEncoding = 'brotli',
): { hash: string; body: Buffer; encoding: CompressionEncoding } {
  const c = compressBody(payload, encoding);
  return { hash: c.hash, body: c.body, encoding: c.encoding };
}

/** 按显式 encoding 解压 */
export function decompressBody(body: Uint8Array | Buffer, encoding: CompressionEncoding | string): Buffer {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const enc = String(encoding) as CompressionEncoding;
  switch (enc) {
    case 'brotli':
      return brotliDecompressSync(buf);
    case 'gzip':
      return gunzipSync(buf);
    case 'plain':
      return buf;
    default:
      throw new Error(`unsupported compression encoding: ${String(encoding)}`);
  }
}

/**
 * 编码未知时的容错解压：
 * 1) gzip magic (0x1f 0x8b) 直接 gzip 解压
 * 2) 依次尝试 brotli -> gzip -> plain，返回首个成功且可解码结果
 */
export function decompressAuto(body: Uint8Array | Buffer): DecompressedPayload {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return { data: gunzipSync(buf), encoding: 'gzip' };
  }
  try {
    return { data: brotliDecompressSync(buf), encoding: 'brotli' };
  } catch {
    /* try next */
  }
  try {
    return { data: gunzipSync(buf), encoding: 'gzip' };
  } catch {
    /* try next */
  }
  return { data: buf, encoding: 'plain' };
}

/** 按 encoding 解压并解析 JSON（快照辅助）：解析失败返回 fallback */
export function decompressJson<T = unknown>(body: Uint8Array | Buffer, encoding: CompressionEncoding | string, fallback: T): T {
  try {
    return JSON.parse(decompressBody(body, encoding).toString('utf8')) as T;
  } catch {
    return fallback;
  }
}
