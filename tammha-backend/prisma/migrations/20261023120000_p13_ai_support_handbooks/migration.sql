-- P13: AI support (request metadata) + university handbooks (extracted text, one per university)
-- Additive migration from the P12 schema (schema version 2.6.0). No DROP, no data changes.

-- Safety check: "one official handbook per university" becomes a unique index below.
-- Stop with a clear message instead of a cryptic unique-index error if duplicates exist.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "university_handbooks" GROUP BY "universityId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'P13 migration stopped: a university has more than one handbook row. Keep one handbook per university, then run the migration again.';
  END IF;
END $$;

-- CreateEnum
CREATE TYPE "AiRequestKind" AS ENUM ('PROJECT_QUESTION', 'NEXT_STEPS', 'TASK_BREAKDOWN', 'MILESTONE_GUIDANCE', 'HANDBOOK_GUIDANCE', 'IDEA_EVALUATION', 'ROADMAP_GENERATION');

-- AlterTable
ALTER TABLE "ai_support" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "errorCode" TEXT,
ADD COLUMN     "handbookExcerpts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "handbookId" TEXT,
ADD COLUMN     "inputTokens" INTEGER,
ADD COLUMN     "kind" "AiRequestKind" NOT NULL DEFAULT 'PROJECT_QUESTION',
ADD COLUMN     "latencyMs" INTEGER,
ADD COLUMN     "model" TEXT,
ADD COLUMN     "outputTokens" INTEGER,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "result" JSONB;

-- AlterTable
ALTER TABLE "university_handbooks" ADD COLUMN     "contentType" TEXT NOT NULL DEFAULT 'application/pdf',
ADD COLUMN     "extractedChars" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "extractedText" TEXT,
ADD COLUMN     "pageCount" INTEGER,
ADD COLUMN     "uploadedById" TEXT;

-- CreateIndex
CREATE INDEX "ai_support_userId_createdAt_idx" ON "ai_support"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_support_projectId_createdAt_idx" ON "ai_support"("projectId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "university_handbooks_universityId_key" ON "university_handbooks"("universityId");

-- AddForeignKey
ALTER TABLE "university_handbooks" ADD CONSTRAINT "university_handbooks_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_support" ADD CONSTRAINT "ai_support_handbookId_fkey" FOREIGN KEY ("handbookId") REFERENCES "university_handbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
