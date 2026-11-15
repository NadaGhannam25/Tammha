/**
 * Build guard: ensure the pinned, reviewed transitive dependency updates were
 * resolved into package-lock.json. This does not imply zero remaining advisories.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const requiredOverrides = {
  multer: '2.5.0', qs: '6.17.1', lodash: '4.18.1',
};
const problems = [];
for (const [name, ver] of Object.entries(requiredOverrides)) {
  if (pkg.overrides?.[name] !== ver) problems.push(`package.json override ${name} must be ${ver}`);
  if (lock.packages?.[`node_modules/${name}`]?.version !== ver) {
    problems.push(`package-lock.json ${name} must resolve ${ver}`);
  }
}
const nested = [
  ['@nestjs/platform-express', 'body-parser', '1.20.9'],
  ['@nestjs/swagger', 'js-yaml', '4.3.2'],
  ['@nestjs/schedule', 'uuid', '11.1.1'],
];
for (const [owner, name, ver] of nested) {
  if (pkg.overrides?.[owner]?.[name] !== ver) {
    problems.push(`package.json ${owner}/${name} override must be ${ver}`);
  }
  const packagePaths = Object.entries(lock.packages || {});
  const matches = packagePaths.filter(([k]) =>
    k === `node_modules/${name}` || k.includes(`/node_modules/${name}`));
  if (!matches.some(([, info]) => info.version === ver)) {
    problems.push(`package-lock.json must resolve ${name}@${ver}`);
  }
}
if (problems.length) {
  console.error('[security] Update is not finalized. Run RUN_SECURITY_FIXES.cmd on your machine first.');
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.log('[security] Reviewed targeted overrides exist in the lockfile.');
console.log('[security] This is NOT a full security clearance; inspect npm audit before publishing.');
