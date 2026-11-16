/**
 * 管理/归档服务（D4）。
 *
 * 职责：
 *  - backup：SQLite 在线备份（VACUUM INTO）到 dataDir/backups/YYYY-MM-DD.db；
 *  - archive：raw_snapshots(>N 天) + raw_blobs → dataDir/archive/YYYY-MM/
 *      blobs/<hash>.br（内容即 brotli 压缩后的原始 body，文件名=sha256）
 *      snapshots.ndjson.br（元数据行）
 *      manifest.json（sha256 清单，可 verify/restore）
 *    只标记 archived=1 + archive_path，不删除任何数据；
 *  - verify：重算 manifest 中每个文件 sha256；
 *  - restore：按月份把 blob 文件回填 raw_blobs + 把 raw_snapshots 恢复为 hot（幂等，不删归档）；
 *  - dbStats：DB 体积 / 表行数 / 归档与备份统计。
 *
 * 该服务不依赖全局单例：构造时注入 DB 句柄与目录，便于单测；
 * createDefaultAdminService() 供路由在运行期懒解析 config + getDb()。
 */
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { sha256Hex } from '../shared/crypto.js';
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';

/** node:sqlite DatabaseSync 的最小结构（避免在类型层耦合 node:sqlite） */
export interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  };
}

export interface DbHandleLike {
  raw: SqliteLike;
}

export type DbInput = SqliteLike | DbHandleLike;

export interface AdminServiceOptions {
  db: DbInput;
  dataDir: string;
  dbPath?: string;
  archiveDir?: string;
  backupDir?: string;
  archiveAfterDays?: number;
  /** 注入时钟（测试用） */
  now?: () => Date;
}

export interface BackupResult {
  ok: boolean;
  path: string;
  bytes: number;
  createdAt: string;
  schemaVersion: number;
}

export interface ArchiveMonthResult {
  month: string;
  dir: string;
  manifestPath: string;
  snapshotCount: number;
  blobCount: number;
  bytes: number;
}

export interface ArchiveResult {
  dryRun: boolean;
  afterDays: number;
  cutoff: string;
  snapshotCount: number;
  blobCount: number;
  bytes: number;
  months: ArchiveMonthResult[];
}

export interface ManifestSummary {
  month: string;
  path: string;
  snapshotCount: number;
  blobCount: number;
  bytes: number;
  createdAt?: string;
  schemaVersion?: number;
}

export interface VerifyResult {
  ok: boolean;
  months: Array<{ month: string; ok: boolean; checkedFiles: number; problems: string[] }>;
}

export interface RestoreResult {
  dryRun: boolean;
  months: string[];
  restoredSnapshots: number;
  restoredBlobs: number;
}

export interface DbStatsResult {
  dbPath: string;
  sizeBytes: number;
  walBytes: number;
  schemaVersion: number;
  tables: Record<string, number>;
  archive: { months: number; files: number; bytes: number };
  backups: { count: number; latest?: string };
}

interface ManifestEntry {
  id: number;
  kind: string;
  platform: string | null;
  runId: string | null;
  refType: string | null;
  refId: string | null;
  url: string | null;
  blobHash: string;
  fetchedAt: string;
  encoding: string;
  bytes: number;
}

interface ManifestFile {
  path: string;
  /** 文件字节的 sha256（校验用） */
  sha256: string;
  bytes: number;
  /** blobs/*.br 对应的 raw_blobs.hash（内容哈希，非压缩文件哈希） */
  blobHash?: string;
}

interface Manifest {
  schemaVersion: number;
  month: string;
  createdAt: string;
  afterDays: number;
  cutoff: string;
  snapshotCount: number;
  blobCount: number;
  bytes: number;
  entries: ManifestEntry[];
  files: ManifestFile[];
}

