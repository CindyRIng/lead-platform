/**
 * CLI 命令实现：全部映射 REST（默认 http://127.0.0.1:8793）。
 *
 * - 默认输出人读表格/摘要；`--json` 输出与 REST `data` 一致；
 * - 错误码非 0 退出（RestClientError.code 原样输出到 stderr）；
 * - `goal run --wait` 轮询进度；`events tail` 跟随 SSE。
 */
import type { RestClient } from '../api/restClient.js';
import { RestClientError } from '../api/restClient.js';
import { printData, summaryLines, writeJson } from './output.js';

export interface CliRuntime {
  client: RestClient;
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface CommandImpl {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  /** opts key → query 参数名 */
  query?: Record<string, string>;
  /** 额外/计算型 query（如 --enabled/--disabled → enabled=true|false） */
  queryFrom?: (opts: Record<string, unknown>) => Record<string, unknown>;
  /** 请求体构造（POST/PATCH）；返回 undefined 表示无 body */
  body?: (opts: Record<string, unknown>, args: Record<string, string>) => unknown;
  /** 特殊命令（轮询/SSE/摘要输出），返回退出码 */
  special?: (opts: Record<string, unknown>, args: Record<string, string>, runtime: CliRuntime) => Promise<number>;
  /** 非 --json 的摘要输出；缺省用表格/JSON */
  summary?: (data: unknown) => string;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export function csv(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map(String);
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function boolOpt(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return undefined;
  return undefined;
}

function trimOp<const T extends Record<string, unknown>>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (v !== undefined && v !== null && v !== '') out[key] = v;
  }
  return out as T;
}

function keywordMap(opts: Record<string, unknown>): Record<string, string[]> | undefined {
  const keywords: Record<string, string[]> = {};
  const bosses = csv(opts.keywordsBoss);
  const zhilian = csv(opts.keywordsZhilian);
  const ali = csv(opts.keywordsAli);
  if (bosses) keywords.boss = bosses;
  if (zhilian) keywords.zhilian = zhilian;
  if (ali) keywords.ali = ali;
  return Object.keys(keywords).length ? keywords : undefined;
}

function regionOf(opts: Record<string, unknown>): Record<string, unknown> {
  return trimOp({
    province: opts.province,
    cityCodes: csv(opts.cityCodes),
  });
}

function goalCreateBody(opts: Record<string, unknown>): unknown {
  if (typeof opts.name !== 'string' || !opts.name) {
    throw new RestClientError('VALIDATION_ERROR', '--name is required');
  }
  return trimOp({
    name: opts.name,
    region: regionOf(opts),
    platforms: csv(opts.platforms),
    keywords: keywordMap(opts),
    maxLeadsPerRun: num(opts.maxLeads) ?? null,
    dailyLeadLimit: num(opts.dailyLimit) ?? null,
    schedule: trimOp({ cron: opts.cron, timeZone: 'Asia/Shanghai' }),
    priority: num(opts.priority),
    enabled: opts.disabled === true ? false : true,
  });
}

function goalUpdateBody(opts: Record<string, unknown>): unknown {
  const body: Record<string, unknown> = {};
  if (typeof opts.name === 'string') body.name = opts.name;
  if (opts.province !== undefined || opts.cityCodes !== undefined) {
    body.region = trimOp({ province: opts.province, cityCodes: csv(opts.cityCodes) });
  }
  const platforms = csv(opts.platforms);
  if (platforms) body.platforms = platforms;
  const keywords = keywordMap(opts);
  if (keywords) body.keywords = keywords;
  const maxLeads = num(opts.maxLeads);
  if (maxLeads !== undefined) body.maxLeadsPerRun = maxLeads;
  const cron = opts.cron;
  if (typeof cron === 'string') body.schedule = { cron };
  const priority = num(opts.priority);
  if (priority !== undefined) body.priority = priority;
  if (opts.enable === true) body.enabled = true;
  if (opts.disable === true) body.enabled = false;
  const expectedVersion = num(opts.version);
  if (expectedVersion !== undefined) body.expectedVersion = expectedVersion;
  if (Object.keys(body).length === 0) {
    throw new RestClientError('VALIDATION_ERROR', 'no fields to update (use --name/--enable/--disable/--cron/...)');
  }
  return body;
}

/* ------------------------------------------------------------------ */
/* 特殊命令                                                            */
/* ------------------------------------------------------------------ */

const TERMINAL_RUN_STATUSES = new Set(['completed', 'partial', 'failed', 'cancelled']);

async function goalRunWait(
  opts: Record<string, unknown>,
  args: Record<string, string>,
  runtime: CliRuntime,
): Promise<number> {
  const goalId = args.id ?? '';
  const run = (await runtime.client.requestData('POST', `/v1/goals/${encodeURIComponent(goalId)}/run`)) as {
    id?: string;
    status?: string;
  };
  if (runtime.json) {
    writeJson(runtime.out, run);
  } else {
    runtime.out(`Run started: ${String(run.id ?? '?')} status=${String(run.status ?? '?')}`);
  }
  if (opts.wait !== true || !run.id) return 0;
  const intervalSec = num(opts.interval) ?? 5;
  let lastStatus = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, Math.max(1, intervalSec) * 1000));
    const detail = (await runtime.client.requestData('GET', `/v1/runs/${encodeURIComponent(run.id)}`)) as {
      status?: string;
      stats?: unknown;
    };
    const status = String(detail.status ?? '');
    if (status !== lastStatus) {
      lastStatus = status;
      if (!runtime.json) runtime.out(`status=${status}`);
    }
    if (TERMINAL_RUN_STATUSES.has(status)) {
      if (runtime.json) writeJson(runtime.out, detail);
      return 0;
    }
  }
}

