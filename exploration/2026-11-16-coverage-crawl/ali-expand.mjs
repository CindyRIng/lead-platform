#!/usr/bin/env node
/**
 * Ali 河北扩展采集（探索脚本）
 * 目标：在已有 1,970 家的基础上继续枚举，观察“跑到全量”能到多少。
 *
 * 阶段：
 *   county : 118 个县/县级市英文名 × pages（默认 5），locationMode=off，按名称判河北
 *   city   : 11 个地级市英文名 × pages（默认 20），同上
 *   matrix : 行业词 × 11 城市，province=Hebei strict（返回即河北确认）
 * checkpoint：data/ali-expansion.json（可断点续跑）；日志 stdout。
 *
 * 用法：node ali-expand.mjs county
 *       node ali-expand.mjs city
 *       node ali-expand.mjs matrix
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/songqian';
const OUT = path.join(process.cwd(), 'data');
fs.mkdirSync(OUT, { recursive: true });
const STATE_FILE = path.join(OUT, 'ali-expansion.json');

const TOKEN = (() => {
  const txt = fs.readFileSync(path.join(HOME, 'ali-client/.env'), 'utf8');
  return /^ALI_API_TOKEN=(.+)$/m.exec(txt)?.[1]?.trim();
})();
const BASE = 'http://127.0.0.1:8792';
const PHASE = process.argv[2] || 'county';
const PAGES = Number(process.argv[3] || (PHASE === 'county' ? 5 : PHASE === 'city' ? 20 : 1));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(BASE + pathname, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600000),
      });
      const json = await res.json();
      if (!json.ok) {
        const code = json.error?.code || String(res.status);
        if ((code === 'RATE_LIMITED' || code === 'UPSTREAM_RATE_LIMITED' || res.status === 429) && attempt < retries) { await sleep(30000); continue; }
        return { ok: false, code, message: json.error?.message };
      }
      return { ok: true, data: json.data, meta: json.meta };
    } catch (e) {
      if (attempt < retries) { await sleep(15000); continue; }
      return { ok: false, code: String(e?.name || e) };
    }
  }
}

// ---------- 区域词 ----------
const HEBEI_CITIES_ZH = ['石家庄', '唐山', '秦皇岛', '邯郸', '邢台', '保定', '张家口', '承德', '沧州', '廊坊', '衡水'];
const CITY_EN = ['Shijiazhuang', 'Tangshan', 'Qinhuangdao', 'Handan', 'Xingtai', 'Baoding', 'Zhangjiakou', 'Chengde', 'Cangzhou', 'Langfang', 'Hengshui'];
let COUNTIES = []; // {en}
let OTHER_PROVINCE_TOKENS = new Set();
const piny = async (s) => {
  const { pinyin } = await import(path.join(HOME, 'ali-client/node_modules/pinyin-pro/dist/index.mjs'));
  return pinyin(String(s).replace(/(省市县区)$/g, ''), { toneType: 'none', type: 'array' }).join('').toLowerCase();
};
try {
  const pca = JSON.parse(fs.readFileSync(path.join(HOME, 'ali-client/data/pca-code.json'), 'utf8'));
  const hb = pca.find((x) => String(x.name).startsWith('河北'));
  for (const c of hb?.children ?? []) for (const g of c.children ?? []) COUNTIES.push({ en: await piny(g.name), zh: g.name });
  const regions = JSON.parse(fs.readFileSync('/tmp/lp-test/ali-regions.json', 'utf8')).data.items;
  for (const r of regions) if (r.level === 'province' && r.nameEn && !/hebei/i.test(r.nameEn)) OTHER_PROVINCE_TOKENS.add(r.nameEn.toLowerCase().split(/\s+/)[0]);
} catch (e) { console.warn('region load warn', String(e).slice(0, 120)); }
const HEBEI_GEO_TOKENS = new Set(['hebei', ...CITY_EN.map((x) => x.toLowerCase()), ...COUNTIES.map((x) => x.en)]);

const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { accounts: {}, done: { county: [], city: [], matrix: [] }, updatedAt: null };
const accounts = new Map(Object.entries(state.accounts || {}));
let added = 0, totalSeedHits = 0;

function classifyByName(name) {
  const n = String(name || '').toLowerCase();
  if (OTHER_PROVINCE_TOKENS.size) for (const t of OTHER_PROVINCE_TOKENS) if (t.length > 3 && n.includes(t)) return 'other';
  for (const t of HEBEI_GEO_TOKENS) if (t.length >= 4 && n.includes(t)) return 'hebei';
  return 'unknown';
}
function absorb(list, seed) {
  let hits = 0;
  for (const s of list || []) {
    if (!s.companyId) continue;
    const cls = s.location?.province === 'Hebei' ? 'hebei' : classifyByName(s.companyName);
    if (cls !== 'hebei') continue;
    hits++;
    if (!accounts.has(s.companyId)) { accounts.set(s.companyId, { companyId: s.companyId, companyName: s.companyName, city: s.location?.city || s.city || null, seeds: [seed], source: 'expand' }); added++; }
    else { const a = accounts.get(s.companyId); if (!a.seeds.includes(seed)) a.seeds.push(seed); }
  }
  totalSeedHits += hits;
  return hits;
}

const started = Date.now();
function save(phase) {
  state.accounts = Object.fromEntries(accounts);
  state.updatedAt = new Date().toISOString();
  state.stats = { phase, added, totalUnique: accounts.size, seedHits: totalSeedHits, elapsedSec: Math.round((Date.now() - started) / 1000) };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

if (PHASE === 'county' || PHASE === 'city') {
  const seeds = PHASE === 'county' ? COUNTIES.map((c) => c.en) : CITY_EN;
  const done = new Set(state.done?.[PHASE] || []);
  console.log(`phase=${PHASE} seeds=${seeds.length} pages=${PAGES} done=${done.size} existingAcc=${accounts.size}`);
  for (const seed of seeds) {
    if (done.has(seed)) continue;
    const r = await api('/v1/search/suppliers', { keyword: seed, pages: PAGES, locationMode: 'off' });
    if (!r.ok) { console.log(`${seed}: ERR ${r.code}`); await sleep(20000); continue; }
    const list = r.data.suppliers || [];
    const hits = absorb(list, seed);
    state.done[PHASE].push(seed);
    if ((state.done[PHASE].length % 10) === 0 || hits) console.log(`${seed}: items=${list.length} hebei=${hits} added=${added} total=${accounts.size} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    save(PHASE);
    await sleep(500);
  }
} else if (PHASE === 'matrix') {
  const INDUSTRIES = (process.env.ALI_INDUSTRIES || 'machinery,hardware,wire mesh,auto parts,pipe fitting,glass,bicycle,furniture,textile,garment,chemicals,electronics,cables,tools,packaging,food,agriculture,medical,construction,lighting,solar,battery,toys,shoes,bags,ceramics,rubber,plastic,steel,bearings,valve,pump,motor,instrument,generator,insulation,adhesive,fastener,casting,forging').split(',');
  const seeds = [];
  // 省级行业词（strict，返回即 Hebei 确认）
  for (const ind of INDUSTRIES) seeds.push({ key: `province|${ind}`, keyword: ind });
  for (const city of CITY_EN) for (const ind of INDUSTRIES) seeds.push({ key: `${city}|${ind}`, keyword: `${city} ${ind}` });
  const done = new Set(state.done?.matrix || []);
  console.log(`phase=matrix cities=${CITY_EN.length} industries=${INDUSTRIES.length} seeds=${seeds.length} done=${done.size} existingAcc=${accounts.size}`);
  let n = 0;
  for (const s of seeds) {
    if (done.has(s.key)) continue;
    const r = await api('/v1/search/suppliers', { keyword: s.keyword, province: 'Hebei', pages: 1, maxEnrich: 60 });
    if (!r.ok) { console.log(`${s.key}: ERR ${r.code}`); await sleep(20000); continue; }
    const hits = absorb(r.data.suppliers || [], s.key);
    state.done.matrix.push(s.key);
    n++;
    if (n % 10 === 0) console.log(`matrix ${n}/${seeds.length - done.size} ${s.key} hebei=${hits} added=${added} total=${accounts.size} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    save('matrix');
    if (n % 40 === 0) { console.log('冷却 60s（防详情接口风控）'); await sleep(60000); }
    else await sleep(800);
  }
} else {
  console.error('phase must be county|city|matrix');
  process.exit(2);
}

save(PHASE);
console.log(JSON.stringify({ phase: PHASE, newAdded: added, totalUnique: accounts.size, elapsedSec: Math.round((Date.now() - started) / 1000), state: STATE_FILE }, null, 2));
