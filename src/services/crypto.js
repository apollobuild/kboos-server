import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-cbc';

function getKey() {
  const k = process.env.ENCRYPTION_KEY || '';
  if (k.length !== 32) throw new Error('ENCRYPTION_KEY must be exactly 32 characters');
  return Buffer.from(k);
}

export function encrypt(text) {
  if (!text) return '';
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

export function decrypt(encrypted) {
  if (!encrypted) return '';
  const [ivHex, dataHex] = encrypted.split(':');
  if (!ivHex || !dataHex) return '';
  const iv = Buffer.from(ivHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv(ALGO, getKey(), iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
