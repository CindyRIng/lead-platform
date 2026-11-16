#!/usr/bin/env node
/**
 * 河北招聘线索覆盖采集（只读探索脚本）
 * 直接从岗位搜索结果提取公司（Boss/智联的 jobs[] 已含 companyId/companyName），
 * 避免额外 /companies 调用，降低风控风险。
 *
 * 用法:
 *   CRAWL_PAGES=3 CRAWL_SLEEP_MS=1500 node crawl-jobs.mjs boss
 *   node crawl-jobs.mjs zhilian
 * 输出:
 *   out/<platform>-companies.jsonl / out/<platform>-summary.json
 */
import fs from 'node:fs';
import path from 'node:path';

const PLATFORM = process.argv[2] || 'boss';
const HOME = process.env.HOME || '/home/songqian';
const OUT = path.join(process.cwd(), 'out');
fs.mkdirSync(OUT, { recursive: true });

function envToken(file, key) {
  const txt = fs.readFileSync(file, 'utf8');
  return new RegExp(`^${key}=(.+)$`, 'm').exec(txt)?.[1]?.trim();
}

const CONFIG = {
  boss: {
    base: 'http://127.0.0.1:8790',
    token: envToken(path.join(HOME, 'boss-client/.env'), 'BOSS_API_TOKEN'),
    searchBody: (cityCode, kw, pages) => ({ keyword: kw, cityCode, pageSize: Number(process.env.CRAWL_PAGE_SIZE || "100"), pages }),
    pick: (j) => ({ id: j.companyId, name: j.companyName, city: j.cityName, industry: j.companyIndustry, scale: j.companyScale }),
    query: (d) => d.query,
  },
  zhilian: {
    base: 'http://127.0.0.1:8791',
    token: envToken(path.join(HOME, 'zhilian-client/.env'), 'ZHILIAN_API_TOKEN'),
    searchBody: (cityCode, kw, pages) => ({ keyword: kw, cityCode, pages }),
    pick: (j) => ({ id: j.companyNumber, name: j.companyName, city: j.cityName, industry: j.companyIndustry, scale: j.companySize }),
    query: (d) => d.query,
  },
};

const CITIES = [
  { name: '石家庄', boss: '101090100', zhilian: '565' },
  { name: '唐山', boss: '101090500', zhilian: '566' },
  { name: '秦皇岛', boss: '101091100', zhilian: '567' },
  { name: '邯郸', boss: '101091000', zhilian: '568' },
  { name: '邢台', boss: '101090900', zhilian: '569' },
  { name: '保定', boss: '101090200', zhilian: '570' },
  { name: '张家口', boss: '101090300', zhilian: '571' },
  { name: '承德', boss: '101090400', zhilian: '572' },
  { name: '沧州', boss: '101090700', zhilian: '573' },
  { name: '廊坊', boss: '101090600', zhilian: '574' },
  { name: '衡水', boss: '101090800', zhilian: '575' },
];
const ALL_KEYWORDS = ['外贸', '外贸业务员', '外贸经理', '外贸单证员', '国际贸易', '跨境电商', '外贸跟单', '外贸专员', '海外销售', '国际业务'];
const KW_LIMIT = Number(process.env.CRAWL_KEYWORDS || '0');
const KEYWORDS = KW_LIMIT > 0 ? ALL_KEYWORDS.slice(0, KW_LIMIT) : ALL_KEYWORDS;
const PAGES = Math.max(1, Math.min(5, Number(process.env.CRAWL_PAGES || '3')));
const SLEEP = Number(process.env.CRAWL_SLEEP_MS || '1500');

const cfg = CONFIG[PLATFORM];
if (!cfg) { console.error('platform must be boss|zhilian'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let reqCount = 0;
async function search(cityCode, kw) {
  for (let attempt = 0; attempt < 4; attempt++) {
    reqCount++;
    const t0 = Date.now();
    try {
      const res = await fetch(cfg.base + '/v1/search/jobs', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify(cfg.searchBody(cityCode, kw, PAGES)),
        signal: AbortSignal.timeout(300000),
      });
      const json = await res.json();
      if (!json.ok) {
        const code = json.error?.code || String(res.status);
        if ((res.status === 429 || code === 'RATE_LIMITED' || code === 'UPSTREAM_COOLDOWN') && attempt < 3) { await sleep(30000); continue; }
        return { ok: false, code, ms: Date.now() - t0 };
      }
      return { ok: true, data: json.data, ms: Date.now() - t0 };
    } catch (e) {
      if (attempt < 3) { await sleep(15000); continue; }
      return { ok: false, code: String(e?.name || e), ms: Date.now() - t0 };
    }
  }
  return { ok: false, code: 'RETRY_EXHAUSTED', ms: 0 };
}

const companies = new Map();
const queries = [];
const started = Date.now();

for (const city of CITIES) {
  for (const kw of KEYWORDS) {
    const cityCode = PLATFORM === 'boss' ? city.boss : city.zhilian;
    const r = await search(cityCode, kw);
    if (!r.ok) {
      queries.push({ city: city.name, keyword: kw, error: r.code });
      console.log(`${PLATFORM} ${city.name}/${kw}: ERR ${r.code} (${reqCount} req)`);
      await sleep(SLEEP * 3);
      continue;
    }
    const q = cfg.query(r.data) || {};
    const jobs = r.data?.jobs || [];
    let n = 0;
    for (const j of jobs) {
      const rec = cfg.pick(j);
      if (!rec.id) continue;
      n++;
      if (!companies.has(rec.id)) companies.set(rec.id, { ...rec, platform: PLATFORM, jobCount: 0, keywords: new Set() });
      const c = companies.get(rec.id);
      c.jobCount++;
      c.keywords.add(kw);
      c.lastCity = city.name;
    }
    queries.push({ city: city.name, keyword: kw, queryId: q.queryId, resCount: q.resCount ?? q.count ?? null, totalCount: q.totalCount ?? null, jobs: jobs.length, newJobs: n, ms: r.ms });
    console.log(`${PLATFORM} ${city.name}/${kw}: jobs=${jobs.length} totalUnique=${companies.size} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    if (SLEEP > 0) await sleep(SLEEP);
  }
}

const rows = [...companies.values()].map((c) => ({ ...c, keywords: [...c.keywords] }));
fs.writeFileSync(path.join(OUT, `${PLATFORM}-companies.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const summary = {
  platform: PLATFORM, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(),
  elapsedSec: Math.round((Date.now() - started) / 1000), requests: reqCount, pages: PAGES, sleepMs: SLEEP,
  cities: CITIES.length, keywords: KEYWORDS.length, queries: queries.length, queryErrors: queries.filter((q) => q.error).length,
  uniqueCompanies: rows.length,
  perCity: Object.fromEntries(CITIES.map((c) => [c.name, rows.filter((r) => r.lastCity === c.name).length])),
  topKeywords: KEYWORDS.map((kw) => ({ keyword: kw, companies: rows.filter((r) => r.keywords.includes(kw)).length })),
  queriesDetail: queries,
};
fs.writeFileSync(path.join(OUT, `${PLATFORM}-summary.json`), JSON.stringify(summary, null, 2));
console.log(`DONE ${PLATFORM}: unique=${rows.length} requests=${reqCount} elapsed=${summary.elapsedSec}s errors=${summary.queryErrors}`);
