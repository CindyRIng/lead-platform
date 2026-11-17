/**
 * 公司去重 / 归并决策（纯领域逻辑，无 IO）。
 *
 * 规则见 docs/02-架构与数据模型.md §8：
 *   a. 有 USCC：按 companies.uscc 命中 → 关联（confidence 1.0）
 *   b. 无 USCC（或未命中）：normalized_name 相同 + 同省（有城市则同市）→ 关联为同一公司
 *   c. 探迹匹配成功后 tanji_company_id 已存在 → 合并两条公司记录（软删除 merged_into）
 *   d. 否则新建公司
 *
 * 名称归一化复用 `src/domain/normalize.ts`（docs/02 §8.3：全半角/括号/法律后缀/河北前缀）。
 * 英文抬头（Ali/Mic）与中文注册名分别归一化，任一 key 相等即可作为名称候选（不激进合并：
 * 缺少省市信息时按较低置信度标记，供人工核对/rematch）。
 *
 * 本文件只做「决策 + 字段合并偏好」，实际落库（create/update/mergeInto/change_events）
 * 由 `src/services/companies.ts` 与 `src/pipeline/enrichment.ts` 执行。
 */
import type { Company, MatchMeta, Platform } from '../shared/domain.js';
import { containsCjk, normalizeCompanyName, normalizeRegionName } from './normalize.js';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 来源侧（待归并）的公司身份信息 */
export interface SourceIdentity {
  platform: Platform | null;
  /** 平台展示名/注册名 */
  name: string;
  /** 英文抬头（Ali/Mic） */
  englishName?: string | null;
  /** 平台文本推导或探迹权威 USCC */
  uscc?: string | null;
  /** 探迹企业 ID */
  tanjiCompanyId?: string | null;
  province?: string | null;
  city?: string | null;
  address?: string | null;
}

/** 已存在公司的最小视图（Company 结构子集；便于纯函数测试） */
export interface ExistingCompanyView {
  id: string;
  name: string;
  normalizedName?: string | null;
  englishName?: string | null;
  uscc?: string | null;
  tanjiCompanyId?: string | null;
  province?: string | null;
  city?: string | null;
  mergedInto?: string | null;
}

export type DedupeReason = 'uscc' | 'tanji_id' | 'normalized_name' | 'none';

export interface DedupePlan {
  /** link = 关联到已有公司；create = 新建公司 */
  action: 'link' | 'create';
  /** link 时为已有公司 id */
  companyId: string | null;
  reason: DedupeReason;
  /** 归一化名称（落 company.normalized_name） */
  normalizedName: string;
  /** link 置信度（用于日志/evidence.merged_by_confidence；create 时 0） */
  confidence: number;
  /** 命中的归一化 key（name/englishName） */
  matchedNameKey: string | null;
  /** 备注：province_unknown / city_unknown / uscc_conflict 等 */
  notes: string[];
}

/** 字段级合并策略：公司主档字段偏好 */
export type CompanyMergeableField =
  | 'name'
  | 'englishName'
  | 'uscc'
  | 'tanjiCompanyId'
  | 'legalRepresentative'
  | 'regCapital'
  | 'foundTime'
  | 'operStatus'
  | 'industry'
  | 'scale'
  | 'province'
  | 'city'
  | 'district'
  | 'address'
  | 'businessScope'
  | 'homepage'
  | 'phoneCount'
  | 'emailCount'
  | 'contactCount'
  | 'matchMeta';

/** 权威性来源：探迹工商 > 平台详情 > 平台搜索结果 */
export type FieldAuthority = 'tanji' | 'source_detail' | 'source_search';

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

