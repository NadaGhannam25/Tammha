/**
 * Render start command (P15):  npm run render:start
 * - MIGRATE_ON_START=true (free plan, which has no pre-deploy step): runs the same safe
 *   `prisma migrate deploy` first; if it fails, the app does not start.
 * - then starts the compiled NestJS app (dist/main.js). Render provides PORT.
 */
'use strict';
const { spawnSync } = require('child_process');
const { join } = require('path');

if (/^(true|1|yes)$/i.test((process.env.MIGRATE_ON_START || '').trim())) {
  const r = spawnSync(process.execPath, [join(__dirname, 'predeploy.js')], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}
require(join(__dirname, '..', '..', 'dist', 'main.js'));
