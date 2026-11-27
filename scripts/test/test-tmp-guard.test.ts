import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const guard = resolve(import.meta.dirname, '..', 'test-tmp-guard.mts');
const uid = process.getuid!();
// Root ignores directory modes, so the rows that lock a directory prove nothing there.
const modesEnforced = uid !== 0;

function removeTree(path: string): void {
  const unlock = (entry: string): void => {
    if (!lstatSync(entry).isDirectory()) return;
    chmodSync(entry, 0o700);
    for (const name of readdirSync(entry)) unlock(join(entry, name));
  };
  unlock(path);
  rmSync(path, { recursive: true, force: true });
}

// The guard makes its own folder inside `outer`, so each row can see that nothing is left there.
function outerTmp(t: TestContext): string {
  const outer = mkdtempSync(join(tmpdir(), 'test-tmp-guard-'));
  t.after(() => removeTree(outer));
  return outer;
}

function environment(outer: string, extra: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extra, TMPDIR: outer };
  delete env.NODE_TEST_CONTEXT;
  if (!('GITHUB_ACTIONS' in extra)) delete env.GITHUB_ACTIONS;
  return env;
}

// Runs `script` in Node as the guarded command.
function run(outer: string, script: string, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [guard, '--', process.execPath, '-e', script], {
    encoding: 'utf8',
    env: environment(outer, extra),
  });
}

const inTmp = (name: string) =>
  `require('node:path').join(process.env.TMPDIR, ${JSON.stringify(name)})`;

test('a command that removes what it creates passes and its temp folder is gone', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs'); const dir = ${inTmp('made')};
     fs.mkdirSync(dir); fs.rmSync(dir, { recursive: true });`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(outer), []);
});

test('the command gets a private, empty temp folder inside the caller’s', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs'); const root = process.env.TMPDIR;
     console.log(JSON.stringify({ root, mode: fs.statSync(root).mode & 0o777, entries: fs.readdirSync(root) }));`,
  );
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout) as { root: string; mode: number; entries: string[] };
  assert.match(seen.root, /\/qaren-tmp-[A-Za-z0-9]{6}$/);
  assert.equal(seen.root.startsWith(`${outer}/`), true);
  assert.equal(seen.mode, 0o700);
  assert.deepEqual(seen.entries, []);
  assert.deepEqual(readdirSync(outer), []);
});

test('a passing command that leaves entries fails with TEST_TMP_LEFTOVER and they are removed', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs');
     fs.mkdirSync(${inTmp('qaren-left-b')}); fs.writeFileSync(${inTmp('qaren-left-a.yaml')}, 'x');`,
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^TEST_TMP_LEFTOVER: the command passed but left 2 entries in its temp folder: qaren-left-a\.yaml, qaren-left-b; next: /,
  );
  assert.match(result.stderr, /crate::test_tmp::TestDir::new/);
  assert.match(result.stderr, /common::temp_dir/);
  assert.match(result.stderr, /test\/helpers\/private-tmp\.ts/);
  assert.equal(result.stderr.trimEnd().includes('\n'), false);
  assert.equal(result.stdout, '');
  assert.deepEqual(readdirSync(outer), []);
});

test('on GitHub Actions the leftover is also one error annotation, whatever the names contain', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs');
     fs.mkdirSync(${inTmp('100%left')}); fs.mkdirSync(${inTmp('two\nlines')});`,
    { GITHUB_ACTIONS: 'true' },
  );
  assert.equal(result.status, 1);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, result.stdout);
  assert.match(
    lines[0]!,
    /^::error title=Test temp folder::TEST_TMP_LEFTOVER: the command passed but left 2 entries in its temp folder: 100%25left, two\?lines; next: /,
  );
  assert.deepEqual(readdirSync(outer), []);
});

test('a failing command keeps its own exit code and its leftovers are still removed', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `require('node:fs').mkdirSync(${inTmp('left-by-a-failure')}); process.exit(7);`,
  );
  assert.equal(result.status, 7);
  assert.equal(
    result.stderr,
    'test-tmp-guard: the command failed and left 1 entries in its temp folder: left-by-a-failure\n',
  );
  assert.deepEqual(readdirSync(outer), []);
});

