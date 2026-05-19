import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Requires both env vars to prevent accidental wipe
if (process.env.CLEAR_DB !== 'yes' || process.env.I_UNDERSTAND_THIS_DELETES_EVERYTHING !== 'yes') {
  console.error('ERROR: clear-db requires CLEAR_DB=yes and I_UNDERSTAND_THIS_DELETES_EVERYTHING=yes');
  console.error('Run: CLEAR_DB=yes I_UNDERSTAND_THIS_DELETES_EVERYTHING=yes node src/clear-db.js');
  process.exit(1);
}

async function main() {
  console.log('Clearing all data (admin user preserved)...');

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
