-- CreateTable
CREATE TABLE "BusinessSequence" (
    "id" TEXT NOT NULL,
    "bizId" TEXT NOT NULL,
    "brief" JSONB NOT NULL DEFAULT '{}',
    "persona" JSONB NOT NULL DEFAULT '{}',
    "touchpoints" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessSequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardToken" (
    "id" TEXT NOT NULL,
    "bizId" TEXT NOT NULL,
    "bizName" TEXT NOT NULL DEFAULT '',
    "token" TEXT NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "usedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessSequence_bizId_key" ON "BusinessSequence"("bizId");

-- CreateIndex
CREATE UNIQUE INDEX "OnboardToken_token_key" ON "OnboardToken"("token");
