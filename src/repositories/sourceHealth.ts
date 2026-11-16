/** source_health 表（五源 + fuma 的健康/登录态） */
import { nowIso } from '../shared/time.js';
import { all, fromDbBool, fromDbIntRequired, fromJsonObject, one, run, toJson, type DbConnection } from './sql.js';
import type { NewSourceHealth, SourceHealthRecord } from './types.js';
import type { AllPlatform, SourceHealthState } from '../shared/domain.js';

interface SourceHealthRow {
  platform: string;
  state: string;
  logged_in: number | null;
  expires_at: string | null;
  checked_at: string;
  consecutive_failures: number;
  detail: string | null;
}

function mapHealth(row: SourceHealthRow): SourceHealthRecord {
  return {
    platform: row.platform as AllPlatform,
    state: row.state as SourceHealthState,
    loggedIn: fromDbBool(row.logged_in),
    expiresAt: row.expires_at,
    checkedAt: row.checked_at,
    consecutiveFailures: fromDbIntRequired(row.consecutive_failures),
    detail: fromJsonObject(row.detail),
  };
}

export class SourceHealthRepository {
  constructor(private readonly db: DbConnection) {}

  upsert(input: NewSourceHealth): SourceHealthRecord {
    run(
      this.db,
      `INSERT INTO source_health(platform, state, logged_in, expires_at, checked_at, consecutive_failures, detail)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(platform) DO UPDATE SET
         state = excluded.state,
         logged_in = excluded.logged_in,
         expires_at = excluded.expires_at,
         checked_at = excluded.checked_at,
         consecutive_failures = excluded.consecutive_failures,
         detail = excluded.detail`,
      [
        input.platform,
        input.state,
        input.loggedIn === undefined ? null : input.loggedIn === null ? null : input.loggedIn ? 1 : 0,
        input.expiresAt ?? null,
        input.checkedAt ?? nowIso(),
        input.consecutiveFailures ?? 0,
        toJson(input.detail ?? null),
      ],
    );
    return this.requireByPlatform(input.platform);
  }

  /** 兼容命名：整体记录一条健康快照 */
  record(input: NewSourceHealth): SourceHealthRecord {
    return this.upsert(input);
  }

  get(platform: AllPlatform): SourceHealthRecord | null {
    const row = one<SourceHealthRow>(this.db, 'SELECT * FROM source_health WHERE platform = ?', [platform]);
    return row ? mapHealth(row) : null;
  }

  getByPlatform(platform: AllPlatform): SourceHealthRecord | null {
    return this.get(platform);
  }

  listAll(): SourceHealthRecord[] {
    return all<SourceHealthRow>(this.db, 'SELECT * FROM source_health ORDER BY platform ASC').map(mapHealth);
  }

  getAll(): SourceHealthRecord[] {
    return this.listAll();
  }

  /** 记录一次失败（consecutive_failures+1）；不存在则新建 */
  markFailure(
    platform: AllPlatform,
    state: SourceHealthState,
    detail?: Record<string, unknown> | null,
    checkedAt: string = nowIso(),
  ): SourceHealthRecord {
    return this.db.transaction(() => {
      const current = this.get(platform);
      return this.upsert({
        platform,
        state,
        loggedIn: current?.loggedIn ?? null,
        expiresAt: current?.expiresAt ?? null,
        checkedAt,
        consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
        detail: detail ?? current?.detail ?? null,
      });
    });
  }

  /** 记录健康（失败计数清零） */
  markOk(
    platform: AllPlatform,
    extra: { loggedIn?: boolean | null; expiresAt?: string | null; detail?: Record<string, unknown> | null } = {},
    checkedAt: string = nowIso(),
  ): SourceHealthRecord {
    return this.upsert({
      platform,
      state: 'ok',
      loggedIn: extra.loggedIn ?? null,
      expiresAt: extra.expiresAt ?? null,
      checkedAt,
      consecutiveFailures: 0,
      detail: extra.detail ?? null,
    });
  }

  /** 状态映射（/v1/status.upstream）：未观测到的平台返回 unknown 占位由路由层补 */
  stateMap(): Partial<Record<AllPlatform, { state: SourceHealthState; loggedIn: boolean | null; checkedAt: string }>> {
    const out: Partial<Record<AllPlatform, { state: SourceHealthState; loggedIn: boolean | null; checkedAt: string }>> = {};
    for (const row of this.listAll()) {
      out[row.platform] = { state: row.state, loggedIn: row.loggedIn, checkedAt: row.checkedAt };
    }
    return out;
  }

  private requireByPlatform(platform: AllPlatform): SourceHealthRecord {
    const health = this.get(platform);
    if (!health) throw new Error(`source health not found: ${platform}`);
    return health;
  }
}
