/**
 * `npm run prisma:validate` — checks prisma/schema.prisma WITHOUT a database.
 *
 * The schema reads DATABASE_URL and DIRECT_URL, and `prisma validate` refuses to run
 * when they are not defined, even though it never connects. This wrapper:
 *   1. loads the local .env if there is one (your real values are left untouched);
 *   2. only if a variable is still missing, sets an obviously fake placeholder;
 *   3. runs `prisma validate` (cross-platform: no shell syntax).
 * Nothing here connects to a database.
 */
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PLACEHOLDER = 'postgresql://validate-only:validate-only@localhost:5432/validate_only';
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  if (!process.env[key]) process.env[key] = PLACEHOLDER;
}

const prismaCli = require.resolve('prisma/build/index.js');
const result = spawnSync(process.execPath, [prismaCli, 'validate'], {
  stdio: 'inherit',
  env: process.env,
});
process.exit(result.status ?? 1);
