-- CreateTable Tenant
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'agency',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "country" TEXT NOT NULL DEFAULT 'MY',
    "currency" TEXT NOT NULL DEFAULT 'MYR',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
    "mobilePrefix" TEXT NOT NULL DEFAULT '+60',
    "languages" TEXT[] DEFAULT ARRAY['EN','MS']::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- Seed default tenant
INSERT INTO "Tenant" ("id", "name", "slug", "plan", "active", "createdAt")
VALUES ('default', 'Default', 'default', 'agency', true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- Add tenantId to all tables
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Reply" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Activity" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "ApiUsageLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "MeetingLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "OnboardToken" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "DemoProspect" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "CampaignAsset" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "BusinessSequence" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "CampaignPipeline" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "CampaignOptimization" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "Wallet" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';
ALTER TABLE "WalletTransaction" ADD COLUMN IF NOT EXISTS "tenantId" TEXT NOT NULL DEFAULT 'default';

-- Indexes for performance
CREATE INDEX IF NOT EXISTS "User_tenantId_idx" ON "User"("tenantId");
CREATE INDEX IF NOT EXISTS "Business_tenantId_idx" ON "Business"("tenantId");
CREATE INDEX IF NOT EXISTS "Campaign_tenantId_idx" ON "Campaign"("tenantId");
CREATE INDEX IF NOT EXISTS "Lead_tenantId_idx" ON "Lead"("tenantId");
CREATE INDEX IF NOT EXISTS "Reply_tenantId_idx" ON "Reply"("tenantId");
CREATE INDEX IF NOT EXISTS "Activity_tenantId_idx" ON "Activity"("tenantId");
CREATE INDEX IF NOT EXISTS "AppSettings_tenantId_idx" ON "AppSettings"("tenantId");
CREATE INDEX IF NOT EXISTS "ApiUsageLog_tenantId_idx" ON "ApiUsageLog"("tenantId");
CREATE INDEX IF NOT EXISTS "MeetingLog_tenantId_idx" ON "MeetingLog"("tenantId");
CREATE INDEX IF NOT EXISTS "Wallet_tenantId_idx" ON "Wallet"("tenantId");
