/** CLI 输出工具：--json 输出与 REST data 一致；默认人读表格/摘要。 */

export interface OutputStreams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export function writeJson(out: (s: string) => void, value: unknown): void {
  out(JSON.stringify(value ?? null, null, 2));
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
  }
  return String(value);
}

/** 简单等宽表格 */
export function renderTable(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (!rows.length) return '(empty)';
  const keys = columns ?? Object.keys(rows[0] ?? {}).slice(0, 8);
  const widths = keys.map((key) => Math.max(key.length, ...rows.map((r) => cell(r[key]).length)));
  const line = (values: string[]): string =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i] ?? v.length)))
      .join('  ')
      .trimEnd();
  const header = line(keys);
  const divider = line(keys.map((_k, i) => '-'.repeat(widths[i] ?? 0)));
  const body = rows.map((row) => line(keys.map((key) => cell(row[key]))));
  return [header, divider, ...body].join('\n');
}

/** 列表视图：数组或 {items:[...]}；否则退回 JSON */
export function renderList(value: unknown): string | null {
  if (Array.isArray(value)) {
    return renderTable(value.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>);
  }
  if (value && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    if (Array.isArray(rec.items)) {
      const rows = rec.items.filter((v) => v && typeof v === 'object') as Array<Record<string, unknown>>;
      const table = renderTable(rows);
      const extra: string[] = [];
      if (typeof rec.total === 'number') extra.push(`total=${rec.total}`);
      if (rec.nextCursor !== undefined && rec.nextCursor !== null) extra.push(`nextCursor=${String(rec.nextCursor)}`);
      if (rec.nextSeq !== undefined) extra.push(`nextSeq=${String(rec.nextSeq)}`);
      if (rec.hasMore !== undefined) extra.push(`hasMore=${String(rec.hasMore)}`);
      return extra.length ? `${table}\n(${extra.join(', ')})` : table;
    }
  }
  return null;
}

export function printData(out: (s: string) => void, data: unknown, json: boolean): void {
  if (json) {
    writeJson(out, data);
    return;
  }
  const list = renderList(data);
  if (list !== null) {
    out(list);
    return;
  }
  writeJson(out, data);
}

/** 摘要行（status/quota 等） */
export function summaryLines(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join('\n');
}
