// Builds style-ltr.css (English, left-to-right) from style.css (Arabic, right-to-left).
// The site loads style.css in Arabic and style-ltr.css in English (see i18n.js).
// Run after changing style.css:
//   npm install --no-save rtlcss@4.3.0 postcss@8.4.47
//   node tools/build-ltr-css.js
const fs = require('fs');
const path = require('path');
const postcss = require('postcss');
const rtlcss = require('rtlcss');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const flipped = postcss.parse(rtlcss.process(css));
// rtlcss keeps 4-value "inset" shorthands as they are: swap their right / left values.
flipped.walkDecls('inset', (d) => {
  const v = postcss.list.space(d.value);
  if (v.length === 4) d.value = [v[0], v[3], v[2], v[1]].join(' ');
});
const banner = '/* GENERATED from style.css by tools/build-ltr-css.js — do not edit by hand. English (LTR) layout. */\n';
fs.writeFileSync(path.join(root, 'style-ltr.css'), banner + flipped.toString());
console.log('style-ltr.css written');
