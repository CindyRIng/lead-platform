/**
 * 通用 SQL WHERE 构造 helpers（仅 repositories 使用）
 *
 * 安全约定：
 * - 列名/SQL 片段来自仓库层代码字面量（`assertIdentifier` 兜底），不是用户输入
 * - 所有值一律走 `?` 绑定，`like` 自动转义 `% _ \`
 * - 不提供「把任意字符串拼进 SQL」的入口；`raw()` 仅供仓库内部使用
 */
import { LeadError } from '../shared/errors.js';

export type WhereParam = null | number | bigint | string | Uint8Array;

export interface WhereClause {
  sql: string;
  params: WhereParam[];
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/** 校验列名/表列标识符（防御性；仓库层仍应使用字面量） */
export function assertIdentifier(identifier: string): string {
  if (!IDENTIFIER_RE.test(identifier)) {
    throw new Error(`invalid SQL identifier: ${identifier}`);
  }
  return identifier;
}

/** 转义 LIKE 通配符（配合 `ESCAPE '\'`） */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

function toStrings(values: readonly unknown[]): WhereParam[] {
  return values.map((v) => (v === undefined ? null : (v as WhereParam)));
}

export class WhereBuilder {
  private readonly parts: string[] = [];
  private readonly params: WhereParam[] = [];

  /** 追加原始条件片段（仓库内部使用；值用 ? 占位） */
  raw(sql: string, ...params: unknown[]): this {
    if (sql.trim().length === 0) return this;
    this.parts.push(sql);
    this.params.push(...toStrings(params));
    return this;
  }

  eq(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} = ?`);
    this.params.push(value === undefined ? null : (value as WhereParam));
    return this;
  }

  ne(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} <> ?`);
    this.params.push(value === undefined ? null : (value as WhereParam));
    return this;
  }

  isNull(column: string): this {
    assertIdentifier(column);
    this.parts.push(`${column} IS NULL`);
    return this;
  }

  isNotNull(column: string): this {
    assertIdentifier(column);
    this.parts.push(`${column} IS NOT NULL`);
    return this;
  }

  gt(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} > ?`);
    this.params.push(value as WhereParam);
    return this;
  }

  gte(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} >= ?`);
    this.params.push(value as WhereParam);
    return this;
  }

  lt(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} < ?`);
    this.params.push(value as WhereParam);
    return this;
  }

  lte(column: string, value: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} <= ?`);
    this.params.push(value as WhereParam);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    assertIdentifier(column);
    const list = values.filter((v) => v !== undefined && v !== null);
    if (list.length === 0) {
      this.parts.push('1 = 0');
      return this;
    }
    this.parts.push(`${column} IN (${list.map(() => '?').join(',')})`);
    this.params.push(...(list as WhereParam[]));
    return this;
  }

  notIn(column: string, values: readonly unknown[]): this {
    assertIdentifier(column);
    const list = values.filter((v) => v !== undefined && v !== null);
    if (list.length === 0) return this;
    this.parts.push(`${column} NOT IN (${list.map(() => '?').join(',')})`);
    this.params.push(...(list as WhereParam[]));
    return this;
  }

  /** LIKE 包含匹配（自动转义） */
  contains(column: string, value: string, caseInsensitive = true): this {
    assertIdentifier(column);
    const pattern = `%${escapeLikePattern(value)}%`;
    this.parts.push(
      caseInsensitive
        ? `${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`
        : `${column} LIKE ? ESCAPE '\\'`,
    );
    this.params.push(pattern);
    return this;
  }

  startsWith(column: string, value: string): this {
    assertIdentifier(column);
    this.parts.push(`${column} LIKE ? ESCAPE '\\'`);
    this.params.push(`${escapeLikePattern(value)}%`);
    return this;
  }

  between(column: string, from: unknown, to: unknown): this {
    assertIdentifier(column);
    this.parts.push(`${column} BETWEEN ? AND ?`);
    this.params.push(from as WhereParam, to as WhereParam);
    return this;
  }

  /** 子查询 EXISTS（片段由仓库内部书写） */
  exists(sqlFragment: string, ...params: unknown[]): this {
    this.parts.push(`EXISTS (${sqlFragment})`);
    this.params.push(...toStrings(params));
    return this;
  }

  /** 分组：callback 内的条件用 OR 连接后整体加括号 */
  orGroup(callback: (builder: WhereBuilder) => void): this {
    const nested = new WhereBuilder();
    callback(nested);
    const clause = nested.build();
    if (clause.sql) {
      this.parts.push(`(${clause.sql})`);
      this.params.push(...clause.params);
    }
    return this;
  }

  isEmpty(): boolean {
    return this.parts.length === 0;
  }

  build(): WhereClause {
    return { sql: this.parts.join(' AND '), params: [...this.params] };
  }

  /** 返回 ` WHERE ...` 或空串 */
  toWhereSql(): string {
    const clause = this.build();
    return clause.sql ? ` WHERE ${clause.sql}` : '';
  }
}

export function buildWhere(): WhereBuilder {
  return new WhereBuilder();
}

/** 分页片段：`LIMIT ? OFFSET ?` 校验后的整数 */
export function limitOffset(limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new LeadError('VALIDATION_ERROR', 'invalid limit/offset');
  }
  return `LIMIT ${limit} OFFSET ${offset}`;
}
