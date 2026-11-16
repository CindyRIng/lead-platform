#!/usr/bin/env node
/**
 * 上传 GitHub 前的泄露检查（Lead 专用）
 * - 确保 .env 未被跟踪
 * - 扫描暂存/跟踪文件中的 token/密钥/真实公司数据痕迹
 * 用法：node scripts/check-no-secrets.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
let files = [];
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT }).toString().split('\0').filter(Boolean);
} catch {
  console.error('not a git repo');
  process.exit(2);
}

const problems = [];
const patterns = [
  { name: '.env tracked', re: /(^|\/)\.env$/ },
  { name: 'API token literal', re: /(API_TOKEN|apiToken|LEAD_API_TOKEN)\s*[=:]\s*['"]?((?!replace-with|your-|test-|example|dummy|fake)[A-Za-z0-9_\-]{16,})/ },
  { name: 'bearer token', re: /Bearer\s+[A-Za-z0-9._\-]{20,}/ },
  { name: 'github token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'private key', re: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
  { name: 'password literal', re: /password\s*[=:]\s*['"][^'"]{6,}['"]/i },
];
// 真实企业/联系人数据目录不允许进入公开仓库
const forbiddenPaths = [
  /^exploration\/.*\/data\/raw\//,
  /^exploration\/.*\/out\/.*\.jsonl$/,
  /^exploration\/.*\/data\/.*\.ndjson$/,
  /^\.lead-platform\//,
];

for (const f of files) {
  if (forbiddenPaths.some((re) => re.test(f))) problems.push(`${f}: forbidden data path`);
  // 测试/mock 中的 test-*/fake-* token、.env.example 占位符不计为泄露
  const isTest = /^tests\//.test(f) || /\.env\.example$/.test(f) || /^scripts\/check-no-secrets\.mjs$/.test(f);
  if (f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.webp')) continue;
  if (!/\.(ts|js|mjs|json|md|yml|yaml|sh|txt|example|service|sql)$/.test(f)) continue;
  const full = path.join(ROOT, f);
  let body = '';
  try { body = fs.readFileSync(full, 'utf8'); } catch { continue; }
  for (const p of patterns) {
    if (isTest && p.name === 'API token literal') continue;
    const m = p.re.exec(body);
    if (m) problems.push(`${f}: ${p.name} -> ${body.slice(m.index, m.index + 80).replace(/\n/g, ' ')}`);
  }
}
if (problems.length) {
  console.error('❌ 发现潜在泄露/敏感文件：');
  for (const p of problems) console.error(' -', p);
  process.exit(1);
}
console.log(`✅ 检查通过：${files.length} 个跟踪文件，未发现 .env/token/私钥/真实数据路径。`);
