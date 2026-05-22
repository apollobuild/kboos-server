import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { requireAuth } from '../middleware/auth.js';
import { generateSequence, regenerateTouchpoint } from '../services/claude.js';

const router = Router();
const prisma = new PrismaClient();

// GET /sequences/:bizId — get sequence (or empty scaffold)
router.get('/:bizId', requireAuth, async (req, res, next) => {
  try {
    const biz = await prisma.business.findUnique({ where: { id: req.params.bizId } });
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const seq = await prisma.businessSequence.findUnique({ where: { bizId: req.params.bizId } });
    res.json(seq || { bizId: req.params.bizId, status: 'empty', brief: {}, persona: {}, touchpoints: [], objections: [] });
  } catch (e) { next(e); }
});

// POST /sequences/:bizId/generate — generate full sequence with Claude Sonnet
router.post('/:bizId/generate', requireAuth, async (req, res, next) => {
  try {
    const biz = await prisma.business.findUnique({ where: { id: req.params.bizId } });
    if (!biz) return res.status(404).json({ error: 'Business not found' });

    const seq = await prisma.businessSequence.findUnique({ where: { bizId: req.params.bizId } });
    const brief = req.body.brief || seq?.brief || {};
    const persona = req.body.persona || seq?.persona || {};

    const generated = await generateSequence({ brief, persona, bizName: biz.name, industry: biz.industry });

    const updated = await prisma.businessSequence.upsert({
      where: { bizId: req.params.bizId },
      create: {
        bizId: req.params.bizId,
        brief,
        persona,
        touchpoints: generated.touchpoints,
        objections: generated.objections,
        status: 'review',
      },
      update: {
        brief,
        persona,
        touchpoints: generated.touchpoints,
        objections: generated.objections,
        status: 'review',
        updatedAt: new Date(),
      },
    });

    res.json(updated);
  } catch (e) { next(e); }
});

// POST /sequences/:bizId/regenerate/:touchpointId — regenerate one touchpoint with Claude Haiku
router.post('/:bizId/regenerate/:touchpointId', requireAuth, async (req, res, next) => {
  try {
    const seq = await prisma.businessSequence.findUnique({ where: { bizId: req.params.bizId } });
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });

    const touchpoints = Array.isArray(seq.touchpoints) ? seq.touchpoints : [];
    const idx = touchpoints.findIndex(t => String(t.id) === req.params.touchpointId);
    if (idx === -1) return res.status(404).json({ error: 'Touchpoint not found' });

    const biz = await prisma.business.findUnique({ where: { id: req.params.bizId } });
    const updated = await regenerateTouchpoint({
      brief: seq.brief,
      persona: seq.persona,
      bizName: biz?.name || '',
      touchpoint: touchpoints[idx],
    });

    touchpoints[idx] = { ...touchpoints[idx], ...updated };

    const saved = await prisma.businessSequence.update({
      where: { bizId: req.params.bizId },
      data: { touchpoints, updatedAt: new Date() },
    });

    res.json({ touchpoint: touchpoints[idx], sequence: saved });
  } catch (e) { next(e); }
});

// PATCH /sequences/:bizId/touchpoint/:id — manual edit a touchpoint
router.patch('/:bizId/touchpoint/:touchpointId', requireAuth, async (req, res, next) => {
  try {
    const seq = await prisma.businessSequence.findUnique({ where: { bizId: req.params.bizId } });
    if (!seq) return res.status(404).json({ error: 'Sequence not found' });

    const touchpoints = Array.isArray(seq.touchpoints) ? seq.touchpoints : [];
    const idx = touchpoints.findIndex(t => String(t.id) === req.params.touchpointId);
    if (idx === -1) return res.status(404).json({ error: 'Touchpoint not found' });

    touchpoints[idx] = { ...touchpoints[idx], ...req.body };

    const saved = await prisma.businessSequence.update({
      where: { bizId: req.params.bizId },
      data: { touchpoints, updatedAt: new Date() },
    });

    res.json(saved);
  } catch (e) { next(e); }
});

// PATCH /sequences/:bizId/brief — update brief and/or persona
router.patch('/:bizId/brief', requireAuth, async (req, res, next) => {
  try {
    const { brief, persona } = req.body;
    const data = { updatedAt: new Date() };
    if (brief !== undefined) data.brief = brief;
    if (persona !== undefined) data.persona = persona;

    const saved = await prisma.businessSequence.upsert({
      where: { bizId: req.params.bizId },
      create: { bizId: req.params.bizId, ...data },
      update: data,
    });

    res.json(saved);
  } catch (e) { next(e); }
});

// POST /sequences/:bizId/approve — set status to active
router.post('/:bizId/approve', requireAuth, async (req, res, next) => {
  try {
    const saved = await prisma.businessSequence.update({
      where: { bizId: req.params.bizId },
      data: { status: 'active', updatedAt: new Date() },
    });
    res.json(saved);
  } catch (e) { next(e); }
});

// POST /sequences/:bizId/reset — reset to draft
router.post('/:bizId/reset', requireAuth, async (req, res, next) => {
  try {
    const saved = await prisma.businessSequence.update({
      where: { bizId: req.params.bizId },
      data: { status: 'draft', touchpoints: [], objections: [], updatedAt: new Date() },
    });
    res.json(saved);
  } catch (e) { next(e); }
});

// PATCH /sequences/:bizId/objections — save objection library
router.patch('/:bizId/objections', requireAuth, async (req, res, next) => {
  try {
    const { objections } = req.body;
    const saved = await prisma.businessSequence.upsert({
      where: { bizId: req.params.bizId },
      create: { bizId: req.params.bizId, objections },
      update: { objections, updatedAt: new Date() },
    });
    res.json(saved);
  } catch (e) { next(e); }
});

export default router;
