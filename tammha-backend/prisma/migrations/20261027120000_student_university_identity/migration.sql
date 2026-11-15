-- Student university identity (follow-up to P16).
-- A STUDENT is identified by a student number (unique per university) OR a VERIFIED
-- university e-mail (unique). Additive only: no DROP, and no existing row is changed.
-- Existing students with neither identifier are NOT given fake values: the application
-- reports them as profile-incomplete until they add and verify one.

-- AlterEnum (the new value is not used inside this migration)
ALTER TYPE "AuthTokenType" ADD VALUE 'UNIVERSITY_EMAIL_VERIFICATION';

-- AlterTable
ALTER TABLE "universities" ADD COLUMN     "emailDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "pendingUniversityEmail" TEXT,
ADD COLUMN     "universityEmail" TEXT,
ADD COLUMN     "universityEmailVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "auth_tokens" ADD COLUMN     "email" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_universityEmail_key" ON "users"("universityEmail");
