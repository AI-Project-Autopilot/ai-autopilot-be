BEGIN;

CREATE TYPE "TrackedTaskStatus" AS ENUM ('selected', 'in_progress', 'completed', 'cancelled');
CREATE TYPE "IssueCreationState" AS ENUM ('none', 'creating', 'created', 'uncertain');

CREATE TABLE "TrackedTask" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "language" VARCHAR(2) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "source" JSONB NOT NULL,
    "status" "TrackedTaskStatus" NOT NULL DEFAULT 'selected',
    "issueNumber" INTEGER,
    "issueUrl" TEXT,
    "issueState" TEXT,
    "issueStateReason" TEXT,
    "issueCreationState" "IssueCreationState" NOT NULL DEFAULT 'none',
    "issueCreationStartedAt" TIMESTAMP(3),
    "issueSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TrackedTask_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TrackedTask_userId_analysisId_recommendationId_key" ON "TrackedTask"("userId", "analysisId", "recommendationId");
CREATE UNIQUE INDEX "TrackedTask_userId_repositoryId_issueNumber_key" ON "TrackedTask"("userId", "repositoryId", "issueNumber");
CREATE INDEX "TrackedTask_userId_createdAt_id_idx" ON "TrackedTask"("userId", "createdAt", "id");
CREATE INDEX "TrackedTask_userId_repositoryId_createdAt_id_idx" ON "TrackedTask"("userId", "repositoryId", "createdAt", "id");

ALTER TABLE "TrackedTask" ADD CONSTRAINT "TrackedTask_userId_fkey" FOREIGN KEY ("userId") REFERENCES "AutopilotUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TrackedTask" ADD CONSTRAINT "TrackedTask_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "RepositoryAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
