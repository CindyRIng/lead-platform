/**
 * 公司名 / 区域名归一化（去重与匹配的纯函数基础）
 *
 * 规则（见 docs/02 §8.3、docs/01 BR）：
 * - 全半角统一（NFKC）+ 转小写（英文）、去首尾空白
 * - 去除括号及其内容（如「（曾用名）」）、标点/符号
 * - 去除公司法律后缀（有限公司/有限责任公司/股份有限公司/集团/公司…）
 * - 中文名去除「河北省/河北」及河北地级市前缀
 * - 英文名按 token 归一：去标点、压缩空白、统一 & -> and、去法律实体后缀
 *
 * 归一化结果仅用于「辅助」去重/匹配（docs/02 §8.3：不做激进合并）。
 */
import { HEBEI_CITIES, HEBEI_PROVINCE } from '../shared/constants.js';

/** 仅中文字符测试 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export function containsCjk(value: string): boolean {
  return CJK_RE.test(value);
}

/** NFKC：全角转半角、兼容字符统一 */
export function toHalfWidth(value: string): string {
  return value.normalize('NFKC');
}

/** 去除成对括号及其内容（中英文括号/方括号/书名号等） */
export function stripBracketContent(value: string): string {
  let out = value;
  let prev = '';
  // 循环直到稳定，处理嵌套/连续括号
  while (out !== prev) {
    prev = out;
    out = out
      .replace(/\([^()]*\)/g, '')
      .replace(/（[^（）]*）/g, '')
      .replace(/\[[^\[\]]*\]/g, '')
      .replace(/【[^【】]*】/g, '')
      .replace(/〔[^〔〕]*〕/g, '')
      .replace(/<[^<>]*>/g, '')
      .replace(/《[^《》]*》/g, '');
  }
  return out;
}

/** 中文公司法律后缀（按长度降序；循环剥离以处理「集团有限公司」） */
const CN_LEGAL_SUFFIXES = [
  '集团股份有限公司',
  '集团有限责任公司',
  '股份有限公司',
  '有限责任公司',
  '集团有限公司',
  '有限公司',
  '控股集团',
  '集团公司',
  '集团',
  '公司',
];

