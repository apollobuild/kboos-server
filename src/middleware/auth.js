import jwt from 'jsonwebtoken';
import prisma from '../db.js';
// Throttle: only write to DB once per 30s per user to avoid hammering on every request
const lastActiveThrottle = new Map();

export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    // Tokens issued before multi-tenancy have no tenantId claim — default them
    if (!req.user.tenantId) req.user.tenantId = 'default';
    // Fire-and-forget: update lastActiveAt at most once every 30 seconds per user
    const uid = req.user.id;
    const now = Date.now();
    if (!lastActiveThrottle.has(uid) || now - lastActiveThrottle.get(uid) > 30_000) {
      lastActiveThrottle.set(uid, now);
      prisma.user.update({ where: { id: uid }, data: { lastActiveAt: new Date() } }).catch(() => {});
    }
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

export function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'Super admin only' });
    next();
  });
}
