CREATE TABLE IF NOT EXISTS "OpenWASession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "label" TEXT NOT NULL DEFAULT 'WhatsApp Number',
    "sessionName" TEXT NOT NULL,
    "phone" TEXT,
    "status" TEXT NOT NULL DEFAULT 'disconnected',
    "dailyLimit" INTEGER NOT NULL DEFAULT 200,
    "sentToday" INTEGER NOT NULL DEFAULT 0,
    "lastResetAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OpenWASession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OpenWASession_tenantId_idx" ON "OpenWASession"("tenantId");

CREATE TABLE IF NOT EXISTS "WAConnectCampaign" (
    "id" SERIAL NOT NULL,
    "tenantId" TEXT NOT NULL DEFAULT 'default',
    "name" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "goal" TEXT NOT NULL DEFAULT '',
    "sequence" JSONB NOT NULL DEFAULT '[]',
    "leads" JSONB NOT NULL DEFAULT '[]',
    "sendLimit" INTEGER NOT NULL DEFAULT 50,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WAConnectCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WAConnectCampaign_tenantId_idx" ON "WAConnectCampaign"("tenantId");
