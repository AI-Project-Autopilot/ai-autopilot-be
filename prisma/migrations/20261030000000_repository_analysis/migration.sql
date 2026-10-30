BEGIN;

-- CreateEnum
CREATE TYPE "RepositoryAnalysisStatus" AS ENUM ('running', 'succeeded', 'failed', 'cancelled');

-- CreateTable
CREATE TABLE "RepositoryAnalysis" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "goal" VARCHAR(2000) NOT NULL,
    "status" "RepositoryAnalysisStatus" NOT NULL DEFAULT 'running',
    "fullName" TEXT,
    "defaultBranch" TEXT,
    "htmlUrl" TEXT,
    "commitSha" TEXT,
    "isPrivate" BOOLEAN,
    "model" TEXT NOT NULL,
    "summary" TEXT,
    "result" JSONB,
    "context" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepositoryAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_userId_createdAt_id_idx" ON "RepositoryAnalysis"("userId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "RepositoryAnalysis_userId_repositoryId_createdAt_id_idx" ON "RepositoryAnalysis"("userId", "repositoryId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "RepositoryAnalysis" ADD CONSTRAINT "RepositoryAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AutopilotUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
