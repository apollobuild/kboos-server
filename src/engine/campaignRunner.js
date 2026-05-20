import { PrismaClient } from '@prisma/client';
import { generateEmail } from '../services/claude.js';
import { sendEmail } from '../services/sendgrid.js';
import { sendViaSMTP } from '../services/smtp.js';
import { sendTemplate } from '../services/wati.js';
import { makeCall } from '../services/vapi.js';

const prisma = new PrismaClient();

function deriveStatus(type) {
  if (type === 'wa') return 'contacted';
  if (type === 'email') return 'emailed';
  if (type === 'call') return 'called';
  return 'contacted';
}

async function dispatchAction(type, lead, campaign) {
  const config = campaign.config || {};
  try {
    if (type === 'wa') {
      if (!lead.phone) return { ok: false, error: 'No phone number' };
      const templateName = config.waTemplateName || 'kboos_intro_v1';
      const firstName = lead.name?.split(' ')[0] || lead.name;
      await sendTemplate({ phone: lead.phone, templateName, parameters: [{ name: 'first_name', value: firstName }] });
      return { ok: true };
    }

    if (type === 'email') {
      if (!lead.email) return { ok: false, error: 'No email address' };
      const emailContent = await generateEmail({
        bizName: campaign.bizName,
        campaignName: campaign.name,
        prompt: config.emailPrompt || 'Write a warm, professional B2B cold email. Be concise.',
        lead: { name: lead.name, company: lead.company, title: lead.title, lang: lead.lang || 'EN' },
      });
      const subject = Array.isArray(emailContent.subjects) ? emailContent.subjects[0] : (emailContent.subject || 'Quick question');
      const fromName = config.fromName || `${campaign.bizName} Team`;
      const replyTo = config.replyTo;

      if (config.smtp?.user && config.smtp?.pass) {
        await sendViaSMTP({ smtpConfig: config.smtp, to: lead.email, subject, body: emailContent.body, fromName, replyTo });
      } else {
        await sendEmail({ to: lead.email, subject, body: emailContent.body, fromName, fromEmail: config.fromEmail || 'outreach@kboos.app', replyTo });
      }
      return { ok: true };
    }

    if (type === 'call') {
      if (!lead.phone) return { ok: false, error: 'No phone number' };
      await makeCall({ phone: lead.phone, leadName: lead.name, bizName: campaign.bizName, campaignScript: config.voiceScript });
      return { ok: true };
    }

    return { ok: false, error: `Unknown action type: ${type}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function runTick() {
  const now = new Date();
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);

  let campaigns;
  try {
    campaigns = await prisma.campaign.findMany({ where: { status: 'active', startedAt: { not: null } } });
  } catch (err) {
    console.error('[Engine] Failed to fetch campaigns:', err.message);
    return;
  }

  for (const campaign of campaigns) {
    try {
      const daysSinceStart = Math.floor((now - new Date(campaign.startedAt)) / (1000 * 60 * 60 * 24));
      const sequence = Array.isArray(campaign.sequence) ? campaign.sequence : [];
      const dailyLimit = campaign.dailyLimit || 200;

      const sentToday = await prisma.campaignAction.count({
        where: { campaignId: campaign.id, sentAt: { gte: todayStart }, status: 'sent' },
      });
      let budget = dailyLimit - sentToday;
      if (budget <= 0) {
        console.log(`[Engine] Campaign ${campaign.id} hit daily limit (${dailyLimit})`);
        continue;
      }

      for (const step of sequence) {
        if (step.day > daysSinceStart) continue;
        if (budget <= 0) break;

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

        for (const lead of leads) {
          // Create pending action first to prevent double-send on crash
          const action = await prisma.campaignAction.create({
            data: { leadId: lead.id, campaignId: campaign.id, type: step.type, stepDay: step.day, status: 'pending', sentAt: now },
          });

          const result = await dispatchAction(step.type, lead, campaign);

          await prisma.campaignAction.update({
            where: { id: action.id },
            data: { status: result.ok ? 'sent' : 'failed', errorMsg: result.error || null },
          });

          if (result.ok) {
            const isFirstContact = ['new', 'scraped', 'personalizing'].includes(lead.status);
            await prisma.lead.update({
              where: { id: lead.id },
              data: { lastContactedAt: now, ...(isFirstContact ? { status: deriveStatus(step.type) } : {}) },
            });
            budget--;
          }
        }
      }
    } catch (err) {
      console.error(`[Engine] Error on campaign ${campaign.id}:`, err.message);
    }
  }

  console.log(`[Engine] Tick complete — ${campaigns.length} campaigns checked`);
}
