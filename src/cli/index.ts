/**
 * CLI 入口：`lead <command>`（commander）。
 *
 * 全局选项：--json / --base-url / --token
 * Token 解析：--token > LEAD_API_TOKEN > ~/.lead-platform/config.json(apiToken/token)
 * 所有命令最终映射 REST；错误码非 0 退出。
 */
import { Command, CommanderError, Option } from 'commander';
import { RestClient, RestClientError } from '../api/restClient.js';
import { CLI_COMMANDS, type CliCommandMeta } from './definitions.js';
import { executeCommand, type CliRuntime } from './commands.js';

export const CLI_VERSION = '0.1.0';

export interface CliDeps {
  fetchImpl?: typeof fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** 覆盖 base-url（测试） */
  baseUrl?: string;
  token?: string;
}

interface ParsedSpec {
  names: string[];
  args: string[];
}

function parseCommandPath(commandPath: string): ParsedSpec {
  const tokens = commandPath.split(' ').filter(Boolean);
  const names: string[] = [];
  const args: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<') || token.startsWith('[')) args.push(token);
    else names.push(token);
  }
  return { names, args };
}

function addOptions(cmd: Command, meta: CliCommandMeta): void {
  for (const opt of meta.options ?? []) {
    const [flags, description] = [opt.flags, opt.description] as const;
    const option = new Option(flags, description);
    if (opt.default !== undefined) option.default(opt.default);
    if (opt.choices) option.choices(opt.choices);
    cmd.addOption(option);
  }
  // 保证每个命令都能在子命令后写 --json（全局 --json 在子命令前也有效）
  const hasJson = (meta.options ?? []).some((o) => o.flags.includes('--json'));
  if (!hasJson) cmd.option('--json', '输出与 REST data 一致的 JSON');
}

function formatError(err: unknown): { code: string; message: string } {
  if (err instanceof RestClientError) return { code: err.code, message: err.message };
  const maybeCode = (err as { code?: unknown })?.code;
  return {
    code: typeof maybeCode === 'string' ? maybeCode : 'INTERNAL_ERROR',
    message: err instanceof Error ? err.message : String(err),
  };
}

function buildProgram(deps: CliDeps, setExitCode: (code: number) => void): Command {
  const program = new Command();
  program
    .name('lead')
    .description('LeadPlatform CLI —— 河北外贸线索聚合 / 探迹补全 / 海关画像 / 事件订阅')
    .version(CLI_VERSION)
    .option('--json', '输出与 REST data 一致的 JSON')
    .option('--base-url <url>', '服务地址（默认 http://127.0.0.1:8793）')
    .option('--token <token>', 'Bearer token（缺省读 LEAD_API_TOKEN / config.json）')
    .showHelpAfterError()
    .enablePositionalOptions(false);

  const groups = new Map<string, Command>();

  for (const meta of CLI_COMMANDS) {
    const { names, args } = parseCommandPath(meta.path);
    let leaf: Command;
    if (names.length === 1) {
      leaf = program.command(names[0] as string, { isDefault: false });
    } else {
      const groupName = names[0] as string;
      let group = groups.get(groupName);
      if (!group) {
        group = program.command(groupName).description(`${groupName} 相关命令`);
        group.showHelpAfterError();
        group.action(() => group?.help());
        groups.set(groupName, group);
      }
      const subName = names.slice(1).join(' ');
      const argSpec = args.length ? ` ${args.join(' ')}` : '';
      leaf = group.command(`${subName}${argSpec}`);
    }
    leaf.description(meta.description);
    addOptions(leaf, meta);

    leaf.action(async (...raw: unknown[]) => {
      const command = raw.pop() as Command;
      const commandOpts = (raw.pop() ?? {}) as Record<string, unknown>;
      const positional = raw.map((v) => (v === undefined || v === null ? '' : String(v)));
      const opts: Record<string, unknown> = { ...program.opts(), ...command.opts(), ...commandOpts };
      const json = Boolean(opts.json);
      const runtime: CliRuntime = {
        client: new RestClient({
          baseUrl: typeof opts.baseUrl === 'string' ? opts.baseUrl : deps.baseUrl,
          token: typeof opts.token === 'string' ? opts.token : deps.token,
          fetchImpl: deps.fetchImpl,
          env: deps.env,
          homeDir: deps.homeDir,
        }),
        json,
        out: deps.stdout ?? ((text: string) => process.stdout.write(`${text}\n`)),
        err: deps.stderr ?? ((text: string) => process.stderr.write(`${text}\n`)),
      };
      try {
        setExitCode(await executeCommand(meta.path, positional, opts, runtime));
      } catch (err) {
        const { code, message } = formatError(err);
        runtime.err(`error ${code}: ${message}`);
        setExitCode(code === 'UNAUTHORIZED' ? 3 : 1);
      }
    });
  }

  return program;
}

/** 可测试入口：不调用 process.exit，返回退出码。 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  let exitCode = 0;
  const program = buildProgram(deps, (code) => {
    exitCode = code;
  });
  program.exitOverride();
  program.configureOutput({
    writeOut: (text) => (deps.stdout ?? ((s: string) => process.stdout.write(s)))(text),
    writeErr: (text) => (deps.stderr ?? ((s: string) => process.stderr.write(s)))(text),
  });
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      if (['commander.helpDisplayed', 'commander.version', 'commander.help'].includes(err.code)) return 0;
      if (err.code === 'commander.unknownCommand' || err.code === 'commander.unknownOption' || err.code === 'commander.missingArgument') {
        return 2;
      }
      return err.exitCode || 1;
    }
    const { code, message } = formatError(err);
    (deps.stderr ?? ((s: string) => process.stderr.write(`${s}\n`)))(`error ${code}: ${message}`);
    return 1;
  }
  return exitCode;
}

export { buildProgram };
