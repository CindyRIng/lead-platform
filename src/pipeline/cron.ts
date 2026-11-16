/**
 * 最小 cron 表达式解析（5 字段：分 时 日 月 周）。
 *
 * 一期调度只需要「每日 hh:mm」类表达式（默认 `0 2 * * *` Asia/Shanghai）；
 * 为支持 Goal 自定义 cron 与手动触发，这里实现一个无依赖的最小解析器：
 * - 支持 `*`、数字、逗号列表、区间 a-b、步长 *\/n 与 a-b/n；
 * - 周字段 0/7 = 周日；一期只做「下一次触发时间」计算（分钟级 tick）。
 */
export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number> | null;
  month: Set<number> | null;
  dayOfWeek: Set<number> | null;
}

export interface ParsedCron {
  expression: string;
  fields: CronFields;
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 7 },
];

function parseField(text: string, spec: { name: string; min: number; max: number }, original: string): Set<number> | null {
  if (text === '*') return null;
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`cron 表达式非法（${spec.name} 步长）：${original}`);
    }
    let start: number;
    let end: number;
    if (rangePart === '*') {
      start = spec.min;
      end = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(rangePart);
      end = stepPart ? spec.max : start;
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < spec.min || end > spec.max || start > end) {
      throw new Error(`cron 表达式非法（${spec.name} 取值）：${original}`);
    }
    for (let v = start; v <= end; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`cron 表达式非法（${spec.name} 为空）：${original}`);
  return values;
}

export function parseCron(expression: string): ParsedCron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron 表达式必须是 5 字段（分 时 日 月 周）：${expression}`);
  const fields = {} as CronFields;
  FIELDS.forEach((spec, index) => {
    const text = parts[index] ?? '*';
    (fields as unknown as Record<string, Set<number> | null>)[spec.name] = parseField(text, spec, expression);
  });
  // 周字段：0 与 7 都表示周日
  const dow = fields.dayOfWeek;
  if (dow && dow.has(7)) dow.add(0);
  return { expression, fields };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

/**
 * 计算 from 之后的下一次触发时间（UTC 毫秒）。
 * 以目标时区本地时间逐分钟推进（最多 400 天）；调用方负责将本地时间与 UTC 互转。
 */
export function nextCronTick(parsed: ParsedCron, fromDate: Date, timeZone: string, maxLookaheadDays = 400): Date {
  const { fields } = parsed;
  const start = new Date(fromDate.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() + 1);
  for (let i = 0; i < maxLookaheadDays * 24 * 60; i++) {
    const parts = localParts(start, timeZone);
    const minuteOk = !fields.minute || fields.minute.has(parts.minute);
    const hourOk = !fields.hour || fields.hour.has(parts.hour);
    const domOk = !fields.dayOfMonth || fields.dayOfMonth.has(parts.day);
    const monthOk = !fields.month || fields.month.has(parts.m);
    const dowOk = !fields.dayOfWeek || fields.dayOfWeek.has(parts.dayOfWeek);
    if (minuteOk && hourOk && domOk && monthOk && dowOk) return start;
    start.setUTCMinutes(start.getUTCMinutes() + 1);
  }
  throw new Error(`cron 表达式在 ${maxLookaheadDays} 天内无触发时间：${parsed.expression}`);
}

export interface LocalDateParts {
  y: number;
  m: number;
  day: number;
  h: number;
  minute: number;
  dayOfWeek: number;
}

/** 取指定时区的年月日时分与星期（1=周一 … 7=周日；0=周日兼容 cron 用 dowCron） */
export function localParts(d: Date, timeZone: string): { y: number; m: number; day: number; hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  const map: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) map[part.type] = part.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(map.year),
    m: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour === '24' ? '0' : map.hour),
    minute: Number(map.minute),
    dayOfWeek: weekdayMap[map.weekday ?? 'Sun'] ?? 0,
  };
}

/** 解析 `HH:MM-HH:MM` 时间窗；非法返回 null */
export function parseTimeWindow(text: string | null | undefined): { startMinute: number; endMinute: number } | null {
  if (!text) return null;
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const [, sh, sm, eh, em] = m;
  const startMinute = Number(sh) * 60 + Number(sm);
  const endMinute = Number(eh) * 60 + Number(em);
  if (startMinute < 0 || startMinute > 1439 || endMinute < 0 || endMinute > 1439) return null;
  return { startMinute, endMinute };
}

/** 当前本地分钟是否在时间窗内（支持跨零点，如 22:00-06:00） */
export function isWithinTimeWindow(windowText: string | null | undefined, d: Date, timeZone: string): boolean {
  const win = parseTimeWindow(windowText);
  if (!win) return true;
  const parts = localParts(d, timeZone);
  const current = parts.hour * 60 + parts.minute;
  if (win.startMinute <= win.endMinute) return current >= win.startMinute && current <= win.endMinute;
  return current >= win.startMinute || current <= win.endMinute;
}
