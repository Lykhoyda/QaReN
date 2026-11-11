import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {
  assertVersionGate,
  evaluateHelpers,
  generateBundle,
  INTERPOLATIONS,
} from '../../../../scripts/build-injected-helpers.ts';
import { HELPERS_VERSION, INJECTED_HELPERS } from '../../dist/injected-helpers.js';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const legacy = read('../../src/runtime/legacy.program.txt');
const baseline = JSON.parse(read('../fixtures/helpers/baseline.txt'));
const sha256 = (program: string): string => createHash('sha256').update(program).digest('hex');
const originalHash = 'f41041b3c6ce53bbaec15099b93babe634e7e31321c3ab2347f2598a1687dcee';
const currentHash = 'd7d616764136987fe4356ea0a81bebeb0305c3a79cca447d10d3598e77a498e3';
const baseVersionSite = '__HELPERS_VERSION__ = 105';

// PR 1 only: later extraction PRs replace this fixed-byte oracle with the
// declared edit list and differential checks, and refresh the base fixture.
test('A: the generated program is the original evaluated bytes at version 106', () => {
  assert.equal(HELPERS_VERSION, 106);
  assert.equal(INJECTED_HELPERS.length, 225919);
  assert.equal(Buffer.byteLength(INJECTED_HELPERS), 226106);
  assert.equal(sha256(INJECTED_HELPERS), currentHash);
  assert.equal(baseline.revision, 'a3147f7878ebcffbf90879f93d3581e3e9e62b8e');
  assert.equal(sha256(baseline.program), originalHash);
  assert.equal(baseline.version, 105);
  assert.equal(baseline.program.split(baseVersionSite).length, 2);
  assert.equal(
    INJECTED_HELPERS,
    baseline.program.replace(baseVersionSite, '__HELPERS_VERSION__ = 106'),
  );
});

test('an app holding the base helpers receives the current helpers', () => {
  const context = vm.createContext({});
  vm.runInContext(baseline.program, context);
  const installed = vm.runInContext('globalThis.__QAREN', context);
  assert.equal(installed.__v, 105);
  vm.runInContext(INJECTED_HELPERS, context);
  const current = vm.runInContext('globalThis.__QAREN', context);
  assert.notEqual(current, installed);
  assert.equal(current.__v, 106);
});

test('B: the committed bundle is the current generator output', () => {
  assert.equal(generateBundle(legacy), read('../../src/injected-helpers.bundle.ts'));
});

test('the generator rejects missing, duplicated and unknown interpolation sites', () => {
  for (const { token } of INTERPOLATIONS) {
    assert.throws(() => generateBundle(legacy.replace(token, '')), /expected .* sites/);
    assert.throws(() => generateBundle(legacy + token), /expected .* sites/);
  }
  assert.throws(() => generateBundle(legacy + '@@QAREN_UNKNOWN@@'), /Unknown interpolation token/);
});

test('literal backslashes, backticks and interpolation syntax survive generation', () => {
  const literal = '\\n ` ${literal} \\ \\${stillLiteral} café\n';
  const tokens = INTERPOLATIONS.flatMap(({ token, count }) => Array(count).fill(token)).join('|');
  const source = generateBundle(literal + tokens + literal);
  const ast = ts.createSourceFile('bundle.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements
    .filter(ts.isVariableStatement)
    .flatMap((statement) => statement.declarationList.declarations)
    .find((entry) => entry.name.getText(ast) === 'INJECTED_HELPERS');
  assert.ok(declaration?.initializer);
  const program = vm.runInNewContext('(' + declaration.initializer.getText(ast) + ')', {
    HELPERS_VERSION: 105,
    TYPOGRAPHY_TEXT_LIMITS: { maxContentChars: 4096, maxTotalChars: 16384 },
    PRIVATE_INPUT_LIMITS: { maxHosts: 1000 },
    INPUT_HOST_TYPES: ['TextInput'],
  });
  assert.equal(program, literal + '105|4096|16384|1000|1000|1000|["TextInput"]' + literal);
});

test('K: evaluated source and built exports agree with the base fixture', () => {
  const current = evaluateHelpers();
  assert.deepEqual(current, { version: HELPERS_VERSION, program: INJECTED_HELPERS });
  assertVersionGate(baseline, current);
});

test('K: identical bytes keep the version, changed bytes require a higher version', () => {
  const base = { version: 105, program: 'base' };
  assertVersionGate(base, { ...base });
  assertVersionGate(base, { version: 106, program: 'changed' });
  for (const version of [104, 106]) {
    assert.throws(
      () => assertVersionGate(base, { version, program: 'base' }),
      /same HELPERS_VERSION/,
    );
  }
  for (const version of [104, 105]) {
    assert.throws(
      () => assertVersionGate(base, { version, program: 'changed' }),
      /higher HELPERS_VERSION/,
    );
  }
});

test('K: all transitive constants are read from the selected revision without fallback', () => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-helper-base-'));
  const src = join(root, 'packages/qaren-core/src');
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  try {
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'value.ts'), 'export const LIMIT: number = 1;\n');
    writeFileSync(join(src, 'constants.ts'), "export { LIMIT } from './value.js';\n");
    writeFileSync(
      join(src, 'injected-helpers.ts'),
      "import { LIMIT } from './constants.js';\n" +
        'export const HELPERS_VERSION = 105;\n' +
        'export const INJECTED_HELPERS = `limit=${LIMIT}`;\n',
    );
    git('init', '--quiet');
    git('add', '.');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Base fixture',
    );
    const revision = git('rev-parse', 'HEAD').trim();
    writeFileSync(join(src, 'value.ts'), 'export const LIMIT: number = 2;\n');
    assert.deepEqual(evaluateHelpers(revision, root), { version: 105, program: 'limit=1' });
    assert.deepEqual(evaluateHelpers(undefined, root), { version: 105, program: 'limit=2' });
    assert.throws(
      () => assertVersionGate(evaluateHelpers(revision, root), evaluateHelpers(undefined, root)),
      /higher HELPERS_VERSION/,
    );
    git('rm', '--force', 'packages/qaren-core/src/value.ts');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'Missing dependency fixture',
    );
    // Even an available working-tree file must not repair a missing historical import.
    writeFileSync(join(src, 'value.ts'), 'export const LIMIT: number = 3;\n');
    assert.throws(() => evaluateHelpers(git('rev-parse', 'HEAD').trim(), root), /value\.ts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
