import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Clearing all seeded data...');

  await prisma.activity.deleteMany({});
  await prisma.lead.deleteMany({});
  await prisma.reply.deleteMany({});
  await prisma.campaign.deleteMany({});
  await prisma.business.deleteMany({});

  // Keep the admin user, remove only demo/invite-pending users
  await prisma.user.deleteMany({
    where: { email: { not: 'admin@kboos.app' } }
  });

  // Reset wallet to zero
  await prisma.wallet.upsert({
    where: { id: 'global' },
    create: { id: 'global', balance: 0 },
    update: { balance: 0 },
  });
  await prisma.walletTransaction.deleteMany({});

  console.log('Done — database cleared. Only admin user remains.');
}

main().catch(console.error).finally(() => prisma.$disconnect());
