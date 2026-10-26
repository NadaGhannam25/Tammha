/**
 * Jest `setupFiles` entry for unit + integration tests (see jest.config.js).
 * Runs in every test file BEFORE any application module is imported.
 */
import { applyTestEnv } from './test-env';

applyTestEnv();

// P13: unit/integration tests never reach the network (Gemini, LiveKit, Supabase, email).
// Any accidental call fails loudly instead of contacting a real service.
globalThis.fetch = (async (input: unknown) => {
  throw new Error(
    `Network access is disabled in unit/integration tests (attempted: ${String(input).split('?')[0]})`,
  );
}) as typeof fetch;
