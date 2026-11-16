#!/usr/bin/env node
/**
 * 合并 Ali 基线（扩展种子+matrix round1）与后续 expansion 结果，输出最终 Ali 河北并集。
 * 输出：data/ali-final-union.json
 */
import fs from 'node:fs';

const base = JSON.parse(fs.readFileSync('data/ali-hebei-sweep.json', 'utf8')).hebeiFull;
const map = new Map(base.map((x) => [x.companyId, { companyId: x.companyId, companyName: x.companyName, city: x.city, source: x.source || 'extended' }]));

let matrixAdded = 0;
for (const line of fs.readFileSync('data/ali-matrix-round1.csv', 'utf8').split('\n').slice(1).filter(Boolean)) {
  const m = line.match(/^"?([^",]+)"?,"?([^"]+)"?,"?([^",]*)"?,"?([^",]*)"?/);
  if (!m) continue;
  const [, id, name, , city] = m;
  if (!map.has(id)) { map.set(id, { companyId: id, companyName: name, city: city || null, source: 'matrix-round1' }); matrixAdded++; }
}

const state = JSON.parse(fs.readFileSync('data/ali-expansion.json', 'utf8'));
const exp = state.accounts || {};
let expNew = 0;
const expansionCities = {};
for (const [id, a] of Object.entries(exp)) {
  if (!map.has(id)) { map.set(id, { companyId: id, companyName: a.companyName, city: a.city, source: 'expansion' }); expNew++; }
  const c = a.city || '未知';
  expansionCities[c] = (expansionCities[c] || 0) + 1;
}
const all = [...map.values()];
const out = {
  generatedAt: new Date().toISOString(),
  baseline: base.length,
  matrixRound1Added: matrixAdded,
  expansionAccounts: Object.keys(exp).length,
  expansionNew: expNew,
  totalUnique: all.length,
  expansionCities,
  hebeiFull: all,
};
fs.writeFileSync('data/ali-final-union.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({ baseline: base.length, matrixRound1Added: matrixAdded, expansionAccounts: Object.keys(exp).length, expansionNew: expNew, totalUnique: all.length, expansionCities }, null, 2));
