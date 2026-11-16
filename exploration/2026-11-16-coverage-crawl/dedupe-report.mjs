#!/usr/bin/env node
/**
 * 河北四源线索去重报告（探索脚本，非生产代码）
 *
 * 输入（可用环境变量覆盖）：
 *   BOSS_JSONL   out/boss-companies.jsonl
 *   ZH_JSONL     out/zhilian-companies.jsonl
 *   ALI_JSON     阿里 sweep 结果（含 hebeiFull）
 *   MIC_NDJSON   麦克 union.ndjson（5008）
 * 输出：
 *   out/dedupe-report.json
 *
 * 方法：
 *   1) 同语言精确/近精确去重：Boss∩智联（中文名）、Ali∩Mic（英文名）
 *   2) 跨语言匹配：中文名 → 拼音 token，与 Ali/Mic 英文名 token 比对（启发式，剔除省/市/generic 词）
 *   3) 输出各源数量、同语言重叠、跨语言启发式重叠与去重后总量（含保守/宽松区间）
 */
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.HOME || '/home/songqian';
const OUT = path.join(process.cwd(), 'out');
fs.mkdirSync(OUT, { recursive: true });
const P = {
  boss: process.env.BOSS_JSONL || path.join(OUT, 'boss-companies.jsonl'),
  zh: process.env.ZH_JSONL || path.join(OUT, 'zhilian-companies.jsonl'),
  ali: process.env.ALI_JSON || '',
  mic: process.env.MIC_NDJSON || '/tmp/hebei-enum2/union.ndjson',
};

const HEBEI_TOKENS = new Set(['hebei', 'shi', 'jiazhuang', 'shijiazhuang', 'tangshan', 'qinhuangdao', 'handan', 'xingtai', 'baoding', 'zhangjiakou', 'chengde', 'cangzhou', 'langfang', 'hengshui']);
// 河北地理词拼音集合（省/市/县），用于剔除地名 token，避免误配
const HEBEI_GEO_TOKENS = new Set(['hebei']);
const CITY_MAP = new Map([
  ['石家庄', 'shijiazhuang'], ['唐山', 'tangshan'], ['秦皇岛', 'qinhuangdao'], ['邯郸', 'handan'],
  ['邢台', 'xingtai'], ['保定', 'baoding'], ['张家口', 'zhangjiakou'], ['承德', 'chengde'],
  ['沧州', 'cangzhou'], ['廊坊', 'langfang'], ['衡水', 'hengshui'],
]);
try {
  const pca = JSON.parse(fs.readFileSync(path.join(HOME, 'ali-client/data/pca-code.json'), 'utf8'));
  const hb = pca.find((x) => String(x.name).startsWith('河北'));
  const { pinyin: py } = await import(path.join(HOME, 'ali-client/node_modules/pinyin-pro/dist/index.mjs'));
  const addGeo = (names) => { for (const n of names) { const p = py(String(n).replace(/(省市县区)$/g, ''), { toneType: 'none', type: 'array' }).join(''); if (p.length >= 4) HEBEI_GEO_TOKENS.add(p.toLowerCase()); } };
  addGeo([hb?.name ?? '河北省', '河北']);
  for (const c of hb?.children ?? []) { addGeo([c.name]); for (const g of c.children ?? []) addGeo([g.name]); }
} catch { /* ignore */ }

const EN_STOP = new Set(['co', 'ltd', 'limited', 'group', 'corp', 'corporation', 'company', 'the', 'and', 'inc', 'llc', 'gmbh', 'imp', 'exp', 'import', 'export', 'trading', 'industry', 'industrial', 'technology', 'tech', 'science', 'development', 'international', 'china', 'hebei']);
const CN_SUFFIX = ['股份有限公司', '有限责任公司', '有限公司', '集团有限公司', '集团', '分公司', '公司'];
const CN_GENERIC = ['河北省', '河北', '石家庄市', '石家庄', '唐山市', '唐山', '秦皇岛市', '秦皇岛', '邯郸市', '邯郸', '邢台市', '邢台', '保定市', '保定', '张家口市', '张家口', '承德市', '承德', '沧州市', '沧州', '廊坊市', '廊坊', '衡水市', '衡水'];

