/** raw_blobs + raw_snapshots：brotli/gzip 压缩 + sha256 内容去重 + 元数据追加 */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import {
  compressBody,
  decompressAuto,
  decompressBody,
  isCompressionEncoding,
  toBuffer,
  type CompressionEncoding,
} from '../utils/compress.js';
import { all, countRows, one, run, type DbConnection } from './sql.js';
import type {
  BlobPutResult,
  BlobRecord,
  NewRawSnapshot,
  RawSnapshot,
  SnapshotListOptions,
  SnapshotWriteInput,
  SnapshotWriteResult,
} from './types.js';

interface BlobRow {
  hash: string;
  encoding: string;
  body: Uint8Array;
  bytes: number;
  created_at: string;
}

interface SnapshotRow {
  id: number;
  kind: string;
  platform: string | null;
  run_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  url: string | null;
  blob_hash: string;
  fetched_at: string;
  archived: number;
  archive_path: string | null;
  archived_at: string | null;
}

function mapSnapshot(row: SnapshotRow): RawSnapshot {
  return {
    id: Number(row.id),
    kind: row.kind,
    platform: row.platform,
    runId: row.run_id,
    refType: row.ref_type,
    refId: row.ref_id,
    url: row.url,
    blobHash: row.blob_hash,
    fetchedAt: row.fetched_at,
    archived: Number(row.archived) !== 0,
    archivePath: row.archive_path,
    archivedAt: row.archived_at,
  };
}

function toEncoding(value: string): CompressionEncoding {
  return isCompressionEncoding(value) ? value : 'plain';
}

export interface SnapshotsRepositoryOptions {
  /** 默认压缩算法（'none' 等价 plain） */
  encoding?: CompressionEncoding | 'none';
  brotliQuality?: number;
}

export class SnapshotsRepository {
  private readonly encoding: CompressionEncoding;
  private readonly brotliQuality: number | undefined;

  constructor(
    private readonly db: DbConnection,
    opts: SnapshotsRepositoryOptions = {},
  ) {
    this.encoding = opts.encoding === undefined || opts.encoding === 'none' ? opts.encoding === 'none' ? 'plain' : 'brotli' : opts.encoding;
    this.brotliQuality = opts.brotliQuality;
  }

  // -------------------------------------------------------------------------
  // raw_blobs
  // -------------------------------------------------------------------------

  /** 压缩写入内容（按 `sha256:<hex>` 去重；已存在则跳过） */
  putBlob(payload: unknown, encoding?: CompressionEncoding): BlobPutResult {
    const enc = encoding ?? this.encoding;
    const compressed = compressBody(payload, enc, { brotliQuality: this.brotliQuality });
    const result = run(
      this.db,
      'INSERT OR IGNORE INTO raw_blobs(hash, encoding, body, bytes, created_at) VALUES(?,?,?,?,?)',
      [compressed.hash, compressed.encoding, compressed.body, compressed.originalBytes, nowIso()],
    );
    return {
      hash: compressed.hash,
      encoding: compressed.encoding,
      created: result.changes > 0,
      bytes: compressed.originalBytes,
      storedBytes: compressed.storedBytes,
    };
  }

  hasBlob(hash: string): boolean {
    return one<{ hash: string }>(this.db, 'SELECT hash FROM raw_blobs WHERE hash = ?', [hash]) !== null;
  }

  getBlob(hash: string): BlobRecord | null {
    const row = one<BlobRow>(this.db, 'SELECT * FROM raw_blobs WHERE hash = ?', [hash]);
    if (!row) return null;
    return {
      hash: row.hash,
      encoding: toEncoding(row.encoding),
      body: Buffer.from(row.body),
      bytes: Number(row.bytes),
      createdAt: row.created_at,
    };
  }

  /** 解码后的原始字节；NULL 表示 blob 不存在 */
  getBlobDecoded(hash: string): Buffer | null {
    const blob = this.getBlob(hash);
    if (!blob) return null;
    try {
      return decompressBody(blob.body, blob.encoding);
    } catch {
      return decompressAuto(blob.body).data;
    }
  }

  getBlobText(hash: string): string | null {
    const decoded = this.getBlobDecoded(hash);
    return decoded ? decoded.toString('utf8') : null;
  }

  // -------------------------------------------------------------------------
  // raw_snapshots
  // -------------------------------------------------------------------------

