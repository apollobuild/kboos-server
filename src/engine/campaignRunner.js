import { enqueue } from '../services/queue.js';
import prisma from '../db.js';

function deriveStatus(type) {
  if (type === 'wa') return 'contacted';
  if (type === 'email') return 'emailed';
  if (type === 'call') return 'called';
  return 'contacted';
}

function isWithinSendWindow(now) {
  // 9am–6pm Malaysia time (UTC+8)
  const klOffset = 8 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const klMinutes = (utcMinutes + klOffset) % (24 * 60);
  return klMinutes >= 9 * 60 && klMinutes < 18 * 60;
}

// Map each sequence step to its asset type (email_1, email_2, wa_1, voice_1, etc.)
function buildAssetTypeMap(sequence) {
  const counters = {};
  return sequence.map(step => {
    if (step.assetType) return step.assetType;
    const key = step.type === 'call' ? 'voice' : step.type;
    counters[key] = (counters[key] || 0) + 1;
    return `${key}_${counters[key]}`;
  });
}

export async function runTick() {
  const now = new Date();

  if (!isWithinSendWindow(now)) {
    console.log('[Engine] Outside send window (9am–6pm KL). Skipping tick.');
    return;
  }

  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  let campaigns;
  try {
    campaigns = await prisma.campaign.findMany({ where: { status: 'active', startedAt: { not: null } } });
  } catch (err) {
    console.error('[Engine] Failed to fetch campaigns:', err.message);
    return;
  }

  let totalEnqueued = 0;

  for (const campaign of campaigns) {
    try {
      const daysSinceStart = Math.floor((now - new Date(campaign.startedAt)) / (1000 * 60 * 60 * 24));
      const sequence = Array.isArray(campaign.sequence) ? campaign.sequence : [];
      if (sequence.length === 0) continue;

      const dailyLimit = campaign.dailyLimit || 200;
      const assetTypeMap = buildAssetTypeMap(sequence);

      // Count pending + sent today to prevent over-enqueuing on each hourly tick
      const usedToday = await prisma.campaignAction.count({
        where: { campaignId: campaign.id, sentAt: { gte: todayStart }, status: { in: ['sent', 'pending'] } },
      });
      let budget = dailyLimit - usedToday;
      if (budget <= 0) {
        console.log(`[Engine] Campaign ${campaign.id} hit daily limit (${dailyLimit})`);
        continue;
      }

      const config = campaign.config || {};
      const pausedChannels = Array.isArray(config.pausedChannels) ? config.pausedChannels : [];

      for (let si = 0; si < sequence.length; si++) {
        const step = sequence[si];
        if (step.day > daysSinceStart) continue;
        if (budget <= 0) break;
        if (pausedChannels.includes(step.type)) continue;

        const actioned = await prisma.campaignAction.findMany({
          where: { campaignId: campaign.id, stepDay: step.day, type: step.type },
          select: { leadId: true },
        });
        const actionedIds = actioned.map(a => a.leadId);

        const skipStatuses = ['unsubscribed', 'bounced'];
        if (step.skipIfReplied) skipStatuses.push('replied', 'hot', 'meeting_booked');

        const leads = await prisma.lead.findMany({
          where: {
            campaignId: campaign.id,
            id: { notIn: actionedIds.length ? actionedIds : [-1] },
            status: { notIn: skipStatuses },
            ...(step.type === 'email' ? { email: { not: '' } } : {}),
            ...(step.type !== 'email' ? { phone: { not: '' } } : {}),
          },
          take: budget,
        });

        if (leads.length === 0) continue;

        const assetType = assetTypeMap[si];
        const queueName = step.type === 'email' ? 'outreach-email'
          : step.type === 'wa' ? 'outreach-wa'
          : 'outreach-voice';

        for (const lead of leads) {
          const action = await prisma.campaignAction.create({
            data: {
              leadId: lead.id,
              campaignId: campaign.id,
              type: step.type,
              stepDay: step.day,
              status: 'pending',
              sentAt: now,
            },
          });

          await enqueue(queueName, {
            leadId: lead.id,
            campaignId: campaign.id,
            assetType,
            stepDay: step.day,
            actionId: action.id,
          });

          // Optimistically advance lead status on first contact
          const isFirstContact = ['new', 'scraped', 'personalizing'].includes(lead.status);
          if (isFirstContact) {
            await prisma.lead.update({
              where: { id: lead.id },
              data: { lastContactedAt: now, status: deriveStatus(step.type) },
            });
          }

          budget--;
          totalEnqueued++;
        }

        console.log(`[Engine] Campaign ${campaign.id} day ${step.day} ${step.type}: enqueued ${leads.length} (${assetType})`);
      }
    } catch (err) {
      console.error(`[Engine] Error on campaign ${campaign.id}:`, err.message);
    }
  }

  console.log(`[Engine] Tick complete — ${campaigns.length} campaigns, ${totalEnqueued} jobs enqueued`);
}
