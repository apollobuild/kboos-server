-- Add AI Smart Reply fields to Reply model
ALTER TABLE "Reply" ADD COLUMN IF NOT EXISTS "thread" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Reply" ADD COLUMN IF NOT EXISTS "aiDraft" TEXT;
ALTER TABLE "Reply" ADD COLUMN IF NOT EXISTS "aiStage" TEXT NOT NULL DEFAULT 'cold';
ALTER TABLE "Reply" ADD COLUMN IF NOT EXISTS "aiEscalate" BOOLEAN NOT NULL DEFAULT false;

-- Add reply persona and goal fields to AppSettings model
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "replyPersonas" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "AppSettings" ADD COLUMN IF NOT EXISTS "replyGoals" JSONB NOT NULL DEFAULT '[]';
