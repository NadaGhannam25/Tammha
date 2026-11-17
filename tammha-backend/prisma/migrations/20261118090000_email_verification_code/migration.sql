-- P17: e-mail verification by 6-digit code (wrong attempts per code; NULL for link tokens)
ALTER TABLE "auth_tokens" ADD COLUMN "attempts" INTEGER;
