/**
 * 区域名称归一/匹配工具。
 *
 * 上游字典口径（docs/04 §4）：
 * - Boss：cityName 不带「市」（如「石家庄」），刷新结果可能无 province；
 * - 智联：name 不带「市」，有 province 字段；
 * - Ali：nameZh 带「市」，还有 nameEn/拼音/code；
 * - Mic：英文名（大小写不敏感）+ 中文名 zh。
 *
 * 因此统一按「去行政后缀的短名」匹配内置 GB/T 2260 基线。
 */
import { CITIES, HEBEI_COUNTIES, PROVINCES, REGION_BASELINE, type RegionBaseline } from '../data/regions.js';

const PROVINCE_SUFFIX = /(省|市|自治区|特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治州|地区|盟|新区)$/;
const CITY_SUFFIX = /(市|地区|盟|自治州|自治旗|新区)$/;

/** 全角 → 半角、去空白 */
export function toHalfWidth(input: string): string {
  return input
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/** 区域名归一化 key：半角、去空格、去行政后缀；用于省/市名称匹配 */
export function regionNameKey(name: string | null | undefined): string {
  if (!name) return '';
  const cleaned = toHalfWidth(name).replace(/\s+/g, '').trim();
  if (!cleaned) return '';
  // 特殊别名
  const alias: Record<string, string> = {
    内蒙古自治区: '内蒙古',
    广西壮族自治区: '广西',
    西藏自治区: '西藏',
    宁夏回族自治区: '宁夏',
    新疆维吾尔自治区: '新疆',
    香港特别行政区: '香港',
    澳门特别行政区: '澳门',
    全国: '全国',
  };
  if (alias[cleaned]) return alias[cleaned];
  return cleaned.replace(PROVINCE_SUFFIX, '').replace(CITY_SUFFIX, '');
}

/** 展示短名（中文） */
export function regionShortName(name: string): string {
  return regionNameKey(name);
}

const PROVINCE_BY_KEY = new Map<string, RegionBaseline>();
const PROVINCE_BY_CODE = new Map<string, RegionBaseline>();
for (const p of PROVINCES) {
  PROVINCE_BY_KEY.set(regionNameKey(p.name), p);
  PROVINCE_BY_KEY.set(regionNameKey(p.shortName), p);
  PROVINCE_BY_CODE.set(p.code, p);
}

const CITY_BY_CODE = new Map<string, RegionBaseline>();
const CITY_BY_PROVINCE_KEY = new Map<string, Map<string, RegionBaseline>>();
for (const c of CITIES) {
  CITY_BY_CODE.set(c.code, c);
  const province = c.parentCode ? PROVINCE_BY_CODE.get(c.parentCode) : null;
  if (!province) continue;
  const key = regionNameKey(province.name);
  let m = CITY_BY_PROVINCE_KEY.get(key);
  if (!m) {
    m = new Map();
    CITY_BY_PROVINCE_KEY.set(key, m);
  }
  m.set(regionNameKey(c.name), c);
  m.set(regionNameKey(c.shortName), c);
}

/** 河北 11 市英文名（docs/04 §4.2 实测值；Mic/Ali 用） */
export const HEBEI_CITY_EN: Readonly<Record<string, string>> = Object.freeze({
  130100: 'Shijiazhuang',
  130200: 'Tangshan',
  130300: 'Qinhuangdao',
  130400: 'Handan',
  130500: 'Xingtai',
  130600: 'Baoding',
  130700: 'Zhangjiakou',
  130800: 'Chengde',
  130900: 'Cangzhou',
  131000: 'Langfang',
  131100: 'Hengshui',
});

const CITY_BY_EN_KEY = new Map<string, RegionBaseline>();
for (const [code, englishName] of Object.entries(HEBEI_CITY_EN)) {
  const city = CITY_BY_CODE.get(code);
  if (city) CITY_BY_EN_KEY.set(englishName.toLowerCase(), city);
}

const CITY_BY_PLATFORM_NAME = new Map<string, RegionBaseline>();
for (const c of CITIES) {
  CITY_BY_PLATFORM_NAME.set(regionNameKey(c.name), c);
  CITY_BY_PLATFORM_NAME.set(regionNameKey(c.shortName), c);
}
for (const [code, englishName] of Object.entries(HEBEI_CITY_EN)) {
  const city = CITY_BY_CODE.get(code);
  if (city) CITY_BY_PLATFORM_NAME.set(englishName.toLowerCase(), city);
}

/**
 * 平台城市名 → 规范中文全名（如 `Shijiazhuang` → `石家庄市`、`石家庄` → `石家庄市`）。
 * 用于把 Ali/Mic 英文城市名与 Boss/智联 中文城市名统一（公司主档/覆盖度统计口径）。
 */
export function canonicalCityName(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = toHalfWidth(input).trim();
  if (!text) return null;
  const byKey = CITY_BY_PLATFORM_NAME.get(regionNameKey(text)) ?? CITY_BY_PLATFORM_NAME.get(text.toLowerCase());
  return byKey?.name ?? null;
}

/** 平台城市名 → 规范中文短名（如 `Shijiazhuang` → `石家庄`），用于 coverageByCity 统计 key */
export function canonicalCityShortName(input: string | null | undefined): string | null {
  const name = canonicalCityName(input);
  if (!name) return null;
  const city = CITIES.find((c) => c.name === name);
  return city ? regionNameKey(city.name) : regionNameKey(name);
}

/** 全部内置区域（省 + 地级市） */
export function allBaselineRegions(): RegionBaseline[] {
  return REGION_BASELINE;
}

/** 按 code 或中文名/短名解析省 */
export function findProvince(input: string | null | undefined): RegionBaseline | null {
  if (!input) return null;
  const text = toHalfWidth(input).trim();
  if (!text) return null;
  if (/^\d{6}$/.test(text)) return PROVINCE_BY_CODE.get(text) ?? null;
  if (/^\d{2}$/.test(text)) return PROVINCE_BY_CODE.get(`${text}0000`) ?? null;
  return PROVINCE_BY_KEY.get(regionNameKey(text)) ?? null;
}

/** 解析地级市（在指定省内；不传省则全国唯一匹配，存在歧义返回 null） */
export function findCity(
  provinceOrCode: string | null | undefined,
  cityInput: string | null | undefined,
): RegionBaseline | null {
  if (!cityInput) return null;
  const text = toHalfWidth(cityInput).trim();
  if (!text) return null;
  if (/^\d{6}$/.test(text)) {
    const byCode = CITY_BY_CODE.get(text);
    if (!byCode) return null;
    if (!provinceOrCode) return byCode;
    const province = findProvince(provinceOrCode);
    return province && byCode.parentCode === province.code ? byCode : null;
  }
  const province = findProvince(provinceOrCode);
  if (province) {
    const m = CITY_BY_PROVINCE_KEY.get(regionNameKey(province.name));
    return m?.get(regionNameKey(text)) ?? null;
  }
  // 无省提示：英文名优先（河北），中文名全国唯一才返回
  const byEn = CITY_BY_EN_KEY.get(text.toLowerCase());
  if (byEn) return byEn;
  const matches: RegionBaseline[] = [];
  for (const m of CITY_BY_PROVINCE_KEY.values()) {
    const hit = m.get(regionNameKey(text));
    if (hit && !matches.some((x) => x.code === hit.code)) matches.push(hit);
  }
  return matches.length === 1 ? matches[0] : null;
}

/** 按省展开地级市；直辖市/无地级市省份返回省本身作为单一「检索单元」 */
export function expandProvinceCities(provinceOrCode: string | null | undefined): RegionBaseline[] {
  const province = findProvince(provinceOrCode);
  if (!province) return [];
  const cities = CITIES.filter((c) => c.parentCode === province.code);
  if (cities.length > 0) return cities;
  // 直辖市：把省本身当作一个检索单元（code 用省 code），平台映射仍按省 code 存
  return [{ ...province, level: 'city' as const, parentCode: province.code, shortName: province.shortName }];
}

export function isMunicipality(provinceCode: string): boolean {
  return ['110000', '120000', '310000', '500000'].includes(provinceCode);
}

/** 省下是否包含指定城市 code；用于 cityCodes 子集校验 */
export function isValidCityOfProvince(provinceCode: string, cityCode: string): boolean {
  if (isMunicipality(provinceCode)) return cityCode === provinceCode || cityCode === `${provinceCode.slice(0, 2)}0100`;
  return CITIES.some((c) => c.code === cityCode && c.parentCode === provinceCode);
}

/** 河北强 token：省名 + 11 地级市英文名（用于 off 模式归属判断，避免县级通用词误配） */
export const HEBEI_STRONG_TOKENS: ReadonlySet<string> = (() => {
  const set = new Set<string>(['hebei']);
  for (const name of Object.values(HEBEI_CITY_EN)) set.add(name.toLowerCase());
  return set;
})();

/** 河北 geo token（省/市/县英文名；仅用于展示/人工排查，不用于自动归属） */
export const HEBEI_GEO_TOKENS: ReadonlySet<string> = (() => {
  const set = new Set<string>(HEBEI_STRONG_TOKENS);
  for (const county of HEBEI_COUNTIES) if (county.englishName.length >= 4) set.add(county.englishName);
  return set;
})();

const OTHER_KNOWN: ReadonlySet<string> = new Set([
  'beijing',
  'tianjin',
  'shanghai',
  'chongqing',
  'guangdong',
  'zhejiang',
  'jiangsu',
  'shandong',
  'fujian',
  'henan',
  'hubei',
  'hunan',
  'anhui',
  'jiangxi',
  'sichuan',
  'liaoning',
  'jilin',
  'heilongjiang',
  'shanxi',
  'shaanxi',
  'gansu',
  'yunnan',
  'guizhou',
  'guangxi',
  'hainan',
  'xinjiang',
  'xizang',
  'tibet',
  'ningxia',
  'qinghai',
  'inner mongolia',
  'neimenggu',
  'hongkong',
  'macau',
]);

/**
 * 按英文公司名/地址做河北归属启发式判断（Ali locationMode=off 种子用）。
 * 返回 hebei（命中河北地名 token）/ other（命中其他省 token）/ unknown。
 */
export function classifyHebeiCompanyName(name: string | null | undefined): 'hebei' | 'other' | 'unknown' {
  if (!name) return 'unknown';
  const n = toHalfWidth(name).toLowerCase();
  // 1) 明确其他省份 → other（按词边界，避免词内误配）
  for (const token of OTHER_KNOWN) {
    if (token.length <= 3) continue;
    if (new RegExp(`(?<![a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(n)) return 'other';
  }
  // 2) 只信强 token（hebei + 11 市，词边界）；县级通用英文词（anping/sanhe/xinhe/bazhou…）不自动判河北，
  //    它们可能属于外地同名地区，交由 strict 矩阵/其他平台来源确认。
  for (const token of HEBEI_STRONG_TOKENS) {
    if (token.length < 4) continue;
    if (new RegExp(`(?<![a-z])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(n)) return 'hebei';
  }
  return 'unknown';
}
