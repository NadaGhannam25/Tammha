/**
 * REAL LiveKit Cloud smoke test (P12):  npm run livekit:smoke
 *
 * Uses LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET from the project's .env
 * (validated exactly like the API does) and the same LiveKit adapter the API uses.
 *
 * SAFETY
 * - Touches exactly ONE temporary room: tammha-smoke-<random uuid>
 * - Never lists, changes or deletes any other room; always tries to delete its own room.
 * - Never prints the API secret or a token (unless you pass --print-join-token, see below).
 * - Never touches the database.
 *
 * Optional: --print-join-token prints a 10-minute token for the temporary room so you can
 * join it from https://meet.livekit.io (Custom tab: paste the URL and the token). The room is
 * then NOT deleted by the script (LiveKit closes it about a minute after everyone leaves).
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = NOT RUN (LiveKit not configured).
 */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { RoomServiceClient } from 'livekit-server-sdk';
import { readIntegrationsConfig } from '../src/integrations/integrations.config';
import {
  LiveKitMeetingVideoProvider,
  toWebSocketUrl,
} from '../src/integrations/meetings/livekit-meeting-video.provider';

loadEnv({ path: resolve(__dirname, '..', '.env') });

const printJoinToken = process.argv.includes('--print-join-token');
const { config, errors } = readIntegrationsConfig(process.env);
type EnabledLiveKit = Extract<typeof config.livekit, { enabled: true }>;

function enabledLiveKit(): EnabledLiveKit | null {
  const lk = config.livekit;
  if (!lk.enabled || errors.some((e) => e.startsWith('LIVEKIT_'))) return null;
  return lk;
}

const maybeLiveKit = enabledLiveKit();
if (!maybeLiveKit) {
  console.log(
    '\nNOT RUN: real LiveKit was NOT tested.\n' +
      (errors.length
        ? `  Problems (variable names only):\n  - ${errors.join('\n  - ')}\n`
        : '') +
      '  Set LIVEKIT_ENABLED=true, LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET in your\n' +
      '  local .env, then run: npm run livekit:smoke\n',
  );
  process.exit(2);
}
const livekit: EnabledLiveKit = maybeLiveKit;

const room = `tammha-smoke-${randomUUID()}`;
const httpUrl = toWebSocketUrl(livekit.url)
  .replace(/^wss:\/\//, 'https://')
  .replace(/^ws:\/\//, 'http://');
const rooms = new RoomServiceClient(httpUrl, livekit.apiKey, livekit.apiSecret);

let failures = 0;
let created = false;
let deleted = false;

function check(name: string, ok: boolean, detail = '') {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
  if (!ok) failures++;
}

async function main() {
  console.log(
    `\nLiveKit smoke test — server ${toWebSocketUrl(livekit.url)}, room ${room}\n`,
  );

  // 1. a join token is signed locally (no network)
  const provider = new LiveKitMeetingVideoProvider(livekit);
  const creds = await provider.createJoinCredentials({
    roomName: room,
    identity: 'tammha-smoke-user',
    displayName: 'Tammha smoke test',
    canPublish: true,
    ttlSeconds: 600,
  });
  check('join token signed', creds.token.split('.').length === 3);
  check(
    'secret not in the response',
    !JSON.stringify(creds).includes(livekit.apiSecret),
  );

  // 2. the API key/secret are accepted by LiveKit Cloud (server API call)
  await rooms.createRoom({ name: room, emptyTimeout: 60, maxParticipants: 5 });
  created = true;
  check(
    'LiveKit accepted the API key and secret (temporary room created)',
    true,
  );
  const found = await rooms.listRooms([room]);
  check(
    'temporary room exists',
    found.some((r) => r.name === room),
  );

  if (printJoinToken) {
    console.log(
      '\nJoin test (valid 10 minutes): open https://meet.livekit.io -> Custom\n' +
        `  LiveKit URL: ${creds.serverUrl}\n` +
        `  Token:       ${creds.token}\n` +
        '  Do not share this token. The room closes ~1 minute after everyone leaves.\n',
    );
    return;
  }

  // 3. clean up exactly that room
  await rooms.deleteRoom(room);
  deleted = true;
  const after = await rooms.listRooms([room]);
  check('temporary room deleted', !after.some((r) => r.name === room));
}

main()
  .catch((error: Error) => {
    // message only: the SDK never includes the secret in errors
    check('unexpected error', false, error.message);
  })
  .finally(async () => {
    if (created && !deleted && !printJoinToken) {
      try {
        await rooms.deleteRoom(room);
        console.log(`cleanup: deleted ${room}`);
      } catch (error) {
        console.log(`cleanup FAILED for ${room}: ${(error as Error).message}`);
        failures++;
      }
    }
    console.log(
      failures === 0
        ? '\nRESULT: real LiveKit smoke test PASSED\n'
        : `\nRESULT: ${failures} check(s) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
