-- Add tenantId to CampaignAction (was missing)
ALTER TABLE "CampaignAction" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';

-- Performance indexes on Lead
CREATE INDEX IF NOT EXISTS "Lead_campaignId_idx" ON "Lead"("campaignId");
CREATE INDEX IF NOT EXISTS "Lead_status_idx" ON "Lead"("status");
CREATE INDEX IF NOT EXISTS "Lead_campaignId_status_idx" ON "Lead"("campaignId", "status");

-- Performance index on Campaign
CREATE INDEX IF NOT EXISTS "Campaign_bizId_idx" ON "Campaign"("bizId");

-- Tenant isolation index on CampaignAction
CREATE INDEX IF NOT EXISTS "CampaignAction_tenantId_idx" ON "CampaignAction"("tenantId");

-- Tenant isolation index on WalletTransaction
CREATE INDEX IF NOT EXISTS "WalletTransaction_tenantId_idx" ON "WalletTransaction"("tenantId");
