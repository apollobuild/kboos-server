import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireSuperAdmin } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
// List all tenants
router.get('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const tenants = await prisma.tenant.findMany({ orderBy: { createdAt: 'asc' } });
    const counts = await Promise.all(tenants.map(async t => ({
      id: t.id,
      users: await prisma.user.count({ where: { tenantId: t.id } }),
      businesses: await prisma.business.count({ where: { tenantId: t.id } }),
    })));
    const countMap = Object.fromEntries(counts.map(c => [c.id, c]));
    res.json(tenants.map(t => ({ ...t, ...countMap[t.id] })));
  } catch (e) { next(e); }
});

// Get single tenant
router.get('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const t = await prisma.tenant.findUnique({ where: { id: req.params.id } });
    if (!t) return res.status(404).json({ error: 'Tenant not found' });
    res.json(t);
  } catch (e) { next(e); }
});

// Create new tenant + seed admin user + settings + wallet
router.post('/', requireSuperAdmin, async (req, res, next) => {
  try {
    const { name, slug, plan = 'agency', country = 'MY', currency = 'MYR', timezone = 'UTC',
            mobilePrefix = '+60', adminEmail, adminName, adminPassword } = req.body;

    if (!name || !slug || !adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'name, slug, adminEmail, adminPassword are required' });
    }
    if (adminPassword.length < 8) {
      return res.status(400).json({ error: 'Admin password must be at least 8 characters' });
    }

    const existing = await prisma.tenant.findUnique({ where: { slug } });
    if (existing) return res.status(409).json({ error: 'Slug already taken' });

    const tenant = await prisma.tenant.create({
      data: { name, slug, plan, country, currency, timezone, mobilePrefix },
    });

    const hash = await bcrypt.hash(adminPassword, 10);
    await prisma.user.create({
      data: {
        email: adminEmail,
        password: hash,
        name: adminName || adminEmail.split('@')[0],
        role: 'admin',
        tenantId: tenant.id,
      },
    });

    // Seed per-tenant settings and wallet
    await prisma.appSettings.create({ data: { id: `settings_${tenant.id}`, tenantId: tenant.id } });
    await prisma.wallet.create({ data: { id: `wallet_${tenant.id}`, tenantId: tenant.id } });

    res.json({ ok: true, tenant });
  } catch (e) { next(e); }
});

// Update tenant
router.patch('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    const allowed = ['name', 'plan', 'active', 'country', 'currency', 'timezone', 'mobilePrefix', 'languages', 'settings'];
    const data = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
    const t = await prisma.tenant.update({ where: { id: req.params.id }, data });
    res.json(t);
  } catch (e) { next(e); }
});

// Delete tenant (hard delete — use with care)
router.delete('/:id', requireSuperAdmin, async (req, res, next) => {
  try {
    if (req.params.id === 'default') return res.status(400).json({ error: 'Cannot delete default tenant' });
    await prisma.tenant.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
