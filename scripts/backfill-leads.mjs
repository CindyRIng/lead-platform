#!/usr/bin/env node
/**
 * v2 数据回填：company_sources -> leads，verified company -> lead_company_matches
 * 只读上游，不访问网络；幂等，可重复执行。
 * 用法：node --experimental-sqlite scripts/backfill-leads.mjs [--db path]
 */
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const HOME = process.env.HOME || '/home/songqian';
const args = process.argv.slice(2);
const i = args.indexOf('--db');
const dbPath = i >= 0 ? args[i + 1] : path.join(HOME, '.lead-platform/lead.db');
const db = new DatabaseSync(dbPath);
db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const cols = db.prepare('PRAGMA table_info(companies)').all().map((c) => c.name);
if (!cols.includes('verified')) {
  console.error('companies.verified 不存在：请先启动服务执行 v2 迁移');
  process.exit(2);
}

function leadId(platform, platformCompanyId) {
  return 'lead_' + createHash('sha256').update(`${platform}:${platformCompanyId}`).digest('hex').slice(0, 20);
}
function norm(s) {
  return String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '').trim();
}

const sourceRows = db
  .prepare(
    `SELECT cs.id, cs.company_id, cs.platform, cs.platform_company_id, cs.source_name, cs.source_url, cs.city_name, cs.evidence,
            cs.first_seen_at, cs.last_seen_at, c.name, c.english_name, c.province, c.city, c.verified, c.enrichment_status, c.match_meta, c.tanji_company_id
       FROM company_sources cs JOIN companies c ON c.id = cs.company_id`,
  )
  .all();
const insertLead = db.prepare(
  `INSERT INTO leads(id, platform, platform_company_id, source_name, normalized_name, english_name, city_name, province, source_url, evidence, status, company_id, first_seen_at, last_seen_at, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))
   ON CONFLICT(platform, platform_company_id) DO UPDATE SET
     last_seen_at = excluded.last_seen_at, evidence = excluded.evidence, updated_at = datetime('now')`,
);
const insertMatch = db.prepare(
  `INSERT OR IGNORE INTO lead_company_matches(lead_id, company_id, method, confidence, candidate_rank, is_primary, matched_at, raw)
   VALUES (?,?,?,?,?,?,?,?)`,
);

let leads = 0;
let matches = 0;
const matchMeta = new Map();
for (const c of db.prepare('SELECT id, match_meta FROM companies WHERE match_meta IS NOT NULL').all()) {
  try { matchMeta.set(c.id, JSON.parse(c.match_meta)); } catch { /* ignore */ }
}
const companyByTanji = new Map(
  db.prepare('SELECT tanji_company_id, id FROM companies WHERE tanji_company_id IS NOT NULL').all().map((r) => [r.tanji_company_id, r.id]),
);

db.exec('BEGIN IMMEDIATE;');
try {
  for (const r of sourceRows) {
    const id = leadId(r.platform, r.platform_company_id);
    const status = Number(r.verified) === 1 ? 'matched' : r.enrichment_status === 'unmatched' ? 'unmatched' : 'pending';
    insertLead.run(
      id, r.platform, r.platform_company_id, r.source_name, norm(r.source_name || r.name), r.english_name,
      r.city_name, r.province, r.source_url, r.evidence || '{}', status, r.company_id, r.first_seen_at, r.last_seen_at,
    );
    leads += 1;
    const meta = matchMeta.get(r.company_id);
    if (Number(r.verified) === 1) {
      const candidate = (meta?.candidates || []).find((c) => c.id === r.tanji_company_id) || meta?.candidates?.[0];
      insertMatch.run(id, r.company_id, meta?.method || 'english_name', candidate?.score ?? meta?.confidence ?? null, 0, 1, meta?.matchedAt || r.last_seen_at, JSON.stringify(meta?.candidates || []));
      matches += 1;
      // 一个英文抬头可能对应多个 company：已有 company 的候选也建立非主匹配
      for (const [idx, cand] of (meta?.candidates || []).entries()) {
        const cid = companyByTanji.get(cand.id);
        if (cid && cid !== r.company_id) {
          insertMatch.run(id, cid, meta?.method || 'english_name', cand.score ?? null, idx + 1, 0, meta?.matchedAt || r.last_seen_at, JSON.stringify(meta?.candidates || []));
          matches += 1;
        }
      }
    }
  }
  db.exec('COMMIT;');
} catch (e) {
  try { db.exec('ROLLBACK;'); } catch { /* ignore */ }
  throw e;
}

console.log(JSON.stringify({ db: dbPath, sourceRows: sourceRows.length, leadsUpserted: leads, matchesInserted: matches,
  verifiedCompanies: db.prepare('SELECT COUNT(*) n FROM companies WHERE verified = 1').get().n,
  draftCompanies: db.prepare('SELECT COUNT(*) n FROM companies WHERE verified = 0').get().n,
  leadsTotal: db.prepare('SELECT COUNT(*) n FROM leads').get().n,
  matchesTotal: db.prepare('SELECT COUNT(*) n FROM lead_company_matches').get().n,
}, null, 2));
db.close();
