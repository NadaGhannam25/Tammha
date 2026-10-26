-- P11: notifications, reminders and email delivery log
-- Additive migration from the P10 schema (schema version 2.4.0). No DROP, no data changes.

-- AlterEnum
-- (PostgreSQL 12+ allows several ADD VALUE statements in one migration; Supabase runs PostgreSQL 15+.)
ALTER TYPE "NotificationType" ADD VALUE 'TASK_DUE_SOON';
ALTER TYPE "NotificationType" ADD VALUE 'TASK_OVERDUE';
ALTER TYPE "NotificationType" ADD VALUE 'SUBMISSION_STATUS_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'DOCUMENT_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'MEETING_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE 'PROJECT_STATUS_CHANGED';

-- CreateEnum
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "notifications" ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "readAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "email_deliveries" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "subject" TEXT NOT NULL,
    "textBody" TEXT NOT NULL,
    "htmlBody" TEXT,
    "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_deliveries_status_nextAttemptAt_idx" ON "email_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "email_deliveries_notificationId_idx" ON "email_deliveries"("notificationId");

-- CreateIndex
CREATE UNIQUE INDEX "email_deliveries_userId_dedupeKey_key" ON "email_deliveries"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "meetings_projectId_scheduledAt_idx" ON "meetings"("projectId", "scheduledAt");

-- CreateIndex
CREATE INDEX "notifications_userId_isRead_createdAt_idx" ON "notifications"("userId", "isRead", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_userId_dedupeKey_key" ON "notifications"("userId", "dedupeKey");

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
