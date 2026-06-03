import { generateCampaignAssets } from '../services/claude.js';
import { logClaude } from '../services/costLogger.js';
import prisma from '../db.js';

export async function handleAssetGen(job) {
  const { campaignId } = job.data;

  await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'ai_generating', lastError: null } });

  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  const biz = await prisma.business.findUnique({ where: { id: campaign.bizId } });
  const seq = await prisma.businessSequence.findUnique({ where: { bizId: campaign.bizId } }).catch(() => null);

  const brief = seq?.brief || {};

  let assets;
  try {
    assets = await generateCampaignAssets({
      bizName: biz?.name || campaign.bizName,
      industry: biz?.industry || '',
      offer: brief.offer || brief.service || biz?.brief || '',
      dreamOutcome: brief.dreamOutcome || '',
      targetAudience: brief.audience || brief.bestCustomer || '',
      tone: brief.style || 'professional but warm',
      lang: brief.lang || 'EN',
      channels: campaign.channels || ['wa', 'email'],
    });
  } catch (err) {
    await prisma.campaignPipeline.update({ where: { campaignId }, data: { stage: 'ai_error', lastError: err.message } });
    throw err;
  }

  // Store all assets
  const allAssets = [
    ...(assets.emails || []).map(e => ({ ...e, channel: 'email' })),
    ...(assets.whatsapps || []).map(w => ({ ...w, channel: 'wa' })),
    ...(assets.voice ? Object.values(assets.voice).map(v => ({ ...v, channel: 'voice' })) : []),
  ];

  // Clear old assets only AFTER generation succeeded (preserves assets if generation throws)
  await prisma.campaignAsset.deleteMany({ where: { campaignId } });

  for (const a of allAssets) {
    await prisma.campaignAsset.create({
      data: {
        campaignId,
        assetType: a.assetType,
        channel: a.channel,
        label: a.label,
        subject: a.subject || null,
        body: a.body,
        notes: a.notes || null,
      },
    });
  }

  await prisma.campaignPipeline.update({
    where: { campaignId },
    data: { stage: 'ai_content_ready', assetsReadyAt: new Date() },
  });

  console.log(`[AssetGen] Campaign ${campaignId}: ${allAssets.length} assets generated`);
}