async function eventsTail(
  opts: Record<string, unknown>,
  _args: Record<string, string>,
  runtime: CliRuntime,
): Promise<number> {
  const query = trimOp({
    types: typeof opts.types === 'string' ? opts.types : undefined,
    sinceSeq: num(opts.sinceSeq),
    companyId: typeof opts.company === 'string' ? opts.company : undefined,
  });
  const timeoutSec = num(opts.timeout) ?? 0;
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once('SIGINT', onSigint);
  let timer: NodeJS.Timeout | undefined;
  if (timeoutSec > 0) {
    timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  }
  let count = 0;
  try {
    for await (const event of runtime.client.stream('/v1/events/stream', { query, signal: controller.signal })) {
      count++;
      const parsed = event.parsed;
      if (runtime.json) {
        runtime.out(JSON.stringify(parsed ?? event.data));
      } else {
        const rec = (parsed ?? {}) as Record<string, unknown>;
        const seq = rec.seq ?? event.id ?? '?';
        const type = rec.type ?? event.event ?? '?';
        const companyId = rec.companyId ?? '';
        runtime.out(`[${String(seq)}] ${String(type)} ${companyId ? `company=${String(companyId)}` : ''}`.trimEnd());
      }
      if (timeoutSec === 0 && !process.stdout.isTTY && count > 0 && false) break;
    }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      return 0;
    }
    if (err instanceof RestClientError) throw err;
    const message = (err as Error)?.message ?? String(err);
    if (/aborted|abort/i.test(message)) return 0;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    process.off('SIGINT', onSigint);
    controller.abort();
  }
  return 0;
}

