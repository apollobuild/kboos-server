import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

export function hashInput(data) {
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 16);
}

export async function getCache(entityType, entityId, insightType, inputHash) {
  const row = await prisma.aiInsightCache.findUnique({
    where: { entityType_entityId_insightType: { entityType, entityId, insightType } },
  });
  if (!row) return null;
  if (row.expiresAt < new Date()) return null;
  if (row.inputHash !== inputHash) return null;
  return row.result;
}

export async function setCache(entityType, entityId, insightType, result, inputHash, ttlHours = 4) {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await prisma.aiInsightCache.upsert({
    where: { entityType_entityId_insightType: { entityType, entityId, insightType } },
    update: { result, inputHash, computedAt: new Date(), expiresAt },
    create: { entityType, entityId, insightType, result, inputHash, computedAt: new Date(), expiresAt },
  });
}

export async function clearExpired() {
  const deleted = await prisma.aiInsightCache.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return deleted.count;
}
