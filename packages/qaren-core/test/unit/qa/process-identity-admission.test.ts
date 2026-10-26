import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { probeIosExternalRunnerStrict } from '../../../dist/runners/external-runner-detect.js';

const device = 'FC78646A-56D5-4737-9CD0-A360D622F3B3';
const prompt = '/Applications/Xcode Beta.app/usr/bin/xcodebuild test';
const identity = (pid = 20, executable = '/opt/bin/agent') => ({
  v: 1,
  pid,
  birth: { seconds: 1, micros: 0 },
  executable,
});
const ps = (stdout: string) => (async () => ({ stdout, stderr: '' })) as unknown as typeof execFile;

test('kernel identity resolves path-bearing prompts without parsing their contents', async () => {
  for (const executable of ['/opt/bin/agent', 'agent']) {
    for (const text of [prompt, `${'word '.repeat(4_000)}${prompt}`]) {
      let calls = 0;
      const scan = ps(`20 ${executable} ${text}\n`);
      assert.equal(await probeIosExternalRunnerStrict(scan, device), 'unknown');
      assert.equal(
        await probeIosExternalRunnerStrict(scan, device, async (pid, timeout) => {
          calls++;
          assert.equal(pid, 20);
          assert.ok(timeout > 0 && timeout <= 1_000);
          return identity();
        }),
        'clear',
      );
      assert.equal(calls, 1);
    }
  }
});

test('missing, mismatched, future and invalid identities cannot clear an ambiguous row', async () => {
  for (const observed of [
    null,
    {},
    { ...identity(), v: 2 },
    identity(21),
    identity(20, 'agent'),
    identity(20, '/'),
    identity(20, '/opt/bin/agent\n'),
    identity(20, `/${'a'.repeat(4096)}`),
    { ...identity(), birth: { seconds: Date.now() / 1000 + 10, micros: 0 } },
    { ...identity(), birth: { seconds: 0, micros: 0 } },
    { ...identity(), birth: { seconds: 1, micros: 1_000_000 } },
    { ...identity(), birth: { seconds: Number.MAX_SAFE_INTEGER, micros: 0 } },
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(`20 agent ${prompt}\n`), device, async () => observed),
      'unknown',
    );
  }
  assert.equal(
    await probeIosExternalRunnerStrict(ps(`20 agent ${prompt}\n`), device, async () => {
      throw new Error('private probe failure');
    }),
    'unknown',
  );
});

test('the kernel executable decides a symlinked launcher whose argv[0] differs', async () => {
  const scan = ps(`20 claude --append-system-prompt ${prompt}\n`);
  assert.equal(
    await probeIosExternalRunnerStrict(scan, device, async () =>
      identity(20, '/Users/me/.local/share/claude/versions/2.1.283'),
    ),
    'clear',
  );
  for (const [name, expected] of [
    ['node', 'clear'],
    ['java', 'unknown'],
    ['bash', 'unknown'],
    ['xcodebuild', 'unknown'],
    ['maestro', 'unknown'],
    ['ExampleUITestsRunner', 'unknown'],
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(scan, device, async () => identity(20, `/tools/${name}`)),
      expected,
      name,
    );
  }
});

test('script interpreters clear by kernel identity without inspecting their arguments', async () => {
  for (const name of ['node', 'nodejs', 'python3', 'python3.12', 'ruby', 'perl']) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(`20 ${name} ${prompt}\n`), device, async () =>
        identity(20, `/tools/${name}`),
      ),
      'clear',
      name,
    );
  }
});

test('observed drivers, shells and Java remain unknown without inspecting their arguments', async () => {
  for (const name of [
    'java',
    'sh',
    'bash',
    'zsh',
    'env',
    'xcodebuild',
    'maestro',
    'maestro.sh',
    'WebDriverAgentRunner-Runner',
    'RnFastRunnerUITests-Runner',
    'XCTRunner',
    'ExampleUITestsRunner',
  ]) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(`20 ${name} ${prompt}\n`), device, async () =>
        identity(20, `/tools/${name}`),
      ),
      'unknown',
      name,
    );
  }
});

test('native observations cannot override driver rows or partial scan failures', async () => {
  let calls = 0;
  const observe = async () => {
    calls++;
    return identity();
  };
  for (const [row, result] of [
    [`21 maestro test --device ${device}\n`, 'busy'],
    ['bad row\n', 'unknown'],
  ] as const) {
    assert.equal(
      await probeIosExternalRunnerStrict(ps(`20 agent ${prompt}\n${row}`), device, observe),
      result,
    );
  }
  assert.equal(calls, 0);
  assert.equal(
    await probeIosExternalRunnerStrict(
      ps(`20 agent ${prompt}\n21 java -classpath lib maestro.cli.AppKt mcp\n`),
      device,
      observe,
    ),
    'unknown',
  );
});

test('every ambiguous row needs proof and excessive identity work refuses before probing', async () => {
  let calls = 0;
  const observe = async (pid: number) => {
    calls++;
    return pid === 20 ? identity() : null;
  };
  assert.equal(
    await probeIosExternalRunnerStrict(
      ps(`20 agent ${prompt}\n21 agent ${prompt}\n`),
      device,
      observe,
    ),
    'unknown',
  );
  assert.equal(calls, 2);
  calls = 0;
  assert.equal(
    await probeIosExternalRunnerStrict(
      ps(
        Array.from(
          { length: 65 },
          (_, i) => `${i + 20} java -classpath lib maestro.cli.AppKt mcp\n`,
        ).join(''),
      ),
      device,
      observe,
    ),
    'unknown',
  );
  assert.equal(calls, 0);
});
