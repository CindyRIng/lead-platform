/** 结构化日志 + PII 打码（Lead 基线） */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const PHONE_RE = /(?<!\d)(1[3-9]\d{9})(?!\d)/g;
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const ID_RE = /(?<!\d)(\d{17}[\dXx])(?!\d)/g;

export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return value
      .replace(EMAIL_RE, (m) => `${m.slice(0, 2)}***@${m.split('@')[1]}`)
      .replace(PHONE_RE, (m) => `${m.slice(0, 3)}****${m.slice(7)}`)
      .replace(ID_RE, (m) => `${m.slice(0, 6)}********${m.slice(-4)}`);
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/token|secret|password|authorization/i.test(k)) out[k] = '***';
      else out[k] = redact(v);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

let logFile: string | null = null;
let fileBytes = 0;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function ensureLogFile(): void {
  if (logFile) return;
  try {
    const dir = path.join(config.dataDir, 'logs');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    logFile = path.join(dir, 'lead-platform.log');
    try { fileBytes = fs.statSync(logFile).size; } catch { fileBytes = 0; }
  } catch {
    logFile = null;
  }
}

function rotateIfNeeded(): void {
  if (!logFile) return;
  if (fileBytes < MAX_FILE_BYTES) return;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(logFile, `${logFile}.${stamp}`);
    fileBytes = 0;
  } catch {
    /* ignore */
  }
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const base = { ...bindings };
  const write = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[config.logLevel as LogLevel]) return;
    const entry = redact({ ts: new Date().toISOString(), level, msg, ...base, ...(fields ?? {}) });
    const line = JSON.stringify(entry);
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
    ensureLogFile();
    if (logFile) {
      try {
        rotateIfNeeded();
        fs.appendFileSync(logFile, line + '\n');
        fileBytes += Buffer.byteLength(line) + 1;
      } catch {
        /* ignore */
      }
    }
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger({ ...base, ...b }),
  };
}

export const logger: Logger = createLogger({ component: 'lead-platform' });
