/** regions / region_platform_map（内置区域基线 + 各平台字典映射） */
import { nowIso } from '../shared/time.js';
import { all, countRows, one, run, type DbConnection } from './sql.js';
import type {
  NewRegionPlatformMapping,
  RegionPlatformMapping,
  RegionRecord,
} from './types.js';
import type { Platform } from '../shared/domain.js';

interface RegionRow {
  code: string;
  name: string;
  level: string;
  parent_code: string | null;
}

interface MappingRow {
  region_code: string;
  platform: string;
  platform_value: string;
  source: string | null;
  synced_at: string | null;
}

function mapRegion(row: RegionRow): RegionRecord {
  return {
    code: row.code,
    name: row.name,
    level: row.level as RegionRecord['level'],
    parentCode: row.parent_code,
  };
}

function mapMapping(row: MappingRow): RegionPlatformMapping {
  return {
    regionCode: row.region_code,
    platform: row.platform as Platform,
    platformValue: row.platform_value,
    source: row.source,
    syncedAt: row.synced_at,
  };
}

export class RegionsRepository {
  constructor(private readonly db: DbConnection) {}

  // -------------------------------------------------------------------------
  // regions
  // -------------------------------------------------------------------------

  upsertRegions(rows: RegionRecord[]): number {
    if (rows.length === 0) return 0;
    return this.db.transaction(() => {
      let changes = 0;
      for (const row of rows) {
        changes += run(
          this.db,
          `INSERT INTO regions(code, name, level, parent_code) VALUES(?,?,?,?)
           ON CONFLICT(code) DO UPDATE SET name = excluded.name, level = excluded.level, parent_code = excluded.parent_code`,
          [row.code, row.name, row.level, row.parentCode ?? null],
        ).changes;
      }
      return changes;
    });
  }

  getRegion(code: string): RegionRecord | null {
    const row = one<RegionRow>(this.db, 'SELECT * FROM regions WHERE code = ?', [code]);
    return row ? mapRegion(row) : null;
  }

  getByCode(code: string): RegionRecord | null {
    return this.getRegion(code);
  }

  listProvinces(): RegionRecord[] {
    return all<RegionRow>(
      this.db,
      "SELECT * FROM regions WHERE level = 'province' ORDER BY code ASC",
    ).map(mapRegion);
  }

  listCities(provinceCode: string): RegionRecord[] {
    return all<RegionRow>(
      this.db,
      "SELECT * FROM regions WHERE level = 'city' AND parent_code = ? ORDER BY code ASC",
      [provinceCode],
    ).map(mapRegion);
  }

  listAll(level?: RegionRecord['level']): RegionRecord[] {
    return level
      ? all<RegionRow>(this.db, 'SELECT * FROM regions WHERE level = ? ORDER BY code ASC', [level]).map(mapRegion)
      : all<RegionRow>(this.db, 'SELECT * FROM regions ORDER BY code ASC').map(mapRegion);
  }

  findByName(name: string, level?: RegionRecord['level']): RegionRecord[] {
    const where = level ? 'WHERE name = ? AND level = ?' : 'WHERE name = ?';
    const params = level ? [name, level] : [name];
    return all<RegionRow>(this.db, `SELECT * FROM regions ${where} ORDER BY code ASC`, params).map(mapRegion);
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM regions');
  }

  // -------------------------------------------------------------------------
  // region_platform_map
  // -------------------------------------------------------------------------

  upsertMapping(input: NewRegionPlatformMapping): RegionPlatformMapping {
    run(
      this.db,
      `INSERT INTO region_platform_map(region_code, platform, platform_value, source, synced_at)
       VALUES(?,?,?,?,?)
       ON CONFLICT(region_code, platform) DO UPDATE SET
         platform_value = excluded.platform_value,
         source = excluded.source,
         synced_at = excluded.synced_at`,
      [
        input.regionCode,
        input.platform,
        input.platformValue,
        input.source ?? null,
        input.syncedAt ?? nowIso(),
      ],
    );
    return this.requireMapping(input.regionCode, input.platform);
  }

