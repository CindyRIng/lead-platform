/** leads / lead_company_matches 仓库（v2 线索层） */
import { all, one, run, toJson, type DbConnection } from './sql.js';
import { nowIso } from '../shared/time.js';

export interface LeadRecord {
  id: string;
  platform: string;
  platformCompanyId: string;
  sourceName: string | null;
  normalizedName: string | null;
  englishName: string | null;
  cityName: string | null;
  province: string | null;
  sourceUrl: string | null;
  evidence: Record<string, unknown>;
  status: string;
  companyId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  archived: boolean;
}

export interface LeadMatchCompany {
  leadId: string;
  companyId: string;
  name: string;
  englishName: string | null;
  uscc: string | null;
  method: string | null;
  confidence: number | null;
  candidateRank: number | null;
  isPrimary: boolean;
  matchedAt: string;
}

interface LeadRow {
  id: string;
  platform: string;
  platform_company_id: string;
  source_name: string | null;
  normalized_name: string | null;
  english_name: string | null;
  city_name: string | null;
  province: string | null;
  source_url: string | null;
  evidence: string | null;
  status: string;
  company_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  archived: number;
}

function mapLead(r: LeadRow): LeadRecord {
  return {
    id: r.id,
    platform: r.platform,
    platformCompanyId: r.platform_company_id,
    sourceName: r.source_name,
    normalizedName: r.normalized_name,
    englishName: r.english_name,
    cityName: r.city_name,
    province: r.province,
    sourceUrl: r.source_url,
    evidence: safeJson(r.evidence),
    status: r.status,
    companyId: r.company_id,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    archived: Number(r.archived) === 1,
  };
}
function safeJson(text: string | null): Record<string, unknown> {
  try { return text ? (JSON.parse(text) as Record<string, unknown>) : {}; } catch { return {}; }
}

export interface LinkMatchInput {
  leadId: string;
  companyId: string;
  method?: string | null;
  confidence?: number | null;
  candidateRank?: number | null;
  isPrimary?: boolean;
  matchedAt?: string;
  raw?: unknown;
}

export class LeadsRepository {
  constructor(private readonly db: DbConnection) {}

  /** 确保 company 的 company_sources 都有对应 lead，并同步 company_id（合并迁移后） */
  ensureForCompany(companyId: string): LeadRecord[] {
    run(
      this.db,
      `INSERT OR IGNORE INTO leads(id, platform, platform_company_id, source_name, normalized_name, city_name, source_url, evidence, status, company_id, first_seen_at, last_seen_at, created_at, updated_at)
       SELECT 'lead_' || lower(hex(randomblob(10))), cs.platform, cs.platform_company_id, cs.source_name, cs.source_name, cs.city_name, cs.source_url, cs.evidence,
              CASE WHEN c.verified = 1 THEN 'matched' ELSE 'pending' END, cs.company_id, cs.first_seen_at, cs.last_seen_at,
              datetime('now'), datetime('now')
         FROM company_sources cs JOIN companies c ON c.id = cs.company_id
        WHERE cs.company_id = ?`,
      [companyId],
    );
    run(
      this.db,
      `UPDATE leads SET company_id = ?
        WHERE EXISTS (
          SELECT 1 FROM company_sources cs
           WHERE cs.company_id = ? AND cs.platform = leads.platform AND cs.platform_company_id = leads.platform_company_id
        )`,
      [companyId, companyId],
    );
    return this.listByCompany(companyId);
  }

  listByCompany(companyId: string): LeadRecord[] {
    return all<LeadRow>(this.db, 'SELECT * FROM leads WHERE company_id = ? ORDER BY first_seen_at ASC', [companyId]).map(mapLead);
  }

  findByPlatformId(platform: string, platformCompanyId: string): LeadRecord | null {
    const row = one<LeadRow>(this.db, 'SELECT * FROM leads WHERE platform = ? AND platform_company_id = ?', [platform, platformCompanyId]);
    return row ? mapLead(row) : null;
  }

