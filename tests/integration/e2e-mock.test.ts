/**
 * 端到端集成 / 验收测试：mock 六上游 + 真实 SQLite + 真实 wiring/workers/REST（进程内完整 app 生命周期）。
 *
 * 覆盖 docs/01 §8 AC-1..AC-18（AC-10 性能基准由 scripts/acceptance.ts 的 bench 模式覆盖）。
 * 具体断言实现见 `tests/acceptance/full-scenario.ts`（与 `npm run accept` 共用同一套 AC 检查）。
 *
 * 约束：
 *  - 网络仅指向 127.0.0.1 上的 tests/mock-upstreams（绝不访问真实上游）；
 *  - tanji unlock 仅作用于 mock 内存，绝不消耗真实额度；
 *  - 使用临时数据目录，不污染 ~/.lead-platform；
 *  - 所有场景数据均为合成 fixture（无真实公司/PII）。
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { startMockUpstreams, type MockUpstreams } from '../mock-upstreams/index.js';
import {
  applyEnv,
  buildLeadTestEnv,
  createTempSandbox,
  type EnvRestore,
  type TempSandbox,
} from '../helpers/index.js';
import {
  AC_CHECKS,
  buildFullScenario,
  closeFullScenario,
  type FullScenario,
} from '../acceptance/full-scenario.js';

let mocks: MockUpstreams;
let sandbox: TempSandbox;
let envRestore: EnvRestore;
let scenario: FullScenario;

beforeAll(async () => {
  mocks = await startMockUpstreams();
  sandbox = createTempSandbox('lead-e2e-');
  envRestore = applyEnv(buildLeadTestEnv({ sandbox, mocks }));
  scenario = await buildFullScenario(mocks, sandbox);
}, 180_000);

afterAll(async () => {
  if (scenario) await closeFullScenario(scenario).catch(() => undefined);
  envRestore?.restore();
  await mocks?.stop().catch(() => undefined);
  sandbox?.cleanup();
}, 60_000);

describe('LeadPlatform 全链路验收（mock 上游 + 真实 DB + 真实 workers/REST）', () => {
  for (const check of AC_CHECKS) {
    it(
      `${check.id} ${check.title}`,
      async () => {
        const details = await check.run(scenario);
        // 证据写入测试输出，便于验收报告对照
        if (details && Object.keys(details).length > 0) console.info(`[${check.id}]`, JSON.stringify(details).slice(0, 700));
      },
      180_000,
    );
  }
});
