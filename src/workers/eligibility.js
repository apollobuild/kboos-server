import { PrismaClient } from '@prisma/client';
import { checkChannelEligibility } from '../services/leadScoring.js';

const prisma = new PrismaClient();

export async function handleEligibility(job) {
  const { campaignId } = job.data;

  await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'eligibility_checking' } });

  const leads = await prisma.lead.findMany({ where: { campaignId }, select: { id: true, phone: true, email: true } });

  let eligibleEmail = 0, eligibleWa = 0, eligibleVoice = 0, ineligibleCount = 0;
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const channels = campaign.channels || [];

  for (const lead of leads) {
    const elig = checkChannelEligibility(lead);
    await prisma.leadEligibility.upsert({
      where: { leadId_campaignId: { leadId: lead.id, campaignId } },
      update: { ...elig, checkedAt: new Date() },
      create: { leadId: lead.id, campaignId, ...elig },
    });
    if (channels.includes('email') && elig.emailEligible) eligibleEmail++;
    if (channels.includes('wa') && elig.waEligible) eligibleWa++;
    if (channels.includes('call') && elig.voiceEligible) eligibleVoice++;
    if (!elig.emailEligible && !elig.waEligible && !elig.voiceEligible) ineligibleCount++;
  }

  await prisma.campaignPipeline.update({
    where: { campaignId },
    data: { stage: 'awaiting_launch', eligibleEmail, eligibleWa, eligibleVoice, ineligibleCount },
  });

  console.log(`[Eligibility] Campaign ${campaignId}: email=${eligibleEmail} wa=${eligibleWa} voice=${eligibleVoice} ineligible=${ineligibleCount}`);
}