test('the two tool-cache directories of this user are not leftovers', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs');
     fs.mkdirSync(${inTmp('node-compile-cache')}); fs.mkdirSync(${inTmp(`v8-compile-cache-${uid}`)});`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(outer), []);
});

for (const [what, make] of [
  ['a longer name', `fs.mkdirSync(${inTmp('node-compile-cache-2')})`],
  ['another user’s cache', `fs.mkdirSync(${inTmp(`v8-compile-cache-${uid + 1}`)})`],
  ['a cache name with a suffix', `fs.mkdirSync(${inTmp(`v8-compile-cache-${uid}x`)})`],
  ['a file with the Node cache name', `fs.writeFileSync(${inTmp('node-compile-cache')}, 'x')`],
  ['a file with the v8 cache name', `fs.writeFileSync(${inTmp(`v8-compile-cache-${uid}`)}, 'x')`],
] as const) {
  test(`${what} is a leftover, not a tool cache`, (t) => {
    const outer = outerTmp(t);
    const result = run(outer, `const fs = require('node:fs'); ${make};`);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /^TEST_TMP_LEFTOVER: the command passed but left 1 entries /);
    assert.deepEqual(readdirSync(outer), []);
  });
}

test('a command that removes its whole temp folder has left nothing', (t) => {
  const outer = outerTmp(t);
  const result = run(outer, `require('node:fs').rmSync(process.env.TMPDIR, { recursive: true });`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(readdirSync(outer), []);
});

test(
  'a read-only folder left behind is reported and still removed',
  { skip: !modesEnforced && 'directory modes are not enforced for this user' },
  (t) => {
    const outer = outerTmp(t);
    // A symlink inside the locked folder points at a locked folder outside; it must not be opened.
    const canary = outerTmp(t);
    mkdirSync(join(canary, 'inner'));
    writeFileSync(join(canary, 'inner', 'file'), 'x');
    chmodSync(join(canary, 'inner'), 0o500);
    const result = run(
      outer,
      `const fs = require('node:fs'); const dir = ${inTmp('locked')};
       fs.mkdirSync(dir); fs.writeFileSync(dir + '/file', 'x');
       fs.symlinkSync(${JSON.stringify(join(canary, 'inner'))}, dir + '/link'); fs.chmodSync(dir, 0o500);`,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^TEST_TMP_LEFTOVER: the command passed but left 1 entries in its temp folder: locked; next: /,
    );
    assert.equal(lstatSync(join(canary, 'inner')).mode & 0o777, 0o500);
    assert.deepEqual(readdirSync(outer), []);
  },
);

test(
  'a temp folder its command made unreadable is still listed',
  { skip: !modesEnforced && 'directory modes are not enforced for this user' },
  (t) => {
    const outer = outerTmp(t);
    const result = run(
      outer,
      `const fs = require('node:fs'); fs.mkdirSync(${inTmp('left')}); fs.chmodSync(process.env.TMPDIR, 0o300);`,
    );
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /^TEST_TMP_LEFTOVER: the command passed but left 1 entries in its temp folder: left; next: /,
    );
    assert.deepEqual(readdirSync(outer), []);
  },
);

test('a passing command that replaces its temp folder with a file fails with TEST_TMP_UNREADABLE', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs'); const root = process.env.TMPDIR;
     fs.rmSync(root, { recursive: true }); fs.writeFileSync(root, 'not a folder');`,
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^TEST_TMP_UNREADABLE: the command passed but its temp folder could not be read: .*qaren-tmp-[A-Za-z0-9]{6} is no longer a directory; next: /,
  );
  assert.deepEqual(readdirSync(outer), []);
});

test(
  'a temp folder replaced with a symlink is TEST_TMP_UNREADABLE and the target is not touched',
  { skip: !modesEnforced && 'directory modes are not enforced for this user' },
  (t) => {
    const outer = outerTmp(t);
    const canary = outerTmp(t);
    mkdirSync(join(canary, 'inner'));
    writeFileSync(join(canary, 'inner', 'file'), 'x');
    chmodSync(join(canary, 'inner'), 0o500);
    const target = JSON.stringify(join(canary, 'inner'));
    const result = run(
      outer,
      `const fs = require('node:fs'); const root = process.env.TMPDIR;
       fs.rmSync(root, { recursive: true }); fs.symlinkSync(${target}, root);`,
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^TEST_TMP_UNREADABLE: .* is no longer a directory; next: /);
    assert.equal(lstatSync(join(canary, 'inner')).mode & 0o777, 0o500);
    assert.deepEqual(readdirSync(join(canary, 'inner')), ['file']);
    assert.deepEqual(readdirSync(outer), []);
  },
);