const TABLE_LIST = [
  'goals',
  'goal_runs',
  'source_queries',
  'raw_blobs',
  'raw_snapshots',
  'companies',
  'company_sources',
  'company_contacts',
  'pipeline_jobs',
  'unlock_ledger',
  'change_events',
  'webhook_subscriptions',
  'webhook_deliveries',
  'quota_observations',
  'source_health',
  'regions',
  'region_platform_map',
  'company_platform_profiles',
  'company_platform_jobs',
  'company_customs_profiles',
];

const MANIFEST_FILE = 'manifest.json';
const SNAPSHOTS_FILE = 'snapshots.ndjson.br';
const BLOBS_DIR = 'blobs';

function rawOf(db: DbInput): SqliteLike {
  const maybe = db as DbHandleLike;
  if (maybe && typeof maybe === 'object' && maybe.raw && typeof maybe.raw.prepare === 'function') return maybe.raw;
  return db as SqliteLike;
}

function isoDaysAgo(days: number, from: Date): string {
  return new Date(from.getTime() - days * 86400_000).toISOString();
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export class AdminService {
  private readonly db: SqliteLike;
  private readonly dataDir: string;
  private readonly dbPath: string | undefined;
  readonly archiveDir: string;
  readonly backupDir: string;
  private readonly archiveAfterDays: number;
  private readonly now: () => Date;

  constructor(opts: AdminServiceOptions) {
    this.db = rawOf(opts.db);
    this.dataDir = opts.dataDir;
    this.dbPath = opts.dbPath;
    this.archiveDir = opts.archiveDir ?? path.join(opts.dataDir, 'archive');
    this.backupDir = opts.backupDir ?? path.join(opts.dataDir, 'backups');
    this.archiveAfterDays = opts.archiveAfterDays ?? 90;
    this.now = opts.now ?? (() => new Date());
  }

  /* ------------------------------ backup ------------------------------ */

  async backup(): Promise<BackupResult> {
    fs.mkdirSync(this.backupDir, { recursive: true, mode: 0o700 });
    const now = this.now();
    const date = now.toISOString().slice(0, 10);
    let file = path.join(this.backupDir, `${date}.db`);
    if (fs.existsSync(file)) {
      const stamp = now.toISOString().slice(11, 19).replace(/:/g, '');
      file = path.join(this.backupDir, `${date}-${stamp}.db`);
    }
    const escaped = file.replace(/'/g, "''");
    try {
      this.db.exec(`VACUUM INTO '${escaped}'`);
    } catch (err) {
      throw new LeadError('INTERNAL_ERROR', `sqlite backup failed: ${(err as Error).message}`, { cause: err });
    }
    const stat = fs.statSync(file);
    return {
      ok: true,
      path: file,
      bytes: stat.size,
      createdAt: now.toISOString(),
      schemaVersion: this.schemaVersion(),
    };
  }

  /* ------------------------------ archive ----------------------------- */

  async archive(opts: { afterDays?: number; dryRun?: boolean } = {}): Promise<ArchiveResult> {
    const afterDays = opts.afterDays ?? this.archiveAfterDays;
    const dryRun = opts.dryRun === true;
    const now = this.now();
    const cutoff = isoDaysAgo(afterDays, now);

    const snapshots = this.db
      .prepare(
        `SELECT id, kind, platform, run_id, ref_type, ref_id, url, blob_hash, fetched_at
           FROM raw_snapshots
          WHERE archived = 0 AND archive_path IS NULL AND fetched_at < ?
          ORDER BY fetched_at ASC, id ASC`,
      )
      .all(cutoff) as Array<Record<string, unknown>>;

    const byMonth = new Map<string, Array<Record<string, unknown>>>();
    for (const row of snapshots) {
      const month = String(row.fetched_at ?? '').slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(month)) continue;
      const list = byMonth.get(month) ?? [];
      list.push(row);
      byMonth.set(month, list);
    }

    const months: ArchiveMonthResult[] = [];
    let totalSnapshots = 0;
    let totalBlobs = 0;
    let totalBytes = 0;

    for (const [month, rows] of [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const dir = path.join(this.archiveDir, month);
      const blobsDir = path.join(dir, BLOBS_DIR);
      const manifestPath = path.join(dir, MANIFEST_FILE);
      const entries: ManifestEntry[] = [];
      const files: ManifestFile[] = [];
      let monthBytes = 0;
      const blobHashes = new Set<string>();
      const snapshotEntries: string[] = [];
      const writtenBlobs = new Set<string>();

      for (const row of rows) {
        const blobHash = String(row.blob_hash ?? '');
        const blob = this.db.prepare('SELECT hash, encoding, body, bytes FROM raw_blobs WHERE hash = ?').get(blobHash) as
          | Record<string, unknown>
          | undefined;
        const encoding = blob ? String(blob.encoding ?? 'brotli') : 'brotli';
        const body = blob ? toBuffer(blob.body) : Buffer.alloc(0);
        const bytes = blob && typeof blob.bytes === 'number' ? (blob.bytes as number) : body.length;
        const entry: ManifestEntry = {
          id: Number(row.id),
          kind: String(row.kind ?? ''),
          platform: (row.platform as string | null) ?? null,
          runId: (row.run_id as string | null) ?? null,
          refType: (row.ref_type as string | null) ?? null,
          refId: (row.ref_id as string | null) ?? null,
          url: (row.url as string | null) ?? null,
          blobHash,
          fetchedAt: String(row.fetched_at ?? ''),
          encoding,
          bytes,
        };
        entries.push(entry);
        snapshotEntries.push(JSON.stringify(entry));
        if (!blobHashes.has(blobHash)) {
          blobHashes.add(blobHash);
          const fileName = `${blobHash}.br`;
          const relPath = `${BLOBS_DIR}/${fileName}`;
          const absPath = path.join(blobsDir, fileName);
          const fileSha = sha256Hex(body);
          if (!dryRun && !writtenBlobs.has(fileName)) {
            fs.mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
            const existingSha = fs.existsSync(absPath) ? sha256Hex(fs.readFileSync(absPath)) : null;
            if (existingSha !== fileSha) fs.writeFileSync(absPath, body, { mode: 0o600 });
            writtenBlobs.add(fileName);
          }
          files.push({ path: relPath, sha256: fileSha, bytes: body.length, blobHash });
          monthBytes += body.length;
        }
      }

      const ndjson = Buffer.from(snapshotEntries.join('\n') + '\n', 'utf8');
      const compressed = brotliCompressSync(ndjson);
      const ndjsonSha = sha256Hex(compressed);
      files.push({ path: SNAPSHOTS_FILE, sha256: ndjsonSha, bytes: compressed.length });
      monthBytes += compressed.length;

      if (!dryRun) {
        fs.mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
        fs.writeFileSync(path.join(dir, SNAPSHOTS_FILE), compressed, { mode: 0o600 });
        const manifest: Manifest = {
          schemaVersion: 1,
          month,
          createdAt: now.toISOString(),
          afterDays,
          cutoff,
          snapshotCount: entries.length,
          blobCount: blobHashes.size,
          bytes: monthBytes,
          entries,
          files,
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
        const archivePath = `${month}/${SNAPSHOTS_FILE}`;
        const archivedAt = now.toISOString();
        this.inTransaction(() => {
          for (const entry of entries) {
            this.db
              .prepare('UPDATE raw_snapshots SET archived = 1, archive_path = ?, archived_at = ? WHERE id = ?')
              .run(archivePath, archivedAt, entry.id);
          }
        });
      }

      months.push({
        month,
        dir,
        manifestPath,
        snapshotCount: entries.length,
        blobCount: blobHashes.size,
        bytes: monthBytes,
      });
      totalSnapshots += entries.length;
      totalBlobs += blobHashes.size;
      totalBytes += monthBytes;
    }

    return {
      dryRun,
      afterDays,
      cutoff,
      snapshotCount: totalSnapshots,
      blobCount: totalBlobs,
      bytes: totalBytes,
      months,
    };
  }

  /* ---------------------------- manifests ----------------------------- */

  async listManifests(): Promise<ManifestSummary[]> {
    const months = this.availableMonths();
    const out: ManifestSummary[] = [];
    for (const month of months) {
      const manifestPath = path.join(this.archiveDir, month, MANIFEST_FILE);
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
        out.push({
          month,
          path: manifestPath,
          snapshotCount: Number(manifest.snapshotCount ?? manifest.entries?.length ?? 0),
          blobCount: Number(manifest.blobCount ?? 0),
          bytes: Number(manifest.bytes ?? 0),
          createdAt: manifest.createdAt,
          schemaVersion: manifest.schemaVersion,
        });
      } catch {
        out.push({ month, path: manifestPath, snapshotCount: 0, blobCount: 0, bytes: 0 });
      }
    }
    return out;
  }

  /* ------------------------------ verify ------------------------------ */

  async verify(opts: { month?: string } = {}): Promise<VerifyResult> {
    const months = opts.month ? [opts.month] : this.availableMonths();
    const results: VerifyResult['months'] = [];
    let allOk = true;
    for (const month of months) {
      const problems: string[] = [];
      let checkedFiles = 0;
      const manifestPath = path.join(this.archiveDir, month, MANIFEST_FILE);
      let manifest: Manifest | null = null;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch {
        problems.push(`manifest missing or unreadable: ${manifestPath}`);
        results.push({ month, ok: false, checkedFiles, problems });
        allOk = false;
        continue;
      }
      if (manifest.month !== month) problems.push(`manifest month mismatch: ${manifest.month} != ${month}`);
      if (Number(manifest.snapshotCount) !== (manifest.entries?.length ?? 0)) {
        problems.push(`snapshotCount mismatch: ${manifest.snapshotCount} != ${manifest.entries?.length ?? 0}`);
      }
      const dir = path.join(this.archiveDir, month);
      for (const file of manifest.files ?? []) {
        checkedFiles++;
        const absPath = path.join(dir, file.path);
        if (!fs.existsSync(absPath)) {
          problems.push(`file missing: ${file.path}`);
          continue;
        }
        const bytes = fs.readFileSync(absPath);
        if (bytes.length !== Number(file.bytes)) {
          problems.push(`file size mismatch: ${file.path} (${bytes.length} != ${file.bytes})`);
        }
        const digest = sha256Hex(bytes);
        if (digest !== file.sha256) problems.push(`sha256 mismatch: ${file.path}`);
      }
      const ok = problems.length === 0;
      if (!ok) allOk = false;
      results.push({ month, ok, checkedFiles, problems });
    }
    return { ok: allOk, months: results };
  }

  /* ------------------------------ restore ----------------------------- */

  async restore(opts: { month?: string; dryRun?: boolean } = {}): Promise<RestoreResult> {
    const dryRun = opts.dryRun === true;
    const months = opts.month ? [opts.month] : this.availableMonths();
    let restoredSnapshots = 0;
    let restoredBlobs = 0;
    const now = nowIso();

    for (const month of months) {
      const dir = path.join(this.archiveDir, month);
      const manifestPath = path.join(dir, MANIFEST_FILE);
      let manifest: Manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Manifest;
      } catch {
        throw new LeadError('NOT_FOUND', `archive manifest not found for month: ${month}`, {
          details: { path: manifestPath },
        });
      }

      const blobFiles = new Map<string, ManifestFile>();
      for (const file of manifest.files ?? []) {
        if (!file.path.startsWith(`${BLOBS_DIR}/`) || !file.blobHash) continue;
        blobFiles.set(file.blobHash, file);
      }

      const ensureBlob = (hash: string, encoding: string, bytes?: number): number => {
        const exists = this.db.prepare('SELECT hash FROM raw_blobs WHERE hash = ?').get(hash);
        if (exists) return 0;
        const file = blobFiles.get(hash);
        if (!file) {
          throw new LeadError('INTERNAL_ERROR', `archive blob file metadata missing for ${hash} (month ${month})`);
        }
        if (dryRun) return 1;
        const body = fs.readFileSync(path.join(dir, file.path));
        if (sha256Hex(body) !== file.sha256) {
          throw new LeadError('INTERNAL_ERROR', `archive blob corrupted: ${file.path}`, { details: { month } });
        }
        this.db
          .prepare('INSERT OR IGNORE INTO raw_blobs (hash, encoding, body, bytes, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(hash, encoding, body, bytes ?? body.length, now);
        return 1;
      };

      const restoreEntry = (entry: ManifestEntry): number => {
        const blobAdded = ensureBlob(entry.blobHash, entry.encoding, entry.bytes);
        restoredBlobs += blobAdded;
        const existing = this.db.prepare('SELECT id FROM raw_snapshots WHERE id = ?').get(entry.id) as
          | Record<string, unknown>
          | undefined;
        if (existing) {
          if (dryRun) return 0;
          this.db
            .prepare('UPDATE raw_snapshots SET archived = 0, archive_path = ? WHERE id = ?')
            .run(`${month}/${SNAPSHOTS_FILE}`, entry.id);
          return 0;
        }
        if (dryRun) return 1;
        this.db
          .prepare(
            `INSERT INTO raw_snapshots (id, kind, platform, run_id, ref_type, ref_id, url, blob_hash, fetched_at, archived, archive_path, archived_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
          )
          .run(
            entry.id,
            entry.kind,
            entry.platform,
            entry.runId,
            entry.refType,
            entry.refId,
            entry.url,
            entry.blobHash,
            entry.fetchedAt,
            `${month}/${SNAPSHOTS_FILE}`,
            now,
          );
        return 1;
      };

      this.inTransaction(() => {
        for (const entry of manifest.entries ?? []) restoredSnapshots += restoreEntry(entry);
      });
    }

    return { dryRun, months, restoredSnapshots, restoredBlobs };
  }

  /* ------------------------------ dbStats ----------------------------- */

  async dbStats(): Promise<DbStatsResult> {
    let sizeBytes = 0;
    let walBytes = 0;
    if (this.dbPath) {
      try {
        sizeBytes = fs.statSync(this.dbPath).size;
      } catch {
        /* ignore */
      }
      try {
        walBytes = fs.statSync(`${this.dbPath}-wal`).size;
      } catch {
        /* ignore */
      }
    }
    const tables: Record<string, number> = {};
    for (const table of TABLE_LIST) {
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined;
        tables[table] = Number(row?.n ?? 0);
      } catch {
        tables[table] = 0;
      }
    }
    const manifests = await this.listManifests();
    const archiveFiles = manifests.reduce((sum, m) => sum + m.snapshotCount, 0);
    let backupCount = 0;
    let latestBackup: string | undefined;
    try {
      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.endsWith('.db'))
        .sort();
      backupCount = files.length;
      latestBackup = files.length ? path.join(this.backupDir, files[files.length - 1] as string) : undefined;
    } catch {
      /* ignore */
    }
    return {
      dbPath: this.dbPath ?? '',
      sizeBytes,
      walBytes,
      schemaVersion: this.schemaVersion(),
      tables,
      archive: {
        months: manifests.length,
        files: archiveFiles,
        bytes: manifests.reduce((sum, m) => sum + m.bytes, 0),
      },
      backups: { count: backupCount, ...(latestBackup ? { latest: latestBackup } : {}) },
    };
  }

  /** 可选：清理过期 webhook 投递（默认不启用；死信应保留到处理完毕） */
  async purgeWebhookDeliveries(opts: { olderThanDays: number; statuses?: string[]; dryRun?: boolean }): Promise<{
    dryRun: boolean;
    deleted: number;
  }> {
    const cutoff = isoDaysAgo(opts.olderThanDays, this.now());
    const statuses = opts.statuses ?? ['delivered', 'dead'];
    const placeholders = statuses.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status IN (${placeholders}) AND created_at < ?`)
      .get(...statuses, cutoff) as { n?: number } | undefined;
    const count = Number(rows?.n ?? 0);
    if (opts.dryRun) return { dryRun: true, deleted: count };
    this.db
      .prepare(`DELETE FROM webhook_deliveries WHERE status IN (${placeholders}) AND created_at < ?`)
      .run(...statuses, cutoff);
    return { dryRun: false, deleted: count };
  }

  /* ----------------------------- internal ----------------------------- */

  private schemaVersion(): number {
    try {
      const row = this.db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      return Number(row?.user_version ?? 0);
    } catch {
      return 0;
    }
  }

  private availableMonths(): string[] {
    try {
      return fs
        .readdirSync(this.archiveDir)
        .filter((name) => /^\d{4}-\d{2}$/.test(name))
        .filter((name) => fs.existsSync(path.join(this.archiveDir, name, MANIFEST_FILE)))
        .sort();
    } catch {
      return [];
    }
  }

  private inTransaction<T>(fn: () => T): T {
    const handle = this.db as SqliteLike & { transaction?: <R>(f: () => R) => R };
    if (typeof handle.transaction === 'function') return handle.transaction(fn);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        /* ignore */
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 运行期默认实例（路由使用）                                            */
/* ------------------------------------------------------------------ */

let defaultInstance: AdminService | null = null;

export interface RuntimeLike {
  db?: { raw?: SqliteLike; path?: string; location?: string };
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * 解析运行期依赖：
 *  - 优先使用 server 注入的 context（db + config）；
 *  - 否则动态 import src/config.js + src/db/index.js 的 getDb()。
 */
export async function createDefaultAdminService(runtime?: RuntimeLike | null): Promise<AdminService> {
  let dataDir: string | undefined;
  let dbPath: string | undefined;
  let archiveDir: string | undefined;
  let backupDir: string | undefined;
  let archiveAfterDays: number | undefined;

  const applyConfig = (cfg: Record<string, unknown> | undefined | null): void => {
    if (!cfg) return;
    dataDir = typeof cfg.dataDir === 'string' ? cfg.dataDir : dataDir;
    dbPath = typeof cfg.dbPath === 'string' ? cfg.dbPath : dbPath;
    archiveDir = typeof cfg.archiveDir === 'string' ? cfg.archiveDir : archiveDir;
    backupDir = typeof cfg.backupDir === 'string' ? cfg.backupDir : backupDir;
    archiveAfterDays = typeof cfg.archiveAfterDays === 'number' ? cfg.archiveAfterDays : archiveAfterDays;
  };

  let db = runtime?.db as DbInput | undefined;
  applyConfig(runtime?.config as Record<string, unknown> | undefined);

  if (!db) {
    try {
      const spec = '../config.js';
      const cfgMod = (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as Record<string, unknown>;
      const cfg = (cfgMod.config ?? (typeof cfgMod.getConfig === 'function' ? (cfgMod.getConfig as () => unknown)() : null)) as
        | Record<string, unknown>
        | null;
      applyConfig(cfg);
    } catch {
      /* config 不可用：退回默认目录 */
    }
    try {
      const spec = '../db/index.js';
      const dbMod = (await import(/* @vite-ignore */ new URL(spec, import.meta.url).href)) as Record<string, unknown>;
      const getDb = dbMod.getDb;
      if (typeof getDb === 'function') db = (getDb as () => DbInput)();
    } catch {
      /* ignore */
    }
  }

  if (!db) {
    throw new LeadError('INTERNAL_ERROR', 'admin service requires a database handle (integration point: db.handle)');
  }

  dataDir = dataDir ?? path.join(process.env.HOME || '.', '.lead-platform');
  if (!defaultInstance) {
    defaultInstance = new AdminService({
      db,
      dataDir,
      dbPath,
      archiveDir,
      backupDir,
      archiveAfterDays,
    });
  } else {
    // 运行期配置可能变化（测试）：重建
    defaultInstance = new AdminService({ db, dataDir, dbPath, archiveDir, backupDir, archiveAfterDays });
  }
  return defaultInstance;
}

export function resetDefaultAdminServiceForTests(): void {
  defaultInstance = null;
}
