/**
 * 启动/停止 LeadPlatform 服务（子进程模式，最贴近真实部署与 AC-8 重启场景）。
 *
 * 为何用子进程：
 *  - `src/config.ts` 是模块级单例（import 时读 env），子进程可以干净地施加测试环境变量；
 *  - AC-8 要求 kill -9 后重启，子进程模式可直接验证；
 *  - 与 systemd 部署路径一致（`node --experimental-sqlite --import tsx src/main.ts`）。
 *
 * 若后续生产代码暴露 `buildApp()`，可在此基础上增加 in-process 模式（更快）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiAssertionError, TestApiClient } from './http.js';
import { sleep } from './tmp.js';
import { waitFor } from './wait.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export interface StartLeadAppOptions {
  /** 测试环境变量（含 LEAD_* 与上游 URL；会 merge 到 process.env 之上） */
  env: Record<string, string>;
  /** API token（默认取 env.LEAD_API_TOKEN） */
  token?: string;
  /** 指定端口；缺省自动挑一个空闲端口 */
  port?: number;
  /** 是否等待 /v1/health 就绪（默认 true） */
  waitReady?: boolean;
  /** 启动超时（默认 25s，tsx 首次启动编译较慢） */
  readyTimeoutMs?: number;
  /** 日志文件路径（默认写到 dataDir/logs/app-<pid>.log） */
  logFile?: string;
  cwd?: string;
}

export interface RunningLeadApp {
  url: string;
  token: string;
  port: number;
  proc: ChildProcess;
  api: TestApiClient;
  /** 子进程 stdout/stderr 最近输出（调试用） */
  logs(): string;
  /** 进程是否仍在运行 */
  readonly alive: boolean;
  /** 退出码（已退出时） */
  readonly exitCode: number | null;
  /** SIGTERM 优雅关闭（超时后 SIGKILL） */
  stop(): Promise<void>;
  /** 直接 SIGKILL（模拟 kill -9 / 断电） */
  kill9(): Promise<void>;
}

export async function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function tailLines(text: string, n = 40): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export async function startLeadApp(opts: StartLeadAppOptions): Promise<RunningLeadApp> {
  const cwd = opts.cwd ?? PROJECT_ROOT;
  const port = opts.port ?? (await getFreePort());
  const token = opts.token ?? opts.env.LEAD_API_TOKEN ?? '';
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...opts.env,
    LEAD_PORT: String(port),
  };

  const logFile = opts.logFile ?? path.join(opts.env.LEAD_DATA_DIR ?? cwd, 'logs', `app-${Date.now()}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const args = ['--experimental-sqlite', '--import', 'tsx', path.join(cwd, 'src', 'main.ts')];
  const proc = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  const append = (chunk: Buffer, which: 'out' | 'err') => {
    const text = chunk.toString('utf8');
    if (which === 'out') stdoutBuf += text;
    else stderrBuf += text;
    if (stdoutBuf.length > 200_000) stdoutBuf = stdoutBuf.slice(-100_000);
    if (stderrBuf.length > 200_000) stderrBuf = stderrBuf.slice(-100_000);
    logStream.write(text);
  };
  proc.stdout?.on('data', (c: Buffer) => append(c, 'out'));
  proc.stderr?.on('data', (c: Buffer) => append(c, 'err'));

  let exitCode: number | null = null;
  const exited = new Promise<number | null>((resolve) => {
    proc.on('exit', (code, signal) => {
      exitCode = code ?? (signal ? 128 : null);
      resolve(exitCode);
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const api = new TestApiClient(baseUrl, token);

  const running: RunningLeadApp = {
    url: baseUrl,
    token,
    port,
    proc,
    api,
    logs: () => tailLines(`--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`, 80),
    get alive() {
      return exitCode === null && proc.exitCode === null;
    },
    get exitCode() {
      return exitCode;
    },
    async stop() {
      if (exitCode !== null) return;
      proc.kill('SIGTERM');
      const timeout = setTimeout(() => {
        if (exitCode === null) proc.kill('SIGKILL');
      }, 5000);
      await exited;
      clearTimeout(timeout);
      await new Promise<void>((resolve) => logStream.end(resolve));
    },
    async kill9() {
      if (exitCode !== null) return;
      proc.kill('SIGKILL');
      await exited;
    },
  };

  if (opts.waitReady !== false) {
    const timeoutMs = opts.readyTimeoutMs ?? 25_000;
    try {
      await waitFor(
        async () => {
          if (exitCode !== null) {
            throw new Error(`LeadPlatform 启动即退出（exit=${exitCode}）\n${running.logs()}`);
          }
          try {
            const res = await fetch(`${baseUrl}/v1/health`);
            return res.ok;
          } catch {
            return false;
          }
        },
        { timeoutMs, intervalMs: 100, label: 'LeadPlatform /v1/health 就绪' },
      );
    } catch (err) {
      await running.kill9().catch(() => undefined);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n--- 进程日志 ---\n${running.logs()}\n--- 日志文件: ${logFile}`,
      );
    }
  }

  return running;
}

/** 断言原始响应是预期错误码（供验收脚本使用） */
export function describeApiError(err: unknown): string {
  if (err instanceof ApiAssertionError) return `${err.status}: ${JSON.stringify(err.body)}`;
  return err instanceof Error ? err.message : String(err);
}

/** 等待进程退出（用于断言 kill 后行为） */
export async function waitForExit(proc: ChildProcess, timeoutMs = 5000): Promise<number | null> {
  if (proc.exitCode !== null) return proc.exitCode;
  const timeout = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  const code = await new Promise<number | null>((resolve) => {
    proc.once('exit', (c) => resolve(c));
  });
  clearTimeout(timeout);
  return code;
}

/** 简短 sleep（导出方便测试） */
export { sleep };
