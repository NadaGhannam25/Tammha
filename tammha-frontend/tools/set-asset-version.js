#!/usr/bin/env node
// Sets the version (?v=...) on every local .js and .css file referenced by the HTML pages, so
// browsers load the new files after a release instead of an old cached copy.
// Run from tammha-frontend:  node tools/set-asset-version.js 20261123
'use strict';
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');
const root = path.join(__dirname, '..');
const ref = /((?:src|href)=")((?!https?:|\/\/)[\w./-]+\.(?:js|css))(?:\?v=[\w.-]*)?(")/g;

let changed = 0;
for (const name of fs.readdirSync(root).filter((f) => f.endsWith('.html'))) {
  const file = path.join(root, name);
  const before = fs.readFileSync(file, 'utf8');
  const after = before.replace(ref, (_, a, p, b) => `${a}${p}?v=${version}${b}`);
  if (after !== before) { fs.writeFileSync(file, after, 'utf8'); changed += 1; }
}
console.log(`Asset version ${version} set in ${changed} pages.`);
