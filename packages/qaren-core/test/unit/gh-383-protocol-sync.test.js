// GH #383: the /command wire protocol is versioned by a constant that exists
// in THREE files — TS bridge, Swift runner, Kotlin runner. This tri-file sync
// test is the CI guard that they agree (same style as the gh-374 static
// invariant: grep the sources, not the runtime).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(BRIDGE_ROOT, '..', '..');

function extract(path, regex) {
  const src = readFileSync(path, 'utf8');
  const m = src.match(regex);
  assert.ok(m, `${path} must declare the protocol constant (${regex})`);
  return Number(m[1]);
}

test('gh-383: RUNNER_PROTOCOL_VERSION agrees across TS, Swift, and Kotlin', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'runners', 'protocol.ts'),
    /export const RUNNER_PROTOCOL_VERSION = (\d+);/,
  );
  const swift = extract(
    join(
      REPO_ROOT,
      'packages',
      'rn-fast-runner',
      'RnFastRunner',
      'RnFastRunnerUITests',
      'RunnerProtocol.swift',
    ),
    /static let version = (\d+)/,
  );
  const kotlin = extract(
    join(
      REPO_ROOT,
      'packages',
      'rn-android-runner',
      'app',
      'src',
      'main',
      'java',
      'dev',
      'lykhoyda',
      'rndevagent',
      'androidrunner',
      'RunnerProtocol.kt',
    ),
    /const val VERSION = (\d+)/,
  );
  assert.equal(swift, ts, 'Swift RunnerProtocol.version must match protocol.ts');
  assert.equal(kotlin, ts, 'Kotlin RunnerProtocol.VERSION must match protocol.ts');
});

test('gh-383: MIN_SUPPORTED_RUNNER_PROTOCOL <= RUNNER_PROTOCOL_VERSION', () => {
  const src = readFileSync(join(BRIDGE_ROOT, 'src', 'runners', 'protocol.ts'), 'utf8');
  const min = Number(src.match(/export const MIN_SUPPORTED_RUNNER_PROTOCOL = (\d+);/)?.[1]);
  const cur = Number(src.match(/export const RUNNER_PROTOCOL_VERSION = (\d+);/)?.[1]);
  assert.ok(Number.isInteger(min) && Number.isInteger(cur));
  assert.ok(min <= cur);
});

import { classifyRunnerCompatibility } from '../../dist/runners/protocol.js';

test('gh-383 classify: missing protocolVersion → legacy', () => {
  assert.deepEqual(classifyRunnerCompatibility({}, '0.58.0'), {
    compatible: false,
    reason: 'legacy',
  });
});

test('gh-383 classify: older / equal / newer protocol', () => {
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 0 }, null), {
    compatible: false,
    reason: 'protocol-older',
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, null), {
    compatible: true,
  });
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 99 }, null), {
    compatible: false,
    reason: 'protocol-newer',
  });
});

test('gh-383 classify: version-skew only when both sides known', () => {
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, '0.57.3'),
    { compatible: false, reason: 'version-skew' },
  );
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.3' }, '0.57.3'),
    { compatible: true },
  );
  assert.deepEqual(classifyRunnerCompatibility({ protocolVersion: 1 }, '0.57.3'), {
    compatible: true,
  });
  assert.deepEqual(
    classifyRunnerCompatibility({ protocolVersion: 1, runnerVersion: '0.57.1' }, null),
    { compatible: true },
  );
});
