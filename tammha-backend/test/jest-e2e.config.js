/**
 * REAL-DATABASE E2E smoke tests (`npm run test:e2e`).
 * Uses the developer's .env (Supabase) and is READ-ONLY. It deliberately does NOT
 * load src/testing/test-env.ts.
 *
 * rootDir is the project root (not this folder), so aliases resolve to <root>/src.
 */
const path = require('path');
const { moduleNameMapper } = require('../jest.paths');

module.exports = {
  rootDir: path.resolve(__dirname, '..'),
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper,
  testEnvironment: 'node',
  testTimeout: 30000,
  maxWorkers: 1,
};
