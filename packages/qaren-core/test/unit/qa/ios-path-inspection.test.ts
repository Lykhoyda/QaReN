import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  hasUnresolvedIosPathPattern,
  probeIosExternalRunnerStrict,
} from '../../../dist/runners/external-runner-detect.js';

const device = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const complete = { status: 'complete', unresolvedPath: 'absent' };
const identity = {
  v: 1,
  pid: 20,
  birth: { seconds: 1, micros: 0 },
  executable: '/usr/local/bin/node',
  iosPathInspection: complete,
};
const ps = (command: string) =>
  (async (_bin: string, _args: string[], options: object) => {
    assert.deepEqual(options, { timeout: 2_000, encoding: 'utf8' });
    return { stdout: `20 ${command}\n`, stderr: '' };
  }) as unknown as typeof execFile;
const program = `privacy-canary-${'x'.repeat(35_000)}`;

test('quote-heavy non-path rows remain clear within the scan budget', async (t) => {
  const command = `/usr/local/bin/node -e /maestro.${'x'.repeat(7500)}+${'"'.repeat(7500)}`;
  assert.ok(command.length < 16_384);
  const stdout = Array.from({ length: 64 }, (_, i) => `${20 + i} ${command}\n`).join('');
  assert.ok(Buffer.byteLength(stdout) < 1024 * 1024);
  const scan = (async () => ({ stdout, stderr: '' })) as unknown as typeof execFile;
  const started = performance.now();
  const status = await probeIosExternalRunnerStrict(scan, device);
  const elapsed = performance.now() - started;
  t.diagnostic(`64-row quote-heavy scan: ${elapsed.toFixed(1)}ms`);
  assert.equal(status, 'clear');
  assert.ok(elapsed < 2_000, `quote-heavy scan took ${elapsed.toFixed(1)}ms`);
});

test('a scan with no unresolved rows cannot clear at or beyond its deadline', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  for (const elapsed of [19_999, 20_000, 35_400]) {
    now = 0;
    const scan = (async () => {
      now = elapsed;
      return { stdout: '20 /usr/local/bin/node -e ordinary\n', stderr: '' };
    }) as unknown as typeof execFile;
    assert.equal(
      await probeIosExternalRunnerStrict(scan, device),
      elapsed < 20_000 ? 'clear' : 'unknown',
    );
  }
});

test('shared Rust/TypeScript fixtures retain the original unresolved-path predicate', () => {
  const fixtures: Array<[string, boolean]> = JSON.parse(
    readFileSync(new URL('./ios-path-patterns.json', import.meta.url), 'utf8'),
  );
  const original = (command: string) => {
    const components = command.split('/').slice(1);
    return components.some(
      (component, index) =>
        /^(?:maestro(?:-driver-iosUITests-Runner|\.\w+)?|WebDriverAgent(?:Runner)?(?:-Runner)?|QarenIosRunner\S*|QaReN-Runner|XCTRunner|xcodebuild|\S*UITests-?Runner)(?=$|[\s"'])/i.test(
          component,
        ) ||
        (index < components.length - 1 &&
          /(?:UITests-?Runner|XCTRunner|QaReN-Runner)\.app/i.test(component)) ||
        (/(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i.test(command) &&
          /^java(?=$|[\s"'])/i.test(component)),
    );
  };
  for (const [fixture, expected] of fixtures) {
    for (const prefix of ['', `/bin/node -e ${'x'.repeat(30_001)} `]) {
      const command = prefix + fixture;
      assert.equal(hasUnresolvedIosPathPattern(command), expected, fixture);
      assert.equal(hasUnresolvedIosPathPattern(command), original(command), fixture);
    }
  }
  const fragments = [
    'maestro.',
    'x_1',
    '+',
    '-',
    '"',
    "'",
    ' ',
    '\t',
    '\u00a0',
    '\ufeff',
    'é',
    '/',
    'java',
    ' maestro.cli.AppKt ',
    'UITestsRunner',
    'UITests-Runner',
    'XCTRunner.app',
    'QarenIosRunner',
    'QaReN-Runner',
    'WebDriverAgent',
  ];
  let seed = 12345;
  for (let sample = 0; sample < 150_000; sample++) {
    let command = '/tools/maestro.';
    for (let part = 0; part < 8; part++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      command += fragments[seed % fragments.length];
    }
    assert.equal(hasUnresolvedIosPathPattern(command), original(command), command);
  }
});

test('long unrelated inline programs admit without kernel inspection', async () => {
  let calls = 0;
  assert.equal(
    await probeIosExternalRunnerStrict(
      ps(`/usr/local/bin/node -e ${program}`),
      device,
      async () => {
        calls++;
        return null;
      },
    ),
    'clear',
  );
  assert.equal(calls, 0);
});

test('interpreter identity admits argument paths; shell ambiguity, drivers and invalid identities refuse', async () => {
  for (const command of [
    `node -e ${program}/usr/bin/xcodebuild`,
    `node -e /tmp/WebDriverAgent ${program}`,
    'node -e /tmp/WebDriverAgent',
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(command), device, async () => identity),
      'clear',
    );
  }
  for (const [command, executable] of [
    [`/bin/sh --unknown ${program}`, '/bin/sh'],
    [`xcodebuild test ${program}`, identity.executable],
    [`java -classpath lib maestro.cli.AppKt test ${program}`, identity.executable],
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(command), device, async () => ({
        ...identity,
        executable,
      })),
      'unknown',
    );
  }
  for (const change of [
    { pid: 21 },
    { v: 2 },
    { birth: { seconds: Date.now(), micros: 0 } },
    { birth: { seconds: 1, micros: -1 } },
    { executable: '/bin/bash' },
    { executable: '/Users/Test User/bin/bash' },
    { executable: '/tmp/My AppUITestsRunner' },
    { executable: '/tmp/xcodebuild' },
    { executable: 'node' },
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(
        ps(`node -e ${program}/tmp/XCTRunner`),
        device,
        async () => ({
          ...identity,
          ...change,
        }),
      ),
      'unknown',
    );
  }
});

test('relevant long commands share the combined 64-candidate admission budget', async () => {
  let calls = 0;
  const scan = (async () => ({
    stdout:
      Array.from(
        { length: 64 },
        (_, i) => `${20 + i} /usr/bin/java -classpath lib maestro.cli.AppKt mcp\n`,
      ).join('') + `84 node -e ${program}/tmp/XCTRunner\n`,
  })) as unknown as typeof execFile;
  assert.equal(
    await probeIosExternalRunnerStrict(scan, device, async () => {
      calls++;
      return identity;
    }),
    'unknown',
  );
  assert.equal(calls, 0);
});

test('relevant long-command identities cannot extend the overall observation deadline', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  assert.equal(
    await probeIosExternalRunnerStrict(ps(`agent ${program}/tmp/XCTRunner`), device, async () => {
      now = 20_000;
      return identity;
    }),
    'unknown',
  );
  now = 0;
  assert.equal(
    await probeIosExternalRunnerStrict(ps(`agent ${program}/tmp/XCTRunner`), device, async () => ({
      ...identity,
      birth: {
        get seconds() {
          now = 20_000;
          return 1;
        },
        micros: 0,
      },
    })),
    'unknown',
  );
});
