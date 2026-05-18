import { PrismaClient } from '@prisma/client';
import { encrypt, decrypt } from './crypto.js';

const prisma = new PrismaClient();

export async function getApiKey(name) {
  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  if (!settings) return null;
  const keys = settings.apiKeysEnc;
  return keys[name] ? decrypt(keys[name]) : null;
}

export async function saveApiKey(name, value) {
  const settings = await prisma.appSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global', apiKeysEnc: { [name]: encrypt(value) } },
    update: {},
  });
  const keys = { ...(settings.apiKeysEnc || {}) };
  keys[name] = encrypt(value);
  return prisma.appSettings.update({
    where: { id: 'global' },
    data: { apiKeysEnc: keys },
  });
}
