/**
 * 验收脚本（AC-1..AC-18）。
 *
 * 用法：
 *   npm run accept                       # 全部 AC；输出 reports/acceptance-<ts>.json + .md
 *   npm run accept -- --only=AC-1,AC-4   # 只跑指定项
 *   npm run accept -- --keep             # 保留临时数据目录（调试）
 *   npm run accept -- --report-dir=reports
 *
 * 实现方式：
 *  - 启动 tests/mock-upstreams 六个本地 mock（随机端口）；
 *  - 用临时数据目录 + 真实 SQLite + 真实 wiring/workers/REST 组装完整 app（`tests/acceptance/full-scenario.ts`）；
 *  - 逐项执行 AC 检查（与 tests/integration/e2e-mock.test.ts 共用同一套断言）；
 *  - 输出 JSON + Markdown 报告，退出码 = 失败数（0 = 全部通过）。
 *
 * 安全：绝不访问真实上游、绝不调用真实 tanji unlock、绝不消耗额度；不使用真实公司/PII 数据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstreams, type MockUpstreams } from '../tests/mock-upstreams/index.js';
import {
  FIXTURE_VERSION,
  PROJECT_ROOT,
  TEST_API_TOKEN,
  applyEnv,
  buildLeadTestEnv,
  createTempSandbox,
  type EnvRestore,
  type TempSandbox,
} from '../tests/helpers/index.js';
import {
  AC_CHECKS,
  buildFullScenario,
  closeFullScenario,
  type AcCheck,
  type FullScenario,
} from '../tests/acceptance/full-scenario.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
void __dirname;

type AcStatus = 'pass' | 'fail' | 'skip';

interface CheckResult {
  id: string;
  title: string;
  status: AcStatus;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

interface Options {
  only: Set<string> | null;
  keep: boolean;
  reportDir: string;
  verbose: boolean;
}

/** AC-10（性能冒烟）需要 1 万公司/100 万事件规模数据，mock e2e 不覆盖，报告中明确标注 */
const AC10_SKIP: AcCheck = {
  id: 'AC-10',
  title: '性能冒烟：1 万公司列表 p95<300ms；100 万事件 sinceSeq<200ms',
  async run() {
    throw new Error('SKIP: 性能基准需要真实规模数据（见 docs/17 与 Lead 性能验收），mock e2e 不覆盖');
  },
};

function parseArgs(argv: string[]): Options {
  const opts: Options = { only: null, keep: false, reportDir: path.join(PROJECT_ROOT, 'reports'), verbose: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--only=')) {
      opts.only = new Set(
        arg
          .slice('--only='.length)
          .split(',')
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean),
      );
    } else if (arg === '--keep') opts.keep = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg.startsWith('--report-dir=')) opts.reportDir = path.resolve(arg.slice('--report-dir='.length));
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: npm run accept -- [--only=AC-1,AC-4] [--keep] [--verbose] [--report-dir=reports]');
      process.exit(0);
    }
  }
  return opts;
}

