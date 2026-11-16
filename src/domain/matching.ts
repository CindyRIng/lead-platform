/**
 * 探迹公司匹配算法（纯领域逻辑，无 IO / 无网络）。
 *
 * 契约来源：
 * - docs/02-架构与数据模型.md §8（去重）、§9（探迹匹配算法）
 * - docs/01-需求规格.md FR-5/FR-6、BR-18（Ali/Mic 用英文抬头匹配）
 * - docs/04-上游对接与区域映射.md §3.5 / §5
 * - docs/09 §2.5 实测（中文名/英文抬头均可命中；英文抬头 score 224–466）
 * - docs/12 §7.2（英文名归一化/去城市词）
 *
 * 匹配流水线（docs/02 §9）：
 *   1. USCC 精确：POST /v1/search/name {field:socialCreditCode} → 归一化后完全相等 → confidence 1.0
 *   2. 名称精确/归一化：字段 name，归一化后完全相等 +0.6
 *   3. 名称近似：包含关系 +0.4；否则相似度 0.3*sim
 *   4. 省市：省份相同 +0.2、城市相同 +0.2
 *   5. 探迹相关度：score/rankScore 归一化（默认 /1000 截断）×0.1
 *   6. 总分 clamp 到 [0,1]；≥ threshold（默认 0.55）为高置信度；
 *      **低于阈值仍自动匹配**（用户决策，docs/02 §9）但返回 lowConfidence=true 供事后核对/rematch。
 *
 * 中英文抬头（BR-18）：
 * - 平台为 ali/mic 时优先用英文抬头搜索，中文名仅作兜底/校验；
 * - 跨语言（拉丁查询 vs 中文主体）无法做字符相似度，此时以探迹「关联搜索相关度」替代
 *   名称相似度分量（0.3*relNorm），并保留省市/相关度加分；候选若自带 englishName 则按同语言规则比较。
 * - 英文名归一化复用 `src/domain/normalize.ts`（去 CO/LTD/GROUP 等、小写、去标点）。
 *
 * 返回值：{ matched, confidence, method, candidates, queryName }（Lead 冻结形状）+ 审计扩展字段
 * （best / lowConfidence / threshold / searches）。candidates 最多 5 条，含 {id,name,uscc,score}。
 */
import type { MatchCandidate, Platform } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { containsCjk, normalizeCompanyName, normalizeRegionName } from './normalize.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 匹配方式（写入 companies.match_meta.method） */
export type MatchMethod = 'uscc' | 'name_exact' | 'name_fuzzy' | 'english_name' | 'none';

export type MatchSearchField = 'name' | 'socialCreditCode' | 'address' | 'contact';

/** 搜索客户端可返回的候选（上游 CompanySummary 的结构子集） */
export interface MatchCandidateSource {
  id: string;
  name: string;
  uscc?: string | null;
  englishName?: string | null;
  province?: string | null;
  city?: string | null;
  address?: string | null;
  /** 探迹相关度分（实测中文名 100–1100+，英文抬头 224–466） */
  score?: number | null;
  rankScore?: number | null;
}

export interface MatchSearchParams {
  name: string;
  field?: MatchSearchField;
  pageSize?: number;
  maxPages?: number;
}

export interface MatchSearchResponse {
  companies: MatchCandidateSource[];
  total?: number;
  hasMore?: boolean;
  warnings?: string[];
}

/**
 * 匹配依赖的最小搜索端口（结构类型）：T1 `TanjiClient.searchByName` 天然满足，
 * 单测/流水线可注入 mock，无需依赖 HTTP 适配器类型。
 */
export interface MatchSearchClient {
  searchByName(params: MatchSearchParams): Promise<MatchSearchResponse>;
}

export interface MatchInput {
  /** 来源公司名（中文注册名/平台展示名） */
  name: string;
  /** 英文抬头（Ali/Mic 来源；用于跨语言匹配，也用于海关补全） */
  englishName?: string | null;
  /** 来源详情中的 USCC（Boss/智联文本推导，可能缺失/错误；仅作精确搜索提示） */
  uscc?: string | null;
  province?: string | null;
  city?: string | null;
  platform?: Platform | null;
  /** 覆盖默认搜索顺序（一般不用；rematch 时可换用 fullName/注册名再试；仅支持 name/USCC） */
  queries?: Array<{ name: string; field?: 'name' | 'socialCreditCode' }> | null;
}

