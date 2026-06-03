import { Router } from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../db.js';

const router = Router();

// Guard: production-only, debug key required
function debugGuard(req, res, next) {
  if (process.env.NODE_ENV !== 'production') {
    return res.status(404).json({ error: 'Not found' });
  }
  const key = req.headers['x-debug-key'];
  const expected = process.env.DEBUG_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'Debug key not configured on server' });
  }
  if (!key || key !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Derive tenant slug from Host header — mirrors auth.js getTenantSlug exactly
function getTenantSlug(host) {
  const parts = (host || '').split('.');
  if (parts.length >= 3) return parts[0];
  return 'default';
}

router.get('/production-state', debugGuard, async (req, res) => {
  const report = {
    generated_at: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    sections: {},
  };

  // ── 1. Database identity ──────────────────────────────────────────────────
  try {
    const rows = await prisma.$queryRaw`
      SELECT
        current_database()   AS db_name,
        inet_server_addr()   AS db_host,
        inet_server_port()   AS db_port,
        current_user         AS db_user,
        version()            AS pg_version
    `;
    report.sections.database_identity = {
      status: 'connected',
      db_name:    rows[0].db_name,
      db_host:    rows[0].db_host,
      db_port:    Number(rows[0].db_port),
      db_user:    rows[0].db_user,
      pg_version: rows[0].pg_version.split(' ').slice(0, 2).join(' '), // "PostgreSQL 16.x"
    };
  } catch (e) {
    report.sections.database_identity = { status: 'error', error: e.message };
  }

  // ── 2. Tenant table snapshot ──────────────────────────────────────────────
  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, slug: true, name: true, active: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    report.sections.tenants = {
      count: tenants.length,
      rows: tenants,
      has_default_id:   tenants.some(t => t.id === 'default'),
      has_default_slug: tenants.some(t => t.slug === 'default'),
    };
  } catch (e) {
    report.sections.tenants = { status: 'error', error: e.message };
  }

  // ── 3. Data distribution by tenantId ─────────────────────────────────────
  try {
    const [userDist, bizDist, leadDist, campDist] = await Promise.all([
      prisma.$queryRaw`SELECT "tenantId", COUNT(*)::int AS count FROM "User"     GROUP BY "tenantId" ORDER BY count DESC`,
      prisma.$queryRaw`SELECT "tenantId", COUNT(*)::int AS count FROM "Business" GROUP BY "tenantId" ORDER BY count DESC`,
      prisma.$queryRaw`SELECT "tenantId", COUNT(*)::int AS count FROM "Lead"     GROUP BY "tenantId" ORDER BY count DESC`,
      prisma.$queryRaw`SELECT "tenantId", COUNT(*)::int AS count FROM "Campaign" GROUP BY "tenantId" ORDER BY count DESC`,
    ]);
    report.sections.data_distribution = {
      User:     userDist,
      Business: bizDist,
      Lead:     leadDist,
      Campaign: campDist,
    };
  } catch (e) {
    report.sections.data_distribution = { status: 'error', error: e.message };
  }

  // ── 4. Runtime auth sample ────────────────────────────────────────────────
  const authSection = {};

  // 4a. Incoming Authorization header — decode WITHOUT verifying (no secret exposed)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const rawToken = authHeader.slice(7);
    try {
      // Decode only (no verify) — shows payload without using or exposing JWT_SECRET
      const decoded = jwt.decode(rawToken);
      authSection.provided_jwt_payload = decoded;
      authSection.provided_jwt_tenantId = decoded?.tenantId ?? null;
    } catch {
      authSection.provided_jwt_payload = 'decode_failed';
    }
  } else {
    authSection.provided_jwt_payload = 'no_authorization_header';
  }

  // 4b. tenantId resolution — step by step, mirrors auth.js login exactly
  const host = req.headers.host || '';
  const slug = getTenantSlug(host);
  let resolvedTenant = null;
  let tenantLookupError = null;
  try {
    resolvedTenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, name: true },
    });
  } catch (e) {
    tenantLookupError = e.message;
  }
  const resolvedTenantId = resolvedTenant?.id ?? 'default';

  authSection.tenantId_resolution = {
    step1_host_header:         host,
    step2_host_parts:          host.split('.'),
    step3_parts_length:        host.split('.').length,
    step4_condition_gte_3:     host.split('.').length >= 3,
    step5_slug_returned:       slug,
    step6_tenant_db_lookup:    resolvedTenant ?? (tenantLookupError ? { error: tenantLookupError } : null),
    step7_tenantId_resolved:   resolvedTenantId,
    step8_note:                resolvedTenant
      ? 'Tenant found by slug — JWT will carry tenant.id (not the string "default")'
      : 'No tenant found for slug — JWT will carry the fallback string "default"',
  };

  // 4c. req.user — set by requireAuth middleware; show what it would contain
  // This endpoint is NOT behind requireAuth, so we derive it manually from the header
  authSection.req_user_would_be = authSection.provided_jwt_payload !== 'no_authorization_header'
    ? authSection.provided_jwt_payload
    : 'No Authorization header — req.user would be undefined (401 on protected routes)';

  report.sections.auth_sample = authSection;

  // ── 5. Request trace — example /leads query ───────────────────────────────
  try {
    // Show what WHERE clause /leads would use with this request's tenantId
    const exampleTid = authSection.provided_jwt_payload?.tenantId ?? resolvedTenantId;
    const whereClause = { tenantId: exampleTid };

    const [sampleLeads, leadCount] = await Promise.all([
      prisma.lead.findMany({
        where: whereClause,
        select: { id: true, tenantId: true, name: true, status: true },
        take: 5,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.lead.count({ where: whereClause }),
    ]);

    report.sections.leads_query_trace = {
      tenantId_used_as_filter:  exampleTid,
      where_clause:             JSON.stringify(whereClause),
      prisma_call:              `prisma.lead.findMany({ where: { tenantId: "${exampleTid}" }, take: 5 })`,
      equivalent_sql:           `SELECT * FROM "Lead" WHERE "tenantId" = '${exampleTid}' ORDER BY "createdAt" DESC LIMIT 5`,
      total_matching_leads:     leadCount,
      sample_results:           sampleLeads,
    };
  } catch (e) {
    report.sections.leads_query_trace = { status: 'error', error: e.message };
  }

  res.json(report);
});

export default router;
