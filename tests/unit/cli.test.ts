/**
 * D2 CLI 测试：不依赖真实服务，用注入 fetch mock 验证
 * 命令覆盖完整性、REST 映射、--json 输出、鉴权/错误码退出、SSE 参数解析。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { CLI_COMMANDS } from '../../src/cli/definitions.js';
import { listImplementedCommands } from '../../src/cli/commands.js';
import { resolveRestClientConfig } from '../../src/api/restClient.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(response: unknown, status = 200) {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: String(init?.method ?? 'GET'), headers, body });
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function captureStreams() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

const okEnvelope = (data: unknown) => ({
  ok: true,
  data,
  meta: { schemaVersion: '1.0', requestId: 'req_x', timestamp: new Date().toISOString(), tookMs: 1 },
  error: null,
});

const errEnvelope = (code: string, message: string) => ({
  ok: false,
  data: null,
  meta: { schemaVersion: '1.0', requestId: 'req_x', timestamp: new Date().toISOString(), tookMs: 1 },
  error: { code, message, retryable: false },
});

describe('CLI 命令覆盖', () => {
  it('definitions 中的每条命令都有实现，且无多余实现', () => {
    const defined = new Set(CLI_COMMANDS.map((c) => c.path));
    const implemented = new Set(listImplementedCommands());
    for (const path of defined) expect(implemented.has(path), `missing impl: ${path}`).toBe(true);
    expect([...implemented].filter((p) => !defined.has(p))).toEqual([]);
  });

  it('覆盖任务要求的关键子命令', () => {
    const paths = CLI_COMMANDS.map((c) => c.path);
    for (const required of [
      'status',
      'quota',
      'sources',
      'goal list',
      'goal show <id>',
      'goal create',
      'goal update <id>',
      'goal run <id>',
      'run list',
      'run show <id>',
      'run cancel <id>',
      'company list',
      'company show <id>',
      'company contacts <id>',
      'company changes <id>',
      'company snapshots <id>',
      'company platforms <id>',
      'company platform <id> <platform>',
      'company jobs <id> <platform>',
      'company refresh <id>',
      'company customs <id>',
      'company customs-refresh <id>',
      'company rematch <id>',
      'company unlock <id>',
      'changes',
      'events tail',
      'webhook list',
      'webhook create',
      'webhook delete <id>',
      'webhook deliveries <id>',
      'webhook replay <id> <deliveryId>',
      'job list',
      'job retry <id>',
      'admin backup',
      'admin archive',
      'admin verify',
      'admin restore',
    ]) {
      expect(paths, required).toContain(required);
    }
  });
});

describe('CLI REST 映射', () => {
  it('lead status --json 输出 REST data 并带 Bearer', async () => {
    const { calls, fetchImpl } = makeFetch(okEnvelope({ service: 'lead-platform', version: '0.1.0' }));
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'status', '--json', '--token', 'tkn'], { fetchImpl, ...s });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8793/v1/status');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers.authorization).toBe('Bearer tkn');
    expect(JSON.parse(s.out.join('\n'))).toEqual({ service: 'lead-platform', version: '0.1.0' });
    expect(s.err).toEqual([]);
  });

  it('lead goal create 组装 body（region/platforms/keywords/schedule）', async () => {
    const { calls, fetchImpl } = makeFetch(okEnvelope({ id: 'goal_1' }), 201);
    const s = captureStreams();
    const code = await runCli(
      [
        'node',
        'lead',
        'goal',
        'create',
        '--name',
        '河北省-外贸线索',
        '--province',
        '河北省',
        '--platforms',
        'boss,ali',
        '--keywords-boss',
        '外贸,外贸经理',
        '--max-leads',
        '2000',
        '--cron',
        '0 2 * * *',
        '--json',
        '--token',
        'tkn',
      ],
      { fetchImpl, ...s },
    );
    expect(code).toBe(0);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://127.0.0.1:8793/v1/goals');
    expect(call.body).toMatchObject({
      name: '河北省-外贸线索',
      region: { province: '河北省' },
      platforms: ['boss', 'ali'],
      keywords: { boss: ['外贸', '外贸经理'] },
      maxLeadsPerRun: 2000,
      schedule: { cron: '0 2 * * *', timeZone: 'Asia/Shanghai' },
      enabled: true,
    });

  });

  it('lead goal show <id> 映射路径参数', async () => {
    const { calls, fetchImpl } = makeFetch(okEnvelope({ id: 'goal_1', name: 'x' }));
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'goal', 'show', 'goal_1', '--json', '--token', 'tkn'], {
      fetchImpl,
      ...s,
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('http://127.0.0.1:8793/v1/goals/goal_1');
  });

  it('lead company list 传递 query（province/limit/cursor）', async () => {
    const { calls, fetchImpl } = makeFetch(okEnvelope({ items: [], nextCursor: null }));
    const s = captureStreams();
    const code = await runCli(
      ['node', 'lead', 'company', 'list', '--province', '河北省', '--limit', '5', '--cursor', 'abc', '--json', '--token', 'tkn'],
      { fetchImpl, ...s },
    );
    expect(code).toBe(0);
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/companies');
    expect(url.searchParams.get('province')).toBe('河北省');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('cursor')).toBe('abc');
  });

  it('lead --base-url 覆盖服务地址', async () => {
    const { calls, fetchImpl } = makeFetch(okEnvelope({}));
    const s = captureStreams();
    const code = await runCli(['node', 'lead', '--base-url', 'http://127.0.0.1:9999', 'quota', '--json', '--token', 'tkn'], {
      fetchImpl,
      ...s,
    });
    expect(code).toBe(0);
    expect(calls[0]?.url).toBe('http://127.0.0.1:9999/v1/quota');
  });

  it('REST 401 → 退出码 3 且 stderr 含错误码（非 json 也不崩）', async () => {
    const { fetchImpl } = makeFetch(errEnvelope('UNAUTHORIZED', 'missing or invalid bearer token'), 401);
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'status', '--json'], { fetchImpl, ...s, token: '' });
    expect(code).toBe(3);
    expect(s.err.join('\n')).toContain('UNAUTHORIZED');
  });

  it('后端不可达 → 退出码 1 且 SERVICE_UNAVAILABLE', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'status', '--json', '--token', 'tkn'], { fetchImpl, ...s });
    expect(code).toBe(1);
    expect(s.err.join('\n')).toContain('SERVICE_UNAVAILABLE');
  });

  it('未知命令 → 退出码 2', async () => {
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'nope'], { ...s });
    expect(code).toBe(2);
  });

  it('缺参数 → 非 0 退出并提示 VALIDATION_ERROR', async () => {
    const { fetchImpl } = makeFetch(okEnvelope({}));
    const s = captureStreams();
    const code = await runCli(['node', 'lead', 'goal', 'show', '--token', 'tkn'], { fetchImpl, ...s });
    expect(code).not.toBe(0);
  });
});

describe('配置解析', () => {
  it('env 优先于 config 文件', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-cli-home-'));
    fs.mkdirSync(path.join(home, '.lead-platform'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.lead-platform', 'config.json'),
      JSON.stringify({ apiToken: 'file-token', port: 8793, baseUrl: 'http://127.0.0.1:8793' }),
    );
    const resolved = resolveRestClientConfig({
      env: { LEAD_API_TOKEN: 'env-token', LEAD_BASE_URL: 'http://127.0.0.1:18888' },
      homeDir: home,
    });
    expect(resolved.token).toBe('env-token');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:18888');
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('无 env 时回落 config 文件', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lead-cli-home-'));
    fs.mkdirSync(path.join(home, '.lead-platform'), { recursive: true });
    fs.writeFileSync(path.join(home, '.lead-platform', 'config.json'), JSON.stringify({ apiToken: 'file-token', port: 18793 }));
    const resolved = resolveRestClientConfig({ env: {}, homeDir: home });
    expect(resolved.token).toBe('file-token');
    expect(resolved.baseUrl).toBe('http://127.0.0.1:18793');
    fs.rmSync(home, { recursive: true, force: true });
  });
});
