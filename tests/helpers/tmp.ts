/**
 * 临时数据目录/DB helper。
 *
 * 每个测试用例（或验收脚本）使用独立的临时目录，避免污染 `~/.lead-platform/`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TempSandbox {
  /** 临时根目录（0700） */
  dir: string;
  /** SQLite 数据库文件 */
  dbPath: string;
  /** 原始快照归档目录 */
  archiveDir: string;
  /** 备份目录 */
  backupDir: string;
  /** 日志目录 */
  logsDir: string;
  cleanup(): void;
}

export function createTempSandbox(prefix = 'lead-test-'): TempSandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  const sandbox: TempSandbox = {
    dir,
    dbPath: path.join(dir, 'lead.db'),
    archiveDir: path.join(dir, 'archive'),
    backupDir: path.join(dir, 'backups'),
    logsDir: path.join(dir, 'logs'),
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  for (const d of [sandbox.archiveDir, sandbox.backupDir, sandbox.logsDir]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return sandbox;
}

/** 判断目录是否为空（用于断言「未写入真实数据目录」） */
export function isEmptyDir(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
