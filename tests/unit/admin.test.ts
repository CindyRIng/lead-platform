/**
 * D4 管理/归档服务测试：临时 DB + 临时目录，覆盖
 * backup / archive / listManifests / verify / restore / dbStats 幂等、不丢数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AdminService } from '../../src/services/admin.js';
import { LeadError } from '../../src/shared/errors.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');
const SCHEMA = fs.readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8');

let dir: string;
let dbPath: string;
let db: DatabaseSync;
let service: AdminService;

function insertBlob(hash: string, body: Buffer): void {
  db.prepare('INSERT OR REPLACE INTO raw_blobs (hash, encoding, body, bytes, created_at) VALUES (?, ?, ?, ?, ?)').run(
    hash,
    'brotli',
    body,
    0,
    NOW.toISOString(),
  );
}

function insertSnapshot(id: number, hash: string, fetchedAt: string): void {
  db.prepare(
    `INSERT INTO raw_snapshots (id, kind, platform, run_id, ref_type, ref_id, url, blob_hash, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 'search_page', 'boss', 'run_1', 'company', `cmp_${id}`, 'https://example.invalid/x', hash, fetchedAt);
}

function count(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number };
  return Number(row?.n ?? 0);
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-admin-test-'));
  dbPath = path.join(dir, 'lead.db');
  db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  db.exec('PRAGMA user_version = 1;');

  insertBlob('hash_old_1', Buffer.from('old-body-1'));
  insertBlob('hash_old_2', Buffer.from('old-body-2'));
  insertBlob('hash_recent', Buffer.from('recent-body'));

  // 2 条旧快照（>90 天，2026-08），1 条新快照（2026-11-10）
  insertSnapshot(1, 'hash_old_1', '2026-08-01T00:00:00.000Z');
  insertSnapshot(2, 'hash_old_2', '2026-08-02T00:00:00.000Z');
  insertSnapshot(3, 'hash_recent', '2026-11-10T00:00:00.000Z');

  db.prepare(
    `INSERT INTO companies (id, name, normalized_name, first_seen_at, last_seen_at, created_at, updated_at)
     VALUES ('cmp_1', '河北测试机械有限公司', '河北测试机械有限公司', ?, ?, ?, ?)`,
  ).run(NOW.toISOString(), NOW.toISOString(), NOW.toISOString(), NOW.toISOString());

  service = new AdminService({
    db,
    dataDir: dir,
    dbPath,
    archiveAfterDays: 90,
    now: () => NOW,
  });
});

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('archive / manifests / verify', () => {
  it('archive 把 90 天前快照写入月份目录并标记 archived，不动新快照', async () => {
    const result = await service.archive();
    expect(result.dryRun).toBe(false);
    expect(result.afterDays).toBe(90);
    expect(result.snapshotCount).toBe(2);
    expect(result.blobCount).toBe(2);
    expect(result.months.map((m) => m.month)).toEqual(['2026-08']);

    const manifestPath = path.join(dir, 'archive', '2026-08', 'manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive', '2026-08', 'snapshots.ndjson.br'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive', '2026-08', 'blobs', 'hash_old_1.br'))).toBe(true);

    const archived = db.prepare('SELECT id, archived, archive_path FROM raw_snapshots ORDER BY id').all() as Array<{
      id: number;
      archived: number;
      archive_path: string | null;
    }>;
    expect(archived.filter((r) => r.archived === 1).map((r) => r.id)).toEqual([1, 2]);
    expect(archived.find((r) => r.id === 3)?.archived).toBe(0);
    expect(archived.find((r) => r.id === 1)?.archive_path).toBe('2026-08/snapshots.ndjson.br');
    // 不删除任何数据
    expect(count('raw_snapshots')).toBe(3);
    expect(count('raw_blobs')).toBe(3);
  });

  it('archive 幂等：再次执行不重复归档', async () => {
    const result = await service.archive();
    expect(result.snapshotCount).toBe(0);
    expect(result.months).toEqual([]);
  });

  it('dryRun 不写文件/不改库', async () => {
    // 先把新快照时间也调到 90 天前，验证 dryRun 不会标记
    db.prepare("UPDATE raw_snapshots SET fetched_at = '2026-08-03T00:00:00.000Z' WHERE id = 3").run();
    const result = await service.archive({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.snapshotCount).toBe(1);
    expect(db.prepare('SELECT archived FROM raw_snapshots WHERE id = 3').get()).toMatchObject({ archived: 0 });
    // 复原
    db.prepare("UPDATE raw_snapshots SET fetched_at = '2026-11-10T00:00:00.000Z' WHERE id = 3").run();
  });

  it('listManifests 返回月份摘要', async () => {
    const manifests = await service.listManifests();
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ month: '2026-08', snapshotCount: 2, blobCount: 2 });
    expect(manifests[0]?.bytes).toBeGreaterThan(0);
  });

  it('verify 校验 sha256 通过', async () => {
    const result = await service.verify();
    expect(result.ok).toBe(true);
    expect(result.months[0]).toMatchObject({ month: '2026-08', ok: true });
    expect(result.months[0]?.checkedFiles).toBeGreaterThanOrEqual(3);
  });

  it('verify 检测文件被篡改', async () => {
    const target = path.join(dir, 'archive', '2026-08', 'blobs', 'hash_old_1.br');
    const original = fs.readFileSync(target);
    fs.writeFileSync(target, Buffer.concat([original, Buffer.from('tampered')]));
    const result = await service.verify({ month: '2026-08' });
    expect(result.ok).toBe(false);
    expect(result.months[0]?.problems.some((p) => p.includes('sha256 mismatch') || p.includes('size mismatch'))).toBe(true);
    fs.writeFileSync(target, original);
    expect((await service.verify()).ok).toBe(true);
  });
});

describe('restore', () => {
  it('restore 回填缺失 blob 并把 snapshot 恢复为 hot（幂等）', async () => {
    // 模拟 hot 库丢失（先删 snapshot 解除 FK，再删 blob）
    db.prepare('DELETE FROM raw_snapshots WHERE id IN (1, 2)').run();
    db.prepare("DELETE FROM raw_blobs WHERE hash IN ('hash_old_1', 'hash_old_2')").run();

    const result = await service.restore({ month: '2026-08' });
    expect(result.months).toEqual(['2026-08']);
    expect(result.restoredBlobs).toBe(2);
    expect(result.restoredSnapshots).toBe(2);

    const blob = db.prepare("SELECT hash, body, encoding FROM raw_blobs WHERE hash = 'hash_old_1'").get() as {
      hash: string;
      body: Uint8Array;
      encoding: string;
    };
    expect(blob.hash).toBe('hash_old_1');
    expect(Buffer.from(blob.body).toString()).toBe('old-body-1');
    expect(blob.encoding).toBe('brotli');

    const restored = db.prepare('SELECT id, archived FROM raw_snapshots WHERE id = 2').get() as { id: number; archived: number };
    expect(restored).toMatchObject({ id: 2, archived: 0 });

    const hotCount = db.prepare('SELECT COUNT(*) AS n FROM raw_snapshots WHERE archived = 0').get() as { n?: number };
    expect(Number(hotCount?.n ?? 0)).toBe(3);
    // 归档文件保留（不删除）
    expect(fs.existsSync(path.join(dir, 'archive', '2026-08', 'manifest.json'))).toBe(true);

    // 幂等：再次 restore 不再回填
    const again = await service.restore({ month: '2026-08' });
    expect(again.restoredBlobs).toBe(0);
    expect(again.restoredSnapshots).toBe(0);
  });

  it('restore 未知月份 → NOT_FOUND', async () => {
    await expect(service.restore({ month: '1999-01' })).rejects.toBeInstanceOf(LeadError);
    await expect(service.restore({ month: '1999-01' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('restore dryRun 只统计不写库', async () => {
    db.prepare('DELETE FROM raw_snapshots WHERE id = 3').run();
    db.prepare("DELETE FROM raw_blobs WHERE hash = 'hash_recent'").run();
    const result = await service.restore({ month: '2026-08', dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.restoredBlobs).toBe(0);
    const exists = db.prepare("SELECT hash FROM raw_blobs WHERE hash = 'hash_recent'").get();
    expect(exists).toBeUndefined();
    await service.restore({ month: '2026-08' });
    // 2026-11 的快照不属于归档月份，restore 不会恢复它；手工补回以保持后续断言
    insertBlob('hash_recent', Buffer.from('recent-body'));
    insertSnapshot(3, 'hash_recent', '2026-11-10T00:00:00.000Z');
    expect(db.prepare('SELECT id FROM raw_snapshots WHERE id = 3').get()).toMatchObject({ id: 3 });
  });
});

describe('backup / dbStats', () => {
  it('backup 生成可打开的 SQLite 副本', async () => {
    const result = await service.backup();
    expect(result.ok).toBe(true);
    expect(fs.existsSync(result.path)).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    const copy = new DatabaseSync(result.path);
    try {
      const row = copy.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n?: number };
      expect(Number(row.n)).toBe(1);
      const cells = copy.prepare("SELECT name FROM companies WHERE id = 'cmp_1'").get() as { name?: string };
      expect(cells.name).toContain('测试机械');
    } finally {
      copy.close();
    }
  });

  it('dbStats 返回表行数/体积/归档与备份统计', async () => {
    const stats = await service.dbStats();
    expect(stats.schemaVersion).toBe(1);
    expect(stats.sizeBytes).toBeGreaterThan(0);
    expect(stats.tables.companies).toBe(1);
    expect(stats.tables.raw_snapshots).toBeGreaterThanOrEqual(3);
    expect(stats.archive.months).toBe(1);
    expect(stats.archive.files).toBeGreaterThanOrEqual(2);
    expect(stats.backups.count).toBeGreaterThanOrEqual(1);
  });
});
