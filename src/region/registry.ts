/**
 * 区域注册表（Region Registry）。
 *
 * - 基线：src/data/regions.ts 内置 GB/T 2260（省 + 地级市）+ 河北 11 市四平台映射；
 * - 平台映射：region_platform_map(region_code, platform, platform_value, source, synced_at)
 *   由 src/region/sync.ts 从各上游字典同步（source=client_sync），失败回退内置基线（source=builtin）；
 * - 查询组成（docs/02 §6）：Goal 的 region_province_code → 该省城市列表（cityCodes 为空时）
 *   → 每个城市取各平台映射值 → 生成 source_queries。
 */
import { BUILTIN_HEBEI_MAP, CITIES, HEBEI_PROVINCE_PLATFORM_VALUE, REGION_BASELINE, type RegionBaseline } from '../data/regions.js';
import type { GoalRegion, Platform, RegionRow } from '../shared/domain.js';
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import {
  expandProvinceCities,
  findCity,
  findProvince,
  HEBEI_CITY_EN,
  isMunicipality,
  isValidCityOfProvince,
  regionNameKey,
} from './names.js';
import type { RegionMappingRow, RegionsPort } from '../pipeline/ports.js';

export interface ResolvedCity {
  code: string;
  name: string;
  nameZh: string;
  englishName: string | null;
  platformValues: Partial<Record<Platform, string>>;
}

export interface ResolveCitiesResult {
  provinceCode: string;
  provinceName: string;
  cities: ResolvedCity[];
}

export interface PlatformRegionInput {
  platform: Platform;
  level: 'province' | 'city';
  platformValue: string;
  nameZh: string | null;
  nameEn: string | null;
  parentCode?: string | null;
}

export interface RegionSyncResult {
  platform: Platform;
  matched: number;
  unmatched: number;
  mappings: number;
}

const BUILTIN_MAP_INDEX = new Map<string, Map<Platform, string>>();
for (const row of BUILTIN_HEBEI_MAP) {
  let m = BUILTIN_MAP_INDEX.get(row.regionCode);
  if (!m) {
    m = new Map();
    BUILTIN_MAP_INDEX.set(row.regionCode, m);
  }
  m.set(row.platform, row.platformValue);
}

/** 由 GB/T 2260 城市 code 推导 Ali 区域 code（CN-13-1301 形如 CN-{省2}-{市4}） */
export function aliCodeFromGb(code: string): string | null {
  if (!/^\d{6}$/.test(code)) return null;
  return `CN-${code.slice(0, 2)}-${code.slice(0, 4)}`;
}

function baseRow(r: RegionBaseline): RegionRow {
  return { code: r.code, name: r.name, level: r.level, parentCode: r.parentCode };
}

export class RegionRegistry {
  private readonly regions: RegionsPort;
  private readonly now: () => string;
  private baselineEnsured = false;

  constructor(regions: RegionsPort, opts?: { now?: () => string }) {
    this.regions = regions;
    this.now = opts?.now ?? nowIso;
  }

  /** 写入内置基线（幂等；不覆盖已有 client_sync 映射） */
  async ensureBaseline(): Promise<void> {
    if (this.baselineEnsured) return;
    await this.regions.upsertRegions(REGION_BASELINE.map(baseRow));
    for (const row of BUILTIN_HEBEI_MAP) {
      const existing = await this.regions.getMapping(row.regionCode, row.platform);
      if (existing) continue;
      await this.regions.upsertMapping({
        regionCode: row.regionCode,
        platform: row.platform,
        platformValue: row.platformValue,
        source: 'builtin',
        syncedAt: this.now(),
      });
    }
    this.baselineEnsured = true;
  }

  /** 省下地级市（DB 优先，空则回退内置基线） */
  async listProvinceCities(provinceCodeOrName: string): Promise<RegionBaseline[]> {
    const province = findProvince(provinceCodeOrName);
    if (!province) return [];
    await this.ensureBaseline().catch(() => undefined);
    let rows: RegionRow[] = [];
    try {
      rows = (await this.regions.listCities(province.code)) ?? [];
    } catch {
      rows = [];
    }
    const fromDb = rows
      .filter((r) => r.level === 'city')
      .map((r) => ({ code: r.code, name: r.name, level: 'city' as const, parentCode: r.parentCode, shortName: regionNameKey(r.name) }));
    if (fromDb.length > 0) return fromDb;
    return expandProvinceCities(province.code);
  }

  /** 单城市平台映射值：DB → 内置 → 可推导（Ali code） */
  async getPlatformValue(regionCode: string, platform: Platform): Promise<string | null> {
    let db: { platformValue: string } | null = null;
    try {
      db = await this.regions.getMapping(regionCode, platform);
    } catch {
      db = null;
    }
    if (db?.platformValue) return db.platformValue;
    const builtin = BUILTIN_MAP_INDEX.get(regionCode)?.get(platform);
    if (builtin) return builtin;
    if (platform === 'ali') return aliCodeFromGb(regionCode);
    return null;
  }

  /** 省 × 平台映射（含省本级，如 Ali CN-13 / Mic Hebei） */
  async getProvincePlatformValue(provinceCode: string, platform: Platform): Promise<string | null> {
    let db: { platformValue: string } | null = null;
    try {
      db = await this.regions.getMapping(provinceCode, platform);
    } catch {
      db = null;
    }
    if (db?.platformValue) return db.platformValue;
    const builtin = BUILTIN_MAP_INDEX.get(provinceCode)?.get(platform);
    if (builtin) return builtin;
    return HEBEI_PROVINCE_PLATFORM_VALUE[platform] ?? null;
  }

