/**
 * Render pre-deploy step (P15):  npm run render:predeploy
 * Also used by render:start when MIGRATE_ON_START=true (free plan).
 *
 * SAFE production migration:
 * - only `prisma migrate deploy` (applies committed migrations in order; never resets,
 *   never drops the database, never creates new migrations)
 * - refuses to run without DATABASE_URL/DIRECT_URL, with placeholders, or with the
 *   IPv6-only direct host (Render has no IPv6 egress: use the Supabase pooler)
 * - prints `prisma migrate status` afterwards
 * - never prints connection strings
 */
'use strict';
const { spawnSync } = require('child_process');

function fail(message) {
  console.error(`\n[predeploy] ✖ ${message}\n`);
  process.exit(1);
}

function check(name) {
  const value = (process.env[name] || '').trim();
  if (!value) fail(`${name} is not set (Render > tammha-api > Environment).`);
  if (!/^postgres(ql)?:\/\//.test(value)) fail(`${name} is not a PostgreSQL connection string.`);
  if (/\[(YOUR-PASSWORD|PASSWORD|PROJECT_REF|REGION)\]/.test(value)) {
    fail(`${name} still contains the [PLACEHOLDERS] from the Supabase page.`);
  }
  const auth = value.replace(/^postgres(ql)?:\/\//, '').split('/')[0];
  if (auth.split('@').length !== 2 || auth.includes('#') || /\s/.test(value)) {
    fail(
      `${name}: special characters in the password (@ # / ? space...) must be URL-encoded, ` +
        'or reset the database password to letters and digits (Supabase > Project Settings > Database).',
    );
  }
  let host = '';
  try {
    host = new URL(value).hostname;
  } catch {
    fail(`${name} is not a valid URL (special characters in the password must be URL-encoded).`);
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    fail(
      `${name} uses the direct host db.<ref>.supabase.co (IPv6 only, unreachable from Render). ` +
        'Use the pooler strings from Supabase > Connect (aws-*.pooler.supabase.com).',
    );
  }
  return host;
}

const dbHost = check('DATABASE_URL');
const directHost = check('DIRECT_URL');
if (!/pgbouncer=true/.test(process.env.DATABASE_URL) && /:6543\b/.test(process.env.DATABASE_URL)) {
  console.warn('[predeploy] ! DATABASE_URL uses port 6543 without ?pgbouncer=true (Prisma needs it with the transaction pooler).');
}
console.log(`[predeploy] database hosts: runtime=${dbHost} migrations=${directHost}`);

function prisma(args) {
  const r = spawnSync('npx', ['prisma', ...args], { stdio: 'inherit', env: process.env });
  return r.status === 0;
}

console.log('[predeploy] prisma migrate deploy');
if (!prisma(['migrate', 'deploy'])) fail('prisma migrate deploy failed — the previous version keeps running.');
console.log('[predeploy] prisma migrate status');
prisma(['migrate', 'status']);
console.log('[predeploy] ✔ migrations applied');
