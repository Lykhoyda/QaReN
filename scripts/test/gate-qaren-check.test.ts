import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qaren-gate-'));
  for (const dir of ['scripts', 'bin', 'app/.qaren', 'packages/qaren-cli/target/debug'])
    mkdirSync(join(root, dir), { recursive: true });
  for (const file of ['gate-qaren-check.sh', 'assert-qaren-check.ts'])
    copyFileSync(new URL(`../${file}`, import.meta.url), join(root, 'scripts', file));
  const executable = (path: string, body: string) => {
    writeFileSync(join(root, path), `#!/bin/bash\nset -eu\n${body}\n`);
    chmodSync(join(root, path), 0o755);
  };
  executable('bin/corepack', ':');
  executable('bin/git', 'echo 0123456789abcdef0123456789abcdef01234567');
  executable('bin/cargo', 'printf "%s" "$QAREN_BUILD_COMMIT" > "$FIXTURE_ROOT/build-commit"');
  executable('bin/xcrun', 'echo forbidden-device-command >&2; exit 99');
  executable(
    'packages/qaren-cli/target/debug/qaren',
    `
printf '%s\\n' "$@" > "$FIXTURE_ROOT/args"
cat "$FIXTURE_ROOT/receipt.json"
exit "\${FIXTURE_EXIT:-0}"
`,
  );
  writeFileSync(join(root, 'app/.qaren/config.yaml'), 'appId: com.fixture\n');
  writeFileSync(join(root, 'literal.md'), '1. Tap "Tasks"\n');
  const core = { run_id: 'check-test', pgid: 9000, at: '2026-02-02T02:42:00Z', outcome: 'absent' };
  const fresh = {
    run_id: 'check-test',
    app_id: 'com.fixture',
    device_id: 'device-test',
    proven_absent_at: '2026-02-02T02:40:00Z',
    status: 'proven_absent',
  };
  const record = {
    schema: 'qaren-run/1',
    run_id: 'check-test',
    phase: 'cleaned',
    created_at: '2026-02-02T02:39:00Z',
    candidate: { app_id: 'com.fixture' },
    resources: {
      device_borrowed: true,
      ios_simulator: { udid: 'device-test' },
      core_cleanup: core,
      fresh_install: fresh,
    },
  };
  writeFileSync(join(root, 'run.json'), JSON.stringify(record));
  writeFileSync(
    join(root, 'ledger.json'),
    JSON.stringify({
      verdict: 'PASS',
      llmTurns: 0,
      escapes: 0,
      recoveries: 0,
      jev: { calls: 0 },
    }),
  );
  const receipt = {
    schema: 'qaren/1',
    verb: 'check',
    run_id: 'check-test',
    phase: 'cleaned',
    result: 'pass',
    device: { ios_udid: 'device-test' },
    ledger: { verdict: 'PASS', steps: 1 },
    outcomes: { fresh_install: 'proven_absent' },
    cleanup: { core: 'absent', metro: 'removed', simulator: 'kept', device_lease: 'removed' },
    emitted_at: '2026-02-02T02:43:00Z',
    candidate: { app_id: 'com.fixture' },
    core_cleanup: core,
    fresh_install: fresh,
    artifacts: {
      ledger: join(root, 'ledger.json'),
      run_record: join(root, 'run.json'),
      report: join(root, 'report.md'),
    },
  };
  writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
  const run = (extra: Record<string, string> = {}) =>
    spawnSync('bash', [join(root, 'scripts/gate-qaren-check.sh')], {
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        HOME: root,
        QAREN_TEST_APP: join(root, 'app'),
        QAREN_PLAN_FILE: join(root, 'literal.md'),
        FIXTURE_ROOT: root,
        ...extra,
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
  return { root, receipt, record, run };
}

test('gate delegates fresh install and device selection to check without device commands', () => {
  const f = fixture();
  try {
    for (const selected of [false, true]) {
      const output = f.run(selected ? { QAREN_DEVICE_UDID: 'device-test' } : {});
      assert.equal(output.status, 0, output.stdout + output.stderr);
      const args = readFileSync(join(f.root, 'args'), 'utf8').trim().split('\n');
      assert.equal(args[0], 'check');
      assert.equal(
        readFileSync(join(f.root, 'build-commit'), 'utf8'),
        '0123456789abcdef0123456789abcdef01234567',
      );
      assert.ok(args.includes('--fresh-install'));
      assert.ok(!args.includes('--boot-device'));
      assert.equal(args.includes('--device'), selected);
      if (selected) assert.equal(args[args.indexOf('--device') + 1], 'device-test');
      assert.match(output.stdout, /gate:qaren-check: PASS/);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('gate forwards only QAREN_BOOT_DEVICE=1 and leaves explicit device enforcement to check', () => {
  const f = fixture();
  try {
    for (const QAREN_BOOT_DEVICE of ['0', 'true', '1']) {
      for (const selected of [false, true]) {
        const output = f.run({
          QAREN_BOOT_DEVICE,
          ...(selected ? { QAREN_DEVICE_UDID: 'device-test' } : {}),
        });
        assert.equal(output.status, 0, output.stdout + output.stderr);
        const args = readFileSync(join(f.root, 'args'), 'utf8').trim().split('\n');
        assert.equal(args.includes('--boot-device'), QAREN_BOOT_DEVICE === '1');
        assert.equal(args.includes('--device'), selected);
        if (selected) assert.equal(args[args.indexOf('--device') + 1], 'device-test');
      }
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('gate rejects a PASS with retained ownership or unavailable durable cleanup proof', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, 'run.json'), JSON.stringify({ ...f.record, phase: 'walking' }));
    assert.equal(f.run().status, 1);
    rmSync(join(f.root, 'run.json'));
    assert.equal(f.run().status, 1);
    writeFileSync(join(f.root, 'run.json'), JSON.stringify(f.record));
    writeFileSync(
      join(f.root, 'receipt.json'),
      JSON.stringify({
        ...f.receipt,
        cleanup: {
          ...f.receipt.cleanup,
          device_lease: 'unresolved: retained: metro',
        },
      }),
    );
    assert.equal(f.run().status, 1);
    writeFileSync(join(f.root, 'receipt.json'), JSON.stringify(f.receipt));
    assert.equal(f.run({ FIXTURE_EXIT: '4' }).status, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('gate cannot skip assertions when the assertion entry point is symlinked', () => {
  const f = fixture();
  try {
    const entry = join(f.root, 'scripts/assert-qaren-check.ts');
    renameSync(entry, join(f.root, 'scripts/actual-check.ts'));
    symlinkSync('actual-check.ts', entry);
    for (const NODE_OPTIONS of ['', '--preserve-symlinks-main']) {
      writeFileSync(join(f.root, 'run.json'), JSON.stringify(f.record));
      const output = f.run({ NODE_OPTIONS });
      assert.equal(output.status, 0, output.stdout + output.stderr);
      assert.match(output.stdout, /gate:qaren-check: PASS/);
      rmSync(join(f.root, 'run.json'));
      assert.equal(f.run({ NODE_OPTIONS }).status, 1);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('gate delegates literal plans without a key and preserves the phrase walk requirement', () => {
  const f = fixture();
  try {
    const literal = f.run();
    assert.equal(literal.status, 0, literal.stdout + literal.stderr);
    assert.match(literal.stdout, /jev.calls=0/);
    const phrase = join(f.root, 'phrases.md');
    writeFileSync(phrase, '1. Tap the Tasks tab\n');
    const refused = f.run({ QAREN_PLAN_FILE: phrase });
    assert.equal(refused.status, 1);
    assert.equal(readFileSync(join(f.root, 'args'), 'utf8').split('\n')[0], 'check');
    writeFileSync(
      join(f.root, 'ledger.json'),
      JSON.stringify({
        verdict: 'PASS',
        llmTurns: 0,
        escapes: 0,
        recoveries: 0,
        jev: { calls: 2, callDetails: [{ scope: 'walk', outcome: 'ok' }] },
        steps: [{ resolvedBy: 'jev' }],
      }),
    );
    const accepted = f.run({ QAREN_PLAN_FILE: phrase });
    assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
