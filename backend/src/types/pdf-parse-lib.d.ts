// pdf-parse ships its library at lib/pdf-parse.js; @types/pdf-parse only types the
// package entry point (which runs a self-test when loaded without a parent module).
declare module 'pdf-parse/lib/pdf-parse.js' {
  import pdfParse = require('pdf-parse');
  export = pdfParse;
}