export interface MatchOptions {
  /** 高置信度阈值，默认 0.55 */
  threshold?: number;
  /** 搜索每页条数，默认 20（≤100） */
  pageSize?: number;
  /** 名称搜索最大页数，默认 2（USCC 搜索固定 1；≤50） */
  maxPages?: number;
  /** 返回候选上限，默认 5 */
  maxCandidates?: number;
  /** 低于阈值是否仍自动匹配，默认 true（docs/02 §9 用户决策） */
  autoMatchLowConfidence?: boolean;
  /** 探迹相关度归一化分母，默认 1000 */
  relatednessScale?: number;
}

export interface MatchSearchLog {
  field: MatchSearchField;
  queryName: string;
  /** 上游返回条数 */
  returned: number;
  /** 本次搜索归一化后最高分 */
  bestScore: number | null;
  errorCode?: string;
}

export interface MatchResult {
  matched: boolean;
  confidence: number;
  method: MatchMethod;
  candidates: MatchCandidate[];
  queryName: string;
  /** 最佳候选（= candidates[0]） */
  best: MatchCandidate | null;
  /** 置信度是否低于阈值（低置信度仍 matched=true，按用户决策；供 rematch/人工核对） */
  lowConfidence: boolean;
  threshold: number;
  /** 各次搜索的审计明细 */
  searches: MatchSearchLog[];
}

export type NameRelation = 'exact' | 'contains' | 'similar' | 'cross_script' | 'none';

export interface ScoreDetail {
  score: number;
  relation: NameRelation;
  nameScore: number;
  provinceMatch: boolean;
  cityMatch: boolean;
  relatednessNorm: number;
}

type MatchAttempt = { field: 'name' | 'socialCreditCode'; name: string };

interface ScoredCandidate {
  source: MatchCandidateSource;
  score: number;
  relation: NameRelation;
  queryName: string;
  field: MatchSearchField;
  nameScore: number;
}

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RE = /[a-z]/i;

const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 2;
const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_RELATEDNESS_SCALE = 1000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function hasCjk(value: string): boolean {
  return CJK_RE.test(value) || containsCjk(value);
}

function isLatinOnly(value: string): boolean {
  return !hasCjk(value) && LATIN_RE.test(value);
}

// ---------------------------------------------------------------------------
// USCC / 名称归一化
// ---------------------------------------------------------------------------

/** USCC 归一化：大写、去除空白与分隔符（仅用于比较，不校验校验位） */
export function normalizeUscc(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

// ---------------------------------------------------------------------------
// 相似度（同语言）
// ---------------------------------------------------------------------------

/** 经典 Levenshtein 距离（公司名长度有限，O(n*m) 可接受） */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    const ca = a[i - 1] as string;
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b[j - 1] ? 0 : 1;
      const del = (prev[j] as number) + 1;
      const ins = (curr[j - 1] as number) + 1;
      const sub = (prev[j - 1] as number) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length] as number;
}

/** 编辑距离相似度：1 - dist/maxLen */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/** 字符 bigram Dice 系数（中文名称效果较好） */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const count = grams.get(g) ?? 0;
    if (count > 0) {
      overlap += 1;
      grams.set(g, count - 1);
    }
  }
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