async function statusSummary(_opts: Record<string, unknown>, _args: Record<string, string>, runtime: CliRuntime): Promise<number> {
  const data = (await runtime.client.requestData('GET', '/v1/status')) as Record<string, unknown>;
  if (runtime.json) {
    writeJson(runtime.out, data);
    return 0;
  }
  const db = (data.db ?? {}) as Record<string, unknown>;
  const queue = (data.queue ?? {}) as Record<string, unknown>;
  const alerts = Array.isArray(data.alerts) ? (data.alerts as string[]) : [];
  runtime.out(
    summaryLines([
      ['service', data.service],
      ['version', data.version],
      ['uptimeSec', data.uptimeSec],
      ['db', `size=${db.sizeBytes ?? '?'}B schema=${db.schemaVersion ?? '?'} companies=${db.companies ?? '?'}`],
      ['queue', JSON.stringify(queue)],
      ['alerts', alerts.length ? alerts.join('; ') : 'none'],
    ]),
  );
  return 0;
}

async function quotaSummary(_opts: Record<string, unknown>, _args: Record<string, string>, runtime: CliRuntime): Promise<number> {
  const data = (await runtime.client.requestData('GET', '/v1/quota')) as Record<string, unknown>;
  if (runtime.json) {
    writeJson(runtime.out, data);
    return 0;
  }
  const layer = (value: unknown): string => {
    const rec = (value ?? {}) as Record<string, unknown>;
    return `used=${rec.used ?? '?'}/${rec.limit ?? '?'} remaining=${rec.remaining ?? '?'} ${rec.unit ?? ''}`.trim();
  };
  runtime.out(
    summaryLines([
      ['daily', layer(data.daily)],
      ['monthly', layer(data.monthly)],
      ['enterpriseMonthly', layer(data.enterpriseMonthly)],
      ['settlementDay', data.settlementDay],
      ['nearlySevenDayUnlockCount', data.nearlySevenDayUnlockCount],
      ['observedAt', data.observedAt],
      ['alerts', Array.isArray(data.alerts) && data.alerts.length ? (data.alerts as string[]).join('; ') : 'none'],
    ]),
  );
  return 0;
}

async function sourcesSummary(_opts: Record<string, unknown>, _args: Record<string, string>, runtime: CliRuntime): Promise<number> {
  const data = await runtime.client.requestData('GET', '/v1/sources');
  printData(runtime.out, data, runtime.json);
  return 0;
}

/* ------------------------------------------------------------------ */
/* 命令实现表（key = CLI_COMMANDS.path）                                 */
/* ------------------------------------------------------------------ */

