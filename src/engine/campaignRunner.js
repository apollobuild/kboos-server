import { enqueue } from '../services/queue.js';
import prisma from '../db.js';

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

      // Canary: until at least one send has succeeded, only send a small first
      // batch. If the setup is broken, we lose a handful of attempts — not the
      // whole list — before the circuit breaker auto-pauses the campaign.
      const successfulSends = await prisma.campaignAction.count({ where: { campaignId: campaign.id, status: 'sent' } });
      const CANARY_BATCH = 10;
      if (successfulSends === 0) budget = Math.min(budget, CANARY_BATCH);

      for (let si = 0; si < sequence.length; si++) {
        const step = sequence[si];
        // "Day 1" means launch day (0 elapsed), so a step is due once
        // daysSinceStart >= step.day - 1. Without the -1, day-1 steps never
        // fired on launch day and the campaign sent nothing until +24h.
        if ((step.day - 1) > daysSinceStart) continue;
        if (budget <= 0) break;
        if (pausedChannels.includes(step.type)) continue;

        const actioned = await prisma.campaignAction.findMany({
          where: { campaignId: campaign.id, stepDay: step.day, type: step.type },
          select: { leadId: true, id: true, status: true, retryCount: true },
        });
        // Only 'sent'/'pending' leads are off-limits. Failed/skipped leads are
        // retryable (so fixing the cause re-sends to them) — reuse their row.
        // Cap auto-retries so a permanently-broken send doesn't re-fire hourly
        // forever; a manual "Retry failed sends" resets the counter.
        const MAX_AUTO_RETRY = 6;
        const blockedIds = [];
        const retryActionByLead = {};
        for (const a of actioned) {
          if (a.status === 'sent' || a.status === 'pending') blockedIds.push(a.leadId);
          else if ((a.retryCount || 0) >= MAX_AUTO_RETRY) blockedIds.push(a.leadId);
          else retryActionByLead[a.leadId] = a.id;
        }
        const actionedIds = blockedIds;

        const skipStatuses = ['unsubscribed', 'bounced'];
        if (step.skipIfReplied) skipStatuses.push('replied', 'hot', 'meeting_booked');

        // Exclude leads the channel-strategy step marked ineligible for this
        // channel; unchecked leads still pass (the worker re-checks anyway)
        const channelFilter = step.type === 'email'
          ? { email: { not: '' }, NOT: { eligibilityChecked: true, emailEligible: false } }
          : step.type === 'wa'
            ? { phone: { not: '' }, NOT: { eligibilityChecked: true, waEligible: false } }
            : { phone: { not: '' }, NOT: { eligibilityChecked: true, voiceEligible: false } };

        const leads = await prisma.lead.findMany({
          where: {
            campaignId: campaign.id,
            id: { notIn: actionedIds.length ? actionedIds : [-1] },
            status: { notIn: skipStatuses },
            ...channelFilter,
          },
          take: budget,
        });

        if (leads.length === 0) continue;

        const assetType = assetTypeMap[si];
        const queueName = step.type === 'email' ? 'outreach-email'
          : step.type === 'wa' ? 'outreach-wa'
          : 'outreach-voice';

        for (const lead of leads) {
          // Reuse the prior failed/skipped row on retry; otherwise create fresh
          let actionId = retryActionByLead[lead.id];
          if (actionId) {
            await prisma.campaignAction.update({
              where: { id: actionId },
              data: { status: 'pending', sentAt: now, errorMsg: null },
            });
          } else {
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
            actionId = action.id;
          }

          await enqueue(queueName, {
            leadId: lead.id,
            campaignId: campaign.id,
            assetType,
            stepDay: step.day,
            actionId,
          });

          // Lead status and lastContactedAt are set by the outreach worker
          // after a confirmed send — never here, or skipped/failed sends
          // would still show as "contacted" in the dashboard

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
