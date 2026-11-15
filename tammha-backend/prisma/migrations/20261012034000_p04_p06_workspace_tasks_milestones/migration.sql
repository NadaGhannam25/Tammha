-- P04 + P06 combined migration
-- Generated to bridge the already-applied v2.0.1 initial schema to the current P06 schema.

-- CreateEnum
CREATE TYPE "SupervisionRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "teams"
ADD COLUMN "inviteCode" TEXT,
ADD COLUMN "inviteCodeUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "supervision_requests" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "supervisorId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" "SupervisionRequestStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "responseNote" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervision_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "teams_inviteCode_key" ON "teams"("inviteCode");

-- CreateIndex
CREATE INDEX "supervision_requests_projectId_status_idx" ON "supervision_requests"("projectId", "status");

-- CreateIndex
CREATE INDEX "supervision_requests_supervisorId_status_idx" ON "supervision_requests"("supervisorId", "status");

-- CreateIndex
CREATE INDEX "milestones_projectId_dueDate_idx" ON "milestones"("projectId", "dueDate");

-- CreateIndex
CREATE INDEX "tasks_projectId_status_idx" ON "tasks"("projectId", "status");

-- CreateIndex
CREATE INDEX "tasks_projectId_dueDate_idx" ON "tasks"("projectId", "dueDate");

-- AddForeignKey
ALTER TABLE "supervision_requests" ADD CONSTRAINT "supervision_requests_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervision_requests" ADD CONSTRAINT "supervision_requests_supervisorId_fkey" FOREIGN KEY ("supervisorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervision_requests" ADD CONSTRAINT "supervision_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