const IMPLS: Record<string, CommandImpl> = {
  status: { method: 'GET', path: '/v1/status', special: statusSummary },
  quota: { method: 'GET', path: '/v1/quota', special: quotaSummary },
  sources: { method: 'GET', path: '/v1/sources', special: sourcesSummary },
  stats: { method: 'GET', path: '/v1/stats', query: { kind: 'kind', from: 'from', to: 'to', runId: 'runId' } },

  'goal list': {
    method: 'GET',
    path: '/v1/goals',
    query: { limit: 'limit', offset: 'offset' },
    queryFrom: (opts) => {
      if (opts.enabled === true) return { enabled: true };
      if (opts.disabled === true) return { enabled: false };
      return {};
    },
  },
  'goal show <id>': { method: 'GET', path: '/v1/goals/:id' },
  'goal create': { method: 'POST', path: '/v1/goals', body: goalCreateBody },
  'goal update <id>': { method: 'PATCH', path: '/v1/goals/:id', body: goalUpdateBody },
  'goal run <id>': { method: 'POST', path: '/v1/goals/:id/run', special: goalRunWait },
  'goal runs <id>': { method: 'GET', path: '/v1/goals/:id/runs', query: { limit: 'limit', offset: 'offset' } },

  'run list': { method: 'GET', path: '/v1/runs', query: { goal: 'goalId', status: 'status', limit: 'limit', offset: 'offset' } },
  'run show <id>': { method: 'GET', path: '/v1/runs/:id' },
  'run cancel <id>': { method: 'POST', path: '/v1/runs/:id/cancel' },

  'company list': {
    method: 'GET',
    path: '/v1/companies',
    query: {
      province: 'province',
      city: 'city',
      platform: 'platform',
      unlockStatus: 'unlockStatus',
      enrichmentStatus: 'enrichmentStatus',
      q: 'q',
      updatedSince: 'updatedSince',
      limit: 'limit',
      cursor: 'cursor',
    },
  },
  'company show <id>': { method: 'GET', path: '/v1/companies/:id', query: { include: 'include' } },
  'company sources <id>': { method: 'GET', path: '/v1/companies/:id/sources' },
  'company contacts <id>': {
    method: 'GET',
    path: '/v1/companies/:id/contacts',
    query: { type: 'type', unlockedOnly: 'unlockedOnly', limit: 'limit' },
  },
  'company changes <id>': {
    method: 'GET',
    path: '/v1/companies/:id/changes',
    query: { sinceVersion: 'sinceVersion', limit: 'limit' },
  },
  'company snapshots <id>': {
    method: 'GET',
    path: '/v1/companies/:id/snapshots',
    query: { kind: 'kind', platform: 'platform', limit: 'limit', cursor: 'cursor' },
  },
  'company platforms <id>': { method: 'GET', path: '/v1/companies/:id/platforms' },
  'company platform <id> <platform>': { method: 'GET', path: '/v1/companies/:id/platforms/:platform' },
  'company jobs <id> <platform>': {
    method: 'GET',
    path: '/v1/companies/:id/platforms/:platform/jobs',
    query: { status: 'status', limit: 'limit', cursor: 'cursor' },
  },
  'company platform-changes <id> <platform>': {
    method: 'GET',
    path: '/v1/companies/:id/platforms/:platform/changes',
    query: { sinceVersion: 'sinceVersion', limit: 'limit' },
  },
  'company refresh <id>': {
    method: 'POST',
    path: '/v1/companies/:id/refresh',
    body: (opts) => trimOp({ platforms: csv(opts.platforms), kinds: csv(opts.kinds) }),
  },
  'company customs <id>': { method: 'GET', path: '/v1/companies/:id/customs' },
  'company customs-refresh <id>': { method: 'POST', path: '/v1/companies/:id/customs/refresh' },
  'company rematch <id>': {
    method: 'POST',
    path: '/v1/companies/:id/rematch',
    body: (opts) => trimOp({ force: boolOpt(opts.force) }),
  },
  'company unlock <id>': {
    method: 'POST',
    path: '/v1/companies/:id/unlock',
    body: (opts) => trimOp({ idempotencyKey: opts.idempotencyKey }),
  },

  changes: {
    method: 'GET',
    path: '/v1/changes',
    query: {
      sinceSeq: 'sinceSeq',
      types: 'types',
      company: 'companyId',
      limit: 'limit',
      cursor: 'cursor',
    },
  },
  'events tail': { method: 'GET', path: '/v1/events/stream', special: eventsTail },

  'webhook list': { method: 'GET', path: '/v1/webhooks' },
  'webhook create': {
    method: 'POST',
    path: '/v1/webhooks',
    body: (opts) => {
      const eventTypes = csv(opts.events);
      if (!eventTypes) throw new RestClientError('VALIDATION_ERROR', '--events is required');
      return trimOp({
        url: opts.url,
        eventTypes,
        secret: opts.secret,
        description: opts.description,
      });
    },
  },
  'webhook update <id>': {
    method: 'PATCH',
    path: '/v1/webhooks/:id',
    body: (opts) => {
      const body: Record<string, unknown> = trimOp({
        url: opts.url,
        eventTypes: csv(opts.events),
      });
      if (opts.enable === true) body.active = true;
      if (opts.disable === true) body.active = false;
      if (Object.keys(body).length === 0) throw new RestClientError('VALIDATION_ERROR', 'no fields to update');
      return body;
    },
  },
  'webhook delete <id>': { method: 'DELETE', path: '/v1/webhooks/:id' },
  'webhook deliveries <id>': {
    method: 'GET',
    path: '/v1/webhooks/:id/deliveries',
    query: { status: 'status', limit: 'limit', cursor: 'cursor' },
  },
  'webhook replay <id> <deliveryId>': {
    method: 'POST',
    path: '/v1/webhooks/:id/deliveries/:deliveryId/replay',
  },

  'job list': {
    method: 'GET',
    path: '/v1/jobs',
    query: { status: 'status', stage: 'stage', company: 'companyId', limit: 'limit', cursor: 'cursor' },
  },
  'job show <id>': { method: 'GET', path: '/v1/jobs/:id' },
  'job retry <id>': { method: 'POST', path: '/v1/jobs/:id/retry' },

  'admin backup': { method: 'POST', path: '/v1/admin/backup' },
  'admin archive': {
    method: 'POST',
    path: '/v1/admin/archive',
    body: (opts) => trimOp({ afterDays: num(opts.afterDays), dryRun: boolOpt(opts.dryRun) }),
  },
  'admin manifests': { method: 'GET', path: '/v1/admin/archive/manifests' },
  'admin verify': { method: 'GET', path: '/v1/admin/verify', query: { month: 'month' } },
  'admin restore': {
    method: 'POST',
    path: '/v1/admin/restore',
    body: (opts) => trimOp({ month: opts.month, dryRun: boolOpt(opts.dryRun) }),
  },
  'admin db-stats': { method: 'GET', path: '/v1/admin/db-stats' },
};

