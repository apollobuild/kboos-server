ALTER TABLE "User" ADD COLUMN "inviteToken" TEXT;
CREATE UNIQUE INDEX "User_inviteToken_key" ON "User"("inviteToken");
