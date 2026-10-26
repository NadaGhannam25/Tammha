/**
 * REAL Supabase Storage smoke test (P07):  npm run storage:smoke
 *
 * Uses SUPABASE_URL and SUPABASE_SECRET_KEY from the project's .env and the same
 * SupabaseStorageService the API uses.
 *
 * SAFETY
 * - Touches exactly ONE object: __p07-smoke__/<random uuid>/test.txt
 * - Lists only that unique folder; never lists, reads or deletes anything else.
 * - Never deletes or changes the bucket, never touches the database.
 * - Always tries to remove that one object, even when a check fails.
 *
 * Exit codes: 0 = all checks passed, 1 = a check failed, 2 = NOT RUN (no credentials).
 */
import { config as loadEnv } from 'dotenv';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { createClient } from '@supabase/supabase-js';
import {
  DOCUMENTS_BUCKET,
  SupabaseStorageService,
} from '../src/modules/documents/supabase-storage.service';
import { withDownloadName } from '../src/modules/documents/document-files';

loadEnv({ path: resolve(__dirname, '..', '.env') });

const url = process.env.SUPABASE_URL?.trim() ?? '';
const secret = process.env.SUPABASE_SECRET_KEY?.trim() ?? '';

if (
  !url ||
  !secret ||
  url.includes('your-project') ||
  /^(your-|\[)/.test(secret)
) {
  console.log(
    '\nNOT RUN: real Supabase Storage was NOT tested.\n' +
      '  Set SUPABASE_URL and SUPABASE_SECRET_KEY in your local .env, then run: npm run storage:smoke\n',
  );
  process.exit(2);
}

const folder = `__p07-smoke__/${randomUUID()}`;
const path = `${folder}/test.txt`;
const content = `Tammha P07 storage smoke test ${folder}`;

const client = createClient(url, secret, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});
const service = new SupabaseStorageService({
  getOrThrow: (key: string) =>
    ({ SUPABASE_URL: url, SUPABASE_SECRET_KEY: secret })[key],
} as never);

let failures = 0;
let uploaded = false;
let removed = false;

function check(name: string, ok: boolean, detail = '') {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`,
  );
  if (!ok) failures++;
}

async function listsTheObject(): Promise<boolean> {
  const { data, error } = await client.storage
    .from(DOCUMENTS_BUCKET)
    .list(folder);
  if (error) throw new Error(`list failed: ${error.message}`);
  return (data ?? []).some((entry) => entry.name === 'test.txt');
}

async function main() {
  console.log(
    `\nSupabase Storage smoke test — bucket "${DOCUMENTS_BUCKET}", object ${path}\n`,
  );

  // 1. bucket exists and is PRIVATE (read-only metadata request)
  const { data: bucket, error: bucketError } =
    await client.storage.getBucket(DOCUMENTS_BUCKET);
  check('bucket exists', !bucketError && !!bucket, bucketError?.message);
  check(
    'bucket is PRIVATE',
    bucket?.public === false,
    `public=${bucket?.public}`,
  );

  // 2. upload one tiny object
  await service.upload(path, Buffer.from(content, 'utf8'), 'text/plain');
  uploaded = true;
  check('upload temporary object', true);
  check('object exists', await listsTheObject());

  // 3. signed URL returns the content
  const signedUrl = await service.createSignedUrl(path);
  const signedRes = await fetch(signedUrl);
  const signedBody = await signedRes.text();
  check(
    'signed URL works',
    signedRes.ok && signedBody === content,
    `HTTP ${signedRes.status}`,
  );

  // 4. download URL with an Arabic file name
  const downloadRes = await fetch(withDownloadName(signedUrl, 'اختبار.txt'));
  const disposition = downloadRes.headers.get('content-disposition') ?? '';
  await downloadRes.arrayBuffer();
  check(
    'download URL sets attachment',
    downloadRes.ok && /attachment/i.test(disposition),
    disposition,
  );

  // 5. the public URL must NOT serve the file (bucket is private)
  const publicUrl = client.storage.from(DOCUMENTS_BUCKET).getPublicUrl(path)
    .data.publicUrl;
  const publicRes = await fetch(publicUrl);
  const publicBody = await publicRes.text();
  check(
    'public URL is denied',
    !(publicRes.ok && publicBody === content),
    `HTTP ${publicRes.status}`,
  );

  // 6. delete exactly that object and verify
  await service.remove([path]);
  removed = true;
  check('temporary object deleted', !(await listsTheObject()));
}

main()
  .catch((error: Error) => {
    check('unexpected error', false, error.message);
  })
  .finally(async () => {
    if (uploaded && !removed) {
      try {
        await service.remove([path]);
        console.log(`cleanup: removed ${path}`);
      } catch (error) {
        console.log(`cleanup FAILED for ${path}: ${(error as Error).message}`);
        failures++;
      }
    }
    console.log(
      failures === 0
        ? '\nRESULT: real Supabase Storage smoke test PASSED\n'
        : `\nRESULT: ${failures} check(s) FAILED\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  });