  upsertMappings(rows: NewRegionPlatformMapping[]): number {
    if (rows.length === 0) return 0;
    return this.db.transaction(() => {
      let changes = 0;
      for (const row of rows) {
        changes += run(
          this.db,
          `INSERT INTO region_platform_map(region_code, platform, platform_value, source, synced_at)
           VALUES(?,?,?,?,?)
           ON CONFLICT(region_code, platform) DO UPDATE SET
             platform_value = excluded.platform_value,
             source = excluded.source,
             synced_at = excluded.synced_at`,
          [row.regionCode, row.platform, row.platformValue, row.source ?? null, row.syncedAt ?? nowIso()],
        ).changes;
      }
      return changes;
    });
  }

  getMapping(regionCode: string, platform: Platform): RegionPlatformMapping | null {
    const row = one<MappingRow>(
      this.db,
      'SELECT * FROM region_platform_map WHERE region_code = ? AND platform = ?',
      [regionCode, platform],
    );
    return row ? mapMapping(row) : null;
  }

  getMappingValue(regionCode: string, platform: Platform): string | null {
    return this.getMapping(regionCode, platform)?.platformValue ?? null;
  }

  listMappings(platform: Platform): RegionPlatformMapping[] {
    return all<MappingRow>(
      this.db,
      'SELECT * FROM region_platform_map WHERE platform = ? ORDER BY region_code ASC',
      [platform],
    ).map(mapMapping);
  }

  /**
   * 省 → 地级市 的平台值映射（组成 source_queries 用）：
   * `{ '130100': '101010100', ... }`
   */
  listMappingsForProvince(provinceCode: string, platform: Platform): Record<string, string> {
    const rows = all<{ region_code: string; platform_value: string }>(
      this.db,
      `SELECT m.region_code, m.platform_value
       FROM region_platform_map m
       JOIN regions r ON r.code = m.region_code
       WHERE r.parent_code = ? AND r.level = 'city' AND m.platform = ?
       ORDER BY r.code ASC`,
      [provinceCode, platform],
    );
    const out: Record<string, string> = {};
    for (const row of rows) out[row.region_code] = row.platform_value;
    return out;
  }

  /** 兼容命名 */
  getMap(provinceCode: string, platform: Platform): Record<string, string> {
    return this.listMappingsForProvince(provinceCode, platform);
  }

  listMappingsForRegionCodes(regionCodes: string[], platform: Platform): RegionPlatformMapping[] {
    if (regionCodes.length === 0) return [];
    return all<MappingRow>(
      this.db,
      `SELECT * FROM region_platform_map WHERE platform = ?
       AND region_code IN (${regionCodes.map(() => '?').join(',')})`,
      [platform, ...regionCodes],
    ).map(mapMapping);
  }

  deleteMappingsForProvince(provinceCode: string, platform: Platform): number {
    return run(
      this.db,
      `DELETE FROM region_platform_map
       WHERE platform = ? AND region_code IN (SELECT code FROM regions WHERE parent_code = ?)`,
      [platform, provinceCode],
    ).changes;
  }

  deleteMapping(regionCode: string, platform: Platform): boolean {
    return (
      run(this.db, 'DELETE FROM region_platform_map WHERE region_code = ? AND platform = ?', [
        regionCode,
        platform,
      ]).changes > 0
    );
  }

  countMappings(platform?: Platform): number {
    return platform
      ? countRows(this.db, 'SELECT COUNT(*) FROM region_platform_map WHERE platform = ?', [platform])
      : countRows(this.db, 'SELECT COUNT(*) FROM region_platform_map');
  }

  private requireMapping(regionCode: string, platform: Platform): RegionPlatformMapping {
    const mapping = this.getMapping(regionCode, platform);
    if (!mapping) throw new Error(`region mapping not found: ${regionCode}/${platform}`);
    return mapping;
  }
}
