/**
 * 六个 mock 上游的统一启动/停止入口。
 *
 * 用法（vitest）：
 * ```ts
 * import { startMockUpstreams } from '../mock-upstreams/index.js';
 * const mocks = await startMockUpstreams();       // 随机端口，避免端口冲突
 * process.env.BOSS_CLIENT_URL = mocks.url('boss');
 * ...
 * await mocks.stop();
 * ```
 *
 * 也支持固定端口（acceptance / 子进程模式）：`startMockUpstreams({ ports: { boss: 8790 } })`。
 * 固定端口被占用时会抛错（不会自动 kill 已有进程）。
 */
import type { FastifyInstance } from 'fastify';
import { createAliMock } from './ali.js';
import { createBossMock } from './boss.js';
import { createFumaMock } from './fuma.js';
import { createMicMock } from './mic.js';
import { createTanjiMock } from './tanji.js';
import { createZhilianMock } from './zhilian.js';
import {
  type MockPlatform,
  type MockWorld,
  MOCK_PLATFORMS,
  createWorld,
  resetWorld,
  resetRequestLog,
  scenarioSummary,
} from './state.js';

export * from './state.js';
export * from './common.js';
export { createBossMock } from './boss.js';
export { createZhilianMock } from './zhilian.js';
export { createAliMock } from './ali.js';
export { createMicMock } from './mic.js';
export { createTanjiMock } from './tanji.js';
export { createFumaMock } from './fuma.js';

/** mock 上游之间的固定测试 token（mock 默认不校验，但配置层可能要求非空） */
export const MOCK_TOKENS: Record<MockPlatform, string> = {
  boss: 'mock-boss-token',
  zhilian: 'mock-zhilian-token',
  ali: 'mock-ali-token',
  mic: 'mock-mic-token',
  tanji: 'mock-tanji-token',
  fuma: 'mock-fuma-token',
};

export interface StartMockOptions {
  /** 指定端口；缺省每个平台用 0（随机可用端口） */
  ports?: Partial<Record<MockPlatform, number>>;
  /** 监听地址，默认 127.0.0.1（仅 loopback） */
  host?: string;
}

export interface MockUpstreams {
  readonly world: MockWorld;
  readonly apps: Record<MockPlatform, FastifyInstance>;
  readonly urls: Record<MockPlatform, string>;
  readonly ports: Record<MockPlatform, number>;
  /** 启动全部 mock（幂等：重复调用直接返回） */
  start(): Promise<void>;
  /** 停止全部 mock */
  stop(): Promise<void>;
  url(platform: MockPlatform): string;
  /** 生成 LeadPlatform 上游连接所需的环境变量 */
  env(): Record<string, string>;
  /** 重置场景 + 清空请求日志 */
  reset(): void;
  /** 场景/控制摘要（验收报告用） */
  describe(): Record<string, unknown>;
}

function buildApps(world: MockWorld): Record<MockPlatform, FastifyInstance> {
  return {
    boss: createBossMock(world),
    zhilian: createZhilianMock(world),
    ali: createAliMock(world),
    mic: createMicMock(world),
    tanji: createTanjiMock(world),
    fuma: createFumaMock(world),
  };
}

export async function startMockUpstreams(options: StartMockOptions = {}): Promise<MockUpstreams> {
  const host = options.host ?? '127.0.0.1';
  const world = createWorld();
  const apps = buildApps(world);
  const urls = {} as Record<MockPlatform, string>;
  const ports = {} as Record<MockPlatform, number>;
  let started = false;

  const start = async (): Promise<void> => {
    if (started) return;
    for (const platform of MOCK_PLATFORMS) {
      const desired = options.ports?.[platform] ?? 0;
      const app = apps[platform];
      await app.listen({ host, port: desired });
      const address = app.server.address();
      const port = typeof address === 'object' && address ? address.port : desired;
      ports[platform] = port;
      urls[platform] = `http://${host}:${port}`;
      world.platforms[platform].url = urls[platform];
      world.platforms[platform].port = port;
    }
    started = true;
  };

  const stop = async (): Promise<void> => {
    if (!started) return;
    await Promise.all(
      MOCK_PLATFORMS.map(async (p) => {
        try {
          await apps[p].close();
        } catch {
          /* ignore */
        }
      }),
    );
    started = false;
  };

  const instance: MockUpstreams = {
    world,
    apps,
    urls,
    ports,
    start,
    stop,
    url(platform) {
      const u = urls[platform];
      if (!u) throw new Error(`mock upstream ${platform} 尚未启动`);
      return u;
    },
    env() {
      return {
        BOSS_CLIENT_URL: urls.boss ?? '',
        BOSS_API_TOKEN: MOCK_TOKENS.boss,
        ZHILIAN_CLIENT_URL: urls.zhilian ?? '',
        ZHILIAN_API_TOKEN: MOCK_TOKENS.zhilian,
        ALI_CLIENT_URL: urls.ali ?? '',
        ALI_API_TOKEN: MOCK_TOKENS.ali,
        MIC_CLIENT_URL: urls.mic ?? '',
        TANJI_CLIENT_URL: urls.tanji ?? '',
        TANJI_API_TOKEN: MOCK_TOKENS.tanji,
        FUMA_CLIENT_URL: urls.fuma ?? '',
        FUMA_API_TOKEN: MOCK_TOKENS.fuma,
        FUMA_ACCOUNT_ID: 'acct_01',
      };
    },
    reset() {
      resetWorld(world);
      resetRequestLog(world);
    },
    describe() {
      return scenarioSummary(world);
    },
  };
  await start();
  return instance;
}

/** 便捷函数：在 app 内使用（已启动） */
export async function createAndStartMockUpstreams(options?: StartMockOptions): Promise<MockUpstreams> {
  return startMockUpstreams(options);
}
