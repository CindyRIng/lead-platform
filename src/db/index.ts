/** SQLite 连接与初始化（Lead 基线）
 * DatabaseHandle 同时兼容 node:sqlite 直用与 repos 注入（raw/transaction）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config, ensureConfigDirs } from '../config.js';
import { migrate } from './migrate.js';
import { logger } from '../logger.js';

export class DatabaseHandle {
  readonly raw: DatabaseSync;
  private depth = 0;

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  /** 事务：BEGIN IMMEDIATE + 嵌套 SAVEPOINT */
  transaction<T>(fn: () => T): T {
    const savepoint = `sp_${this.depth}`;
    if (this.depth === 0) this.raw.exec('BEGIN IMMEDIATE;');
    else this.raw.exec(`SAVEPOINT ${savepoint};`);
    this.depth++;
    try {
      const result = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec('COMMIT;');
      else this.raw.exec(`RELEASE ${savepoint};`);
      return result;
    } catch (err) {
      this.depth--;
      try {
        if (this.depth === 0) this.raw.exec('ROLLBACK;');
        else this.raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`);
      } catch { /* ignore */ }
      throw err;
    }
  }

  prepare(sql: string) { return this.raw.prepare(sql); }
  exec(sql: string): void { this.raw.exec(sql); }
  close(): void { this.raw.close(); }
}

export type Db = DatabaseSync;
export type Database = DatabaseHandle;

let singleton: DatabaseHandle | null = null;

export interface OpenOptions {
  file?: string;
  migrate?: boolean;
}

export function openDatabase(fileOrOpts: string | OpenOptions = {}): DatabaseHandle {
  const opts: OpenOptions = typeof fileOrOpts === 'string' ? { file: fileOrOpts } : fileOrOpts;
  const file = opts.file ?? config.dbPath ?? path.join(config.dataDir, 'lead.db');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = new DatabaseHandle(file);
  if (opts.migrate !== false) migrate(handle);
  return handle;
}

export function openMemoryDatabase(opts: { migrate?: boolean } = {}): DatabaseHandle {
  const handle = new DatabaseHandle(':memory:');
  if (opts.migrate !== false) migrate(handle);
  return handle;
}

export function initDatabase(file?: string): DatabaseHandle {
  ensureConfigDirs(config);
  singleton = openDatabase(file ? { file } : {});
  logger.info('database initialized', { file: file ?? config.dbPath });
  return singleton;
}

export function getDb(): DatabaseHandle {
  if (!singleton) singleton = initDatabase();
  return singleton;
}

export function setDb(db: DatabaseHandle | null): void {
  singleton = db;
}

export function closeDb(): void {
  if (singleton) {
    try { singleton.close(); } catch { /* ignore */ }
    singleton = null;
  }
}

export function dbSizeBytes(file?: string): number {
  const f = file ?? config.dbPath ?? path.join(config.dataDir, 'lead.db');
  try {
    let total = fs.statSync(f).size;
    for (const suffix of ['-wal', '-shm']) {
      try { total += fs.statSync(f + suffix).size; } catch { /* ignore */ }
    }
    return total;
  } catch {
    return 0;
  }
}
