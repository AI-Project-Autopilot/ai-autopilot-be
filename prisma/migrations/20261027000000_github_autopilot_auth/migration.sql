-- CreateTable
CREATE TABLE "AutopilotUser" (
    "id" TEXT NOT NULL,
    "githubId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopilotUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutopilotSession" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "githubTokenEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutopilotSession_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "AutopilotOAuthState" (
    "stateHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "verifierEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutopilotOAuthState_pkey" PRIMARY KEY ("stateHash")
);

-- CreateIndex
CREATE UNIQUE INDEX "AutopilotUser_githubId_key" ON "AutopilotUser"("githubId");

-- CreateIndex
CREATE INDEX "AutopilotSession_userId_idx" ON "AutopilotSession"("userId");

-- CreateIndex
CREATE INDEX "AutopilotSession_expiresAt_idx" ON "AutopilotSession"("expiresAt");

-- CreateIndex
CREATE INDEX "AutopilotOAuthState_expiresAt_idx" ON "AutopilotOAuthState"("expiresAt");

-- AddForeignKey
ALTER TABLE "AutopilotSession" ADD CONSTRAINT "AutopilotSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AutopilotUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;