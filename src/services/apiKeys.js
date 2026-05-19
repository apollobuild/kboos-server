import { PrismaClient } from '@prisma/client';
import { encrypt, decrypt } from './crypto.js';

const prisma = new PrismaClient();

export async function getApiKey(name) {
  const settings = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  if (!settings?.apiKeysEnc) return null;
  const val = settings.apiKeysEnc[name];
  return val ? decrypt(val) : null;
}

export async function saveApiKey(name, value) {
  const current = await prisma.appSettings.findUnique({ where: { id: 'global' } });
  const keys = { ...(current?.apiKeysEnc || {}), [name]: encrypt(value) };
  await prisma.appSettings.upsert({
    where: { id: 'global' },
    create: { id: 'global', apiKeysEnc: keys },
    update: { apiKeysEnc: keys },
  });
}
