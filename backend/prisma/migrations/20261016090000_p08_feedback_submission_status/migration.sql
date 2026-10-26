-- P08: supervisor feedback, submission status, optional score/rubric
-- Additive migration from P07 schema to P08 schema.

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "documents"
ADD COLUMN "reviewStatus" "SubmissionStatus" NOT NULL DEFAULT 'SUBMITTED',
ADD COLUMN "reviewStatusUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "feedbacks"
ADD COLUMN "documentId" TEXT,
ADD COLUMN "documentVersion" INTEGER,
ADD COLUMN "status" "SubmissionStatus",
ADD COLUMN "score" DOUBLE PRECISION,
ADD COLUMN "maxScore" DOUBLE PRECISION,
ADD COLUMN "rubric" JSONB,
ADD COLUMN "scoreVisibleToStudents" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "receivedById" DROP NOT NULL,
ALTER COLUMN "rating" DROP NOT NULL,
ALTER COLUMN "category" SET DEFAULT 'GENERAL';

-- CreateIndex
CREATE INDEX "documents_projectId_reviewStatus_idx" ON "documents"("projectId", "reviewStatus");

-- CreateIndex
CREATE INDEX "feedbacks_documentId_idx" ON "feedbacks"("documentId");

-- AddForeignKey
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
