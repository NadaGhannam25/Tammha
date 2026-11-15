/**
 * Apply narrowly scoped security overrides to the existing Nest 10 dependency graph.
 * Does not install packages or touch databases. Run through RUN_SECURITY_FIXES.cmd,
 * which creates a backup, regenerates package-lock.json and runs all 948 tests.
 * This is NOT a NestJS major upgrade; remaining audit findings require review.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const filename = path.join(__dirname, '..', 'package.json');
const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
data.overrides = {
  ...data.overrides,
  // Fixed in 2.5.0 (GHSA-q7qp-rjg7-q26m).
  multer: '2.5.0',
  // qs 6.17.1 resolves the advisory on earlier 6.x releases.
  qs: '6.17.1',
  // Fixed lodash 4.x release; preserves its major version.
  lodash: '4.18.1',
  // Nest 10 uses body-parser 1.x; do NOT force body-parser 1.x on Express 5.
  '@nestjs/platform-express': {
    ...(data.overrides?.['@nestjs/platform-express'] || {}),
    'body-parser': '1.20.9',
  },
  // Nest Swagger 7 uses js-yaml 4.x; do NOT override other 3.x consumers.
  '@nestjs/swagger': {
    ...(data.overrides?.['@nestjs/swagger'] || {}),
    'js-yaml': '4.3.2',
  },
  // Schedule 4 consumes uuid 11; patch within that major.
  '@nestjs/schedule': {
    ...(data.overrides?.['@nestjs/schedule'] || {}),
    uuid: '11.1.1',
  },
};
fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('[security] Targeted overrides applied to package.json.');
console.log('[security] Next: npm install to regenerate package-lock.json; then verify.');
