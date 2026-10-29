import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  candidateNativeRunnerDirs,
  candidatePluginManifestFiles,
  candidateRunnerManifestFiles,
  legacyNativeRunnerDirHint,
  resolveNativeRunnerDir,
} from '../../dist/runners/runtime-paths.js';

const sourceBase = join('/repo', 'packages', 'qaren-core', 'dist', 'runners');
const runtimeBase = join('/runtime', 'runners');

test('native runner candidates include the source-checkout package path', () => {
  assert.ok(
    candidateNativeRunnerDirs('qaren-ios-runner', sourceBase).includes(
      join('/repo', 'packages', 'qaren-ios-runner'),
    ),
  );
});

test('native runner candidates include the installed runtime runners directory', () => {
  assert.ok(
    candidateNativeRunnerDirs('rn-android-runner', runtimeBase).includes(
      join('/runtime', 'runners', 'rn-android-runner'),
    ),
  );
});

test('runner manifest candidates include the source root and the installed runtime', () => {
  assert.ok(
    candidateRunnerManifestFiles(sourceBase).includes(join('/repo', 'runner-manifest.json')),
  );
  assert.ok(
    candidateRunnerManifestFiles(runtimeBase).includes(join('/runtime', 'runner-manifest.json')),
  );
});

test('plugin manifest candidates use the release package instead of the private core version', () => {
  const candidates = candidatePluginManifestFiles(sourceBase);
  assert.ok(
    candidates.includes(join('/repo', 'packages', 'qaren-plugin', '.claude-plugin', 'plugin.json')),
  );
  assert.ok(!candidates.includes(join('/repo', 'packages', 'qaren-core', 'package.json')));
});

test('a bundled entry in the installed tarball finds the runtime files the tarball ships', () => {
  // scripts/build-qaren-tarball.ts bundles every spawned entry into <root>/runtime/qa/.
  const bundled = join('/install', 'runtime', 'qa');
  assert.equal(
    candidateRunnerManifestFiles(bundled).find((path) => path.startsWith('/install')),
    join('/install', 'runtime', 'runner-manifest.json'),
  );
  assert.ok(
    candidateNativeRunnerDirs('qaren-ios-runner', bundled).includes(
      join('/install', 'runtime', 'runners', 'qaren-ios-runner'),
    ),
  );
  assert.ok(
    candidatePluginManifestFiles(bundled).includes(join('/install', 'runtime', 'package.json')),
  );
});

test('native runner candidates preserve override, repository, runtime and source ordering', (t) => {
  const oldNativeRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
  const oldRoot = process.env.QAREN_ROOT;
  process.env.QAREN_NATIVE_RUNNER_ROOT = '/native-override';
  process.env.QAREN_ROOT = '/repo-override';
  t.after(() => {
    if (oldNativeRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
    else process.env.QAREN_NATIVE_RUNNER_ROOT = oldNativeRoot;
    if (oldRoot === undefined) delete process.env.QAREN_ROOT;
    else process.env.QAREN_ROOT = oldRoot;
  });
  assert.deepEqual(candidateNativeRunnerDirs('qaren-ios-runner', sourceBase), [
    '/native-override/qaren-ios-runner',
    '/repo-override/packages/qaren-ios-runner',
    '/repo/packages/qaren-core/dist/runners/qaren-ios-runner',
    '/repo/packages/qaren-ios-runner',
  ]);
});

test('the legacy iOS hint names only an existing directory and never resolves it for launch', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-runtime-paths-'));
  const oldNativeRoot = process.env.QAREN_NATIVE_RUNNER_ROOT;
  const oldRoot = process.env.QAREN_ROOT;
  process.env.QAREN_NATIVE_RUNNER_ROOT = root;
  process.env.QAREN_ROOT = join(root, 'repo');
  t.after(() => {
    if (oldNativeRoot === undefined) delete process.env.QAREN_NATIVE_RUNNER_ROOT;
    else process.env.QAREN_NATIVE_RUNNER_ROOT = oldNativeRoot;
    if (oldRoot === undefined) delete process.env.QAREN_ROOT;
    else process.env.QAREN_ROOT = oldRoot;
    rmSync(root, { recursive: true, force: true });
  });
  const base = join(root, 'x', 'runtime', 'qa');
  const legacy = join(root, 'rn-fast-runner');
  assert.equal(legacyNativeRunnerDirHint('qaren-ios-runner', base), undefined);
  writeFileSync(legacy, 'not a directory');
  assert.equal(legacyNativeRunnerDirHint('qaren-ios-runner', base), undefined);
  rmSync(legacy);
  mkdirSync(legacy);
  assert.equal(
    legacyNativeRunnerDirHint('qaren-ios-runner', base),
    `found pre-2.0.4 runner directory ${legacy}; this version cannot use it: install the current runner (qaren update, or a fresh source checkout) or unset QAREN_NATIVE_RUNNER_ROOT/QAREN_ROOT`,
  );
  assert.equal(resolveNativeRunnerDir('qaren-ios-runner', base), join(root, 'qaren-ios-runner'));
  assert.equal(legacyNativeRunnerDirHint('rn-android-runner', base), undefined);
  const current = join(root, 'qaren-ios-runner');
  mkdirSync(current);
  assert.equal(resolveNativeRunnerDir('qaren-ios-runner', base), current);
  mkdirSync(join(root, 'repo', 'packages', 'rn-fast-runner'), { recursive: true });
  assert.ok(legacyNativeRunnerDirHint('qaren-ios-runner', base)?.includes(legacy));
});