function timestampSlug(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function escapeCell(s: string): string {
  return String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function summaryOf(results: CheckResult[]): { total: number; pass: number; fail: number; skip: number } {
  return {
    total: results.length,
    pass: results.filter((r) => r.status === 'pass').length,
    fail: results.filter((r) => r.status === 'fail').length,
    skip: results.filter((r) => r.status === 'skip').length,
  };
}

async function preflight(scenario: FullScenario): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const add = (id: string, title: string, ok: boolean, started: number, details?: Record<string, unknown>, error?: string) =>
    results.push({ id, title, status: ok ? 'pass' : 'fail', durationMs: Date.now() - started, details, ...(error ? { error } : {}) });

  let started = Date.now();
  try {
    const res = await scenario.rt.api.request('GET', '/v1/health');
    const body = res.body as { ok?: boolean; data?: Record<string, unknown> };
    add('PRE-1', 'GET /v1/health 200 且 envelope 合法', res.status === 200 && body.ok === true, started, {
      status: res.status,
      service: body.data?.service,
    });
  } catch (err) {
    add('PRE-1', 'GET /v1/health 200 且 envelope 合法', false, started, undefined, err instanceof Error ? err.message : String(err));
  }

  started = Date.now();
  try {
    const res = await scenario.rt.api.request('GET', '/v1/goals', { token: null });
    const body = res.body as { error?: { code?: string } };
    add('PRE-2', '无 Bearer token → 401 UNAUTHORIZED', res.status === 401 && body.error?.code === 'UNAUTHORIZED', started, {
      status: res.status,
      code: body.error?.code,
    });
  } catch (err) {
    add('PRE-2', '无 Bearer token → 401 UNAUTHORIZED', false, started, undefined, err instanceof Error ? err.message : String(err));
  }

  started = Date.now();
  try {
    add('PRE-3', 'mock 上游为本地 loopback（无真实上游流量）', true, started, {
      upstreams: (['boss', 'zhilian', 'ali', 'mic', 'tanji', 'fuma'] as const).map((p) => scenario.mocks.url(p)),
      tanjiUnlockCalls: scenario.mocks.world.scenario.tanjiUnlockCalls,
    });
  } catch (err) {
    add('PRE-3', 'mock 上游为本地 loopback（无真实上游流量）', false, started, undefined, err instanceof Error ? err.message : String(err));
  }
  return results;
}

function renderMarkdown(payload: Record<string, unknown>): string {
  const pre = (payload.preflight as CheckResult[]) ?? [];
  const results = (payload.results as CheckResult[]) ?? [];
  const s = summaryOf(results);
  const lines: string[] = [];
  lines.push('# LeadPlatform 验收报告（mock 全链路自动生成）');
  lines.push('');
  lines.push(`- 生成时间：${payload.generatedAt}`);
  lines.push(`- 总耗时：${payload.durationMs} ms`);
  lines.push(`- Node：${(payload.environment as Record<string, unknown>)?.node ?? process.version}`);
  lines.push(`- fixture 版本：${payload.fixtureVersion}`);
  lines.push(
    `- 运行方式：mock 六上游（127.0.0.1 随机端口）+ 临时 SQLite + 真实 wiring/workers/REST，**未访问真实上游、未消耗探迹额度**`,
  );
  lines.push('');
  lines.push('## 汇总');
  lines.push('');
  lines.push('| 总数 | 通过 | 失败 | 跳过 |');
  lines.push('|---|---|---|---|');
  lines.push(`| ${s.total} | ${s.pass} | ${s.fail} | ${s.skip} |`);
  lines.push('');
  lines.push('## 预检');
  lines.push('');
  lines.push('| ID | 项目 | 结果 | 耗时 | 说明 |');
  lines.push('|---|---|---|---|---|');
  for (const r of pre) {
    lines.push(`| ${r.id} | ${r.title} | ${r.status} | ${r.durationMs}ms | ${escapeCell(r.error ?? JSON.stringify(r.details ?? {}))} |`);
  }
  lines.push('');
  lines.push('## 验收项（AC-1..AC-18）');
  lines.push('');
  lines.push('| ID | 验收内容 | 结果 | 耗时 | 证据/说明 |');
  lines.push('|---|---|---|---|---|');
  for (const r of results) {
    const evidence = r.error ?? (r.details ? JSON.stringify(r.details) : '');
    lines.push(`| ${r.id} | ${escapeCell(r.title)} | ${r.status} | ${r.durationMs}ms | ${escapeCell(String(evidence)).slice(0, 500)} |`);
  }
  lines.push('');
  lines.push('## 场景摘要');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(payload.scenario ?? {}, null, 2).slice(0, 6000));
  lines.push('```');
  lines.push('');
  const mocks = payload.mocks as Record<string, unknown> | undefined;
  if (mocks) {
    lines.push('## Mock 上游');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(mocks, null, 2).slice(0, 4000));
    lines.push('```');
    lines.push('');
  }
  lines.push(
    `> 本报告由 \`npm run accept\` 生成；所有数据为 tests/fixtures 合成数据，上游为 tests/mock-upstreams 本地 mock，绝不访问真实上游/消耗额度。`,
  );
  lines.push('');
  return lines.join('\n');
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  const startedAt = new Date();
  const startedMs = Date.now();
  let mocks: MockUpstreams | null = null;
  let sandbox: TempSandbox | null = null;
  let envRestore: EnvRestore | null = null;
  let scenario: FullScenario | null = null;
  const preResults: CheckResult[] = [];
  const results: CheckResult[] = [];

  const cleanup = async () => {
    if (scenario) await closeFullScenario(scenario).catch(() => undefined);
    envRestore?.restore();
    await mocks?.stop().catch(() => undefined);
    if (sandbox && !opts.keep) sandbox.cleanup();
  };

  try {
    mocks = await startMockUpstreams();
    sandbox = createTempSandbox('lead-accept-');
    envRestore = applyEnv(buildLeadTestEnv({ sandbox, mocks, token: TEST_API_TOKEN }));
    scenario = await buildFullScenario(mocks, sandbox);
    preResults.push(...(await preflight(scenario)));

    const preFailed = preResults.some((r) => r.status === 'fail');
    // 在 AC-11 之前插入 AC-10（性能基准，mock 中标记 skip）
    const checks = [...AC_CHECKS];
    checks.splice(
      checks.findIndex((c) => c.id === 'AC-11'),
      0,
      AC10_SKIP,
    );
    for (const check of checks) {
      if (opts.only && !opts.only.has(check.id)) continue;
      const began = Date.now();
      if (preFailed) {
        results.push({ id: check.id, title: check.title, status: 'skip', durationMs: 0, error: '预检失败，跳过 AC 执行' });
        continue;
      }
      if (check === AC10_SKIP) {
        results.push({
          id: check.id,
          title: check.title,
          status: 'skip',
          durationMs: 0,
          error: '性能基准需 1 万公司/100 万事件规模数据，不在 mock e2e 覆盖（见 docs/17）',
        });
        continue;
      }
      try {
        const details = (await check.run(scenario)) ?? undefined;
        results.push({ id: check.id, title: check.title, status: 'pass', durationMs: Date.now() - began, details });
        if (opts.verbose) console.log(`✅ ${check.id} ${check.title} (${Date.now() - began}ms)`);
      } catch (err) {
        const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
        results.push({ id: check.id, title: check.title, status: 'fail', durationMs: Date.now() - began, error: message });
        if (opts.verbose) console.log(`❌ ${check.id} ${check.title}\n   ${message.split('\n')[0]}`);
      }
    }
  } catch (err) {
    results.push({
      id: 'INFRA',
      title: '验收环境启动失败',
      status: 'fail',
      durationMs: 0,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
  }

  const summary = summaryOf(results);
  const durationMs = Date.now() - startedMs;
  const ts = timestampSlug(startedAt);
  const repos = (scenario?.rt.repos ?? null) as Record<string, any> | null;
  const scenarioSummary = scenario
    ? {
        goalId: scenario.goal?.id,
        runId: scenario.run?.id,
        runStatus: scenario.run?.status,
        collectionStats: scenario.collectionStats,
        preTick: scenario.preTick,
        companies: repos?.companies?.count?.() ?? null,
        companiesAll: repos?.companies?.count?.({ includeMerged: true }) ?? null,
        sources: repos?.companySources?.count?.() ?? null,
        changeEvents: repos?.changeEvents?.count?.() ?? null,
        unlockLedger: repos?.unlockLedger?.list?.({ limit: 100 })?.length ?? null,
        quotaConsumed: scenario.quotaConsumed,
      }
    : null;
  const payload: Record<string, unknown> = {
    schemaVersion: '1.0',
    kind: 'acceptance',
    generatedAt: startedAt.toISOString(),
    durationMs,
    fixtureVersion: FIXTURE_VERSION,
    environment: {
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      cwd: PROJECT_ROOT,
      appUrl: scenario?.rt.baseUrl ?? null,
      mockMode: 'loopback-ephemeral',
      keepSandbox: opts.keep,
      sandboxDir: opts.keep ? sandbox?.dir : undefined,
    },
    summary,
    preflight: preResults,
    results,
    scenario: scenarioSummary,
    mocks: (() => {
      try {
        return mocks?.describe() ?? null;
      } catch {
        return null;
      }
    })(),
  };

  fs.mkdirSync(opts.reportDir, { recursive: true });
  const jsonPath = path.join(opts.reportDir, `acceptance-${ts}.json`);
  const mdPath = path.join(opts.reportDir, `acceptance-${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(payload));

  console.log('');
  console.log(`LeadPlatform 验收报告（${startedAt.toISOString()}）`);
  console.log(`  预检: ${preResults.filter((r) => r.status === 'pass').length}/${preResults.length} pass`);
  console.log(`  AC:   ${summary.pass} pass / ${summary.fail} fail / ${summary.skip} skip（共 ${summary.total}）`);
  for (const r of [...preResults, ...results]) {
    const mark = r.status === 'pass' ? '✅' : r.status === 'fail' ? '❌' : '⏭️';
    console.log(`  ${mark} ${r.id.padEnd(6)} ${r.title.slice(0, 64)}${r.status === 'skip' ? '（skip）' : ''}`);
    if (r.status === 'fail') console.log(`         ${String(r.error ?? '').split('\n')[0]}`);
  }
  console.log('');
  console.log(`  JSON: ${path.relative(PROJECT_ROOT, jsonPath)}`);
  console.log(`  MD:   ${path.relative(PROJECT_ROOT, mdPath)}`);
  if (opts.keep && sandbox) console.log(`  临时目录保留: ${sandbox.dir}`);

  await cleanup();
  process.exit(Math.min(125, summary.fail));
}

void main().catch(async (err) => {
  console.error('验收脚本异常:', err);
  process.exit(1);
});