/** USCC 归一化（仅比较用；不校验校验位） */
export function normalizeUsccKey(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.normalize('NFKC').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** 生成用于去重的名称 key 列表（中文名 + 英文抬头，去重保序） */
export function dedupeNameKeys(identity: Pick<SourceIdentity, 'name' | 'englishName'>): string[] {
  const keys: string[] = [];
  const push = (value: string | null | undefined): void => {
    const key = normalizeCompanyName(value ?? undefined);
    if (key && !keys.includes(key)) keys.push(key);
  };
  push(identity.name);
  push(identity.englishName);
  return keys;
}

/** 名称是否可直接判定为同一公司（归一化后相等） */
export function sameNormalizedName(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = normalizeCompanyName(a ?? undefined);
  const kb = normalizeCompanyName(b ?? undefined);
  return ka.length > 0 && ka === kb;
}

/** 地区是否兼容：规范名归一化后相等；任一缺失视为「未知」（兼容但降低置信度） */
export function regionCompatible(
  a: string | null | undefined,
  b: string | null | undefined,
): { compatible: boolean; known: boolean } {
  const na = normalizeRegionName(a);
  const nb = normalizeRegionName(b);
  if (!na || !nb) return { compatible: true, known: false };
  return { compatible: na === nb, known: true };
}

/** 中英文混合名称：优先中文注册名，其次英文抬头 */
export function pickCanonicalName(identity: Pick<SourceIdentity, 'name' | 'englishName'>): string {
  const name = (identity.name ?? '').trim();
  if (name && containsCjk(name)) return name;
  const english = (identity.englishName ?? '').trim();
  if (name) return name;
  return english;
}

// ---------------------------------------------------------------------------
// 去重决策（docs/02 §8.2）
// ---------------------------------------------------------------------------

/** 过滤掉已合并主体（对外只暴露存活主体） */
export function activeCompanies<T extends { mergedInto?: string | null }>(companies: T[]): T[] {
  return companies.filter((c) => !c.mergedInto);
}

/**
 * 在「已有公司集合」中为公司身份找归属：
 *  1. USCC 精确（最高优先）
 *  2. tanji_company_id 精确
 *  3. 归一化名称/英文抬头相等 + 省市兼容（同省；两市都有则须同市）
 *
 * 若多条命中，按 置信度 → 版本/创建时间 选择（调用方应传入候选集合，本函数取第一条最匹配）。
 */
export function planCompanyAttach(
  identity: SourceIdentity,
  existing: ExistingCompanyView[],
): DedupePlan {
  const normalizedName = normalizeCompanyName(pickCanonicalName(identity)) || normalizeCompanyName(identity.name);
  const active = activeCompanies(existing);
  const notes: string[] = [];

  // a. USCC 精确
  const usccKey = normalizeUsccKey(identity.uscc);
  if (usccKey.length >= 8) {
    const hit = active.find((c) => normalizeUsccKey(c.uscc) === usccKey);
    if (hit) {
      return {
        action: 'link',
        companyId: hit.id,
        reason: 'uscc',
        normalizedName,
        confidence: 1,
        matchedNameKey: null,
        notes,
      };
    }
  }

  // c. tanji_company_id 精确
  if (identity.tanjiCompanyId) {
    const hit = active.find((c) => c.tanjiCompanyId && c.tanjiCompanyId === identity.tanjiCompanyId);
    if (hit) {
      return {
        action: 'link',
        companyId: hit.id,
        reason: 'tanji_id',
        normalizedName,
        confidence: 1,
        matchedNameKey: null,
        notes,
      };
    }
  }

  // b. 归一化名称 + 省市
  const keys = dedupeNameKeys(identity);
  if (keys.length > 0) {
    const candidates: Array<{ company: ExistingCompanyView; key: string; score: number }> = [];
    for (const company of active) {
      const companyKeys = dedupeNameKeys({ name: company.name, englishName: company.englishName });
      const normalized = normalizeCompanyName(company.normalizedName ?? company.name);
      if (normalized) companyKeys.push(normalized);
      const key = keys.find((k) => companyKeys.includes(k));
      if (!key) continue;

      const province = regionCompatible(identity.province, company.province);
      if (!province.compatible) continue;
      const city = regionCompatible(identity.city, company.city);
      if (!city.compatible) continue;

      // 置信度：省市齐全 > 仅省 > 缺失
      let score = 0.6;
      if (province.known) score = 0.8;
      if (province.known && city.known) score = 0.9;
      // 若两侧 name 都是中文（或都是英文）加一点，跨语言同名仅在省市完全一致时接受
      if (!province.known && !city.known) score = 0.55;
      candidates.push({ company, key, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (best) {
      if (!regionCompatible(identity.province, best.company.province).known) notes.push('province_unknown');
      if (!regionCompatible(identity.city, best.company.city).known) notes.push('city_unknown');
      if (notes.length > 0) notes.push('low_confidence_name_link');
      return {
        action: 'link',
        companyId: best.company.id,
        reason: 'normalized_name',
        normalizedName,
        confidence: best.score,
        matchedNameKey: best.key,
        notes,
      };
    }
  }

  return {
    action: 'create',
    companyId: null,
    reason: 'none',
    normalizedName,
    confidence: 0,
    matchedNameKey: null,
    notes,
  };
}

// ---------------------------------------------------------------------------
// 合并时的字段偏好（docs/02 §8.4：保留较完整字段 + 权威优先）
// ---------------------------------------------------------------------------

/** 判断字段是否非空（空数组/空对象/空串视为空） */
export function isMeaningfulValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/** 字段来源权威性排序：探迹 > 平台详情 > 平台搜索（阿拉伯数字越大越权威） */
export function authorityRank(authority: FieldAuthority): number {
  switch (authority) {
    case 'tanji':
      return 3;
    case 'source_detail':
      return 2;
    default:
      return 1;
  }
}

/**
 * 计算合并 patch：以「已有字段 → 新字段」为准，规则：
 * - 新值非空且（旧值为空 或 新来源更权威）→ 采用新值；
 * - 新值为空 → 保留旧值（不覆盖）；
 * - 返回仅包含需要更新的字段（避免无意义 version 递增）。
 *
 * @param existing 已有公司主档
 * @param incoming 待写入字段（通常来自平台详情/探迹详情/匹配结果）
 * @param authority 入参字段的权威性
 */
export function planFieldPatch(
  existing: Partial<Record<CompanyMergeableField, unknown>>,
  incoming: Partial<Record<CompanyMergeableField, unknown>>,
  authority: FieldAuthority,
): Partial<Record<CompanyMergeableField, unknown>> {
  const patch: Partial<Record<CompanyMergeableField, unknown>> = {};
  for (const field of Object.keys(incoming) as CompanyMergeableField[]) {
    const next = incoming[field];
    if (!isMeaningfulValue(next)) continue;
    const current = existing[field];
    if (!isMeaningfulValue(current)) {
      patch[field] = next;
      continue;
    }
    if (authorityRank(authority) >= 2) {
      // 平台详情/探迹权威字段覆盖平台搜索推导值；同权威时不覆盖（保守）
      if (authorityRank(authority) > 1 && JSON.stringify(current) !== JSON.stringify(next)) {
        patch[field] = next;
      }
    }
  }
  return patch;
}

/** 合并两条公司记录的字段（保留较完整字段；tanji 权威字段来自 target） */
export function mergeCompanyViews(source: Company, target: Company): Partial<Company> {
  const patch: Partial<Company> = {};
  const fields: CompanyMergeableField[] = [
    'name',
    'englishName',
    'uscc',
    'tanjiCompanyId',
    'legalRepresentative',
    'regCapital',
    'foundTime',
    'operStatus',
    'industry',
    'scale',
    'province',
    'city',
    'district',
    'address',
    'businessScope',
    'homepage',
    'phoneCount',
    'emailCount',
    'contactCount',
    'matchMeta',
  ];
  for (const field of fields) {
    if (!isMeaningfulValue(target[field]) && isMeaningfulValue(source[field])) {
      (patch as Record<string, unknown>)[field] = source[field];
    }
  }
  // 来源数合并、tradeTags 去重并集
  patch.sourceCount = (source.sourceCount ?? 0) + (target.sourceCount ?? 0);
  const tags = new Set([...(target.tradeTags ?? []), ...(source.tradeTags ?? [])]);
  if (tags.size > 0) patch.tradeTags = [...tags];
  // extra 浅合并（target 优先）
  const extra = { ...(source.extra ?? {}), ...(target.extra ?? {}) };
  if (Object.keys(extra).length > 0) patch.extra = extra;
  return patch;
}

/** 构造 match_meta（docs/02 §9；最多 5 条候选） */
export function buildMatchMeta(input: {
  method: string;
  confidence: number;
  candidates: MatchMeta['candidates'];
  matchedAt?: string;
}): MatchMeta {
  return {
    method: input.method,
    confidence: Math.max(0, Math.min(1, input.confidence)),
    matchedAt: input.matchedAt,
    candidates: (input.candidates ?? []).slice(0, 5).map((c) => ({
      id: c.id,
      name: c.name,
      uscc: c.uscc ?? null,
      score: c.score,
    })),
  };
}
