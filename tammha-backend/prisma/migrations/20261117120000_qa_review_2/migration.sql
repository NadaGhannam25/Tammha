-- QA review 2: onboarding (college, major), account deletion, meeting notes per author

-- AlterEnum
ALTER TYPE "AuthTokenType" ADD VALUE 'ACCOUNT_DELETION';

-- AlterTable
ALTER TABLE "users" ADD COLUMN "college" TEXT,
ADD COLUMN "major" TEXT,
ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Meeting notes: one per author instead of one per meeting (existing notes stay with their author)
DROP INDEX "meeting_notes_meetingId_key";
CREATE UNIQUE INDEX "meeting_notes_meetingId_createdById_key" ON "meeting_notes"("meetingId", "createdById");
CREATE INDEX "meeting_notes_meetingId_idx" ON "meeting_notes"("meetingId");
