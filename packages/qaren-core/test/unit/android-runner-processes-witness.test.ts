// The stale-runner reaper verifies release with `dumpsys activity processes <runner>`.
// The fixtures are real API 37 emulator output, shared with the CLI's cleanup tests:
// that image answers `dumpsys activity instrumentation` with an error and exit 0
// whether or not the runner is instrumenting, so only a recognised processes dump
// may read as absence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { androidRunnerProcessListed } from '../../dist/runners/rn-android-runner-client.js';

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'qaren-cli',
  'tests',
  'fixtures',
);
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

test('a recognised processes dump lists the instrumenting runner', () => {
  assert.equal(androidRunnerProcessListed(fixture('android-runner-processes-running.txt')), true);
});

test('a recognised processes dump without the runner reads as absence', () => {
  assert.equal(androidRunnerProcessListed(fixture('android-runner-processes-stopped.txt')), false);
});

test('unrecognised output never reads as absence', () => {
  for (const stdout of [
    fixture('android-dumpsys-unsupported.txt'),
    '',
    '\n',
    "Can't find service: activity\n",
  ]) {
    assert.equal(androidRunnerProcessListed(stdout), undefined, JSON.stringify(stdout));
  }
});
