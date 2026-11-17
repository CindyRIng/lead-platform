/** 线索层 API（v2 语义）：GET /v1/leads */
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { ok, type Paginated } from '../../shared/envelope.js';
import { newRequestId } from '../../shared/ids.js';
import { getDb } from '../../db/index.js';
import { safeJsonParse } from '../../shared/json.js';

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
  company_verified: number | null;
  company_name: string | null;
  company_enrichment: string | null;
}

function mapLead(r: LeadRow) {
  return {
    id: r.id,
    platform: r.platform,
    platformCompanyId: r.platform_company_id,
    sourceName: r.source_name,
    englishName: r.english_name,
    cityName: r.city_name,
    province: r.province,
    sourceUrl: r.source_url,
    status: r.status,
    companyId: r.company_verified === 1 ? r.company_id : null,
    draftCompanyId: r.company_verified === 1 ? null : r.company_id,
    companyName: r.company_verified === 1 ? r.company_name : null,
    enrichmentStatus: r.company_enrichment,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    archived: Number(r.archived) === 1,
    evidence: safeJsonParse<Record<string, unknown>>(r.evidence, {}),
  };
}

export function registerLeadRoutes(app: FastifyInstance): void {
  app.get('/v1/leads', async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req as unknown as { leadRequestId?: string }).leadRequestId ?? newRequestId();
    const q = req.query as Record<string, unknown>;
    const where: string[] = ['1=1'];
    const params: unknown[] = [];
    if (q.platform) { where.push('l.platform = ?'); params.push(String(q.platform)); }
    if (q.status) { where.push('l.status = ?'); params.push(String(q.status)); }
    if (q.city) { where.push('l.city_name = ?'); params.push(String(q.city)); }
    if (q.q) { where.push("(l.source_name LIKE ? OR COALESCE(l.english_name,'') LIKE ?)"); const like = `%${String(q.q)}%`; params.push(like, like); }
    const limit = Math.max(1, Math.min(Number(q.limit ?? 50), 200));
    const offset = Math.max(0, Number(q.offset ?? 0));
    const db = getDb();
    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM leads l WHERE ${where.join(' AND ')}`).get(...(params as never[])) as { n?: number } | undefined;
    const rows = db
      .prepare(
        `SELECT l.*, c.verified AS company_verified, c.name AS company_name, c.enrichment_status AS company_enrichment
           FROM leads l LEFT JOIN companies c ON c.id = l.company_id
          WHERE ${where.join(' AND ')}
          ORDER BY l.last_seen_at DESC, l.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...(params as never[]), limit + 1, offset) as unknown as LeadRow[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map(mapLead);
    const data: Paginated<ReturnType<typeof mapLead>> & { total: number } = { items, nextCursor: hasMore ? String(offset + limit) : null, hasMore, total: Number(totalRow?.n ?? 0) };
    return reply.send(ok(data, id));
  });
}
