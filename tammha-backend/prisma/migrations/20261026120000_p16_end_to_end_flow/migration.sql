-- P16: end-to-end Tammha flow.
-- Additive migration from the P13 schema (2.6.0 -> 2.7.0): new columns, tables and enum values.
-- No DROP. Existing rows are backfilled so current users and projects keep working:
--   * existing projects count as fully set up (setupStep = COMPLETED, setupCompletedAt = createdAt)
--   * existing users have already used the app, so onboarding counts as completed
--   * emailVerifiedAt stays NULL (no address has been verified yet)

-- AlterEnum (new values are not used inside this migration)
ALTER TYPE "NotificationType" ADD VALUE 'TEAM_INVITATION';
ALTER TYPE "NotificationType" ADD VALUE 'SUPERVISION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'SUPERVISION_RESPONDED';
ALTER TYPE "NotificationType" ADD VALUE 'HANDBOOK_PROCESSED';

-- CreateEnum
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "TeamInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProjectCategory" AS ENUM ('TECHNOLOGY', 'EDUCATION', 'HEALTH', 'MEDICAL', 'BUSINESS', 'ENGINEERING', 'OTHER');

-- CreateEnum
CREATE TYPE "ProjectOrigin" AS ENUM ('NEW', 'CONTINUATION', 'PREVIOUSLY_IMPLEMENTED');

-- CreateEnum
CREATE TYPE "ProjectSetupStep" AS ENUM ('TEAM', 'SUPERVISOR', 'DETAILS', 'QUESTIONS', 'HANDBOOK', 'COMPLETED');

-- CreateEnum
CREATE TYPE "HandbookStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('MANUAL', 'AI_SUGGESTION');

-- CreateEnum
CREATE TYPE "AiMessageRole" AS ENUM ('USER', 'ASSISTANT');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "emailVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "onboardingCompletedAt" TIMESTAMP(3),
ADD COLUMN     "studentNumber" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "category" "ProjectCategory",
ADD COLUMN     "expectedCompletionDate" TIMESTAMP(3),
ADD COLUMN     "objectives" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "origin" "ProjectOrigin",
ADD COLUMN     "overview" TEXT,
ADD COLUMN     "setupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "setupStep" "ProjectSetupStep" NOT NULL DEFAULT 'COMPLETED';

-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "sortOrder" INTEGER;

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "estimatedDays" INTEGER,
ADD COLUMN     "source" "TaskSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "sourceKey" TEXT;

-- AlterTable
ALTER TABLE "ai_support" ADD COLUMN     "projectHandbookId" TEXT;

-- CreateTable
CREATE TABLE "auth_tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "AuthTokenType" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_invitations" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "status" "TeamInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "message" TEXT,
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_handbooks" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "status" "HandbookStatus" NOT NULL DEFAULT 'PROCESSING',
    "title" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "storagePath" TEXT NOT NULL,
    "pageCount" INTEGER,
    "extractedText" TEXT,
    "extractedChars" INTEGER NOT NULL DEFAULT 0,
    "sectionCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "uploadedById" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_handbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_conversations" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "AiMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "kind" "AiRequestKind",
    "aiRequestId" TEXT,
    "guidance" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id")
);

-- Backfill existing rows (see header)
UPDATE "projects" SET "setupCompletedAt" = "createdAt" WHERE "setupCompletedAt" IS NULL;
UPDATE "users" SET "onboardingCompletedAt" = "createdAt" WHERE "onboardingCompletedAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_universityId_studentNumber_key" ON "users"("universityId", "studentNumber");

-- CreateIndex
CREATE UNIQUE INDEX "auth_tokens_tokenHash_key" ON "auth_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_tokens_userId_type_idx" ON "auth_tokens"("userId", "type");

-- CreateIndex
CREATE INDEX "team_invitations_inviteeId_status_idx" ON "team_invitations"("inviteeId", "status");

-- CreateIndex
CREATE INDEX "team_invitations_teamId_status_idx" ON "team_invitations"("teamId", "status");

-- CreateIndex
CREATE INDEX "project_handbooks_projectId_isActive_idx" ON "project_handbooks"("projectId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "project_handbooks_projectId_version_key" ON "project_handbooks"("projectId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_sourceKey_key" ON "tasks"("sourceKey");

-- CreateIndex
CREATE INDEX "ai_conversations_userId_projectId_lastMessageAt_idx" ON "ai_conversations"("userId", "projectId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ai_messages_conversationId_createdAt_idx" ON "ai_messages"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_inviteeId_fkey" FOREIGN KEY ("inviteeId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_handbooks" ADD CONSTRAINT "project_handbooks_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_handbooks" ADD CONSTRAINT "project_handbooks_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_support" ADD CONSTRAINT "ai_support_projectHandbookId_fkey" FOREIGN KEY ("projectHandbookId") REFERENCES "project_handbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "ai_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_aiRequestId_fkey" FOREIGN KEY ("aiRequestId") REFERENCES "ai_support"("id") ON DELETE SET NULL ON UPDATE CASCADE;
