-- Additive language preference. Existing accounts default to Arabic.
-- Safe to apply once; preserves all existing account and notification data.
ALTER TABLE "users" ADD COLUMN "preferredLanguage" TEXT NOT NULL DEFAULT 'ar';
ALTER TABLE "users" ADD CONSTRAINT "users_preferredLanguage_check" CHECK ("preferredLanguage" IN ('ar', 'en'));
