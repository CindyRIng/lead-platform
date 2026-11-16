#!/usr/bin/env node
/**
 * 跨语言重叠抽样验证（探索脚本）
 * 目的：抽样 Ali/Mic 英文公司名 → tanji 英文名匹配 → 中文主体 → 是否出现在招聘源（Boss/智联）名单中。
 * 用于估算「英文源 × 中文源」的重叠率，并检验拼音启发式的准确率。
 *
 * 用法：node sample-crossmatch.mjs [N]
 * 输出：out/crossmatch-sample.json
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/songqian';
const N = Number(process.argv[2] || '80');
const OUT = path.join(process.cwd(), 'out');
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readJsonl = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const TJ_TOKEN = readJson(path.join(HOME, '.tanji-client/config.json'))?.apiToken;
if (!TJ_TOKEN) throw new Error('tanji token missing');

const aliJson = readJson(process.env.ALI_JSON || '');
const ali = (aliJson?.hebeiFull || []).map((r) => ({ source: 'ali', name: r.companyName, city: r.city }));
const mic = readJsonl(process.env.MIC_NDJSON || '/tmp/hebei-enum2/union.ndjson').map((r) => ({ source: 'mic', name: r.company_name, city: r.city }));
const zhNamesRaw = [
  ...readJsonl(process.env.BOSS_JSONL || path.join(OUT, 'boss-companies.jsonl')).map((r) => r.name),
  ...readJsonl(process.env.ZH_JSONL || path.join(OUT, 'zhilian-companies.jsonl')).map((r) => r.name),
].filter(Boolean);

// 简单中文归一化（与 dedupe 脚本口径一致）
const SUFFIX = ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '分公司', '公司'];
const prefixCity = ['河北省', '河北', '石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水'];
function cnCore(name) {
  let s = String(name || '').replace(/[（(].*?[）)]/g, '').replace(/[\s·,，.。;；:：、'"“”‘’\-—_/\\]/g, '');
  for (const p of prefixCity) if (s.startsWith(p)) { s = s.slice(p.length); break; }
  for (const suf of SUFFIX) if (s.endsWith(suf)) { s = s.slice(0, -suf.length); break; }
  return s.toLowerCase();
}
const zhSet = new Set(zhNamesRaw.map(cnCore));
function hitRecruitment(cnName) {
  const core = cnCore(cnName);
  if (!core) return false;
  if (zhSet.has(core)) return true;
  for (const z of zhSet) {
    if (z.length >= 4 && core.length >= 4 && (z.includes(core) || core.includes(z))) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;
async function tanjiMatch(name) {
  for (let attempt = 0; attempt < 3; attempt++) {
    calls++;
    try {
      const res = await fetch('http://127.0.0.1:8787/v1/search/name', {
        method: 'POST',
        headers: { authorization: `Bearer ${TJ_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, field: 'name', pageSize: 5, maxPages: 1 }),
        signal: AbortSignal.timeout(60000),
      });
      const json = await res.json();
      if (!json.ok) { await sleep(3000); continue; }
      const top = json.data?.companies?.[0] || null;
      return top ? { id: top.id, name: top.name, uscc: top.uscc, score: top.score, total: json.data.total } : { id: null, name: null, total: json.data?.total ?? 0 };
    } catch { await sleep(3000); }
  }
  return { error: true };
}

function pickN(list, n, seed) {
  const arr = [...list];
  let s = seed;
  for (let i = arr.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483647; const j = s % (i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, n);
}

const started = Date.now();
const samples = [];
for (const [source, list] of [['ali', ali], ['mic', mic]]) {
  const picked = pickN(list, Math.min(N, list.length), 42);
  for (const item of picked) {
    const r = await tanjiMatch(item.name);
    samples.push({ source, englishName: item.name, city: item.city, tanji: r, hitRecruitment: r?.name ? hitRecruitment(r.name) : false });
    if (samples.length % 10 === 0) console.log(`sampled ${samples.length}/${N * 2} calls=${calls} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
  }
}
const rate = (arr) => arr.length ? arr.filter((x) => x.hitRecruitment).length / arr.length : 0;
const bySource = { ali: samples.filter((s) => s.source === 'ali'), mic: samples.filter((s) => s.source === 'mic') };
const totalEn = ali.length + mic.length;
const overallRate = rate(samples);
const se = Math.sqrt(overallRate * (1 - overallRate) / Math.max(1, samples.length));
const report = {
  generatedAt: new Date().toISOString(),
  n: samples.length,
  calls,
  elapsedSec: Math.round((Date.now() - started) / 1000),
  counts: { ali: ali.length, mic: mic.length, zhNames: zhNamesRaw.length },
  rates: {
    ali: rate(bySource.ali), mic: rate(bySource.mic), overall: overallRate,
    ci95: [Math.max(0, overallRate - 1.96 * se), Math.min(1, overallRate + 1.96 * se)],
    estimatedCrossOverlapCount: Math.round(overallRate * totalEn),
  },
  samples,
};
fs.writeFileSync(path.join(OUT, 'crossmatch-sample.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ n: report.n, rates: report.rates, counts: report.counts }, null, 2));
