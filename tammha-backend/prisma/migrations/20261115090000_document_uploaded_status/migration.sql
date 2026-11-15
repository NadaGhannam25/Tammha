-- Additive only: a new document status for regular files that were not sent for review.
-- No existing row is changed and no default is changed (the API sets the value explicitly).
ALTER TYPE "SubmissionStatus" ADD VALUE IF NOT EXISTS 'UPLOADED';
