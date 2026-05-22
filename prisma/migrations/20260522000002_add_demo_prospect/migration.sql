CREATE TABLE "DemoProspect" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "company" TEXT NOT NULL,
  "industry" TEXT NOT NULL DEFAULT '',
  "phone" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "lang" TEXT NOT NULL DEFAULT 'EN',
  "waMsg" TEXT NOT NULL DEFAULT '',
  "emailSubject" TEXT NOT NULL DEFAULT '',
  "emailBody" TEXT NOT NULL DEFAULT '',
  "voiceScript" TEXT NOT NULL DEFAULT '',
  "convoHistory" JSONB NOT NULL DEFAULT '[]',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DemoProspect_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DemoProspect_phone_key" ON "DemoProspect"("phone");