test('a failing command whose temp folder is unreadable keeps its exit code and says so', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs'); const root = process.env.TMPDIR;
     fs.rmSync(root, { recursive: true }); fs.writeFileSync(root, 'not a folder'); process.exit(7);`,
  );
  assert.equal(result.status, 7);
  assert.match(
    result.stderr,
    /^test-tmp-guard: the command failed and its temp folder could not be read: .* is no longer a directory\n$/,
  );
  assert.deepEqual(readdirSync(outer), []);
});

test('more than 20 leftovers are shown as the first 20 and a count', (t) => {
  const outer = outerTmp(t);
  const result = run(
    outer,
    `const fs = require('node:fs');
     for (let i = 10; i < 35; i++) fs.mkdirSync(require('node:path').join(process.env.TMPDIR, 'left-' + i));`,
  );
  assert.equal(result.status, 1);
  const first20 = Array.from({ length: 20 }, (_, i) => `left-${i + 10}`).join(', ');
  assert.equal(
    result.stderr.startsWith(
      `TEST_TMP_LEFTOVER: the command passed but left 25 entries in its temp folder: ${first20} (and 5 more); next: `,
    ),
    true,
    result.stderr,
  );
  assert.deepEqual(readdirSync(outer), []);
});

for (const [ending, exit, expected] of [
  ['passes', '', 1],
  ['fails', 'process.exit(7);', 7],
] as const) {
  test(
    `a temp folder that cannot be removed is reported when the command ${ending}`,
    { skip: !modesEnforced && 'directory modes are not enforced for this user' },
    (t) => {
      const outer = outerTmp(t);
      // The folder that holds the guard's folder becomes read-only, so the guard cannot unlink it.
      const result = run(
        outer,
        `require('node:fs').chmodSync(${JSON.stringify(outer)}, 0o500); ${exit}`,
      );
      chmodSync(outer, 0o700);
      const [kept] = readdirSync(outer);
      assert.match(kept ?? '', /^qaren-tmp-[A-Za-z0-9]{6}$/);
      assert.equal(result.status, expected);
      assert.equal(
        result.stderr.includes(`the folder ${join(outer, kept!)} could not be removed: `),
        true,
        result.stderr,
      );
      assert.equal(
        result.stderr.startsWith('TEST_TMP_NOT_REMOVED: the command passed and left nothing, but '),
        expected === 1,
      );
      assert.equal(
        result.stderr.startsWith('test-tmp-guard: the command failed; the folder '),
        expected === 7,
      );
    },
  );
}

test('a temp folder that cannot be created is TEST_TMP_SETUP and the command does not run', (t) => {
  const outer = outerTmp(t);
  const marker = join(outer, 'the-command-ran');
  const result = spawnSync(
    process.execPath,
    [
      guard,
      '--',
      process.execPath,
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`,
    ],
    { encoding: 'utf8', env: environment(join(outer, 'missing')) },
  );
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /^TEST_TMP_SETUP: cannot create a temp folder in .*; the command was not run; next: /,
  );
  assert.equal(existsSync(marker), false);
  assert.deepEqual(readdirSync(outer), []);
});

for (const [signal, code] of [
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
] as const) {
  test(`${signal} sent to the guard reaches the command and the temp folder is removed`, async (t) => {
    const outer = outerTmp(t);
    // Its own process group, so a failing row can end the guard and its command together.
    const child = spawn(
      process.execPath,
      [
        guard,
        '--',
        process.execPath,
        '-e',
        `require('node:fs').mkdirSync(${inTmp('held')}); console.log('ready'); setInterval(() => {}, 1000);`,
      ],
      { env: environment(outer), stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    );
    t.after(() => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // The group has already ended.
      }
    });
    const ended = new Promise<number | null>((done) => child.once('exit', done));
    const ready = new Promise<'ready'>((done) => child.stdout.once('data', () => done('ready')));
    const late = () => sleep(10_000, 'timed out' as const, { ref: false });
    assert.equal(await Promise.race([ready, ended, late()]), 'ready');
    child.kill(signal);
    assert.equal(await Promise.race([ended, late()]), code);
    assert.deepEqual(readdirSync(outer), []);
  });
}

test('without a command the guard prints its usage and creates nothing', (t) => {
  const outer = outerTmp(t);
  for (const args of [[guard], [guard, '--'], [guard, process.execPath, '-e', '0']]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: environment(outer) });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /^usage: node scripts\/test-tmp-guard\.mts -- <command>/);
    assert.deepEqual(readdirSync(outer), []);
  }
});

test('a command that cannot start is TEST_TMP_NOT_STARTED and exits 127', (t) => {
  const outer = outerTmp(t);
  const result = spawnSync(process.execPath, [guard, '--', join(outer, 'no-such-command')], {
    encoding: 'utf8',
    env: environment(outer),
  });
  assert.equal(result.status, 127);
  assert.match(result.stderr, /^TEST_TMP_NOT_STARTED: cannot start .*no-such-command: .*; next: /);
  assert.deepEqual(readdirSync(outer), []);
});

test('the core test scripts and the CI cargo step run through the guard and keep its exit code', () => {
  const root = resolve(import.meta.dirname, '..', '..');
  const scripts = (
    JSON.parse(readFileSync(join(root, 'packages/qaren-core/package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  const runners = Object.entries(scripts).filter(([, script]) => script.includes('node --test'));
  assert.deepEqual(runners.map(([name]) => name).sort(), [
    'test',
    'test:all',
    'test:contract',
    'test:coverage',
    'test:integration',
  ]);
  for (const [name, script] of runners) {
    // Exactly `yarn build:test && <guard> -- node --test <arguments>`: nothing after it can hide the guard's exit code.
    assert.match(
      script,
      /^yarn build:test && node \.\.\/\.\.\/scripts\/test-tmp-guard\.mts -- node --test [^|;&]+$/,
      name,
    );
  }
  const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const cargoRuns = workflow.split('\n').filter((line) => /^\s+run: .*\bcargo test\b/.test(line));
  assert.deepEqual(
    cargoRuns.map((line) => line.trim()),
    [
      'run: node scripts/test-tmp-guard.mts -- cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked',
      'run: cargo test --manifest-path packages/qaren-cli/Cargo.toml --locked --test metro_bind_smoke --no-run',
    ],
  );
});
