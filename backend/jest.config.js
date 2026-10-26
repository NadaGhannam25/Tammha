/**
 * Unit + integration tests (`npm test`, `npm run test:unit`, `npm run test:integration`).
 * No database and no .env needed: values come from src/testing/test-env.ts.
 */
const { moduleNameMapper } = require('./jest.paths');

module.exports = {
  rootDir: '.',
  roots: ['<rootDir>/src'],
  testRegex: '.*\\.spec\\.ts$',
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: { '^.+\\.(t|j)s$': 'ts-jest' },
  moduleNameMapper,
  setupFiles: ['<rootDir>/src/testing/jest.setup-env.ts'],
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.spec.ts',
    '!src/testing/**',
    '!src/main.ts',
  ],
  coverageDirectory: '<rootDir>/coverage',
};
