/** Offline, read-only review of pending migrations. No DB connection or SQL execution. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const dir = path.join(root, 'prisma', 'migrations');
const entries = fs.readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory()).map((e) => e.name).sort();
const lastFive = entries.slice(-5);
console.log(`Local migration folders: ${entries.length}`);
console.log('Last 5 (NOT proof they are pending on the real DB):');
for (const name of lastFive) {
  const file = path.join(dir, name, 'migration.sql');
  const sql = fs.readFileSync(file, 'utf8');
  const drops = sql.match(/\bDROP\s+(?:INDEX|TYPE|TABLE|COLUMN)\b|\bDROP\s+COLUMN\b/gi) || [];
  console.log(` - ${name}: ${drops.length} DROP operations`);
}
console.log('Important: Last migration has DROP INDEX, DROP TYPE, DROP COLUMN and user-facing scope changes.');
console.log('REAL Supabase migration status is UNKNOWN without the database connection.');
console.log('DO NOT run prisma migrate deploy until database contents and scope are approved.');
