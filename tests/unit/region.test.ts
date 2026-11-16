/**
 * S1 区域注册表单测：河北 11 市 × 四平台映射、基线幂等、字典同步/回退。
 * 使用内存 fake RegionsPort（不依赖 node:sqlite，测试全离线）。
 */
import { describe, expect, it } from 'vitest';
import { RegionRegistry } from '../../src/region/registry.js';
import { syncRegionDictionaries } from '../../src/region/sync.js';
import type { RegionMappingRow, RegionRow, RegionsPort, SourceHealthUpsert } from '../../src/pipeline/ports.js';
import type { Platform, SourceHealth, SourceHealthState } from '../../src/shared/domain.js';
import { LeadError } from '../../src/shared/errors.js';
import {
  classifyHebeiCompanyName,
  expandProvinceCities,
  findCity,
  findProvince,
  regionNameKey,
} from '../../src/region/names.js';
import { BUILTIN_HEBEI_MAP, CITIES, HEBEI_COUNTIES, PROVINCES } from '../../src/data/regions.js';
import type { PlatformRegion } from '../../src/adapters/sources/types.js';

class FakeRegions implements RegionsPort {
  readonly regions = new Map<string, RegionRow>();
  readonly mappings = new Map<string, RegionMappingRow>();
  private key(regionCode: string, platform: string): string {
    return `${regionCode}|${platform}`;
  }
  upsertRegions(rows: RegionRow[]): void {
    for (const row of rows) this.regions.set(row.code, row);
  }
  listCities(provinceCode: string): RegionRow[] {
    return [...this.regions.values()].filter((r) => r.level === 'city' && r.parentCode === provinceCode);
  }
  getRegion(code: string): RegionRow | null {
    return this.regions.get(code) ?? null;
  }
  upsertMapping(row: RegionMappingRow): void {
    this.mappings.set(this.key(row.regionCode, row.platform), row);
  }
  upsertMappings(rows: RegionMappingRow[]): void {
    for (const row of rows) this.upsertMapping(row);
  }
  getMapping(regionCode: string, platform: Platform): { platformValue: string } | null {
    const row = this.mappings.get(this.key(regionCode, platform));
    return row ? { platformValue: row.platformValue } : null;
  }
  listMappingsForProvince(provinceCode: string, platform: Platform): Record<string, string> {
    const result: Record<string, string> = {};
    for (const row of this.mappings.values()) {
      if (row.platform !== platform) continue;
      const region = this.regions.get(row.regionCode);
      if (region?.parentCode === provinceCode) result[row.regionCode] = row.platformValue;
    }
    return result;
  }
}

class FakeHealth {
  readonly rows = new Map<string, SourceHealth>();
  upserts = 0;
  async upsert(input: SourceHealthUpsert): Promise<void> {
    this.upserts += 1;
    this.rows.set(input.platform, {
      platform: input.platform,
      state: input.state as SourceHealthState,
      loggedIn: input.loggedIn ?? null,
      expiresAt: input.expiresAt ?? null,
      checkedAt: input.checkedAt ?? '2026-11-16T00:00:00.000Z',
      consecutiveFailures: input.consecutiveFailures ?? 0,
      detail: input.detail ?? null,
    });
  }
  async get(platform: string): Promise<SourceHealth | null> {
    return this.rows.get(platform) ?? null;
  }
  async listAll(): Promise<SourceHealth[]> {
    return [...this.rows.values()];
  }
}

const DOCS_HEBEI: Record<string, Record<Platform, string>> = {
  130100: { boss: '101090100', zhilian: '565', ali: 'CN-13-1301', mic: 'Shijiazhuang' },
  130200: { boss: '101090500', zhilian: '566', ali: 'CN-13-1302', mic: 'Tangshan' },
  130300: { boss: '101091100', zhilian: '567', ali: 'CN-13-1303', mic: 'Qinhuangdao' },
  130400: { boss: '101091000', zhilian: '568', ali: 'CN-13-1304', mic: 'Handan' },
  130500: { boss: '101090900', zhilian: '569', ali: 'CN-13-1305', mic: 'Xingtai' },
  130600: { boss: '101090200', zhilian: '570', ali: 'CN-13-1306', mic: 'Baoding' },
  130700: { boss: '101090300', zhilian: '571', ali: 'CN-13-1307', mic: 'Zhangjiakou' },
  130800: { boss: '101090400', zhilian: '572', ali: 'CN-13-1308', mic: 'Chengde' },
  130900: { boss: '101090700', zhilian: '573', ali: 'CN-13-1309', mic: 'Cangzhou' },
  131000: { boss: '101090600', zhilian: '574', ali: 'CN-13-1310', mic: 'Langfang' },
  131100: { boss: '101090800', zhilian: '575', ali: 'CN-13-1311', mic: 'Hengshui' },
};

