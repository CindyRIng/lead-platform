#!/usr/bin/env node
/** `lead` CLI 可执行入口（bin: dist/cli.js）。 */
import { runCli } from './cli/index.js';

void runCli(process.argv).then((code) => {
  process.exitCode = code;
});
