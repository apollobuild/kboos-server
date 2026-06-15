import prisma from '../db.js';

// Auto-pause a campaign when sends are mostly failing, so a broken setup
// (bad template, WATI credentials, no opt-in) can't burn through credits.
// Called by the outreach workers right after they mark an action failed.
export async function recordSendFailure(campaignId, reason) {
  if (!campaignId) return;
  try {
    // Look at the most recent attempts (excludes still-pending jobs)
    const recent = await prisma.campaignAction.findMany({
      where: { campaignId, status: { in: ['sent', 'failed'] } },
      orderBy: { sentAt: 'desc' },
      take: 10,
      select: { status: true },
    });
    const failed = recent.filter(r => r.status === 'failed').length;

    // Trip when we have enough signal and ~all of it is failure
    const enoughSignal = recent.length >= 5;
    const mostlyFailing = failed >= Math.ceil(recent.length * 0.8);
    if (!enoughSignal || !mostlyFailing) return;

    const campaign = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
    if (!campaign || campaign.status !== 'active') return; // already paused/stopped

    await prisma.campaign.update({ where: { id: campaignId }, data: { status: 'paused' } });
    await prisma.campaignPipeline.update({
      where: { campaignId },
      data: { lastError: `Auto-paused: ${failed} of the last ${recent.length} sends failed. Fix the issue, then use "Retry failed" to resume. Reason: ${reason}` },
    }).catch(() => {});
    console.warn(`[CircuitBreaker] Campaign ${campaignId} auto-paused — ${failed}/${recent.length} failing. Reason: ${reason}`);
  } catch (err) {
    console.error('[CircuitBreaker] check failed:', err.message);
  }
}
