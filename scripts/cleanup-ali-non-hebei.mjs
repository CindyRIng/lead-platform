#!/usr/bin/env node
/**
 * 清理 Ali 非河北来源（ops 脚本）
 *
 * 规则（基于 docs/12 的实测口径）：
 *  - 保留：Ali 来源来自 industry_matrix（province=Hebei strict，平台确认）→ 公司判河北；
 *  - 保留：公司任一 Ali 来源的英文名含 河北/11 市/118 县 拼音 token；
 *  - 保留：公司在其他平台（mic/zhilian/boss）有来源（地区过滤由其他平台保证）→ 仅删除该条 Ali 来源；
 *  - 剔除：以上都不满足的 Ali 来源；若公司只有这类 Ali 来源、无其他平台来源，则整家公司连同子表删除。
 *
 * raw_snapshots 永久保留（审计可追溯）。默认 dry-run；--apply 才写库。
 *
 * 用法：
 *   node --experimental-sqlite scripts/cleanup-ali-non-hebei.mjs [--apply] [--db <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HEBEI_COUNTIES, CITIES } from '../dist/data/regions.js';

const HOME = process.env.HOME || '/home/songqian';
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const dbPath = (() => {
  const i = args.indexOf('--db');
  if (i >= 0) return args[i + 1];
  try { return path.join(HOME, '.lead-platform/lead.db'); } catch { return ''; }
})();

const CITY_TOKENS = ['shijiazhuang', 'tangshan', 'qinhuangdao', 'handan', 'xingtai', 'baoding', 'zhangjiakou', 'chengde', 'cangzhou', 'langfang', 'hengshui'];
const TOKENS = new Set(['hebei', 'chinahebei', ...CITY_TOKENS.map((s) => s.toLowerCase()), ...HEBEI_COUNTIES.map((c) => c.englishName).filter(Boolean).map((s) => s.toLowerCase())]);
const TOKEN_LIST = [...TOKENS].filter((t) => t.length >= 4).sort((a, b) => b.length - a.length);

function nameMatchesHebei(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase();
  for (const token of TOKEN_LIST) {
    const re = new RegExp(`(?<![a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`);
    if (re.test(lower)) return true;
  }
  return false;
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const aliSources = db.prepare("SELECT id, company_id, source_name, city_name, evidence FROM company_sources WHERE platform='ali'").all();
const otherSources = db.prepare("SELECT company_id, platform FROM company_sources WHERE platform<>'ali'").all();
const companies = new Map(db.prepare('SELECT id, name, city, merged_into FROM companies').all().map((r) => [r.id, r]));
const mergedTargets = new Set(db.prepare('SELECT DISTINCT merged_into FROM companies WHERE merged_into IS NOT NULL').all().map((r) => r.merged_into));

const otherPlatformByCompany = new Map();
for (const r of otherSources) {
  if (!otherPlatformByCompany.has(r.company_id)) otherPlatformByCompany.set(r.company_id, new Set());
  otherPlatformByCompany.get(r.company_id).add(r.platform);
}

function strategyOf(evidence) {
  try { return JSON.parse(evidence || '{}').strategy || 'unknown'; } catch { return 'unknown'; }
}

const aliByCompany = new Map();
for (const s of aliSources) {
  if (!aliByCompany.has(s.company_id)) aliByCompany.set(s.company_id, []);
  aliByCompany.get(s.company_id).push({ ...s, strategy: strategyOf(s.evidence), hebeiName: nameMatchesHebei(s.source_name) });
}

const deleteSourceIds = [];
const deleteCompanyIds = [];
const keepByMatrix = new Set();
const keepByName = new Set();
const keepByOtherPlatform = new Set();
const keptCompanyIds = new Set();

for (const [companyId, srcs] of aliByCompany.entries()) {
  const company = companies.get(companyId);
  const matrixConfirmed = srcs.some((s) => s.strategy === 'industry_matrix');
  const nameConfirmed = srcs.some((s) => s.hebeiName);
  const hasOtherPlatform = otherPlatformByCompany.has(companyId);
  const hebeiCity = company && company.city && /(石家庄|唐山|秦皇岛|邯郸|邢台|保定|张家口|承德|沧州|廊坊|衡水)/.test(String(company.city));
  const keepCompany = matrixConfirmed || nameConfirmed || hasOtherPlatform || Boolean(hebeiCity);
  if (matrixConfirmed) keepByMatrix.add(companyId);
  if (nameConfirmed) keepByName.add(companyId);
  if (hasOtherPlatform) keepByOtherPlatform.add(companyId);

  for (const s of srcs) {
    if (matrixConfirmed || nameConfirmed) {
      // 公司已确认/可信：只删除非确认、非矩阵的 Ali 来源
      if (!(s.strategy === 'industry_matrix' || s.hebeiName)) deleteSourceIds.push(s.id);
    } else if (hasOtherPlatform) {
      deleteSourceIds.push(s.id); // 公司由其他平台保证，Ali 误入来源删除
    } else {
      deleteSourceIds.push(s.id);
    }
  }

  if (keepCompany) {
    keptCompanyIds.add(companyId);
  } else if (!mergedTargets.has(companyId)) {
    deleteCompanyIds.push(companyId);
  } else {
    keptCompanyIds.add(companyId); // 有下游引用，保留（仅删来源）
  }
}

// 统计（dry-run 报告）
const report = {
  generatedAt: new Date().toISOString(),
  apply: APPLY,
  db: dbPath,
  aliSources: aliSources.length,
  aliCompanies: aliByCompany.size,
  keepCompanies: keptCompanyIds.size,
  deleteSourceIds: deleteSourceIds.length,
  deleteCompanies: deleteCompanyIds.length,
  reason: {
    matrixConfirmedCompanies: keepByMatrix.size,
    nameConfirmedCompanies: keepByName.size,
    otherPlatformCompanies: keepByOtherPlatform.size,
  },
  strategyCounts: aliSources.reduce((acc, s) => {
    const st = strategyOf(s.evidence);
    acc[st] = (acc[st] || 0) + 1;
    return acc;
  }, {}),
};
report.samplesDeletedSources = aliSources.filter((s) => deleteSourceIds.includes(s.id)).slice(0, 10).map((s) => s.source_name);
report.samplesDeletedCompanies = deleteCompanyIds.slice(0, 10).map((id) => companies.get(id)?.name);

if (!APPLY) {
  console.log(JSON.stringify(report, null, 2));
  console.log('\n[dry-run] 未写库；确认后加 --apply 执行。');
  process.exit(0);
}

// 写库
const delSource = db.prepare('DELETE FROM company_sources WHERE id = ?');
const tablesByCompany = [
  'company_sources',
  'company_contacts',
  'pipeline_jobs',
  'company_platform_profiles',
  'company_platform_jobs',
  'company_customs_profiles',
  'unlock_ledger',
  'change_events',
];
db.exec('BEGIN IMMEDIATE;');
try {
  let deletedSources = 0;
  for (const id of deleteSourceIds) { delSource.run(id); deletedSources += 1; }
  let deletedCompanies = 0;
  for (const cid of deleteCompanyIds) {
    for (const t of tablesByCompany) db.prepare(`DELETE FROM ${t} WHERE company_id = ?`).run(cid);
    db.prepare('DELETE FROM companies WHERE id = ?').run(cid);
    deletedCompanies += 1;
  }
  // 重算保留公司 source_count
  db.exec(`UPDATE companies SET source_count = (SELECT COUNT(*) FROM company_sources cs WHERE cs.company_id = companies.id) WHERE merged_into IS NULL;`);
  db.exec('COMMIT;');
  report.applyResult = { deletedSources, deletedCompanies };
} catch (e) {
  try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
  throw e;
}

// 清理过期平台档案/岗位遗留？保留 raw_snapshots 不删。
const outDir = path.join(HOME, '.lead-platform/reports');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `ali-cleanup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, reportFile: outFile }, null, 2));
db.close();
