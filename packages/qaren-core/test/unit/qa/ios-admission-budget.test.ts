import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { probeIosExternalRunnerStrict } from '../../../dist/runners/external-runner-detect.js';

const device = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const other = 'CCCCCCCC-4444-5555-6666-DDDDDDDDDDDD';
const mcpArgv = ['/usr/bin/java', '-classpath', 'lib', 'maestro.cli.AppKt', 'mcp'];
const program = '/opt/bin/agent review /tmp/WebDriverAgent';
type Kind = 'controller' | 'driver' | 'program';

function scan(kinds: Kind[], targetDriver = false): typeof execFile {
  const stdout = kinds
    .map((kind, index) => {
      const command =
        kind === 'controller'
          ? mcpArgv.join(' ')
          : kind === 'program'
            ? program
            : `/usr/bin/xcodebuild test${targetDriver ? ` -destination id=${device}` : ''}`;
      return `${100 + index} ${command}\n`;
    })
    .join('');
  assert.ok(Buffer.byteLength(stdout) < 1024 * 1024);
  return (async (_bin: string, _args: string[], options: object) => {
    assert.deepEqual(options, { timeout: 2_000, encoding: 'utf8' });
    return { stdout, stderr: '' };
  }) as unknown as typeof execFile;
}

function observation(kind: Kind, pid: number) {
  return {
    v: 1,
    pid,
    birth: { seconds: 1, micros: 0 },
    executable:
      kind === 'controller'
        ? '/usr/bin/java'
        : kind === 'driver'
          ? '/usr/bin/xcodebuild'
          : '/opt/bin/agent',
    ...(kind === 'program'
      ? {}
      : {
          argv:
            kind === 'controller'
              ? mcpArgv
              : ['/usr/bin/xcodebuild', 'test', '-destination', `id=${other}`],
        }),
  };
}

test('all 64 combined candidates must resolve through the unchanged evidence modes', async () => {
  const cases: Kind[][] = [
    [...Array<Kind>(18).fill('controller'), 'program'],
    Array<Kind>(64).fill('controller'),
    Array<Kind>(64).fill('driver'),
    [...Array<Kind>(32).fill('driver'), ...Array<Kind>(32).fill('controller')],
    [...Array<Kind>(63).fill('controller'), 'program'],
  ];
  for (const kinds of cases) {
    const observed = new Set<number>();
    assert.equal(
      await probeIosExternalRunnerStrict(
        scan(kinds),
        device,
        async (pid, timeout, withArgv, inspection) => {
          const kind = kinds[pid - 100];
          assert.ok(timeout > 0 && timeout <= 1_000);
          assert.equal(withArgv, kind === 'program' ? undefined : true);
          assert.equal(inspection, undefined);
          observed.add(pid);
          return observation(kind, pid);
        },
      ),
      'clear',
    );
    assert.equal(observed.size, kinds.length);
  }
});

test('65 combined candidates refuse before any observer or target-driver shortcut', async () => {
  const cases: Kind[][] = [
    Array<Kind>(65).fill('controller'),
    Array<Kind>(65).fill('driver'),
    ['driver', ...Array<Kind>(64).fill('controller')],
    [...Array<Kind>(32).fill('driver'), ...Array<Kind>(33).fill('controller')],
    [...Array<Kind>(64).fill('controller'), 'program'],
  ];
  for (const kinds of cases) {
    for (const targetDriver of [false, true]) {
      let calls = 0;
      assert.equal(
        await probeIosExternalRunnerStrict(scan(kinds, targetDriver), device, async (pid) => {
          calls++;
          return observation(kinds[pid - 100], pid);
        }),
        'unknown',
      );
      assert.equal(calls, 0);
    }
  }
});

test('kernel-scoped conflicts at candidate 19 or 64 are never skipped', async () => {
  const kinds = Array<Kind>(64).fill('driver');
  for (const conflictAt of [19, 64]) {
    let calls = 0;
    assert.equal(
      await probeIosExternalRunnerStrict(scan(kinds), device, async (pid) => {
        calls++;
        const value = observation('driver', pid);
        return calls === conflictAt
          ? { ...value, argv: ['/usr/bin/xcodebuild', 'test', '-destination', `id=${device}`] }
          : value;
      }),
      'busy',
    );
    assert.equal(calls, conflictAt);
  }
});

test('a deadline partway through 64 candidates refuses without partial admission or renewal', async (t) => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let calls = 0;
  const timeouts: number[] = [];
  assert.equal(
    await probeIosExternalRunnerStrict(
      scan(Array<Kind>(64).fill('controller')),
      device,
      async (pid, timeout) => {
        calls++;
        timeouts.push(timeout);
        assert.ok(timeout > 0 && timeout <= 1_000);
        now += 950;
        return observation('controller', pid);
      },
    ),
    'unknown',
  );
  assert.equal(calls, 22);
  assert.equal(timeouts.at(-1), 50);
});

test('later disappearance, PID reuse, executable change and unknown or changed argv fail closed', async () => {
  const failures: Array<(value: ReturnType<typeof observation>) => unknown> = [
    () => null,
    (value) => ({ ...value, pid: value.pid + 1 }),
    (value) => ({ ...value, birth: { seconds: Math.floor(Date.now() / 1_000) + 1, micros: 0 } }),
    (value) => ({ ...value, executable: '/usr/bin/node' }),
    (value) => ({ ...value, argv: undefined }),
    (value) => ({ ...value, argv: [...mcpArgv.slice(0, 4), 'test'] }),
    () => {
      throw new Error('observer unavailable');
    },
  ];
  for (const fail of failures) {
    let calls = 0;
    assert.equal(
      await probeIosExternalRunnerStrict(
        scan(Array<Kind>(64).fill('controller')),
        device,
        async (pid) => {
          calls++;
          const value = observation('controller', pid);
          return calls === 19 ? fail(value) : value;
        },
      ),
      'unknown',
    );
    assert.equal(calls, 19);
  }
});
