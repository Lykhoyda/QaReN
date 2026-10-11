// `qaren cleanup` releases the core's Android runner from Rust, without a Node
// runtime, so the CLI names the runner's device port and packages itself. This
// sync test pins them equal to the core's (same style as gh-383-protocol-sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNED_PACKAGES } from '../../dist/runners/release-android-slot.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ANDROID = readFileSync(
  join(CORE_ROOT, '..', 'qaren-cli', 'src', 'adapters', 'android.rs'),
  'utf8',
);
const CLIENT = readFileSync(
  join(CORE_ROOT, 'src', 'runners', 'rn-android-runner-client.ts'),
  'utf8',
);

function match(src: string, regex: RegExp, what: string): RegExpMatchArray {
  const m = src.match(regex);
  assert.ok(m, `${what} must be declared (${regex})`);
  return m;
}

test('the CLI runner device port equals the core DEFAULT_PORT', () => {
  const cli = Number(
    match(CLI_ANDROID, /pub const RUNNER_DEVICE_PORT: u16 = (\d+);/, 'RUNNER_DEVICE_PORT')[1],
  );
  const core = Number(match(CLIENT, /const DEFAULT_PORT = (\d+);/, 'DEFAULT_PORT')[1]);
  assert.equal(cli, core);
});

test('the CLI runner packages equal the packages the core force-stops', () => {
  const body = match(
    CLI_ANDROID,
    /pub const RUNNER_PACKAGES: \[&str; 2\] = \[([^\]]*)\];/,
    'RUNNER_PACKAGES',
  )[1];
  const cli = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(cli, [...OWNED_PACKAGES]);
});