describe('内置区域基线', () => {
  it('全国省 + 地级市基线完整，河北 11 市/118 县级种子齐备', () => {
    expect(PROVINCES).toHaveLength(31);
    expect(PROVINCES.find((p) => p.code === '130000')?.name).toBe('河北省');
    expect(CITIES.filter((c) => c.parentCode === '130000')).toHaveLength(11);
    expect(CITIES.length).toBeGreaterThan(300);
    expect(HEBEI_COUNTIES.length).toBeGreaterThanOrEqual(100);
    expect(new Set(HEBEI_COUNTIES.map((c) => c.code)).size).toBe(HEBEI_COUNTIES.length);
    expect(HEBEI_COUNTIES.every((c) => c.englishName.length > 0)).toBe(true);
  });

  it('区域名归一/查找：省份中英文、市名去后缀、歧义处理', () => {
    expect(regionNameKey('河北省')).toBe('河北');
    expect(regionNameKey('内蒙古自治区')).toBe('内蒙古');
    expect(findProvince('河北')?.code).toBe('130000');
    expect(findProvince('130000')?.name).toBe('河北省');
    expect(findCity('河北', '石家庄')?.code).toBe('130100');
    expect(findCity('130000', '130100')?.name).toBe('石家庄市');
    expect(findCity('河北', '杭州')).toBeNull();
    expect(expandProvinceCities('北京')).toHaveLength(1);
  });

  it('Ali 地理种子名称判省：河北/其他/未知', () => {
    expect(classifyHebeiCompanyName('Hebei Example Industrial Metal Co., Ltd.')).toBe('hebei');
    expect(classifyHebeiCompanyName('Shijiazhuang Trading Co.')).toBe('hebei');
    expect(classifyHebeiCompanyName('Zhejiang Machinery Co., Ltd.')).toBe('other');
    expect(classifyHebeiCompanyName('Acme Industrial Co.')).toBe('unknown');
  });
});