/** 剥离中文公司名末尾的法律后缀（可循环） */
export function stripLegalSuffixCn(value: string): string {
  let out = value;
  let changed = true;
  while (changed && out.length > 0) {
    changed = false;
    for (const suffix of CN_LEGAL_SUFFIXES) {
      if (out.length > suffix.length && out.endsWith(suffix)) {
        out = out.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 中文标点/符号（归一化时删除） */
const CN_PUNCT_RE =
  /[\s·•.,，。;；:：!！?？'"“”‘’、\-—_/\\|&＆+*#$%@^~`()（）\[\]【】{}〔〕<>《》〈〉]/g;

/** 河北行政区划前缀（省名 + 11 地级市名，含/不含「市」） */
const HEBEI_REGION_PREFIXES: string[] = (() => {
  const names = new Set<string>();
  const province = HEBEI_PROVINCE.name;
  names.add(province);
  names.add(province.replace(/省$/, ''));
  for (const city of HEBEI_CITIES) {
    names.add(city.name);
    names.add(city.name.replace(/市$/, ''));
  }
  return [...names].sort((a, b) => b.length - a.length);
})();

/** 去除开头的「河北省/河北 / 石家庄市/石家庄…」前缀（只剥一层省 + 一层市） */
export function stripRegionPrefixCn(value: string): string {
  let out = value;
  const provinceNames = [HEBEI_PROVINCE.name, HEBEI_PROVINCE.name.replace(/省$/, '')];
  for (const name of provinceNames) {
    if (out.length > name.length && out.startsWith(name)) {
      out = out.slice(name.length);
      break;
    }
  }
  for (const city of HEBEI_CITIES) {
    for (const name of [city.name, city.name.replace(/市$/, '')]) {
      if (out.length > name.length && out.startsWith(name)) {
        out = out.slice(name.length);
        break;
      }
    }
  }
  return out;
}

/**
 * 中文公司名归一化：
 * `河北石家庄ABC机械有限公司` -> `abc机械`
 */
export function normalizeChineseCompanyName(value: string): string {
  let out = toHalfWidth(value);
  out = stripBracketContent(out);
  out = out.replace(CN_PUNCT_RE, '');
  out = stripLegalSuffixCn(out);
  out = stripRegionPrefixCn(out);
  // 归一化后再次剥离可能因去前缀而暴露的后缀（如「河北XX有限公司」）
  out = stripLegalSuffixCn(out);
  return out.trim();
}

/** 英文公司法律实体后缀（按 token 长度降序匹配） */
const EN_LEGAL_SUFFIX_TOKENS = [
  'company limited',
  'co limited',
  'co ltd',
  'company ltd',
  'limited liability company',
  'limited',
  'ltd',
  'llc',
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'company',
  'co',
  'plc',
  'gmbh',
  'srl',
  'bv',
  'nv',
  'ag',
  'sa',
  'spa',
  'pty',
  'pt',
];

/** 英文名归一化：小写、标点转空格、& -> and、去尾部法律后缀 */
export function normalizeEnglishCompanyName(value: string): string {
  let out = toHalfWidth(value).toLowerCase();
  out = out.replace(/&/g, ' and ');
  out = out.replace(/[^a-z0-9]+/g, ' ');
  out = out.trim().replace(/\s+/g, ' ');
  let changed = true;
  while (changed && out.length > 0) {
    changed = false;
    for (const suffix of EN_LEGAL_SUFFIX_TOKENS) {
      if (out === suffix) {
        out = '';
        changed = true;
        break;
      }
      if (out.endsWith(` ${suffix}`)) {
        out = out.slice(0, -suffix.length - 1).trimEnd();
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** 公司名归一化统一入口（自动按中/英文选择策略） */
export function normalizeCompanyName(value: string | null | undefined): string {
  if (!value) return '';
  const text = toHalfWidth(String(value)).trim();
  if (!text) return '';
  if (containsCjk(text)) return normalizeChineseCompanyName(text);
  return normalizeEnglishCompanyName(text);
}

/** 归一化后用于精确比较的 key（小写 + 去空白） */
export function companyNameKey(value: string | null | undefined): string {
  return normalizeCompanyName(value).replace(/\s+/g, '');
}

/** 英文名 token（用于名称相似/包含判断） */
export function englishNameTokens(value: string | null | undefined): string[] {
  const normalized = normalizeEnglishCompanyName(value ?? '');
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

/** 区域名归一化：`河北省` -> `河北`，`石家庄市` -> `石家庄`；自治区/特别行政区同级处理 */
export function normalizeRegionName(value: string | null | undefined): string {
  if (!value) return '';
  return toHalfWidth(String(value))
    .replace(/\s+/g, '')
    .replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市|地区|盟|自治州|州)$/u, '')
    .trim();
}

/** 判断 a 是否包含 b（归一化后，b 非空且长度 >= 2） */
export function nameContains(container: string | null | undefined, part: string | null | undefined): boolean {
  const a = companyNameKey(container);
  const b = companyNameKey(part);
  return b.length >= 2 && a.includes(b);
}

/**
 * 生成名称候选 key（用于兜底模糊去重）：
 * - 主 key：完整归一化名
 * - 辅助 key：去区域前缀后的名字
 */
export function companyNameKeys(value: string | null | undefined): string[] {
  const keys = new Set<string>();
  const normalized = normalizeCompanyName(value);
  if (normalized) keys.add(normalized);
  const stripped = normalizeCompanyName(stripRegionPrefixCn(normalized));
  if (stripped) keys.add(stripped);
  return [...keys];
}

/** 便捷别名（部分模块使用） */
export const normalize = normalizeCompanyName;
