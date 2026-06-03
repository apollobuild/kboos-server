import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../db.js';

const router = Router();
function getTenantSlug(req) {
  const host = req.headers.host || '';
  // kobis.kboos.digital → "kobis"
  // kboos.digital or localhost → "default"
  const parts = host.split('.');
  if (parts.length >= 3) return parts[0];
  return 'default';
}

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const slug = getTenantSlug(req);
    const tenant = await prisma.tenant.findUnique({ where: { slug } });
    const tenantId = tenant?.id || 'default';

    const user = await prisma.user.findFirst({ where: { email, tenantId } });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.inviteToken) {
      return res.status(403).json({ error: 'Please set your password using the invite link first' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const payload = { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId, tenantId };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
    const tenantConfig = tenant ? {
      country: tenant.country,
      currency: tenant.currency,
      timezone: tenant.timezone,
      mobilePrefix: tenant.mobilePrefix,
      languages: tenant.languages,
    } : { country: 'MY', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', mobilePrefix: '+60', languages: ['EN', 'MS'] };
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId, tenantId }, tenantConfig });
  } catch (e) { next(e); }
});

router.get('/me', async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token' });
    const user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    res.json(user);
  } catch { res.status(401).json({ error: 'Invalid token' }); }
});

router.get('/invite/:token', async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({ where: { inviteToken: req.params.token } });
    if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
    res.json({ name: user.name, email: user.email });
  } catch (e) { next(e); }
});

router.post('/set-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const user = await prisma.user.findFirst({ where: { inviteToken: token } });
    if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hash, inviteToken: null },
    });
    const tenant = user.tenantId ? await prisma.tenant.findUnique({ where: { id: user.tenantId } }) : null;
    const tenantConfig = tenant ? {
      country: tenant.country,
      currency: tenant.currency,
      timezone: tenant.timezone,
      mobilePrefix: tenant.mobilePrefix,
      languages: tenant.languages,
    } : { country: 'MY', currency: 'MYR', timezone: 'Asia/Kuala_Lumpur', mobilePrefix: '+60', languages: ['EN', 'MS'] };
    const payload = { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId, tenantId: user.tenantId };
    const jwtToken = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, user: { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId, tenantId: user.tenantId }, tenantConfig });
  } catch (e) { next(e); }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!await bcrypt.compare(currentPassword, user.password)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { password: hash } });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /auth/forgot-password — request a password reset link
router.post('/forgot-password', async (req, res, next) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    // Always return success to prevent email enumeration
    const user = await prisma.user.findFirst({ where: { email } });
    if (user) {
      const resetToken = crypto.randomUUID();
      await prisma.user.update({
        where: { id: user.id },
        data: { inviteToken: resetToken },
      });

      const frontendUrl = process.env.FRONTEND_URL || '';
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

      // Best-effort email send — non-fatal if SendGrid not configured
      try {
        const { sendEmail } = await import('../services/sendgrid.js');
        await sendEmail({
          to: email,
          subject: 'Reset your KBOOS password',
          body: `<p>Hello ${user.name},</p><p>Click the link below to reset your password. This link expires in 24 hours.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you did not request this, ignore this email.</p>`,
          fromName: 'KBOOS',
        });
      } catch {
        // SendGrid not configured — log the reset URL for admin
        console.log(`[Auth] Password reset URL for ${email}: ${resetUrl}`);
      }
    }

    res.json({ ok: true, message: 'If that email exists, a reset link has been sent.' });
  } catch (e) { next(e); }
});

// POST /auth/reset-password — set new password using reset token
router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password } = req.body;
    if (!token || !password || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const user = await prisma.user.findFirst({ where: { inviteToken: token } });
    if (!user) return res.status(400).json({ error: 'Invalid or expired reset link' });
    const hash = await bcrypt.hash(password, 10);
    await prisma.user.update({ where: { id: user.id }, data: { password: hash, inviteToken: null } });
    res.json({ ok: true, message: 'Password updated. You can now log in.' });
  } catch (e) { next(e); }
});

// POST /auth/invite — create a user account and send invite email (admin only)
router.post('/invite', requireAuth, async (req, res, next) => {
  try {
    if (!['admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Admin only' });
    }
    const { email, name, role = 'operator', bizId } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const tid = req.user.tenantId;
    const existing = await prisma.user.findFirst({ where: { email, tenantId: tid } });
    if (existing) return res.status(409).json({ error: 'A user with that email already exists' });

    const inviteToken = crypto.randomUUID();
    const placeholder = await bcrypt.hash(crypto.randomUUID(), 10);
    const user = await prisma.user.create({
      data: {
        email,
        name: name || email.split('@')[0],
        password: placeholder,
        role,
        tenantId: tid,
        bizId: bizId || null,
        inviteToken,
      },
    });

    const frontendUrl = process.env.FRONTEND_URL || '';
    const inviteUrl = `${frontendUrl}/set-password?token=${inviteToken}`;

    try {
      const { sendEmail } = await import('../services/sendgrid.js');
      await sendEmail({
        to: email,
        subject: `You've been invited to KBOOS`,
        body: `<p>Hello ${user.name},</p><p>You have been invited to access KBOOS. Click the link below to set your password.</p><p><a href="${inviteUrl}">${inviteUrl}</a></p>`,
        fromName: 'KBOOS',
      });
    } catch {
      console.log(`[Auth] Invite URL for ${email}: ${inviteUrl}`);
    }

    res.json({ ok: true, inviteUrl, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (e) { next(e); }
});

export default router;