describe('RegionRegistry', () => {
  it('ensureBaseline 幂等写入 31 省 + 333 市 + 河北内置映射', async () => {
    const store = new FakeRegions();
    const registry = new RegionRegistry(store);
    await registry.ensureBaseline();
    const firstCount = store.regions.size;
    const firstMappings = store.mappings.size;
    await registry.ensureBaseline();
    expect(store.regions.size).toBe(firstCount);
    expect(store.mappings.size).toBe(firstMappings);
    expect(firstCount).toBe(31 + CITIES.length);
    // 11 市 × 4 平台 + 省 × 2（Ali CN-13 / Mic Hebei）
    expect(firstMappings).toBe(11 * 4 + 2);
    expect(BUILTIN_HEBEI_MAP).toHaveLength(46);
  });

  it('河北 11 市 × 四平台映射与 docs/04 §4.2 实测值完全一致', async () => {
    const registry = new RegionRegistry(new FakeRegions());
    for (const [code, expected] of Object.entries(DOCS_HEBEI)) {
      for (const platform of ['boss', 'zhilian', 'ali', 'mic'] as Platform[]) {
        await expect(registry.getPlatformValue(code, platform)).resolves.toBe(expected[platform]);
      }
    }
    await expect(registry.getProvincePlatformValue('130000', 'ali')).resolves.toBe('CN-13');
    await expect(registry.getProvincePlatformValue('130000', 'mic')).resolves.toBe('Hebei');
  });

  it('resolveCities：全省展开 11 市并带各平台映射；cityCodes 子集与非法城市校验', async () => {
    const registry = new RegionRegistry(new FakeRegions());
    const all = await registry.resolveCities({ province: '河北省' });
    expect(all.provinceCode).toBe('130000');
    expect(all.cities).toHaveLength(11);
    const shijiazhuang = all.cities.find((c) => c.code === '130100');
    expect(shijiazhuang?.platformValues).toMatchObject({
      boss: '101090100',
      zhilian: '565',
      ali: 'CN-13-1301',
      mic: 'Shijiazhuang',
    });
    expect(shijiazhuang?.englishName).toBe('Shijiazhuang');
    const subset = await registry.resolveCities({ province: '河北省', cityCodes: ['130100', '130200'] });
    expect(subset.cities.map((c) => c.code)).toEqual(['130100', '130200']);
    await expect(registry.resolveCities({ province: '不存在的省' })).rejects.toBeInstanceOf(LeadError);
    await expect(registry.resolveCities({ province: '河北省', cityCodes: ['330100'] })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('ingestPlatformRegions：平台字典按名称匹配基线，写 client_sync 映射（覆盖内置值）', async () => {
    const store = new FakeRegions();
    const registry = new RegionRegistry(store);
    const bossDict: PlatformRegion[] = [
      { platform: 'boss', regionCode: '101090100', platformValue: '101090100', level: 'city', nameZh: '石家庄', nameEn: null, aliases: [], parentCode: null },
      { platform: 'boss', regionCode: '999', platformValue: '999', level: 'city', nameZh: '不存在的城市', nameEn: null, aliases: [], parentCode: null },
    ];
    const result = await registry.ingestPlatformRegions('boss', bossDict.map((r) => ({ ...r })));
    expect(result.matched).toBe(1);
    expect(result.unmatched).toBe(1);
    expect(result.mappings).toBe(1);
    const saved = store.mappings.get('130100|boss');
    expect(saved).toMatchObject({ platformValue: '101090100', source: 'client_sync' });
    await expect(registry.getPlatformValue('130100', 'boss')).resolves.toBe('101090100');
  });
});

describe('区域字典同步', () => {
  function adapterStub(platform: 'boss' | 'zhilian' | 'ali' | 'mic', entries: PlatformRegion[], fail = false) {
    return {
      platform,
      listRegions: async () => {
        if (fail) throw new LeadError('SOURCE_SESSION_INVALID', `${platform} 登录失效`);
        return entries;
      },
    };
  }

  it('四源同步成功：河北 11 市写入 client_sync 映射；失败来源回退内置基线并写 source_health', async () => {
    const store = new FakeRegions();
    const health = new FakeHealth();
    const registry = new RegionRegistry(store);
    const hebeiCities: PlatformRegion[] = [
      { platform: 'boss', regionCode: '101090100', platformValue: '101090100', level: 'city', nameZh: '石家庄', nameEn: null, aliases: [], parentCode: null },
      { platform: 'boss', regionCode: '101090500', platformValue: '101090500', level: 'city', nameZh: '唐山', nameEn: null, aliases: [], parentCode: null },
    ];
    const summary = await syncRegionDictionaries({
      registry,
      sourceHealth: health as unknown as FakeHealth,
      adapters: {
        boss: adapterStub('boss', hebeiCities) as never,
        zhilian: adapterStub('zhilian', [], true) as never,
        ali: adapterStub('ali', [
          { platform: 'ali', regionCode: 'CN-13-1301', platformValue: 'CN-13-1301', level: 'city', nameZh: '石家庄市', nameEn: 'Shijiazhuang', aliases: [], parentCode: 'CN-13' },
        ]) as never,
        mic: adapterStub('mic', [
          { platform: 'mic', regionCode: 'Hebei', platformValue: 'Hebei', level: 'province', nameZh: '河北', nameEn: 'Hebei', aliases: [], parentCode: null },
        ]) as never,
      },
    });
    expect(summary.results).toHaveLength(3);
    expect(summary.failed).toEqual([expect.objectContaining({ platform: 'zhilian', errorCode: 'SOURCE_SESSION_INVALID' })]);
    expect(summary.fallback.zhilian).toBe(true);
    expect(store.mappings.get('130100|boss')?.source).toBe('client_sync');
    expect(store.mappings.get('130100|ali')?.platformValue).toBe('CN-13-1301');
    // 智联失败 → source_health 记录 degraded/session_invalid
    const zhilianHealth = health.rows.get('zhilian');
    expect(zhilianHealth?.state).toBe('session_invalid');
    expect(zhilianHealth?.consecutiveFailures).toBe(1);
    // 失败后内置基线仍可用
    await expect(registry.getPlatformValue('130100', 'zhilian')).resolves.toBe('565');
  });
});
