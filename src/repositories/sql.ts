/**
 * repositories 通用 SQL helpers（只在本目录内使用）
 *
 * - 统一参数归一化：`undefined -> null`、`boolean -> 0/1`、`Date -> ISO`、
 *   `Buffer -> Uint8Array`、普通对象/数组 -> JSON 文本
 * - 行结果统一按调用方给定的行类型断言（node:sqlite 返回 null-prototype 对象）
 * - 所有 SQL 均由仓库层以字面量 + `?` 占位符构造，禁止把用户输入拼进 SQL
 */
import type { DatabaseSync } from 'node:sqlite';

export type SqlParam = null | number | bigint | string | Uint8Array;
export type SqlValue = null | number | bigint | string | Uint8Array;

/** repositories 依赖的最小数据库连接结构（与 `src/db/index.ts` 的 Database 兼容） */
export interface DbConnection {
  readonly raw: DatabaseSync;
  /** 事务：SQLite BEGIN IMMEDIATE（实现方需支持嵌套 SAVEPOINT） */
  transaction<T>(fn: () => T): T;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

/** 参数归一化（undefined 不能直接绑定，必须转 null） */
export function normalizeParams(params: readonly unknown[]): SqlParam[] {
  return params.map((value) => normalizeParam(value));
}

export function normalizeParam(value: unknown): SqlParam {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'string':
    case 'bigint':
      return value;
    case 'number':
      if (!Number.isFinite(value)) return null;
      return value;
    case 'boolean':
      return value ? 1 : 0;
    case 'object':
      if (Buffer.isBuffer(value)) return value;
      if (value instanceof Uint8Array) return value;
      if (value instanceof Date) return value.toISOString();
      return JSON.stringify(value);
    default:
      throw new Error(`unsupported SQL parameter type: ${typeof value}`);
  }
}

export function all<T>(db: DbConnection, sql: string, params: readonly unknown[] = []): T[] {
  const stmt = db.raw.prepare(sql);
  return stmt.all(...normalizeParams(params)) as unknown as T[];
}

export function one<T>(db: DbConnection, sql: string, params: readonly unknown[] = []): T | null {
  const stmt = db.raw.prepare(sql);
  const row = stmt.get(...normalizeParams(params));
  return (row ?? null) as unknown as T | null;
}

export function run(db: DbConnection, sql: string, params: readonly unknown[] = []): RunResult {
  const stmt = db.raw.prepare(sql);
  const result = stmt.run(...normalizeParams(params));
  return {
    changes: Number(result.changes ?? 0),
    lastInsertRowid: Number(result.lastInsertRowid ?? 0),
  };
}

/** 取第一行第一列（用于 COUNT/MAX 等标量） */
export function scalar<T = number>(db: DbConnection, sql: string, params: readonly unknown[] = []): T | null {
  const stmt = db.raw.prepare(sql);
  const row = stmt.get(...normalizeParams(params)) as Record<string, unknown> | undefined;
  if (!row) return null;
  const keys = Object.keys(row);
  if (keys.length === 0) return null;
  return row[keys[0] as string] as T;
}

export function countRows(db: DbConnection, sql: string, params: readonly unknown[] = []): number {
  const value = scalar<number | bigint>(db, sql, params);
  return Number(value ?? 0);
}

// ---------------------------------------------------------------------------
// JSON 字段（TEXT 存 JSON）
// ---------------------------------------------------------------------------

export function toJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

export function toJsonArray(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function fromJsonArray<T = unknown>(value: unknown): T[] {
  const parsed = fromJson<unknown>(value, []);
  return Array.isArray(parsed) ? (parsed as T[]) : [];
}

export function fromJsonObject(value: unknown): Record<string, unknown> | null {
  const parsed = fromJson<unknown>(value, null);
  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

export function fromJsonUnknown(value: unknown, fallback: unknown = null): unknown {
  return fromJson<unknown>(value, fallback);
}

// ---------------------------------------------------------------------------
// boolean / integer 转换（SQLite 无 boolean）
// ---------------------------------------------------------------------------

export function toDbBool(value: boolean | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return value ? 1 : 0;
}

export function toDbBoolRequired(value: boolean | null | undefined, fallback = false): number {
  if (value === null || value === undefined) return fallback ? 1 : 0;
  return value ? 1 : 0;
}

export function fromDbBool(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return Number(value) !== 0;
}

export function fromDbBoolRequired(value: unknown): boolean {
  return Number(value ?? 0) !== 0;
}

export function fromDbInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return Number(value);
}

export function fromDbIntRequired(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  return Number(value);
}

/** 生成 `?,?,?` 占位符串（空数组返回 NULL，使 `IN (NULL)` 恒不命中） */
export function placeholders(count: number): string {
  if (count <= 0) return 'NULL';
  return new Array(count).fill('?').join(',');
}

/** 去重并过滤空字符串（用于 IN 查询） */
export function uniqueStrings(values: readonly (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) set.add(value);
  }
  return [...set];
}

/** 把数组切成固定大小的块（避免 IN 参数过多 / SQLITE_MAX_VARIABLE_NUMBER） */
export function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

/** 断言行类型（仅类型层面，不做运行时校验） */
export function castRows<T>(rows: unknown[]): T[] {
  return rows as unknown as T[];
}

/** 宽松接受 Date | ISO 字符串的 now 入参 */
export function toDate(value: Date | string | null | undefined, fallback: Date = new Date()): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  return fallback;
}

/** 宽松接受 Date | ISO 字符串 → ISO 字符串 */
export function toIso(value: Date | string | null | undefined, fallback: Date = new Date()): string {
  return toDate(value, fallback).toISOString();
}
