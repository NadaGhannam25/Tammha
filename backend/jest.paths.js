/**
 * Single source of truth for import aliases in Jest: derived from tsconfig.json
 * "paths" (the same file TypeScript, ESLint and the build use).
 *
 * Shared by jest.config.js (unit + integration) and test/jest-e2e.config.js.
 * Both configs set rootDir to the PROJECT ROOT, so '<rootDir>/src/...' is correct
 * in both (portable on Windows, macOS and Linux).
 */
const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig.json');

const moduleNameMapper = pathsToModuleNameMapper(compilerOptions.paths, {
  prefix: '<rootDir>/',
});

module.exports = { moduleNameMapper };
