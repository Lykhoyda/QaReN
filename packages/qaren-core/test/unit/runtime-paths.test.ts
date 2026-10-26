import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  candidateNativeRunnerDirs,
  candidatePluginManifestFiles,
  candidateRunnerManifestFiles,
} from '../../dist/runners/runtime-paths.js';

const sourceBase = join('/repo', 'packages', 'qaren-core', 'dist', 'runners');
const runtimeBase = join('/runtime', 'runners');

test('native runner candidates include the source-checkout package path', () => {
  assert.ok(
    candidateNativeRunnerDirs('rn-fast-runner', sourceBase).includes(
      join('/repo', 'packages', 'rn-fast-runner'),
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
    candidateNativeRunnerDirs('rn-fast-runner', bundled).includes(
      join('/install', 'runtime', 'runners', 'rn-fast-runner'),
    ),
  );
  assert.ok(
    candidatePluginManifestFiles(bundled).includes(join('/install', 'runtime', 'package.json')),
  );
});
