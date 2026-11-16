/** ISO 时间工具（冻结） */
export function nowIso(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

export function isoPlusDays(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86400_000).toISOString();
}

export function isoPlusMinutes(minutes: number, from = new Date()): string {
  return new Date(from.getTime() + minutes * 60_000).toISOString();
}

export function isoPlusSeconds(seconds: number, from = new Date()): string {
  return new Date(from.getTime() + seconds * 1000).toISOString();
}

/** Asia/Shanghai 的当天 02:00 等：返回下一个调度时间（简单实现，cron 由 scheduler 负责） */
export function shanghaiParts(d = new Date()): { y: number; m: number; day: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), day: Number(parts.day), h: Number(parts.hour === '24' ? '0' : parts.hour), min: Number(parts.minute) };
}

export function isPast(iso: string | null | undefined, now = new Date()): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return Number.isFinite(t) && t <= now.getTime();
}
