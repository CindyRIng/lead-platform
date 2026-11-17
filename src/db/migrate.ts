/** 版本化迁移（幂等；兼容 DatabaseHandle 与原始 DatabaseSync） */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DatabaseSync } from 'node:sqlite';
import type { DatabaseHandle } from './index.js';

const SCHEMA_PATH = fileURLToPath(new URL('./schema.sql', import.meta.url));
export const SCHEMA_VERSION = 2;

type DbLike = DatabaseSync | { raw: DatabaseSync };

function rawDb(db: DbLike): DatabaseSync {
  return 'raw' in db ? db.raw : db;
}

export interface MigrateResult {
  version: number;
  applied: boolean;
}

export function migrate(db: DbLike | DatabaseHandle): MigrateResult {
  const raw = rawDb(db as DbLike);
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  const current = Number(row?.user_version ?? 0);
  if (current >= SCHEMA_VERSION) return { version: current, applied: false };
  const sql = fs.readFileSync(SCHEMA_PATH, 'utf8');
  raw.exec('BEGIN;');
  try {
    raw.exec(sql);
    // v1 -> v2：已有库补齐 verified 列 + 线索/匹配表/触发器（schema.sql 中同时包含）
    const cols = raw.prepare('PRAGMA table_info(companies)').all() as Array<{ name?: string }>;
    if (!cols.some((c) => c.name === 'verified')) {
      raw.exec('ALTER TABLE companies ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;');
      raw.exec('UPDATE companies SET verified = CASE WHEN tanji_company_id IS NOT NULL THEN 1 ELSE 0 END;');
    }
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    raw.exec('COMMIT;');
    return { version: SCHEMA_VERSION, applied: true };
  } catch (err) {
    try { raw.exec('ROLLBACK;'); } catch { /* ignore */ }
    throw err;
  }
}

/** 兼容旧命名 */
export function runMigrations(db: DbLike | DatabaseHandle): void {
  migrate(db);
}

export function currentVersion(db: DbLike | DatabaseHandle): number {
  const raw = rawDb(db as DbLike);
  const row = raw.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function schemaVersion(db: DbLike | DatabaseHandle): number {
  return currentVersion(db);
}
