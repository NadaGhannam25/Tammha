import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from '@jest/globals';
import { TEST_ENV } from './test-env';

/**
 * Guards the test infrastructure itself:
 * 1. every import alias used anywhere resolves to real files in BOTH Jest configs
 *    (unit/integration and the real-database E2E suite);
 * 2. test configuration cannot be overridden by the developer's .env.
 */

const ROOT = path.resolve(__dirname, '..', '..');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const tsconfig = require(path.join(ROOT, 'tsconfig.json'));

const CONFIGS: Record<string, string> = {
  'jest.config.js': path.join(ROOT, 'jest.config.js'),
  'test/jest-e2e.config.js': path.join(ROOT, 'test', 'jest-e2e.config.js'),
};

function listTsFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return listTsFiles(full);
    }

    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Every non-package '@...' import specifier used in
 * src/, test/ and scripts/.
 */
function aliasImports(): string[] {
  const specs = new Set<string>();

  const files = ['src', 'test', 'scripts'].flatMap((dir) =>
    listTsFiles(path.join(ROOT, dir)),
  );

  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');

    for (const match of text.matchAll(
      /from\s+'(@[^']+)'|import\s+'(@[^']+)'/g,
    )) {
      const spec = match[1] ?? match[2];

      const pkg = spec.startsWith('@/')
        ? null
        : spec.split('/').slice(0, 2).join('/');

      if (pkg && fs.existsSync(path.join(ROOT, 'node_modules', pkg))) {
        continue;
      }

      specs.add(spec);
    }
  }

  return [...specs];
}

function resolveWith(configPath: string, spec: string): string | null {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require(configPath);

  const rootDir = path.resolve(path.dirname(configPath), config.rootDir ?? '.');

  for (const [pattern, target] of Object.entries<string>(
    config.moduleNameMapper,
  )) {
    const match = spec.match(new RegExp(pattern));

    if (!match) {
      continue;
    }

    const mapped = target
      .replace('<rootDir>', rootDir)
      .replace(/\$(\d+)/g, (_, index) => match[Number(index)]);

    for (const candidate of [`${mapped}.ts`, path.join(mapped, 'index.ts')]) {
      if (fs.existsSync(candidate)) {
        return path.normalize(candidate);
      }
    }

    return null;
  }

  return null;
}

describe('Jest path aliases', () => {
  const used = aliasImports();

  it('the codebase actually uses the aliases being checked', () => {
    expect(used.some((spec) => spec.startsWith('@/'))).toBe(true);
    expect(used.some((spec) => spec.startsWith('@modules/'))).toBe(true);
    expect(used.some((spec) => spec.startsWith('@common/'))).toBe(true);
  });

  it('every alias prefix used in code is declared in tsconfig.json paths', () => {
    const declared = Object.keys(tsconfig.compilerOptions.paths).map((key) =>
      key.replace('*', ''),
    );

    const undeclared = used.filter(
      (spec) => !declared.some((prefix) => spec.startsWith(prefix)),
    );

    expect(undeclared).toEqual([]);
  });

  it.each(Object.entries(CONFIGS))(
    '%s resolves every alias import to an existing file under <root>/src',
    (_name, configPath) => {
      const normalizedSrc = path.normalize(path.join(ROOT, 'src'));

      const unresolved = used.filter((spec) => {
        const file = resolveWith(configPath, spec);
        const normalizedFile = file ? path.normalize(file) : null;

        return !normalizedFile || !normalizedFile.startsWith(normalizedSrc);
      });

      expect(unresolved).toEqual([]);
    },
  );

  it('the E2E config uses the project root as rootDir (regression: it resolved test/src)', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const e2e = require(CONFIGS['test/jest-e2e.config.js']);

    expect(path.resolve(e2e.rootDir)).toBe(ROOT);
    expect(e2e.setupFiles ?? []).toEqual([]);
  });
});

describe('Test environment isolation', () => {
  it('uses deterministic values, even after Prisma Client loads the local .env', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('@prisma/client');

    for (const [key, value] of Object.entries(TEST_ENV)) {
      expect({
        key,
        value: process.env[key],
      }).toEqual({
        key,
        value,
      });
    }
  });

  it('keeps the production-relevant defaults: 1h access token, test-only bcrypt cost', () => {
    expect(TEST_ENV.JWT_EXPIRATION).toBe('1h');
    expect(Number(TEST_ENV.BCRYPT_ROUNDS)).toBeLessThan(10);
  });
});
