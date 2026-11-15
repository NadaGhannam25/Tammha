-- Student storage quota (shared across all projects of a student).
-- Additive: each stored document version records its size (bytes) and the account that
-- uploaded it, so usage can be calculated per uploader from file metadata (no counter).

-- AlterTable
ALTER TABLE "document_versions" ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "uploadedById" TEXT;

-- Backfill (best information available before this migration):
--  * uploader of existing versions = the document's uploader (versions did not record it)
--  * size is known only for the CURRENT version (documents.fileSize describes the current
--    file); older versions keep NULL until `npm run storage:reconcile` reads their size
--    from Supabase Storage. Nothing is invented.
UPDATE "document_versions" AS v
SET "uploadedById" = d."uploadedById"
FROM "documents" AS d
WHERE v."documentId" = d."id" AND v."uploadedById" IS NULL;

UPDATE "document_versions" AS v
SET "fileSize" = d."fileSize"
FROM "documents" AS d
WHERE v."documentId" = d."id" AND v."fileUrl" = d."fileUrl" AND v."fileSize" IS NULL;

-- CreateIndex
CREATE INDEX "document_versions_uploadedById_idx" ON "document_versions"("uploadedById");

-- CreateIndex
CREATE INDEX "project_handbooks_uploadedById_idx" ON "project_handbooks"("uploadedById");

-- AddForeignKey
ALTER TABLE "document_versions" ADD CONSTRAINT "document_versions_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