export function implFor(commandPath: string): CommandImpl {
  const impl = IMPLS[commandPath];
  if (!impl) throw new Error(`CLI command not implemented: ${commandPath}`);
  return impl;
}

export function listImplementedCommands(): string[] {
  return Object.keys(IMPLS);
}

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

function buildPathParams(impl: CommandImpl, positional: string[]): Record<string, string> {
  const names = Array.from(impl.path.matchAll(/:([A-Za-z0-9_]+)/g)).map((m) => m[1] as string);
  const args: Record<string, string> = {};
  names.forEach((name, index) => {
    const value = positional[index];
    if (value === undefined || value === '') {
      throw new RestClientError('VALIDATION_ERROR', `missing required argument: ${name}`, {
        details: { argument: name },
      });
    }
    args[name] = value;
  });
  return args;
}

function substitutePath(impl: CommandImpl, args: Record<string, string>): string {
  let path = impl.path;
  for (const [name, value] of Object.entries(args)) {
    path = path.replace(`:${name}`, encodeURIComponent(value));
  }
  return path;
}

function buildQuery(impl: CommandImpl, opts: Record<string, unknown>): Record<string, unknown> {
  const query: Record<string, unknown> = { ...(impl.queryFrom?.(opts) ?? {}) };
  for (const [optKey, queryKey] of Object.entries(impl.query ?? {})) {
    const value = opts[optKey];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'boolean') query[queryKey] = value;
    else if (typeof value === 'number') query[queryKey] = value;
    else query[queryKey] = String(value);
  }
  return query;
}

export async function executeCommand(
  commandPath: string,
  positional: string[],
  opts: Record<string, unknown>,
  runtime: CliRuntime,
): Promise<number> {
  const impl = implFor(commandPath);
  const args = buildPathParams(impl, positional);
  if (impl.special) return impl.special(opts, args, runtime);

  const method = impl.method;
  const body = method === 'GET' || method === 'DELETE' ? undefined : impl.body ? impl.body(opts, args) : undefined;
  const data = await runtime.client.requestData(method, substitutePath(impl, args), {
    query: buildQuery(impl, opts),
    body,
  });
  if (runtime.json) {
    writeJson(runtime.out, data);
  } else if (impl.summary) {
    runtime.out(impl.summary(data));
  } else {
    printData(runtime.out, data, false);
  }
  return 0;
}
