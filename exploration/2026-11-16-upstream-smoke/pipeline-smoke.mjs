#!/usr/bin/env node
/**
 * LeadPlatform 迷你流水线验证（只读冒烟 / 探索脚本，非生产代码）
 *
 * 目的：在进入开发前，用真实上游客户端小批量验证关键链路：
 *   1) 五源健康/登录态
 *   2) Boss/智联：岗位检索 → 公司去重 → 公司详情（工商/USCC）→ 在招岗位
 *   3) Ali/Mic：供应商/工厂检索 → 详情（英文抬头 + 店铺档案）
 *   4) 探迹：中文名/英文抬头匹配 → 工商详情 → 联系人（未解锁只读 counts）
 *   5) fuma-platform：英文抬头/中文名 → 海关 tradeList 查询 → 记录过滤/聚合
 *   6) 组装一份「公司线索画像」样例（含平台档案 + 岗位 + 海关摘要）
 *
 * 安全约束：
 *   - 只调用 GET / 只读 POST；不调用 tanji unlock（不消耗额度）
 *   - 不落盘联系人明文（只统计 counts/types）；岗位招聘人姓名落盘前打码
 *   - 所有原始响应保存到 data/raw/，供报告引用
 *
 * 运行：node pipeline-smoke.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = HERE;
const RAW_DIR = join(HERE, 'data', 'raw');
const HOME = process.env.HOME || '/home/songqian';

mkdirSync(RAW_DIR, { recursive: true });

// ---------- config ----------
function readEnv(path, key) {
  try {
    const txt = readFileSync(path, 'utf8');
    const m = txt.match(new RegExp(`^${key}=(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } }

const CFG = {
  boss: { url: 'http://127.0.0.1:8790', token: readEnv(join(HOME, 'boss-client/.env'), 'BOSS_API_TOKEN') },
  zhilian: { url: 'http://127.0.0.1:8791', token: readEnv(join(HOME, 'zhilian-client/.env'), 'ZHILIAN_API_TOKEN') },
  ali: { url: 'http://127.0.0.1:8792', token: readEnv(join(HOME, 'ali-client/.env'), 'ALI_API_TOKEN') },
  mic: { url: 'http://127.0.0.1:8899', token: null },
  tanji: { url: 'http://127.0.0.1:8787', token: readJson(join(HOME, '.tanji-client/config.json'))?.apiToken || null },
  fuma: { url: 'http://127.0.0.1:17890', token: readJson(join(HOME, '.fuma-platform/config.json'))?.server?.apiToken || null, accountId: 'acct_01' },
};

const REPORT = { startedAt: new Date().toISOString(), steps: [], findings: [], candidates: [], quotaConsumed: 0 };

function maskName(v) {
  if (!v || typeof v !== 'string') return v;
  if (v.length <= 1) return v;
  if (/^[A-Za-z]/.test(v)) return v; // 英文公司名/人名不处理（公司名非 PII）
  return v[0] + '*';
}
function maskJobs(jobs) {
  return (jobs || []).map(j => ({ ...j, recruiterName: maskName(j.recruiterName) }));
}
function pick(obj, keys) { const out = {}; for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k]; return out; }

let stepSeq = 0;
async function call(source, method, path, body, saveAs, timeoutMs = 180000) {
  const cfg = CFG[source];
  const url = cfg.url + path;
  const headers = { accept: 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t0 = Date.now();
  let httpStatus = 0, json = null, err = null;
  try {
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    httpStatus = res.status;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
  } catch (e) { err = String(e?.name || e); }
  const ms = Date.now() - t0;
  const id = ++stepSeq;
  const step = { id, source, method, path, httpStatus, ms, ok: json?.ok === true && !err, error: err || json?.error?.code || null, saveAs: saveAs || null };
  REPORT.steps.push(step);
  const data = json?.data ?? null;
  if (saveAs) {
    const payload = { step, response: json };
    writeFileSync(join(RAW_DIR, `${String(id).padStart(2, '0')}-${saveAs}.json`), JSON.stringify(payload, null, 2));
  }
  return { step, json, data, error: json?.error ?? null };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sanitizeRawDir(dir) {
  const names = ['recruiterName', 'bossName', 'recruiterTitle', 'bossTitle'];
  let changed = 0;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const p = join(dir, f);
    let obj;
    try { obj = JSON.parse(readFileSync(p, 'utf8')); } catch { continue; }
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { o.forEach(walk); return; }
      for (const k of Object.keys(o)) {
        if (names.includes(k) && typeof o[k] === 'string' && o[k].length > 1 && /[\u4e00-\u9fa5]/.test(o[k])) {
          o[k] = o[k][0] + '*'; changed++;
        } else walk(o[k]);
      }
    };
    walk(obj);
    writeFileSync(p, JSON.stringify(obj, null, 2));
  }
  return changed;
}


// ---------- 1. health/status ----------
async function healthChecks() {
  const checks = [
    ['boss', 'GET', '/v1/status', undefined, 'boss-status'],
    ['zhilian', 'GET', '/v1/status', undefined, 'zhilian-status'],
    ['ali', 'GET', '/v1/status', undefined, 'ali-status'],
    ['mic', 'GET', '/api/version', undefined, 'mic-version'],
    ['tanji', 'GET', '/v1/status', undefined, 'tanji-status'],
    ['fuma', 'GET', '/v1/status', undefined, 'fuma-status'],
  ];
  const out = {};
  for (const [src, m, p, b, s] of checks) out[src] = await call(src, m, p, b, s);
  return out;
}

// ---------- 2. boss ----------
async function bossFlow() {
  const search = await call('boss', 'POST', '/v1/search/jobs', { keyword: '外贸', cityCode: '101090100', pageSize: 20, pages: 1 }, 'boss-search');
  const qid = search.data?.query?.queryId || search.data?.queryId;
  if (!qid) return { error: 'no queryId' };
  const companies = await call('boss', 'GET', `/v1/companies?queryId=${encodeURIComponent(qid)}`, undefined, 'boss-companies');
  const list = companies.data?.companies || [];
  const target = list.find(c => c.jobCount >= 2) || list[0];
  if (!target) return { error: 'no companies' };
  const detail = await call('boss', 'GET', `/v1/companies/${encodeURIComponent(target.companyId)}`, undefined, 'boss-detail');
  const jobs = await call('boss', 'GET', `/v1/companies/${encodeURIComponent(target.companyId)}/jobs`, undefined, 'boss-jobs');
  const d = detail.data || {};
  return {
    source: 'boss', sourceLabel: 'Boss直聘',
    platformCompanyId: target.companyId,
    displayName: d.fullName || d.name || target.name,
    chineseName: d.business?.companyName || d.fullName || d.name,
    englishName: null,
    uscc: d.business?.uscc || null,
    city: d.cityName || target.cityName,
    address: d.business?.registeredAddress || d.address || null,
    industry: d.industry || target.industry, scale: d.scale || target.scale,
    jobs: maskJobs((jobs.data?.jobs || []).map(j => pick(j, ['jobId', 'title', 'salaryText', 'cityName', 'district', 'degree', 'experience', 'recruiterName', 'recruiterTitle', 'jobUrl']))),
    jobCount: d.jobCount ?? jobs.data?.jobs?.length ?? null,
    bossCount: d.bossCount ?? null,
    tags: d.tags || [], benefits: d.benefits || [],
    business: d.business || null,
  };
}

// ---------- 3. zhilian ----------
async function zhilianFlow() {
  const search = await call('zhilian', 'POST', '/v1/search/jobs', { keyword: '外贸', cityCode: '565', pages: 1, pageSize: 20 }, 'zhilian-search');
  const qid = search.data?.query?.queryId || search.data?.queryId;
  if (!qid) return { error: 'no queryId' };
  const companies = await call('zhilian', 'GET', `/v1/companies?queryId=${encodeURIComponent(qid)}`, undefined, 'zhilian-companies');
  const list = companies.data?.companies || [];
  const target = list.find(c => (c.jobCount || 0) >= 2) || list[0];
  if (!target) return { error: 'no companies' };
  const detail = await call('zhilian', 'GET', `/v1/companies/${encodeURIComponent(target.companyNumber)}`, undefined, 'zhilian-detail');
  const jobs = await call('zhilian', 'GET', `/v1/companies/${encodeURIComponent(target.companyNumber)}/jobs`, undefined, 'zhilian-jobs');
  const d = detail.data || {};
  return {
    source: 'zhilian', sourceLabel: '智联招聘',
    platformCompanyId: target.companyNumber,
    displayName: d.fullName || d.name || target.name,
    chineseName: d.business?.registeredName || d.fullName || d.name,
    englishName: null,
    uscc: d.business?.uscc || null,
    city: d.cityName || target.cityName,
    address: d.address || d.business?.registeredAddress || null,
    industry: d.industry || target.industry, scale: d.size || target.size,
    jobs: maskJobs((jobs.data?.jobs || []).map(j => pick(j, ['positionNumber', 'title', 'salaryText', 'salaryMin', 'salaryMax', 'cityName', 'district', 'education', 'experience', 'publishTime', 'recruiterName', 'jobUrl']))),
    jobCount: d.jobCount ?? jobs.data?.jobs?.length ?? null,
    tags: d.tags || [], benefits: d.benefits || [],
    business: d.business || null,
  };
}

// ---------- 4. ali ----------
async function aliFlow() {
  // 实测结论：Ali 带 keyword + strict location 过滤容易 0 结果；按省检索最稳
  const search = await call('ali', 'POST', '/v1/search/suppliers', { province: '河北', pages: 1, maxEnrich: 60 }, 'ali-search');
  const list = search.data?.suppliers || [];
  if (!list.length) return { error: 'no suppliers' };
  const picked = list.filter(s => /jinshi|shengtian/i.test(s.companyName || '')).slice(0, 2);
  const targets = picked.length ? picked : list.slice(0, 2);
  const out = [];
  for (const s of targets) {
    const detail = await call('ali', 'GET', `/v1/suppliers/${encodeURIComponent(s.companyId)}`, undefined, `ali-detail-${s.companyId}`);
    const d = detail.data || {};
    out.push({
      source: 'ali', sourceLabel: '阿里巴巴国际站',
      platformCompanyId: s.companyId,
      displayName: d.companyName || s.companyName,
      chineseName: null,
      englishName: d.companyName || s.companyName,
      uscc: null,
      city: d.location?.city || s.location?.city || null,
      province: d.location?.province || null,
      address: d.location?.address || null,
      industry: null,
      store: {
        joinedYears: d.joinedYears ?? null,
        supplierIndex: d.supplierIndex ?? null,
        membership: d.membership ? pick(d.membership, ['label', 'plan', 'rank', 'verifiedSupplier', 'verifiedPro', 'paidMember', 'onsiteAssessment', 'goldYears', 'assessedBy']) : null,
        rating: d.rating ?? null,
        businessType: d.businessType ?? null,
        mainProducts: d.mainProducts ?? [],
        profile: d.profile ? pick(d.profile, ['establishedYear', 'annualRevenue', 'employees', 'mainMarkets', 'paymentMethods', 'deliveryTerms']) : null,
        performance: d.performance ? pick(d.performance, ['storeRating', 'onTimeDeliveryRate', 'responseRate', 'responseTime', 'totalExportRevenueUSD', 'floorSpaceText', 'productionLines', 'factoryRank']) : null,
      },
      jobs: [],
      jobCount: null,
    });
  }
  return out;
}

// ---------- 5. mic ----------
async function micFlow() {
  const search = await call('mic', 'GET', '/api/search/factories?province=Hebei&page=1&page_size=20', undefined, 'mic-search');
  const list = search.data?.items || [];
  if (!list.length) return { error: 'no factories' };
  const target = list.find(x => /wire|cable|pipe|metal/i.test(x.company_name || '')) || list[0];
  const detail = await call('mic', 'GET', `/api/companies/${encodeURIComponent(target.account)}?include=audit,response`, undefined, 'mic-detail');
  const d = detail.data || {};
  return {
    source: 'mic', sourceLabel: '中国制造网',
    platformCompanyId: d.account || target.account,
    displayName: d.company_name || target.company_name,
    chineseName: null,
    englishName: d.company_name || target.company_name,
    uscc: null,
    city: d.city || target.city || null,
    province: d.province || target.province || null,
    address: d.address || null,
    industry: null,
    store: {
      membership: d.membership ?? target.membership ?? null,
      audited: d.audited ?? target.audited ?? null,
      capabilityStars: d.capability_stars ?? target.capability_stars ?? null,
      certifications: d.system_certifications ?? target.system_certifications ?? [],
      businessTypes: d.business_types ?? target.business_types ?? [],
      mainProducts: d.main_products ?? target.main_products ?? [],
      employees: d.employees ?? null,
      turnover: d.turnover ?? null,
      plantArea: d.plant_area ?? null,
      establishedAt: d.established_at ?? null,
      enrichment: d.enrichment ? { audit: d.enrichment.audit?.audited_section_count ?? null, response: d.enrichment.response ?? null } : null,
    },
    jobs: [],
    jobCount: null,
  };
}

// ---------- 6. tanji match ----------
async function tanjiMatch(cand) {
  const queryName = cand.englishName || cand.chineseName || cand.displayName;
  const field = 'name';
  const search = await call('tanji', 'POST', '/v1/search/name', { name: queryName, field, pageSize: 5, maxPages: 1 }, `tanji-search-${cand.source}`);
  const comps = search.data?.companies || [];
  const best = comps[0];
  if (!best) return { ...cand, tanji: { queryName, total: search.data?.total ?? 0, matched: null } };
  const detail = await call('tanji', 'GET', `/v1/companies/${encodeURIComponent(best.id)}`, undefined, `tanji-detail-${cand.source}`);
  const contacts = await call('tanji', 'GET', `/v1/companies/${encodeURIComponent(best.id)}/contacts`, undefined, null);
  const d = detail.data || {};
  const contactsData = contacts.data || {};
  return {
    ...cand,
    tanji: {
      queryName,
      total: search.data?.total ?? 0,
      matched: pick(d, ['id', 'name', 'uscc', 'legalRepresentative', 'foundTime', 'address', 'province', 'operStatus', 'homepage']),
      industry: d.industry?.fourth || d.industry?.third || d.industry?.second || null,
      scale: d.scale ?? null,
      tags: (d.tags || []).slice(0, 20),
      unlocked: contactsData.unlocked ?? d.unlocked ?? false,
      detailUnlocked: d.unlocked ?? null,
      contactCounts: contactsData.counts ?? null, // 不落联系人明文
      matchScore: best.score ?? null,
      candidates: comps.slice(0, 3).map(c => ({ id: c.id, name: c.name, uscc: c.uscc, score: c.score })),
    },
  };
}

// ---------- 7. fuma customs ----------
function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fa5]+/g, ' ').trim(); }
function tokensOf(name) {
  return norm(name).split(/\s+/).filter(t => t.length >= 3 &&
    !['CO', 'LTD', 'LIMITED', 'GROUP', 'CORP', 'CORPORATION', 'COMPANY', 'THE', 'AND', 'INC', 'LLC', 'GMBH'].includes(t));
}

function summarizeCustoms(flags, queryNames) {
  const records = [];
  for (const f of flags) {
    if (!f.ok) continue;
    for (const r of f.data?.list || []) records.push({ ...r, __query: f.name, __flag: f.flag });
  }
  const dedup = new Map();
  for (const r of records) if (!dedup.has(r.tradeno)) dedup.set(r.tradeno, r);
  const all = [...dedup.values()];
  const nameTokens = [...new Set(queryNames.flatMap(tokensOf))];

  const classified = all.map(r => {
    const exporterHay = norm([r.rawexporter, r.exporter, r.usedsuppliername].filter(Boolean).join(' '));
    const importerHay = norm([r.rawimporter, r.importer, r.usedbuyername].filter(Boolean).join(' '));
    const asExporter = nameTokens.some(t => exporterHay.includes(t));
    const asImporter = nameTokens.some(t => importerHay.includes(t));
    return { r, asExporter, asImporter, matched: asExporter || asImporter };
  });
  const matched = classified.filter(x => x.matched);
  const asExporter = matched.filter(x => x.asExporter).map(x => x.r);
  const asImporter = matched.filter(x => x.asImporter).map(x => x.r);
  const dates = matched.map(x => x.r.regdate).filter(Boolean).sort();
  const top = (o, n = 5) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));
  const countBy = (arr, fn) => arr.reduce((o, x) => { const k = fn(x); if (k) o[k] = (o[k] || 0) + 1; return o; }, {});
  const buyers = asExporter.map(r => r.rawimporter || r.importer).filter(Boolean);
  const suppliers = asImporter.map(r => r.rawexporter || r.exporter).filter(Boolean);
  let totalWeight = 0, totalCount = 0, amount = 0;
  for (const x of matched) { totalWeight += Number(x.r.weight) || 0; totalCount += Number(x.r.count) || 0; amount += Number(x.r.money) || 0; }

  return {
    queryNames,
    queries: flags.map(f => ({ name: f.name, flag: f.flag, ok: f.ok, totalNum: f.data?.totalNum ?? null, allCount: f.data?.allCount ?? null, exactCount: f.data?.exactCount ?? null, cached: f.data?.cached ?? null, source: f.data?.source ?? null, error: f.error || null })),
    fetched: all.length,
    matched: matched.length,
    asExporter: asExporter.length,
    asImporter: asImporter.length,
    unmatched: all.length - matched.length,
    confidence: matched.length >= 5 ? 'high' : matched.length > 0 ? 'medium' : 'none',
    dateRange: dates.length ? { min: dates[0], max: dates[dates.length - 1] } : null,
    topDestinations: top(countBy(asExporter, r => r.importercountryen || r.destcountry)),
    topOrigins: top(countBy(asImporter, r => r.exportercountryen || r.origincountry)),
    topHs4: top(countBy(matched.map(x => x.r), r => r.hscode ? String(r.hscode).slice(0, 4) : null)),
    topProducts: top(countBy(matched.map(x => x.r), r => r.detail ? String(r.detail).trim().slice(0, 40) : null)),
    topBuyers: top(countBy(buyers, n => n)),
    topSuppliers: top(countBy(suppliers, n => n)),
    totalWeight: Math.round(totalWeight),
    totalCount: Math.round(totalCount),
    amount,
    matchedSample: matched.slice(0, 5).map(x => ({ role: x.asExporter ? 'exporter' : 'importer', tradeno: x.r.tradeno, inout: x.r.inout, rawimporter: x.r.rawimporter, rawexporter: x.r.rawexporter, importercountryen: x.r.importercountryen, exportercountryen: x.r.exportercountryen, hscode: x.r.hscode, regdate: x.r.regdate, detail: String(x.r.detail || '').slice(0, 60) })),
    unmatchedSample: classified.filter(x => !x.matched).slice(0, 3).map(x => ({ rawimporter: x.r.rawimporter, rawexporter: x.r.rawexporter, importer: x.r.importer, exporter: x.r.exporter })),
  };
}

async function fumaCustomsFor(cand) {
  const names = [];
  if (cand.englishName) names.push(cand.englishName);
  if (cand.tanji?.matched?.name) names.push(cand.tanji.matched.name);
  const namesUniq = [...new Set(names)];
  const flagResults = [];
  const t0 = Date.now();
  for (const name of namesUniq) {
    for (const flag of [1, 2]) {
      const r = await call('fuma', 'POST', '/v1/customs/query', { accountId: CFG.fuma.accountId, inputCompany: name, companyFlag: flag, page: 1, pageSize: 20 }, `fuma-customs-${cand.source}-${flag}-${name.slice(0, 20).replace(/[^\w\u4e00-\u9fa5]+/g, '_')}`);
      flagResults.push({ name, flag, ok: r.step.ok, data: r.data, error: r.error });
    }
  }
  const summary = summarizeCustoms(flagResults, namesUniq);
  return { queryNames: namesUniq, ...summary, tookMs: Date.now() - t0 };
}

// ---------- 8. assemble profile ----------
function assembleProfile(cand) {
  return {
    company: cand.tanji?.matched || { name: cand.displayName, uscc: cand.uscc, province: null, sourceOnly: true },
    identity: { uscc: cand.tanji?.matched?.uscc || cand.uscc || null, englishName: cand.englishName || null, chineseName: cand.tanji?.matched?.name || cand.chineseName || null },
    platformProfiles: [{ platform: cand.source, platformCompanyId: cand.platformCompanyId, displayName: cand.displayName, jobs: cand.jobs?.slice(0, 5) || [], store: cand.store || null, jobCount: cand.jobCount ?? null }],
    customs: cand.customs || null,
    contacts: { unlocked: cand.tanji?.unlocked ?? false, counts: cand.tanji?.contactCounts ?? null, note: '未调用 unlock，不消耗额度' },
  };
}

// ---------- main ----------
(async () => {
  console.log('== 1. 上游健康检查 ==');
  const health = await healthChecks();
  REPORT.health = Object.fromEntries(Object.entries(health).map(([k, v]) => [k, { ok: v.step.ok, httpStatus: v.step.httpStatus, ms: v.step.ms, error: v.step.error }]));
  console.log(JSON.stringify(REPORT.health, null, 1));

  console.log('== 2. Boss 链路 ==');
  const boss = await bossFlow(); if (!boss.error) { const m = await tanjiMatch(boss); m.customs = await fumaCustomsFor(m); REPORT.candidates.push(m); }
  else REPORT.findings.push({ stage: 'boss', error: boss.error });
  console.log('boss:', boss.error || `${boss.displayName} jobs=${boss.jobs.length}`);

  console.log('== 3. 智联链路 ==');
  const zh = await zhilianFlow(); if (!zh.error) { const m = await tanjiMatch(zh); m.customs = await fumaCustomsFor(m); REPORT.candidates.push(m); }
  else REPORT.findings.push({ stage: 'zhilian', error: zh.error });
  console.log('zhilian:', zh.error || `${zh.displayName} jobs=${zh.jobs.length}`);

  console.log('== 4. Ali 链路（英文抬头）==');
  const ali = await aliFlow();
  if (ali.error) REPORT.findings.push({ stage: 'ali', error: ali.error });
  else for (const c of ali) { const m = await tanjiMatch(c); m.customs = await fumaCustomsFor(m); REPORT.candidates.push(m); }
  console.log('ali:', ali.error || ali.map(x => x.displayName).join(' | '));

  console.log('== 5. Mic 链路（英文抬头）==');
  const mic = await micFlow(); if (!mic.error) { const m = await tanjiMatch(mic); m.customs = await fumaCustomsFor(m); REPORT.candidates.push(m); }
  else REPORT.findings.push({ stage: 'mic', error: mic.error });
  console.log('mic:', mic.error || mic.displayName);

  REPORT.profiles = REPORT.candidates.map(assembleProfile);
  REPORT.endedAt = new Date().toISOString();
  REPORT.quotaConsumed = 0;
  REPORT.summary = {
    candidates: REPORT.candidates.length,
    tanjiMatched: REPORT.candidates.filter(c => c.tanji?.matched).length,
    customsWithData: REPORT.candidates.filter(c => (c.customs?.matched || 0) > 0).length,
    customsTotalMatched: REPORT.candidates.reduce((a, c) => a + (c.customs?.matched || 0), 0),
    steps: REPORT.steps.length,
    failedSteps: REPORT.steps.filter(s => !s.ok).length,
  };
  const masked = sanitizeRawDir(RAW_DIR);
  REPORT.rawSanitizedFields = masked;
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(REPORT, null, 2));
  console.log('\n== SUMMARY ==');
  console.log(JSON.stringify(REPORT.summary, null, 1));
  console.log('report:', join(OUT_DIR, 'report.json'));
})().catch(e => { console.error('SMOKE FAILED', e); process.exitCode = 1; });