/** 英文 token Jaccard（归一化后去法律后缀） */
export function tokenJaccard(a: string, b: string): number {
  const tokens = (value: string): Set<string> => {
    const normalized = normalizeCompanyName(value);
    const raw = hasCjk(value) ? normalized : normalized.replace(/[^a-z0-9]+/g, ' ').trim();
    return new Set(raw.split(/\s+/).filter((t) => t.length > 0));
  };
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/** 名称相似度：取编辑距离比 / bigram Dice / token Jaccard 的最大值 */
export function nameSimilarity(a: string, b: string): number {
  const q = normalizeCompanyName(a);
  const c = normalizeCompanyName(b);
  if (!q || !c) return 0;
  if (q === c) return 1;
  return clamp01(Math.max(levenshteinRatio(q, c), diceCoefficient(q, c), tokenJaccard(a, b)));
}

/** 同语言名称关系与基础分（docs/02 §9：+0.6 / +0.4 / 0.3*sim） */
export function sameLanguageNameScore(query: string, candidate: string): { score: number; relation: NameRelation } {
  const q = normalizeCompanyName(query);
  const c = normalizeCompanyName(candidate);
  if (!q || !c) return { score: 0, relation: 'none' };
  if (q === c) return { score: 0.6, relation: 'exact' };
  if (q.length >= 4 && c.length >= 4 && (q.includes(c) || c.includes(q))) {
    return { score: 0.4, relation: 'contains' };
  }
  const sim = nameSimilarity(query, candidate);
  if (sim <= 0) return { score: 0, relation: 'none' };
  return { score: 0.3 * sim, relation: 'similar' };
}

function relatednessNorm(candidate: MatchCandidateSource, scale: number): number {
  const rawScore = typeof candidate.score === 'number' && Number.isFinite(candidate.score) ? candidate.score : null;
  const rankScore = typeof candidate.rankScore === 'number' && Number.isFinite(candidate.rankScore) ? candidate.rankScore : null;
  const value = rawScore ?? rankScore;
  if (value === null || value <= 0) return 0;
  return clamp01(value / scale);
}

function addressText(address: string | null | undefined): string {
  return (address ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function regionMatches(inputRegion: string | null | undefined, candidateCityOrProvince: string | null | undefined, candidateAddress: string | null | undefined, addressSuffix: boolean): boolean {
  const wanted = normalizeRegionName(inputRegion);
  if (!wanted) return false;
  const fromField = normalizeRegionName(candidateCityOrProvince);
  if (fromField && fromField === wanted) return true;
  const addr = addressText(candidateAddress);
  if (addr) {
    if (addressSuffix) return addr.includes(`${wanted}市`) || addr.includes(wanted);
    return addr.includes(wanted);
  }
  return false;
}

/**
 * 单候选打分（docs/02 §9 权重）：
 * - 名称：精确/归一化 +0.6；包含 +0.4；相似度 0.3*sim；
 *   跨语言（拉丁查询 <-> 中文主体）以 0.3*探迹相关度 替代相似度项（BR-18 英文抬头路径）；
 * - 省份 +0.2；城市 +0.2；
 * - 探迹相关度 +0.1*relNorm；
 * - 最终 clamp [0,1]。
 * 若输入 USCC 与候选取值一致，直接 1.0（防御性，正常已在 USCC 精确步命中）。
 */
export function scoreCandidate(
  input: MatchInput,
  candidate: MatchCandidateSource,
  query: { name: string; field: MatchSearchField },
  options: Pick<MatchOptions, 'relatednessScale'> = {},
): ScoreDetail {
  const scale = options.relatednessScale ?? DEFAULT_RELATEDNESS_SCALE;
  const relNorm = relatednessNorm(candidate, scale);

  const inputUscc = normalizeUscc(input.uscc);
  const candidateUscc = normalizeUscc(candidate.uscc);
  if (inputUscc.length >= 8 && inputUscc === candidateUscc) {
    return {
      score: 1,
      relation: 'exact',
      nameScore: 0.6,
      provinceMatch: false,
      cityMatch: false,
      relatednessNorm: relNorm,
    };
  }

  const queryText = query.name;
  const candidateName = candidate.name;
  let nameScore = 0;
  let relation: NameRelation = 'none';

  if (query.field === 'name') {
    const queryLatin = isLatinOnly(queryText);
    const candidateHasCjk = hasCjk(candidateName);
    if (!queryLatin || !candidateHasCjk) {
      const same = sameLanguageNameScore(queryText, candidateName);
      nameScore = same.score;
      relation = same.relation;
    } else {
      // 跨语言：优先比较候选英文名（若上游返回），否则用关联搜索相关度作为代理
      const englishCandidate = candidate.englishName?.trim();
      if (englishCandidate && isLatinOnly(englishCandidate)) {
        const same = sameLanguageNameScore(queryText, englishCandidate);
        if (same.relation !== 'none') {
          nameScore = Math.max(nameScore, same.score);
          relation = same.relation;
        }
      }
      if (relation === 'none' && relNorm > 0) {
        nameScore = 0.3 * relNorm;
        relation = 'cross_script';
      }
    }
  }

  const provinceMatch = regionMatches(input.province, candidate.province, candidate.address, false);
  const cityMatch = regionMatches(input.city, candidate.city, candidate.address, true);
  const locationScore = (provinceMatch ? 0.2 : 0) + (cityMatch ? 0.2 : 0);
  const total = clamp01(nameScore + locationScore + 0.1 * relNorm);
  return {
    score: round4(total),
    relation,
    nameScore: round4(nameScore),
    provinceMatch,
    cityMatch,
    relatednessNorm: round4(relNorm),
  };
}

// ---------------------------------------------------------------------------
// 搜索顺序
// ---------------------------------------------------------------------------

/** 归一化 USCC 是否足以发起精确搜索（平台文本推导可能残缺） */
function usableUscc(uscc: string): boolean {
  return uscc.length >= 8;
}

/**
 * 构造搜索顺序：
 * - 有可用 USCC：先 USCC 精确搜索；
 * - 名称：显式 queries 优先；否则 ali/mic 英文抬头优先，其它平台中文名优先，另一个作兜底。
 */
export function buildSearchAttempts(input: MatchInput): MatchAttempt[] {
  const attempts: MatchAttempt[] = [];
  const seen = new Set<string>();
  const push = (attempt: MatchAttempt): void => {
    const name = attempt.name.trim();
    if (!name) return;
    const key = `${attempt.field}::${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ field: attempt.field, name });
  };

  const uscc = normalizeUscc(input.uscc);
  if (usableUscc(uscc)) push({ field: 'socialCreditCode', name: uscc });

  const explicit = input.queries ?? [];
  if (explicit.length > 0) {
    for (const query of explicit) push({ field: query.field ?? 'name', name: query.name });
  } else {
    const cn = (input.name ?? '').trim();
    const en = (input.englishName ?? '').trim();
    const preferEnglish = input.platform === 'ali' || input.platform === 'mic';
    if (preferEnglish && en) {
      push({ field: 'name', name: en });
      push({ field: 'name', name: cn });
    } else {
      push({ field: 'name', name: cn });
      push({ field: 'name', name: en });
    }
  }
  return attempts;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function toMatchCandidate(scored: ScoredCandidate): MatchCandidate | null {
  const id = scored.source.id?.trim();
  const name = scored.source.name?.trim();
  if (!id || !name) return null;
  return {
    id,
    name,
    uscc: scored.source.uscc ?? null,
    score: scored.score,
  };
}

function methodFor(scored: ScoredCandidate): MatchMethod {
  if (scored.field === 'socialCreditCode') return 'uscc';
  if (scored.relation === 'exact') return 'name_exact';
  if (scored.relation === 'cross_script' || isLatinOnly(scored.queryName)) return 'english_name';
  return 'name_fuzzy';
}

function assertSearchOptions(options: MatchOptions, field: MatchSearchField): void {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new LeadError('VALIDATION_ERROR', `匹配 pageSize 必须是 1..100 的整数，收到 ${String(options.pageSize)}`);
  }
  const maxPages = field === 'socialCreditCode' ? 1 : options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) {
    throw new LeadError('VALIDATION_ERROR', `匹配 maxPages 必须是 1..50 的整数，收到 ${String(options.maxPages)}`);
  }
}

/**
 * 执行探迹匹配。
 *
 * @param input  公司名 / 英文抬头 / USCC 提示 / 省 / 市 / 来源平台
 * @param search 搜索端口（通常是 T1 TanjiClient；测试可注入 mock）
 * @param options 阈值等可选项
 */
export async function matchCompany(
  input: MatchInput,
  search: MatchSearchClient,
  options: MatchOptions = {},
): Promise<MatchResult> {
  const attempts = buildSearchAttempts(input);
  if (attempts.length === 0) {
    throw new LeadError('VALIDATION_ERROR', '探迹匹配至少需要 name 或 uscc 之一', {
      details: { name: input.name ?? null, hasUscc: Boolean(input.uscc) },
    });
  }
  const threshold = clamp01(options.threshold ?? DEFAULT_THRESHOLD);
  const maxCandidates = Math.max(1, Math.min(50, options.maxCandidates ?? DEFAULT_MAX_CANDIDATES));
  for (const attempt of attempts) assertSearchOptions(options, attempt.field);
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  const searches: MatchSearchLog[] = [];
  const scoredById = new Map<string, ScoredCandidate>();
  let usccHit: MatchCandidateSource | null = null;

  for (const attempt of attempts) {
    if (attempt.field === 'socialCreditCode') {
      const response = await search.searchByName({ name: attempt.name, field: 'socialCreditCode', pageSize, maxPages: 1 });
      const companies = response.companies ?? [];
      const uscc = normalizeUscc(attempt.name);
      for (const candidate of companies) {
        if (normalizeUscc(candidate.uscc) === uscc) {
          usccHit = candidate;
          break;
        }
      }
      searches.push({ field: 'socialCreditCode', queryName: attempt.name, returned: companies.length, bestScore: usccHit ? 1 : null });
      if (usccHit) break;
      continue;
    }

    // 名称搜索：命中结果即停止后续兜底查询（控制 20 req/min 预算）
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    assertSearchOptions(options, 'name');
    const response = await search.searchByName({ name: attempt.name, field: 'name', pageSize, maxPages });
    const companies = response.companies ?? [];
    let bestScore: number | null = null;
    for (const candidate of companies) {
      const id = candidate.id?.trim();
      const name = candidate.name?.trim();
      if (!id || !name) continue;
      const detail = scoreCandidate(input, candidate, attempt, options);
      const existing = scoredById.get(id);
      if (!existing || detail.score > existing.score) {
        const scored: ScoredCandidate = {
          source: candidate,
          score: detail.score,
          relation: detail.relation,
          queryName: attempt.name,
          field: 'name',
          nameScore: detail.nameScore,
        };
        scoredById.set(id, scored);
        if (bestScore === null || detail.score > bestScore) bestScore = detail.score;
      }
    }
    searches.push({ field: 'name', queryName: attempt.name, returned: companies.length, bestScore: round4(bestScore ?? 0) });
    if (scoredById.size > 0) break;
  }

  const queryName = attempts[0]?.name ?? '';

  // 1) USCC 精确命中：直接返回，confidence=1.0
  if (usccHit) {
    const candidate: MatchCandidate = {
      id: usccHit.id,
      name: usccHit.name,
      uscc: usccHit.uscc ?? (normalizeUscc(input.uscc) || null),
      score: 1,
    };
    return {
      matched: true,
      confidence: 1,
      method: 'uscc',
      candidates: [candidate],
      queryName: normalizeUscc(input.uscc) || queryName,
      best: candidate,
      lowConfidence: false,
      threshold,
      searches,
    };
  }

  // 2) 名称候选：按分数降序，最多 maxCandidates 条
  const scored = [...scoredById.values()].sort((a, b) => b.score - a.score);
  const candidates: MatchCandidate[] = [];
  for (const item of scored) {
    if (candidates.length >= maxCandidates) break;
    const candidate = toMatchCandidate(item);
    if (candidate) candidates.push(candidate);
  }

  if (candidates.length === 0 || scored.length === 0) {
    return {
      matched: false,
      confidence: 0,
      method: 'none',
      candidates: [],
      queryName,
      best: null,
      lowConfidence: false,
      threshold,
      searches,
    };
  }

  const best = candidates[0] as MatchCandidate;
  const confidence = best.score;
  const lowConfidence = confidence < threshold;
  const autoMatch = options.autoMatchLowConfidence !== false;
  const matched = autoMatch ? true : !lowConfidence;
  const bestScored = scored[0] as ScoredCandidate;
  const method: MatchMethod = matched ? methodFor(bestScored) : 'none';

  return {
    matched,
    confidence,
    method,
    candidates,
    queryName: bestScored.queryName,
    best,
    lowConfidence,
    threshold,
    searches,
  };
}

/** 便捷别名：`matched ? best : null` */
export function bestCandidate(result: MatchResult): MatchCandidate | null {
  return result.matched ? result.best : null;
}