  insert(input: NewRawSnapshot): RawSnapshot {
    const result = run(
      this.db,
      `INSERT INTO raw_snapshots(
        kind, platform, run_id, ref_type, ref_id, url, blob_hash, fetched_at, archived, archive_path, archived_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.kind,
        input.platform ?? null,
        input.runId ?? null,
        input.refType ?? null,
        input.refId ?? null,
        input.url ?? null,
        input.blobHash,
        input.fetchedAt ?? nowIso(),
        input.archived ? 1 : 0,
        input.archivePath ?? null,
        input.archivedAt ?? null,
      ],
    );
    if (result.changes === 0) throw new LeadError('INTERNAL_ERROR', 'raw snapshot insert failed');
    const snapshot = this.getSnapshot(result.lastInsertRowid);
    if (!snapshot) throw new LeadError('INTERNAL_ERROR', 'raw snapshot not found after insert');
    return snapshot;
  }

  /** 写 payload（压缩+去重）+ 追加快照元数据（同一事务） */
  writeText(input: SnapshotWriteInput): SnapshotWriteResult {
    return this.db.transaction(() => {
      const blob = this.putBlob(input.payload, input.encoding);
      const snapshot = this.insert({
        kind: input.kind,
        platform: input.platform ?? null,
        runId: input.runId ?? null,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        url: input.url ?? null,
        blobHash: blob.hash,
        fetchedAt: input.fetchedAt ?? nowIso(),
      });
      return { snapshot, blob, blobCreated: blob.created };
    });
  }

  getSnapshot(id: number): RawSnapshot | null {
    const row = one<SnapshotRow>(this.db, 'SELECT * FROM raw_snapshots WHERE id = ?', [id]);
    return row ? mapSnapshot(row) : null;
  }

  listSnapshots(opts: SnapshotListOptions = {}): RawSnapshot[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind !== undefined) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.platform !== undefined) {
      where.push('platform = ?');
      params.push(opts.platform);
    }
    if (opts.runId !== undefined) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.refType !== undefined) {
      where.push('ref_type = ?');
      params.push(opts.refType);
    }
    if (opts.refId !== undefined) {
      where.push('ref_id = ?');
      params.push(opts.refId);
    }
    if (opts.archived !== undefined) {
      where.push('archived = ?');
      params.push(opts.archived ? 1 : 0);
    }
    if (opts.afterId !== undefined) {
      where.push('id > ?');
      params.push(opts.afterId);
    }
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const sql = `SELECT * FROM raw_snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY id DESC LIMIT ?`;
    return all<SnapshotRow>(this.db, sql, [...params, limit]).map(mapSnapshot);
  }

  listByRun(runId: string, limit = 100): RawSnapshot[] {
    return this.listSnapshots({ runId, limit });
  }

  /** 快照 + 解码后的 payload（UTF-8 文本） */
  getWithPayload(id: number): { snapshot: RawSnapshot; payload: string | null } | null {
    const snapshot = this.getSnapshot(id);
    if (!snapshot) return null;
    return { snapshot, payload: this.getBlobText(snapshot.blobHash) };
  }

  getPayload(id: number): string | null {
    const snapshot = this.getSnapshot(id);
    return snapshot ? this.getBlobText(snapshot.blobHash) : null;
  }

  countSnapshots(opts: Pick<SnapshotListOptions, 'kind' | 'runId' | 'archived'> = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.kind !== undefined) {
      where.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.runId !== undefined) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.archived !== undefined) {
      where.push('archived = ?');
      params.push(opts.archived ? 1 : 0);
    }
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM raw_snapshots ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
      params,
    );
  }

  // -------------------------------------------------------------------------
  // 冷归档（90 天后转归档；不删除）
  // -------------------------------------------------------------------------

  /** 待归档快照（hot 且 fetched_at 早于阈值） */
  listArchivable(beforeIso: string, limit = 100): RawSnapshot[] {
    return all<SnapshotRow>(
      this.db,
      `SELECT * FROM raw_snapshots WHERE archived = 0 AND fetched_at < ?
       ORDER BY fetched_at ASC, id ASC LIMIT ?`,
      [beforeIso, limit],
    ).map(mapSnapshot);
  }

  markArchived(ids: number[], archivePath: string, archivedAt: string = nowIso()): number {
    if (ids.length === 0) return 0;
    return this.db.transaction(() => {
      let changes = 0;
      for (const id of ids) {
        changes += run(
          this.db,
          'UPDATE raw_snapshots SET archived = 1, archive_path = ?, archived_at = ? WHERE id = ? AND archived = 0',
          [archivePath, archivedAt, id],
        ).changes;
      }
      return changes;
    });
  }

  /** 清理无快照引用的孤儿 blob（归档/删除后调用） */
  purgeOrphanBlobs(): number {
    return run(
      this.db,
      'DELETE FROM raw_blobs WHERE hash NOT IN (SELECT blob_hash FROM raw_snapshots)',
    ).changes;
  }

  stats(): {
    snapshots: number;
    archived: number;
    blobs: number;
    originalBytes: number;
    storedBytes: number;
    byKind: Record<string, number>;
  } {
    const snapshots = this.countSnapshots();
    const archived = this.countSnapshots({ archived: true });
    const blobRow = one<{ n: number; bytes: number; stored: number }>(
      this.db,
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS bytes, COALESCE(SUM(LENGTH(body)),0) AS stored FROM raw_blobs',
    );
    const kinds = all<{ kind: string; n: number }>(
      this.db,
      'SELECT kind, COUNT(*) AS n FROM raw_snapshots GROUP BY kind',
    );
    const byKind: Record<string, number> = {};
    for (const row of kinds) byKind[row.kind] = Number(row.n);
    return {
      snapshots,
      archived,
      blobs: Number(blobRow?.n ?? 0),
      originalBytes: Number(blobRow?.bytes ?? 0),
      storedBytes: Number(blobRow?.stored ?? 0),
      byKind,
    };
  }

  /** 测试/工具：删除单条快照并清理孤儿 blob */
  deleteSnapshot(id: number): boolean {
    return this.db.transaction(() => {
      const changes = run(this.db, 'DELETE FROM raw_snapshots WHERE id = ?', [id]).changes;
      if (changes > 0) this.purgeOrphanBlobs();
      return changes > 0;
    });
  }

  /** 工具：直接读取 payload（不做 JSON 解析） */
  decodePayload(snapshot: RawSnapshot): Buffer | null {
    return this.getBlobDecoded(snapshot.blobHash);
  }

  /** 工具：写任意 Buffer（兼容旧调用） */
  putBuffer(buffer: Buffer, encoding?: CompressionEncoding): BlobPutResult {
    return this.putBlob(toBuffer(buffer), encoding);
  }
}
