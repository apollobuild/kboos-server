import { PrismaClient } from '@prisma/client';

const connectionUrl = process.env.DATABASE_URL
  ? process.env.DATABASE_URL.includes('?')
    ? process.env.DATABASE_URL + '&connection_limit=3&pool_timeout=20'
    : process.env.DATABASE_URL + '?connection_limit=3&pool_timeout=20'
  : undefined;

const prisma = global._prisma ?? new PrismaClient(
  connectionUrl ? { datasources: { db: { url: connectionUrl } } } : {}
);
if (process.env.NODE_ENV !== 'production') global._prisma = prisma;

export default prisma;
