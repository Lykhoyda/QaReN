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
  assertFragmentSyntax,
  assertVersionGate,
  buildRuntimeFragment,
  evaluateHelpers,
  generateBundle,
  INTERPOLATIONS,
  RUNTIME_MARKER,
} from '../../../../scripts/build-injected-helpers.ts';
import { HELPERS_VERSION, INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { DECLARED_EDITS } from '../fixtures/helpers/edits.ts';
import { applyEdits, removeDeclarations } from './helpers/program-edits.ts';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const legacy = read('../../src/runtime/legacy.program.txt');
const baseline = JSON.parse(read('../fixtures/helpers/baseline.txt'));
const fragment = buildRuntimeFragment();
const sha256 = (program: string): string => createHash('sha256').update(program).digest('hex');

test('the base fixture is develop at version 107', () => {
  assert.equal(baseline.revision, '4a9bb464e047151c172c237cc3caddc8e83f806c');
  assert.equal(baseline.version, 107);
  assert.equal(
    sha256(baseline.program),
    '90fef0bbd29b4f9d54ae8ff3140eca74c86f20f0ccf82f848c2794d3f2c19694',
  );
  assert.equal(HELPERS_VERSION, baseline.version + 1);
});

test('C: the program outside the fragment is the base program with the declared edits', () => {
  const parts = INJECTED_HELPERS.split(fragment);
  assert.equal(parts.length, 2, 'the fragment appears once');
  assert.equal(parts.join(RUNTIME_MARKER), applyEdits(baseline.program, DECLARED_EDITS));
});

test('C: the replay refuses undeclared or ambiguous edits', () => {
  assert.throws(
    () => applyEdits(baseline.program, { ...DECLARED_EDITS, removals: [{ name: 'notDeclared' }] }),
    /expected one declaration, found 0/,
  );
  assert.throws(
    () => removeDeclarations(baseline.program, [{ name: 'qaData' }, { name: 'qaData' }]),
    /overlaps another removal/,
  );
  assert.throws(
    () =>
      applyEdits(baseline.program, {
        ...DECLARED_EDITS,
        replacements: [{ from: '= 106;', to: '= 108;', count: 1 }],
      }),
    /expected 1 occurrences, found 0/,
  );
});

test('L: an app holding the base helpers receives the current helpers', () => {
  const context = vm.createContext({});
  vm.runInContext(baseline.program, context);
  const installed = vm.runInContext('globalThis.__QAREN', context);
  assert.equal(installed.__v, baseline.version);
  vm.runInContext(INJECTED_HELPERS, context);
  const current = vm.runInContext('globalThis.__QAREN', context);
  assert.notEqual(current, installed);
  assert.equal(current.__v, HELPERS_VERSION);
  assert.equal(
    vm.runInContext('typeof __rt', context),
    'undefined',
    'the fragment binding stays local',
  );
});

test('F: the fragment is one ES2015 script statement without module or strict-mode syntax', () => {
  assert.match(fragment, /^  \(\(\) => \{\n/);
  const growth =
    (Buffer.byteLength(INJECTED_HELPERS) - Buffer.byteLength(baseline.program)) /
    Buffer.byteLength(baseline.program);
  console.log(
    `runtime fragment ${Buffer.byteLength(fragment)} bytes; program growth ${(growth * 100).toFixed(2)}%`,
  );
  assert.ok(growth < 0.05, 'stop condition S6: the program grows by less than 5%');
});

test('F: forbidden constructs fail generation with their cause', () => {
  for (const [source, cause] of [
    ['(() => {\n  "use strict";\n})();', /directive "use strict"/],
    ['(() => { class A {} })();', /a class/],
    ['(async () => {})();', /async/],
    ['(() => { function* g() {} })();', /a generator/],
    ['(() => { require("x"); })();', /require/],
    ['(() => { import("x"); })();', /import\(\)/],
    ['(() => { var __defProp = Object.defineProperty; })();', /bundler helper __defProp/],
    ['(() => {})(); (() => {})();', /one expression statement/],
    ['(() => {', /does not parse/],
  ] as const) {
    assert.throws(() => assertFragmentSyntax(source), cause, source);
  }
});

test('the generator refuses a fragment whose exports and aliases disagree', () => {
  const missing = fragment.replace(/\n\s*hostKind\n/, '\n');
  assert.notEqual(missing, fragment);
  assert.throws(
    () => generateBundle(legacy, missing.replace(/isHostFiber,/, 'isHostFiber')),
    /Alias hostKind is missing/,
  );
  assert.throws(
    () => generateBundle(legacy.replace('  var hostKind = __rt.hostKind;\n', ''), fragment),
    /Runtime export hostKind has no alias/,
  );
  assert.throws(
    () => generateBundle(legacy + '\nqaData = null;\n', fragment),
    /qaData is still declared or assigned in the program text/,
  );
  assert.throws(
    () => generateBundle(legacy + '\nfunction qaData() {}\n', fragment),
    /qaData is still declared or assigned in the program text/,
  );
  assert.throws(
    () => generateBundle(legacy.replace('  var __rt;\n', ''), fragment),
    /must follow "var __rt;"/,
  );
  assert.throws(() => generateBundle(legacy + RUNTIME_MARKER, fragment), /expected one marker/);
});

test('B: the committed bundle is the current generator output', () => {
  assert.equal(generateBundle(legacy, fragment), read('../../src/injected-helpers.bundle.ts'));
});

test('the generator rejects missing, duplicated and unknown interpolation sites', () => {
  for (const { token } of INTERPOLATIONS) {
    assert.throws(() => generateBundle(legacy.replace(token, ''), fragment), /expected .* sites/);
    assert.throws(() => generateBundle(legacy + token, fragment), /expected .* sites/);
  }
  assert.throws(
    () => generateBundle(legacy + '@@QAREN_UNKNOWN@@', fragment),
    /Unknown interpolation token/,
  );
});

test('literal backslashes, backticks and interpolation syntax survive generation', () => {
  const literal = '\\n ` ${literal} \\ \\${stillLiteral} café\n';
  const tokens = INTERPOLATIONS.flatMap(({ token, count }) => Array(count).fill(token)).join('|');
  const runtime = '  var __rt;\n' + RUNTIME_MARKER + '\n  var value = __rt.value;\n';
  const literalFragment = '(() => { __rt = { value: "\\\\ ` ${x}" }; })();';
  const source = generateBundle(runtime + literal + tokens + literal, literalFragment);
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
  });
  assert.equal(
    program,
    '  var __rt;\n' +
      literalFragment +
      '\n  var value = __rt.value;\n' +
      literal +
      '105|4096|16384|1000|1000|1000' +
      literal,
  );
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