  /** 省级平台检索值（Boss/智联无省级检索 → null） */
  async listCityMappings(provinceCode: string, platform: Platform): Promise<Record<string, string>> {
    let dbMap: Record<string, string> = {};
    try {
      dbMap = (await this.regions.listMappingsForProvince(provinceCode, platform)) ?? {};
    } catch {
      dbMap = {};
    }
    const result: Record<string, string> = {};
    const cities = await this.listProvinceCities(provinceCode);
    for (const city of cities) {
      const value = dbMap[city.code] ?? (await this.getPlatformValue(city.code, platform));
      if (value) result[city.code] = value;
    }
    return result;
  }

  /** Goal.region → 实际检索城市 + 各平台映射值 */
  async resolveCities(region: GoalRegion): Promise<ResolveCitiesResult> {
    const province = findProvince(region.provinceCode ?? region.province);
    if (!province) {
      throw new LeadError('VALIDATION_ERROR', `未知省份：${region.provinceCode ?? region.province}`, {
        details: { field: 'region.province', value: region.provinceCode ?? region.province },
      });
    }
    const allCities = await this.listProvinceCities(province.code);
    let selected = allCities;
    if (region.cityCodes && region.cityCodes.length > 0) {
      const picked: RegionBaseline[] = [];
      for (const code of region.cityCodes) {
        const city = allCities.find((c) => c.code === code) ?? findCity(province.code, code);
        if (!city) {
          throw new LeadError('VALIDATION_ERROR', `城市不属于${province.name}：${code}`, {
            details: { field: 'region.cityCodes', value: code, provinceCode: province.code },
          });
        }
        if (!picked.some((c) => c.code === city.code)) picked.push(city);
      }
      selected = picked;
    }
    const cities: ResolvedCity[] = [];
    for (const city of selected) {
      const englishName = HEBEI_CITY_EN[city.code] ?? null;
      const platformValues: Partial<Record<Platform, string>> = {};
      for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
        const value = await this.getPlatformValue(city.code, platform);
        if (value) platformValues[platform] = value;
      }
      // 直辖市伪城市：平台映射写在省 code 上
      if (isMunicipality(province.code)) {
        for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
          if (platformValues[platform]) continue;
          const provinceValue = await this.getProvincePlatformValue(province.code, platform);
          if (provinceValue) platformValues[platform] = provinceValue;
        }
      }
      cities.push({ code: city.code, name: city.name, nameZh: city.name, englishName, platformValues });
    }
    return { provinceCode: province.code, provinceName: province.name, cities };
  }

  /** 校验 region 合法性（不抛错，返回错误信息） */
  async validateRegion(region: GoalRegion): Promise<string | null> {
    const province = findProvince(region.provinceCode ?? region.province);
    if (!province) return `未知省份：${region.provinceCode ?? region.province}`;
    for (const code of region.cityCodes ?? []) {
      if (!isValidCityOfProvince(province.code, code)) return `城市不属于${province.name}：${code}`;
    }
    return null;
  }

  /**
   * 摄入一个平台的区域字典：匹配内置基线 → upsert region_platform_map（source=client_sync）。
   * 未匹配条目只计数（不把平台 code 写入 canonical regions 表）。
   */
  async ingestPlatformRegions(platform: Platform, entries: PlatformRegionInput[]): Promise<RegionSyncResult> {
    await this.ensureBaseline();
    const rows: RegionMappingRow[] = [];
    let matched = 0;
    let unmatched = 0;
    for (const entry of entries) {
      const baseline = this.matchBaseline(entry);
      if (!baseline) {
        unmatched += 1;
        continue;
      }
      matched += 1;
      // 同一 region 只取第一次出现（城市名可能重名；以先出现为准）
      if (rows.some((r) => r.regionCode === baseline.code)) continue;
      rows.push({
        regionCode: baseline.code,
        platform,
        platformValue: entry.platformValue,
        source: 'client_sync',
        syncedAt: this.now(),
      });
    }
    if (rows.length > 0) await this.regions.upsertMappings(rows);
    return { platform, matched, unmatched, mappings: rows.length };
  }

  private matchBaseline(entry: PlatformRegionInput): RegionBaseline | null {
    const nameZh = entry.nameZh;
    const nameEn = entry.nameEn;
    if (entry.level === 'province') {
      const p = findProvince(nameZh) ?? findProvince(nameEn ?? '');
      return p ?? null;
    }
    // 城市：英文名优先（河北 11 市内置英文名），再中文短名匹配
    if (nameEn) {
      const byEn = Object.entries(HEBEI_CITY_EN).find(([, en]) => en.toLowerCase() === nameEn.toLowerCase());
      if (byEn) {
        const found = expandProvinceCities('130000').find((c) => c.code === byEn[0]);
        if (found) return found;
      }
    }
    if (nameZh) {
      // 中文名可能恰好与某省同名（如「吉林」），城市级条目优先按全国城市匹配
      const key = regionNameKey(nameZh);
      const hits = CITIES.filter((c) => regionNameKey(c.name) === key);
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        const hebei = hits.find((c) => c.parentCode === '130000');
        if (hebei) return hebei;
        return hits[0];
      }
      const byProvince = findProvince(nameZh);
      if (byProvince) return byProvince;
    }
    return null;
  }
}
