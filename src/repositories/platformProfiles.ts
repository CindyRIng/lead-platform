/** company_platform_profiles 表（每公司 × 平台最新档案） */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import { isoPlusDays } from '../shared/time.js';
import {
  all,
  countRows,
  fromDbInt,
  fromJson,
  fromJsonArray,
  fromJsonObject,
  fromJsonUnknown,
  one,
  run,
  toIso,
  toJson,
  toJsonArray,
  type DbConnection,
} from './sql.js';
import type {
  NewPlatformProfile,
  PlatformProfilePatch,
  PlatformProfileRecord,
  PlatformProfileUpsertResult,
} from './types.js';
import type { Platform, PlatformStatus } from '../shared/domain.js';

interface PlatformProfileRow {
  id: string;
  company_id: string;
  platform: string;
  platform_company_id: string;
  display_name: string | null;
  source_url: string | null;
  full_name: string | null;
  city_name: string | null;
  address: string | null;
  industry: string | null;
  scale: string | null;
  stage: string | null;
  logo_url: string | null;
  intro: string | null;
  tags: string | null;
  benefits: string | null;
  job_count: number | null;
  boss_count: number | null;
  recruiters: string | null;
  store: string | null;
  platform_status: string;
  last_fetched_at: string;
  last_seen_at: string | null;
  next_jobs_refresh_at: string | null;
  next_store_refresh_at: string | null;
  raw_snapshot_id: number | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const SHARED_VALUE = Symbol('shared');

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function mapPlatformProfile(row: PlatformProfileRow): PlatformProfileRecord {
  const tags = row.tags === null ? null : fromJsonArray<string>(row.tags);
  const benefits = row.benefits === null ? null : fromJsonArray<string>(row.benefits);
  return {
    id: row.id,
    companyId: row.company_id,
    platform: row.platform as Platform,
    platformCompanyId: row.platform_company_id,
    displayName: row.display_name,
    sourceUrl: row.source_url,
    fullName: row.full_name,
    cityName: row.city_name,
    address: row.address,
    industry: row.industry,
    scale: row.scale,
    stage: row.stage,
    logoUrl: row.logo_url,
    intro: row.intro,
    tags,
    benefits,
    jobCount: row.job_count,
    bossCount: row.boss_count,
    recruiters: fromJsonUnknown(row.recruiters, null),
    store: fromJsonObject(row.store),
    platformStatus: row.platform_status as PlatformStatus,
    lastFetchedAt: row.last_fetched_at,
    lastSeenAt: row.last_seen_at,
    nextJobsRefreshAt: row.next_jobs_refresh_at,
    nextStoreRefreshAt: row.next_store_refresh_at,
    rawSnapshotId: row.raw_snapshot_id,
    version: Number(row.version ?? 1),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PlatformProfilesRepositoryOptions {
  jobRefreshDays?: number;
  storeRefreshDays?: number;
}

export class PlatformProfilesRepository {
  private readonly jobRefreshDays: number;
  private readonly storeRefreshDays: number;

  constructor(
    private readonly db: DbConnection,
    opts: PlatformProfilesRepositoryOptions = {},
  ) {
    this.jobRefreshDays = opts.jobRefreshDays ?? 7;
    this.storeRefreshDays = opts.storeRefreshDays ?? 30;
  }

  /**
   * upsert 档案：
   * - previous 供调用方做字段 diff
   * - version：显式传则使用；否则 previous.version+1（新建=1）
   * - 未提供的可选字段沿用 previous（显式 null 则置空）
   */
  upsert(input: NewPlatformProfile): PlatformProfileUpsertResult {
    return this.db.transaction(() => {
      const previous = this.getByCompanyPlatform(input.companyId, input.platform);
      const now = nowIso();
      const lastFetchedAt = input.lastFetchedAt ?? now;
      if (!previous) {
        const version = input.version ?? 1;
        const nextJobsRefreshAt =
          input.nextJobsRefreshAt === undefined
            ? isoPlusDays(this.jobRefreshDays)
            : input.nextJobsRefreshAt;
        const nextStoreRefreshAt =
          input.nextStoreRefreshAt === undefined
            ? isoPlusDays(this.storeRefreshDays)
            : input.nextStoreRefreshAt;
        run(
          this.db,
          `INSERT INTO company_platform_profiles(
            id, company_id, platform, platform_company_id, display_name, source_url, full_name,
            city_name, address, industry, scale, stage, logo_url, intro, tags, benefits,
            job_count, boss_count, recruiters, store, platform_status, last_fetched_at, last_seen_at,
            next_jobs_refresh_at, next_store_refresh_at, raw_snapshot_id, version, created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.id ?? `ppf_${cryptoRandom()}`,
            input.companyId,
            input.platform,
            input.platformCompanyId,
            input.displayName ?? null,
            input.sourceUrl ?? null,
            input.fullName ?? null,
            input.cityName ?? null,
            input.address ?? null,
            input.industry ?? null,
            input.scale ?? null,
            input.stage ?? null,
            input.logoUrl ?? null,
            input.intro ?? null,
            input.tags === undefined || input.tags === null ? null : toJsonArray(input.tags),
            input.benefits === undefined || input.benefits === null ? null : toJsonArray(input.benefits),
            input.jobCount ?? null,
            input.bossCount ?? null,
            toJson(input.recruiters ?? null),
            toJson(input.store ?? null),
            input.platformStatus ?? 'active',
            lastFetchedAt,
            input.lastSeenAt ?? lastFetchedAt,
            nextJobsRefreshAt,
            nextStoreRefreshAt,
            input.rawSnapshotId ?? null,
            version,
            now,
            now,
          ],
        );
        const profile = this.requireByCompanyPlatform(input.companyId, input.platform);
        return { profile, previous: null, created: true };
      }

      const version = input.version ?? previous.version + 1;
      const merged = {
        platformCompanyId: input.platformCompanyId ?? previous.platformCompanyId,
        displayName: pick(input.displayName, previous.displayName),
        sourceUrl: pick(input.sourceUrl, previous.sourceUrl),
        fullName: pick(input.fullName, previous.fullName),
        cityName: pick(input.cityName, previous.cityName),
        address: pick(input.address, previous.address),
        industry: pick(input.industry, previous.industry),
        scale: pick(input.scale, previous.scale),
        stage: pick(input.stage, previous.stage),
        logoUrl: pick(input.logoUrl, previous.logoUrl),
        intro: pick(input.intro, previous.intro),
        tags: pick(input.tags, previous.tags),
        benefits: pick(input.benefits, previous.benefits),
        jobCount: pick(input.jobCount, previous.jobCount),
        bossCount: pick(input.bossCount, previous.bossCount),
        recruiters: pick(input.recruiters, previous.recruiters),
        store: pick(input.store, previous.store),
        platformStatus: pick(input.platformStatus, previous.platformStatus),
        lastSeenAt: pick(input.lastSeenAt, previous.lastSeenAt),
        nextJobsRefreshAt: pick(input.nextJobsRefreshAt, previous.nextJobsRefreshAt),
        nextStoreRefreshAt: pick(input.nextStoreRefreshAt, previous.nextStoreRefreshAt),
        rawSnapshotId: pick(input.rawSnapshotId, previous.rawSnapshotId),
      };
      run(
        this.db,
        `UPDATE company_platform_profiles SET
           platform_company_id = ?, display_name = ?, source_url = ?, full_name = ?, city_name = ?,
           address = ?, industry = ?, scale = ?, stage = ?, logo_url = ?, intro = ?, tags = ?,
           benefits = ?, job_count = ?, boss_count = ?, recruiters = ?, store = ?, platform_status = ?,
           last_fetched_at = ?, last_seen_at = ?, next_jobs_refresh_at = ?, next_store_refresh_at = ?,
           raw_snapshot_id = ?, version = ?, updated_at = ?
         WHERE id = ?`,
        [
          merged.platformCompanyId,
          merged.displayName,
          merged.sourceUrl,
          merged.fullName,
          merged.cityName,
          merged.address,
          merged.industry,
          merged.scale,
          merged.stage,
          merged.logoUrl,
          merged.intro,
          merged.tags === null ? null : toJsonArray(merged.tags),
          merged.benefits === null ? null : toJsonArray(merged.benefits),
          merged.jobCount,
          merged.bossCount,
          toJson(merged.recruiters ?? null),
          toJson(merged.store ?? null),
          merged.platformStatus,
          lastFetchedAt,
          merged.lastSeenAt,
          merged.nextJobsRefreshAt,
          merged.nextStoreRefreshAt,
          merged.rawSnapshotId,
          version,
          now,
          previous.id,
        ],
      );
      return { profile: this.requireById(previous.id), previous, created: false };
    });
  }

  getById(id: string): PlatformProfileRecord | null {
    const row = one<PlatformProfileRow>(
      this.db,
      'SELECT * FROM company_platform_profiles WHERE id = ?',
      [id],
    );
    return row ? mapPlatformProfile(row) : null;
  }

  getByCompanyPlatform(companyId: string, platform: Platform): PlatformProfileRecord | null {
    const row = one<PlatformProfileRow>(
      this.db,
      'SELECT * FROM company_platform_profiles WHERE company_id = ? AND platform = ?',
      [companyId, platform],
    );
    return row ? mapPlatformProfile(row) : null;
  }

  listByCompany(companyId: string): PlatformProfileRecord[] {
    return all<PlatformProfileRow>(
      this.db,
      'SELECT * FROM company_platform_profiles WHERE company_id = ? ORDER BY platform ASC',
      [companyId],
    ).map(mapPlatformProfile);
  }

  listByCompanyIds(ids: string[]): PlatformProfileRecord[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    return all<PlatformProfileRow>(
      this.db,
      `SELECT * FROM company_platform_profiles WHERE company_id IN (${unique.map(() => '?').join(',')})
       ORDER BY company_id ASC, platform ASC`,
      unique,
    ).map(mapPlatformProfile);
  }

  update(id: string, patch: PlatformProfilePatch, opts: { expectedVersion?: number } = {}): PlatformProfileRecord {
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.displayName !== undefined) push('display_name', patch.displayName);
    if (patch.sourceUrl !== undefined) push('source_url', patch.sourceUrl);
    if (patch.fullName !== undefined) push('full_name', patch.fullName);
    if (patch.cityName !== undefined) push('city_name', patch.cityName);
    if (patch.address !== undefined) push('address', patch.address);
    if (patch.industry !== undefined) push('industry', patch.industry);
    if (patch.scale !== undefined) push('scale', patch.scale);
    if (patch.stage !== undefined) push('stage', patch.stage);
    if (patch.logoUrl !== undefined) push('logo_url', patch.logoUrl);
    if (patch.intro !== undefined) push('intro', patch.intro);
    if (patch.tags !== undefined) push('tags', patch.tags === null ? null : toJsonArray(patch.tags));
    if (patch.benefits !== undefined) push('benefits', patch.benefits === null ? null : toJsonArray(patch.benefits));
    if (patch.jobCount !== undefined) push('job_count', patch.jobCount);
    if (patch.bossCount !== undefined) push('boss_count', patch.bossCount);
    if (patch.recruiters !== undefined) push('recruiters', toJson(patch.recruiters));
    if (patch.store !== undefined) push('store', toJson(patch.store));
    if (patch.platformStatus !== undefined) push('platform_status', patch.platformStatus);
    if (patch.lastFetchedAt !== undefined) push('last_fetched_at', patch.lastFetchedAt);
    if (patch.lastSeenAt !== undefined) push('last_seen_at', patch.lastSeenAt);
    if (patch.nextJobsRefreshAt !== undefined) push('next_jobs_refresh_at', patch.nextJobsRefreshAt);
    if (patch.nextStoreRefreshAt !== undefined) push('next_store_refresh_at', patch.nextStoreRefreshAt);
    if (patch.rawSnapshotId !== undefined) push('raw_snapshot_id', patch.rawSnapshotId);
    if (patch.version !== undefined) push('version', patch.version);
    push('updated_at', nowIso());

    let sql = `UPDATE company_platform_profiles SET ${sets.join(', ')} WHERE id = ?`;
    params.push(id);
    if (opts.expectedVersion !== undefined) {
      sql += ' AND version = ?';
      params.push(opts.expectedVersion);
    }
    const result = run(this.db, sql, params);
    if (result.changes === 0) {
      const existing = this.getById(id);
      if (!existing) throw new LeadError('NOT_FOUND', `platform profile not found: ${id}`);
      throw new LeadError('CONFLICT', `platform profile version conflict: ${id}`, {
        details: { expectedVersion: opts.expectedVersion, currentVersion: existing.version },
      });
    }
    return this.requireById(id);
  }

  setRawSnapshotId(id: string, rawSnapshotId: number | null): PlatformProfileRecord {
    return this.update(id, { rawSnapshotId });
  }

  /** 到期招聘刷新（boss/zhilian） */
  listDueJobs(opts: { now?: Date; limit?: number } = {}): PlatformProfileRecord[] {
    const now = toIso(opts.now);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<PlatformProfileRow>(
      this.db,
      `SELECT * FROM company_platform_profiles
       WHERE platform IN ('boss','zhilian')
         AND (next_jobs_refresh_at IS NULL OR next_jobs_refresh_at <= ?)
       ORDER BY COALESCE(next_jobs_refresh_at, '') ASC, updated_at ASC LIMIT ?`,
      [now, limit],
    ).map(mapPlatformProfile);
  }

  /** 到期店铺刷新（ali/mic） */
  listDueStores(opts: { now?: Date; limit?: number } = {}): PlatformProfileRecord[] {
    const now = toIso(opts.now);
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    return all<PlatformProfileRow>(
      this.db,
      `SELECT * FROM company_platform_profiles
       WHERE platform IN ('ali','mic')
         AND (next_store_refresh_at IS NULL OR next_store_refresh_at <= ?)
       ORDER BY COALESCE(next_store_refresh_at, '') ASC, updated_at ASC LIMIT ?`,
      [now, limit],
    ).map(mapPlatformProfile);
  }

  countByPlatformStatus(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const row of all<{ platform: string; platform_status: string; n: number }>(
      this.db,
      'SELECT platform, platform_status, COUNT(*) AS n FROM company_platform_profiles GROUP BY platform, platform_status',
    )) {
      const platform = (out[row.platform] ??= {});
      platform[row.platform_status] = Number(row.n);
    }
    return out;
  }

  listByPlatformStatus(status: PlatformStatus, limit = 100): PlatformProfileRecord[] {
    return all<PlatformProfileRow>(
      this.db,
      'SELECT * FROM company_platform_profiles WHERE platform_status = ? ORDER BY updated_at ASC LIMIT ?',
      [status, limit],
    ).map(mapPlatformProfile);
  }

  countDueJobs(now: Date | string = new Date()): number {
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM company_platform_profiles
       WHERE platform IN ('boss','zhilian') AND (next_jobs_refresh_at IS NULL OR next_jobs_refresh_at <= ?)`,
      [toIso(now)],
    );
  }

  countDueStores(now: Date | string = new Date()): number {
    return countRows(
      this.db,
      `SELECT COUNT(*) FROM company_platform_profiles
       WHERE platform IN ('ali','mic') AND (next_store_refresh_at IS NULL OR next_store_refresh_at <= ?)`,
      [toIso(now)],
    );
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_platform_profiles');
  }

  private requireById(id: string): PlatformProfileRecord {
    const profile = this.getById(id);
    if (!profile) throw new LeadError('NOT_FOUND', `platform profile not found: ${id}`);
    return profile;
  }

  private requireByCompanyPlatform(companyId: string, platform: Platform): PlatformProfileRecord {
    const profile = this.getByCompanyPlatform(companyId, platform);
    if (!profile) throw new LeadError('NOT_FOUND', `platform profile not found: ${companyId}/${platform}`);
    return profile;
  }
}

/** 轻量随机 id（platform profile 无专用 ULID 前缀） */
function cryptoRandom(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i++) out += chars[Math.floor(Math.random() * 32)];
  return out;
}
