-- P12: meetings with LiveKit rooms
-- Additive migration from the P11 schema (schema version 2.5.0). No DROP, no data changes.

-- AlterTable
ALTER TABLE "meetings" ADD COLUMN     "cancellationReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "liveKitRoomName" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "meetings_liveKitRoomName_key" ON "meetings"("liveKitRoomName");

-- CreateIndex
CREATE INDEX "meeting_attendees_userId_idx" ON "meeting_attendees"("userId");
