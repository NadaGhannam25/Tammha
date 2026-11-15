-- Pre-integration updates. Additive except where noted; no data is reset.

-- 1) Multiple projects per student: a student may belong to several teams
--    (still never twice in the same team: team_members_teamId_userId_key stays).
DROP INDEX "team_members_userId_key";
CREATE INDEX "team_members_userId_idx" ON "team_members"("userId");

-- 2) Supervisor accounts are created by an ADMIN; the supervisor sets the first
--    password with an activation link (public self-registration is STUDENT only).
ALTER TYPE "AuthTokenType" ADD VALUE 'ACCOUNT_ACTIVATION';

-- 3) Handbook library: University -> College -> Major/Department -> Handbook -> Version.
CREATE TYPE "HandbookSource" AS ENUM ('UPLOAD', 'LIBRARY');

CREATE TABLE "colleges" (
    "id" TEXT NOT NULL,
    "universityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "colleges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "colleges_universityId_name_key" ON "colleges"("universityId", "name");
CREATE INDEX "colleges_universityId_idx" ON "colleges"("universityId");
ALTER TABLE "colleges" ADD CONSTRAINT "colleges_universityId_fkey" FOREIGN KEY ("universityId") REFERENCES "universities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "majors" (
    "id" TEXT NOT NULL,
    "collegeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "code" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "majors_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "majors_collegeId_name_key" ON "majors"("collegeId", "name");
CREATE INDEX "majors_collegeId_idx" ON "majors"("collegeId");
ALTER TABLE "majors" ADD CONSTRAINT "majors_collegeId_fkey" FOREIGN KEY ("collegeId") REFERENCES "colleges"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "library_handbooks" (
    "id" TEXT NOT NULL,
    "universityId" TEXT NOT NULL,
    "collegeId" TEXT,
    "majorId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isUniversityDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "library_handbooks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "library_handbooks_universityId_collegeId_majorId_idx" ON "library_handbooks"("universityId", "collegeId", "majorId");
ALTER TABLE "library_handbooks" ADD CONSTRAINT "library_handbooks_universityId_fkey" FOREIGN KEY ("universityId") REFERENCES "universities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_handbooks" ADD CONSTRAINT "library_handbooks_collegeId_fkey" FOREIGN KEY ("collegeId") REFERENCES "colleges"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "library_handbooks" ADD CONSTRAINT "library_handbooks_majorId_fkey" FOREIGN KEY ("majorId") REFERENCES "majors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing university handbooks become version 1 of each university's default library handbook.
ALTER TABLE "university_handbooks" ADD COLUMN "handbookId" TEXT;
ALTER TABLE "university_handbooks" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "university_handbooks" ADD COLUMN "versionLabel" TEXT NOT NULL DEFAULT '1';
ALTER TABLE "university_handbooks" ADD COLUMN "isCurrent" BOOLEAN NOT NULL DEFAULT true;

INSERT INTO "library_handbooks" ("id", "universityId", "title", "description", "isUniversityDefault", "createdAt", "updatedAt")
SELECT 'lib_' || h."id", h."universityId", h."title", h."description", true, h."uploadedAt", h."updatedAt"
FROM "university_handbooks" h;
UPDATE "university_handbooks" SET "handbookId" = 'lib_' || "id";

ALTER TABLE "university_handbooks" ALTER COLUMN "handbookId" SET NOT NULL;
DROP INDEX "university_handbooks_universityId_key";
CREATE UNIQUE INDEX "university_handbooks_handbookId_version_key" ON "university_handbooks"("handbookId", "version");
CREATE INDEX "university_handbooks_handbookId_isCurrent_idx" ON "university_handbooks"("handbookId", "isCurrent");
ALTER TABLE "university_handbooks" ADD CONSTRAINT "university_handbooks_handbookId_fkey" FOREIGN KEY ("handbookId") REFERENCES "library_handbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The project's handbook: a selected library version (LIBRARY) or its own upload (UPLOAD / null).
ALTER TABLE "projects" ADD COLUMN "handbookSource" "HandbookSource";
ALTER TABLE "projects" ADD COLUMN "libraryHandbookId" TEXT;
CREATE INDEX "projects_libraryHandbookId_idx" ON "projects"("libraryHandbookId");
ALTER TABLE "projects" ADD CONSTRAINT "projects_libraryHandbookId_fkey" FOREIGN KEY ("libraryHandbookId") REFERENCES "university_handbooks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AI explanation of a handbook version (cached per version and language).
CREATE TABLE "handbook_explanations" (
    "id" TEXT NOT NULL,
    "universityHandbookId" TEXT,
    "projectHandbookId" TEXT,
    "language" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "pageCount" INTEGER,
    "pagesIncluded" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "handbook_explanations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "handbook_explanations_universityHandbookId_language_key" ON "handbook_explanations"("universityHandbookId", "language");
CREATE UNIQUE INDEX "handbook_explanations_projectHandbookId_language_key" ON "handbook_explanations"("projectHandbookId", "language");
ALTER TABLE "handbook_explanations" ADD CONSTRAINT "handbook_explanations_universityHandbookId_fkey" FOREIGN KEY ("universityHandbookId") REFERENCES "university_handbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "handbook_explanations" ADD CONSTRAINT "handbook_explanations_projectHandbookId_fkey" FOREIGN KEY ("projectHandbookId") REFERENCES "project_handbooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4) AI: handbook explanation added; AI project-idea evaluation removed (never used).
UPDATE "ai_support" SET "kind" = 'PROJECT_QUESTION' WHERE "kind" = 'IDEA_EVALUATION';
UPDATE "ai_messages" SET "kind" = 'PROJECT_QUESTION' WHERE "kind" = 'IDEA_EVALUATION';
ALTER TYPE "AiRequestKind" RENAME TO "AiRequestKind_old";
CREATE TYPE "AiRequestKind" AS ENUM ('PROJECT_QUESTION', 'NEXT_STEPS', 'TASK_BREAKDOWN', 'MILESTONE_GUIDANCE', 'HANDBOOK_GUIDANCE', 'HANDBOOK_EXPLANATION', 'ROADMAP_GENERATION');
ALTER TABLE "ai_support" ALTER COLUMN "kind" DROP DEFAULT;
ALTER TABLE "ai_support" ALTER COLUMN "kind" TYPE "AiRequestKind" USING ("kind"::text::"AiRequestKind");
ALTER TABLE "ai_support" ALTER COLUMN "kind" SET DEFAULT 'PROJECT_QUESTION';
ALTER TABLE "ai_messages" ALTER COLUMN "kind" TYPE "AiRequestKind" USING ("kind"::text::"AiRequestKind");
DROP TYPE "AiRequestKind_old";

-- 5) Supervisor feedback on a task. Academic grading removed: Tammha keeps written
--    feedback and review decisions only (rating, score, rubric columns are dropped).
ALTER TABLE "feedbacks" ADD COLUMN "taskId" TEXT;
CREATE INDEX "feedbacks_taskId_idx" ON "feedbacks"("taskId");
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feedbacks" DROP COLUMN "rating";
ALTER TABLE "feedbacks" DROP COLUMN "score";
ALTER TABLE "feedbacks" DROP COLUMN "maxScore";
ALTER TABLE "feedbacks" DROP COLUMN "rubric";
ALTER TABLE "feedbacks" DROP COLUMN "scoreVisibleToStudents";

-- 6) Meeting notes: who wrote and who last edited them.
ALTER TABLE "meeting_notes" ADD COLUMN "createdById" TEXT;
ALTER TABLE "meeting_notes" ADD COLUMN "updatedById" TEXT;
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "meeting_notes" ADD CONSTRAINT "meeting_notes_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
