-- Storage objects whose database record was deleted but whose removal from Supabase
-- Storage is not yet confirmed. They keep counting toward the uploader's storage quota
-- until the object is removed. Additive only: no existing table or row is changed.

-- CreateEnum
CREATE TYPE "StoredObjectKind" AS ENUM ('DOCUMENT_FILE', 'PROJECT_HANDBOOK');

-- CreateEnum
CREATE TYPE "StorageDeletionStatus" AS ENUM ('PENDING', 'BLOCKED');

-- CreateTable
CREATE TABLE "storage_pending_deletions" (
    "id" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "kind" "StoredObjectKind" NOT NULL,
    "status" "StorageDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "fileSize" INTEGER,
    "uploadedById" TEXT,
    "projectId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_pending_deletions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "storage_pending_deletions_storagePath_key" ON "storage_pending_deletions"("storagePath");

-- CreateIndex
CREATE INDEX "storage_pending_deletions_uploadedById_idx" ON "storage_pending_deletions"("uploadedById");

-- CreateIndex
CREATE INDEX "storage_pending_deletions_status_nextAttemptAt_idx" ON "storage_pending_deletions"("status", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "storage_pending_deletions" ADD CONSTRAINT "storage_pending_deletions_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
