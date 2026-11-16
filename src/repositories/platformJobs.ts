/** company_platform_jobs 表（Boss/智联岗位 + 生命周期 active/closed） */
import { LeadError } from '../shared/errors.js';
import { nowIso } from '../shared/time.js';
import {
  all,
  countRows,
  fromDbInt,
  one,
  run,
  toJson,
  fromJsonUnknown,
  type DbConnection,
} from './sql.js';
import type {
  NewPlatformJob,
  PlatformJobRecord,
  PlatformJobUpsertResult,
} from './types.js';
import type { Platform } from '../shared/domain.js';

interface PlatformJobRow {
  id: string;
  company_id: string;
  platform: string;
  platform_company_id: string;
  job_id: string;
  title: string;
  salary_text: string | null;
  salary_min: number | null;
  salary_max: number | null;
  city_name: string | null;
  district: string | null;
  degree: string | null;
  experience: string | null;
  publish_time: string | null;
  recruiter_name: string | null;
  recruiter_title: string | null;
  job_url: string | null;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
  closed_at: string | null;
  raw: string | null;
  created_at: string;
  updated_at: string;
}

export function mapPlatformJob(row: PlatformJobRow): PlatformJobRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    platform: row.platform as PlatformJobRecord['platform'],
    platformCompanyId: row.platform_company_id,
    jobId: row.job_id,
    title: row.title,
    salaryText: row.salary_text,
    salaryMin: row.salary_min,
    salaryMax: row.salary_max,
    cityName: row.city_name,
    district: row.district,
    degree: row.degree,
    experience: row.experience,
    publishTime: row.publish_time,
    recruiterName: row.recruiter_name,
    recruiterTitle: row.recruiter_title,
    jobUrl: row.job_url,
    status: row.status as 'active' | 'closed',
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    closedAt: row.closed_at,
    raw: fromJsonUnknown(row.raw, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class PlatformJobsRepository {
  constructor(private readonly db: DbConnection) {}

  /**
   * 岗位 upsert：唯一 (platform, platform_company_id, job_id)
   * - 新建：status='active'、first_seen_at=now
   * - 已存在：保留 first_seen_at，更新字段与 last_seen_at；closed → 重新上线则 active 并清 closed_at
   */
  upsertJob(input: NewPlatformJob): PlatformJobUpsertResult {
    return this.db.transaction(() => {
      const previous = this.getByPlatformJobId(input.platform, input.platformCompanyId, input.jobId);
      const now = nowIso();
      if (!previous) {
        const id = input.id ?? `pjb_${cryptoRandom()}`;
        run(
          this.db,
          `INSERT INTO company_platform_jobs(
            id, company_id, platform, platform_company_id, job_id, title, salary_text, salary_min,
            salary_max, city_name, district, degree, experience, publish_time, recruiter_name,
            recruiter_title, job_url, status, first_seen_at, last_seen_at, closed_at, raw,
            created_at, updated_at
          ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            input.companyId,
            input.platform,
            input.platformCompanyId,
            input.jobId,
            input.title,
            input.salaryText ?? null,
            input.salaryMin ?? null,
            input.salaryMax ?? null,
            input.cityName ?? null,
            input.district ?? null,
            input.degree ?? null,
            input.experience ?? null,
            input.publishTime ?? null,
            input.recruiterName ?? null,
            input.recruiterTitle ?? null,
            input.jobUrl ?? null,
            input.status ?? 'active',
            input.firstSeenAt ?? now,
            input.lastSeenAt ?? now,
            input.closedAt ?? null,
            toJson(input.raw ?? null),
            now,
            now,
          ],
        );
        const job = this.requireById(id);
        return { job, previous: null, created: true };
      }

      const reactivate = previous.status === 'closed' && (input.status ?? 'active') !== 'closed';
      const nextStatus = input.status ?? (reactivate ? 'active' : previous.status);
      run(
        this.db,
        `UPDATE company_platform_jobs SET
           company_id = ?, title = ?, salary_text = ?, salary_min = ?, salary_max = ?, city_name = ?,
           district = ?, degree = ?, experience = ?, publish_time = ?, recruiter_name = ?,
           recruiter_title = ?, job_url = ?, status = ?, last_seen_at = ?, closed_at = ?, raw = ?,
           updated_at = ?
         WHERE id = ?`,
        [
          input.companyId ?? previous.companyId,
          input.title ?? previous.title,
          input.salaryText !== undefined ? input.salaryText : previous.salaryText,
          input.salaryMin !== undefined ? input.salaryMin : previous.salaryMin,
          input.salaryMax !== undefined ? input.salaryMax : previous.salaryMax,
          input.cityName !== undefined ? input.cityName : previous.cityName,
          input.district !== undefined ? input.district : previous.district,
          input.degree !== undefined ? input.degree : previous.degree,
          input.experience !== undefined ? input.experience : previous.experience,
          input.publishTime !== undefined ? input.publishTime : previous.publishTime,
          input.recruiterName !== undefined ? input.recruiterName : previous.recruiterName,
          input.recruiterTitle !== undefined ? input.recruiterTitle : previous.recruiterTitle,
          input.jobUrl !== undefined ? input.jobUrl : previous.jobUrl,
          nextStatus,
          input.lastSeenAt ?? now,
          nextStatus === 'active' ? null : previous.closedAt,
          toJson(input.raw !== undefined ? input.raw : previous.raw),
          now,
          previous.id,
        ],
      );
      return { job: this.requireById(previous.id), previous, created: false };
    });
  }

  /** 批量 upsert（同事务；岗位列表刷新） */
  upsertJobs(inputs: NewPlatformJob[]): PlatformJobUpsertResult[] {
    if (inputs.length === 0) return [];
    return this.db.transaction(() => inputs.map((input) => this.upsertJob(input)));
  }

  getById(id: string): PlatformJobRecord | null {
    const row = one<PlatformJobRow>(this.db, 'SELECT * FROM company_platform_jobs WHERE id = ?', [id]);
    return row ? mapPlatformJob(row) : null;
  }

  getByPlatformJobId(
    platform: PlatformJobRecord['platform'],
    platformCompanyId: string,
    jobId: string,
  ): PlatformJobRecord | null {
    const row = one<PlatformJobRow>(
      this.db,
      `SELECT * FROM company_platform_jobs
       WHERE platform = ? AND platform_company_id = ? AND job_id = ?`,
      [platform, platformCompanyId, jobId],
    );
    return row ? mapPlatformJob(row) : null;
  }

  listByCompanyPlatform(
    companyId: string,
    platform: PlatformJobRecord['platform'],
    opts: { status?: 'active' | 'closed' } = {},
  ): PlatformJobRecord[] {
    const where: string[] = ['company_id = ?', 'platform = ?'];
    const params: unknown[] = [companyId, platform];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    return all<PlatformJobRow>(
      this.db,
      `SELECT * FROM company_platform_jobs WHERE ${where.join(' AND ')}
       ORDER BY last_seen_at DESC, job_id ASC`,
      params,
    ).map(mapPlatformJob);
  }

  listByCompany(companyId: string): PlatformJobRecord[] {
    return all<PlatformJobRow>(
      this.db,
      'SELECT * FROM company_platform_jobs WHERE company_id = ? ORDER BY platform ASC, last_seen_at DESC',
      [companyId],
    ).map(mapPlatformJob);
  }

  listActiveByCompanyPlatform(
    companyId: string,
    platform: PlatformJobRecord['platform'],
  ): PlatformJobRecord[] {
    return this.listByCompanyPlatform(companyId, platform, { status: 'active' });
  }

  /**
   * 关闭岗位：该 company × platform 下仍 active 但本次未出现的岗位 → closed。
   * seenJobIds 为空表示该平台当前无岗位（全部关闭）。
   */
  closeMissing(
    companyId: string,
    platform: PlatformJobRecord['platform'],
    seenJobIds: string[],
    now: string = nowIso(),
  ): PlatformJobRecord[] {
    return this.db.transaction(() => {
      const active = this.listActiveByCompanyPlatform(companyId, platform);
      const seen = new Set(seenJobIds);
      const toClose = active.filter((job) => !seen.has(job.jobId));
      for (const job of toClose) {
        run(
          this.db,
          "UPDATE company_platform_jobs SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?",
          [now, now, job.id],
        );
      }
      return toClose
        .map((job) => this.getById(job.id))
        .filter((job): job is PlatformJobRecord => job !== null);
    });
  }

  markClosed(id: string, at: string = nowIso()): PlatformJobRecord | null {
    const result = run(
      this.db,
      "UPDATE company_platform_jobs SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?",
      [at, nowIso(), id],
    );
    return result.changes > 0 ? this.getById(id) : null;
  }

  reactivate(id: string): PlatformJobRecord | null {
    const result = run(
      this.db,
      "UPDATE company_platform_jobs SET status = 'active', closed_at = NULL, last_seen_at = ?, updated_at = ? WHERE id = ?",
      [nowIso(), nowIso(), id],
    );
    return result.changes > 0 ? this.getById(id) : null;
  }

  countActiveByCompanyPlatform(companyId: string, platform: PlatformJobRecord['platform']): number {
    return countRows(
      this.db,
      "SELECT COUNT(*) FROM company_platform_jobs WHERE company_id = ? AND platform = ? AND status = 'active'",
      [companyId, platform],
    );
  }

  /** 批量 active 岗位数（解锁优先级 P0 判定用） */
  countActiveByCompanyIds(ids: string[]): Map<string, number> {
    const map = new Map<string, number>();
    if (ids.length === 0) return map;
    const unique = [...new Set(ids)];
    for (const row of all<{ company_id: string; n: number }>(
      this.db,
      `SELECT company_id, COUNT(*) AS n FROM company_platform_jobs
       WHERE status = 'active' AND company_id IN (${unique.map(() => '?').join(',')})
       GROUP BY company_id`,
      unique,
    )) {
      map.set(row.company_id, Number(row.n));
    }
    return map;
  }

  countByStatus(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const row of all<{ status: string; n: number }>(
      this.db,
      'SELECT status, COUNT(*) AS n FROM company_platform_jobs GROUP BY status',
    )) {
      out[row.status] = Number(row.n);
    }
    return out;
  }

  count(): number {
    return countRows(this.db, 'SELECT COUNT(*) FROM company_platform_jobs');
  }

  private requireById(id: string): PlatformJobRecord {
    const job = this.getById(id);
    if (!job) throw new LeadError('NOT_FOUND', `platform job not found: ${id}`);
    return job;
  }
}

function cryptoRandom(): string {
  const chars = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let out = '';
  for (let i = 0; i < 26; i++) out += chars[Math.floor(Math.random() * 32)];
  return out;
}
