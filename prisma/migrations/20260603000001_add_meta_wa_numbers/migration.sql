-- MetaWANumber: store multiple Meta Cloud API phone numbers per tenant
CREATE TABLE "MetaWANumber" (
  "id"            SERIAL NOT NULL,
  "tenantId"      TEXT NOT NULL DEFAULT 'default',
  "label"         TEXT NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "active"        BOOLEAN NOT NULL DEFAULT true,
  "dailyLimit"    INTEGER NOT NULL DEFAULT 1000,
  "sentToday"     INTEGER NOT NULL DEFAULT 0,
  "lastResetAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MetaWANumber_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MetaWANumber_tenantId_idx" ON "MetaWANumber"("tenantId");

-- Add WA number selector to Campaign
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "waNumberId" INTEGER;
