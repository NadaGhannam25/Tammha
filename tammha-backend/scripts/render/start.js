/**
 * Render start command (P15):  npm run render:start
 * - MIGRATE_ON_START=true runs committed migrations before boot (MAY DROP COLUMNS).
 *   Leave it false until pending SQL is reviewed and a database backup is verified.
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