  setStatus(leadId: string, status: string): void {
    run(this.db, 'UPDATE leads SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), leadId]);
  }

  linkMatch(input: LinkMatchInput): void {
    run(
      this.db,
      `INSERT INTO lead_company_matches(lead_id, company_id, method, confidence, candidate_rank, is_primary, matched_at, raw)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(lead_id, company_id) DO UPDATE SET
         method = COALESCE(excluded.method, lead_company_matches.method),
         confidence = COALESCE(MAX(excluded.confidence, lead_company_matches.confidence), excluded.confidence),
         candidate_rank = MIN(COALESCE(excluded.candidate_rank, lead_company_matches.candidate_rank), COALESCE(lead_company_matches.candidate_rank, excluded.candidate_rank)),
         is_primary = MAX(excluded.is_primary, lead_company_matches.is_primary)`,
      [
        input.leadId,
        input.companyId,
        input.method ?? null,
        input.confidence ?? null,
        input.candidateRank ?? null,
        input.isPrimary ? 1 : 0,
        input.matchedAt ?? nowIso(),
        input.raw === undefined ? null : toJson(input.raw),
      ],
    );
  }

  listMatchesByLead(leadId: string): LeadMatchCompany[] {
    return all<Record<string, unknown>>(
      this.db,
      `SELECT m.lead_id, m.company_id, m.method, m.confidence, m.candidate_rank, m.is_primary, m.matched_at,
              c.name, c.english_name, c.uscc
         FROM lead_company_matches m JOIN companies c ON c.id = m.company_id
        WHERE m.lead_id = ?
        ORDER BY m.is_primary DESC, COALESCE(m.confidence, 0) DESC`,
      [leadId],
    ).map((r) => ({
      leadId: String(r.lead_id),
      companyId: String(r.company_id),
      name: String(r.name ?? ''),
      englishName: (r.english_name as string | null) ?? null,
      uscc: (r.uscc as string | null) ?? null,
      method: (r.method as string | null) ?? null,
      confidence: r.confidence == null ? null : Number(r.confidence),
      candidateRank: r.candidate_rank == null ? null : Number(r.candidate_rank),
      isPrimary: Number(r.is_primary) === 1,
      matchedAt: String(r.matched_at ?? ''),
    }));
  }

  listMatchesByLeadIds(leadIds: string[]): Map<string, LeadMatchCompany[]> {
    const map = new Map<string, LeadMatchCompany[]>();
    if (leadIds.length === 0) return map;
    const placeholders = leadIds.map(() => '?').join(',');
    const rows = all<Record<string, unknown>>(
      this.db,
      `SELECT m.lead_id, m.company_id, m.method, m.confidence, m.candidate_rank, m.is_primary, m.matched_at,
              c.name, c.english_name, c.uscc
         FROM lead_company_matches m JOIN companies c ON c.id = m.company_id
        WHERE m.lead_id IN (${placeholders})
        ORDER BY m.is_primary DESC, COALESCE(m.confidence, 0) DESC`,
      leadIds,
    );
    for (const r of rows) {
      const leadId = String(r.lead_id);
      const list = map.get(leadId) ?? [];
      list.push({
        leadId, companyId: String(r.company_id), name: String(r.name ?? ''),
        englishName: (r.english_name as string | null) ?? null, uscc: (r.uscc as string | null) ?? null,
        method: (r.method as string | null) ?? null,
        confidence: r.confidence == null ? null : Number(r.confidence),
        candidateRank: r.candidate_rank == null ? null : Number(r.candidate_rank),
        isPrimary: Number(r.is_primary) === 1,
        matchedAt: String(r.matched_at ?? ''),
      });
      map.set(leadId, list);
    }
    return map;
  }

  addAlias(companyId: string, alias: string | null | undefined, language: 'en' | 'zh' | null, source: string): void {
    const value = String(alias ?? '').trim();
    if (!value) return;
    const normalized = value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    if (!normalized) return;
    run(
      this.db,
      `INSERT OR IGNORE INTO company_aliases(id, company_id, alias, normalized_alias, language, source, first_seen_at)
       VALUES ('alias_' || lower(hex(randomblob(10))), ?, ?, ?, ?, ?, ?)`,
      [companyId, value, normalized, language, source, nowIso()],
    );
  }

  countMatches(): number {
    const row = one<{ n: number }>(this.db, 'SELECT COUNT(*) AS n FROM lead_company_matches');
    return Number(row?.n ?? 0);
  }
}