function readJsonl(p) {
  if (!p || !fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

// ---------- 中文名归一化 ----------
const CN_CACHE = new Map();
function cnNorm(name) {
  if (CN_CACHE.has(name)) return CN_CACHE.get(name);
  let s = String(name || '').replace(/[（(].*?[）)]/g, '').replace(/[\s·,，.。;；:：、'"“”‘’\-—_/\\]/g, '');
  let full = s;
  for (const suf of CN_SUFFIX) if (full.endsWith(suf)) { full = full.slice(0, -suf.length); break; }
  let core = full;
  for (const g of CN_GENERIC) if (core.startsWith(g)) { core = core.slice(g.length); break; }
  for (const suf of CN_SUFFIX) if (core.endsWith(suf)) { core = core.slice(0, -suf.length); break; }
  const out = { full: full.toLowerCase(), core: core.toLowerCase() };
  CN_CACHE.set(name, out);
  return out;
}

// ---------- 英文名归一化 ----------
const EN_CACHE = new Map();
function enNorm(name) {
  if (EN_CACHE.has(name)) return EN_CACHE.get(name);
  let s = String(name || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim();
  const tokens = s.split(/\s+/).filter((t) => t.length >= 2 && !EN_STOP.has(t.toLowerCase()));
  const out = { tokens, set: new Set(tokens), joined: tokens.join(' ') };
  EN_CACHE.set(name, out);
  return out;
}

// ---------- 拼音（用于跨语言） ----------
let pinyin = null;
try {
  const m = await import(path.join(HOME, 'ali-client/node_modules/pinyin-pro/dist/index.mjs'));
  pinyin = m.pinyin;
} catch { /* 无 pinyin-pro 时退化为跳过跨语言 */ }

function pinyinTokens(cnCore) {
  if (!pinyin) return [];
  const arr = pinyin(cnCore, { toneType: 'none', type: 'array' }).map((t) => String(t).toLowerCase());
  const toks = new Set();
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].length >= 3 && !HEBEI_TOKENS.has(arr[i])) toks.add(arr[i]);
    if (i + 1 < arr.length) { const b = arr[i] + arr[i + 1]; if (b.length >= 5 && !HEBEI_TOKENS.has(b)) toks.add(b); }
    if (i + 2 < arr.length) { const t = arr[i] + arr[i + 1] + arr[i + 2]; if (t.length >= 6) toks.add(t); }
  }
  return [...toks].filter((t) => !HEBEI_GEO_TOKENS.has(t));
}

// ---------- 读入 ----------
const boss = readJsonl(P.boss).map((r) => ({ platform: 'boss', id: r.id, name: r.name, city: r.city || r.lastCity, raw: r }));
const zh = readJsonl(P.zh).map((r) => ({ platform: 'zhilian', id: r.id, name: r.name, city: r.city || r.lastCity, raw: r }));
const aliJson = P.ali ? readJson(P.ali) : null;
const ali = (aliJson?.hebeiFull || []).map((r) => ({ platform: 'ali', id: r.companyId, name: r.companyName, city: r.city, raw: r }));
// 合并 matrix-round1（行业×城市增量）中不在 hebeiFull 的公司
const matrixCsv = process.env.ALI_MATRIX_CSV || path.join(HOME, 'ali-client/exploration/2026-11-16-perf/matrix-round1.csv');
if (fs.existsSync(matrixCsv)) {
  const ids = new Set(ali.map((x) => x.id));
  const lines = fs.readFileSync(matrixCsv, 'utf8').split('\n').slice(1).filter(Boolean);
  let added = 0;
  for (const line of lines) {
    const m = line.match(/^"?([^",]+)"?,"?([^"]+)"?,"?([^",]*)"?,"?([^",]*)"?/);
    if (!m) continue;
    const [, id, name, , city] = m;
    if (!id || ids.has(id)) continue;
    ids.add(id);
    ali.push({ platform: 'ali', id, name, city: city || null, raw: { source: 'matrix-round1' } });
    added++;
  }
  console.log(`[info] Ali matrix 增量合并 ${added} 家（总 ${ali.length}）`);
}
const mic = readJsonl(P.mic).map((r) => ({ platform: 'mic', id: r.account, name: r.company_name, city: r.city, raw: r }));

const count = { boss: boss.length, zhilian: zh.length, ali: ali.length, mic: mic.length };
if (!ali.length) console.warn('[warn] Ali hebeiFull 为空（可能 perf 结果未包含 hebeiFull）');

// ---------- 同语言去重 ----------
function cnKeySame(a, b) {
  const A = cnNorm(a.name), B = cnNorm(b.name);
  if (A.full && A.full === B.full) return true;
  if (A.core && B.core && A.core === B.core && A.core.length >= 4) return true;
  // 一个包含另一个（短名 vs 全名），要求长度≥4 且城市一致/未知
  const cityOk = !a.city || !b.city || String(a.city).toLowerCase() === String(b.city).toLowerCase();
  if (!cityOk) return false;
  const [short, long] = A.core.length <= B.core.length ? [A.core, B.core] : [B.core, A.core];
  return short.length >= 4 && long.includes(short);
}
function enKeySame(a, b) {
  const A = enNorm(a.name), B = enNorm(b.name);
  if (!A.tokens.length || !B.tokens.length) return false;
  if (A.joined && A.joined === B.joined) return true;
  const isLoc = (t) => HEBEI_TOKENS.has(t.toLowerCase());
  const sa = A.tokens.filter((t) => !isLoc(t));
  const sb = B.tokens.filter((t) => !isLoc(t));
  if (!sa.length || !sb.length) return false;
  const setB = new Set(sb);
  const shared = sa.filter((t) => setB.has(t));
  const union = new Set([...sa, ...sb]).size;
  if (shared.length >= 2 && shared.length / union >= 0.7) return true;
  return false;
}
function overlapCount(listA, listB, sameFn) {
  let matchedA = 0;
  const pairs = [];
  const usedB = new Set();
  for (const a of listA) {
    for (let i = 0; i < listB.length; i++) {
      const b = listB[i];
      if (usedB.has(i)) continue;
      if (sameFn(a, b)) { usedB.add(i); matchedA++; pairs.push([a.name, b.name]); break; }
    }
  }
  return { matchedA, pairs };
}
const bossZh = overlapCount(boss, zh, cnKeySame);
const aliMic = overlapCount(ali, mic, enKeySame);

// ---------- 跨语言启发式匹配（中文 ↔ 英文/拼音） ----------
function cityEq(cnCity, enCity) {
  if (!cnCity || !enCity) return false;
  const zh = String(cnCity).replace(/市$/, '');
  const mapped = CITY_MAP.get(zh) || zh.toLowerCase();
  return String(enCity).toLowerCase().replace(/\s+/g, '').includes(String(mapped));
}
function crossMatch(cn, en) {
  if (!pinyin) return false;
  const py = pinyinTokens(cnNorm(cn.name).core);
  if (!py.length) return false;
  const enSet = new Set([...enNorm(en.name).set].map((x) => x.toLowerCase()));
  const shared = py.filter((t) => t.length >= 5 && enSet.has(t));
  if (shared.length >= 2) return true;
  if (shared.length === 1 && shared[0].length >= 7 && cityEq(cn.city, en.city)) return true;
  return false;
}
const unknownCross = []; // 这里不做全量 O(n*m)（中文数千 × 英文数千），用倒排索引
function buildCrossIndex(englishList) {
  const idx = new Map(); // token -> items
  for (const e of englishList) {
    const norm = enNorm(e.name);
    for (const raw of norm.set) {
      const t = raw.toLowerCase();
      if (!idx.has(t)) idx.set(t, []);
      idx.get(t).push(e);
    }
  }
  return idx;
}
const crossIdx = buildCrossIndex([...ali, ...mic]);
const crossPairs = [];
const crossMatchedEn = new Set();
for (const c of [...boss, ...zh]) {
  const py = pinyinTokens(cnNorm(c.name).core);
  const candidates = new Map();
  for (const t of py) {
    if (t.length < 4) continue;
    for (const e of (crossIdx.get(t) || [])) {
      if (!candidates.has(e.platform + ':' + e.id)) candidates.set(e.platform + ':' + e.id, { e, shared: new Set() });
      candidates.get(e.platform + ':' + e.id).shared.add(t);
    }
  }
  for (const { e, shared } of candidates.values()) {
    const cityOk = !c.city || !e.city || String(c.city).toLowerCase() === String(e.city).toLowerCase();
    const tokens = [...shared].filter((t) => t.length >= 5);
    let hit = false;
    if (tokens.length >= 2) hit = true;
    else if (tokens.length === 1) hit = tokens[0].length >= 7 && cityEq(c.city, e.city);
    if (hit) {
      crossPairs.push({ cn: c.name, en: e.name, platform: e.platform, shared: tokens });
      crossMatchedEn.add(e.platform + ':' + e.id);
    }
  }
}

// ---------- 汇总 ----------
const unionZhNames = new Set();
for (const b of boss) unionZhNames.add(b.name);
for (const z of zh) unionZhNames.add(z.name);
const unionZhSize = boss.length + zh.length - bossZh.matchedA;
const unionEnSize = ali.length + mic.length - aliMic.matchedA;
const crossEst = crossMatchedEn.size;
// 优先使用 tanji 抽样口径（更可信；拼音启发式仅内部 debug）
const tanjiSample = readJson(path.join(OUT, 'crossmatch-sample.json'));
const totalEnCount = ali.length + mic.length;
const crossPreferred = tanjiSample?.rates
  ? Math.round(tanjiSample.rates.overall * totalEnCount)
  : crossEst;
const totalUnique = unionZhSize + unionEnSize - crossPreferred;
const crossCI = tanjiSample?.rates?.ci95
  ? [Math.round(tanjiSample.rates.ci95[0] * totalEnCount), Math.round(tanjiSample.rates.ci95[1] * totalEnCount)]
  : null;
const report = {
  generatedAt: new Date().toISOString(),
  inputs: P,
  counts: count,
  sameLanguage: {
    bossAndZhilian: { overlap: bossZh.matchedA, union: unionZhSize, samples: bossZh.pairs.slice(0, 20) },
    aliAndMic: { overlap: aliMic.matchedA, union: unionEnSize, samples: aliMic.pairs.slice(0, 20) },
  },
  crossLanguage: {
    preferredMethod: tanjiSample ? 'tanji-sample' : 'pinyin-heuristic',
    matchedEnglishCompanies: crossPreferred,
    tanjiSample: tanjiSample ? { n: tanjiSample.n, rate: tanjiSample.rates.overall, ci95: tanjiSample.rates.ci95, estimatedCountCI: crossCI, note: 'Ali/Mic 英文名随机样本经探迹匹配后是否出现在招聘名单' } : null,
    pinyinHeuristicCount: crossEst,
    note: '拼音启发式会误配地名/常见音节，仅内部参考；对外采用 tanji 抽样口径',
    pinyinSamples: crossPairs.slice(0, 10),
  },
  totalUniqueEstimate: totalUnique,
  totalUniqueEstimateRange: crossCI ? [unionZhSize + unionEnSize - crossCI[1], unionZhSize + unionEnSize - crossCI[0]] : null,
  formula: 'union(中文源) + union(英文源) - 跨语言重叠（tanji 抽样估算）',
  caveats: [
    'Boss/智联为关键词扫描（非全量目录），只覆盖在招公司；数量随关键词/页数变化',
    'Ali 为关键词/城市/县种子枚举（1559 已核验 + 矩阵增量），不是平台省级全量目录',
    'Mic 使用 client 已完成的河北 5008 并集（2026-11-16 真实全量枚举）',
    '跨语言匹配为启发式，可能漏配/误配；建议抽样 tanji 英文名匹配做验证',
  ],
};
fs.writeFileSync(path.join(OUT, 'dedupe-report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ counts: report.counts, sameLanguage: report.sameLanguage, cross: { matchedEnglishCompanies: crossEst }, totalUniqueEstimate: totalUnique }, null, 2));
