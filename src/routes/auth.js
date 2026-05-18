import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
const prisma = new PrismaClient();

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !await bcrypt.compare(password, user.password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    if (user.inviteToken) {
      return res.status(403).json({ error: 'Please set your password using the invite link first' });
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId } });
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
    const user = await prisma.user.findUnique({ where: { inviteToken: req.params.token } });
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
    const user = await prisma.user.findUnique({ where: { inviteToken: token } });
    if (!user) return res.status(404).json({ error: 'Invalid or expired invite link' });

    const hash = await bcrypt.hash(password, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { password: hash, inviteToken: null },
    });

    const jwtToken = jwt.sign(
      { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token: jwtToken, user: { id: user.id, email: user.email, name: user.name, role: user.role, bizId: user.bizId } });
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

export default router;
