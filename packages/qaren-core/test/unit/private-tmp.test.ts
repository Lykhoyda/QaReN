import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const helper = resolve(import.meta.dirname, '../helpers/private-tmp.ts');

// Runs `body` in a process that imported the helper first, with `outer` as its temp folder.
function runWithHelper(outer: string, canary: string, body: string) {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    TMPDIR: outer,
    PRIVATE_TMP_CANARY: canary,
  };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import ${JSON.stringify(helper)};
       import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
       import { tmpdir } from 'node:os';
       import { join } from 'node:path';
       const made = mkdtempSync(join(tmpdir(), 'made-by-a-test-'));
       console.log(JSON.stringify({ root: tmpdir(), made }));
       ${body}`,
    ],
    { encoding: 'utf8', env: environment },
  );
}

// A directory a test locked: 0500 with a file inside, so a plain recursive removal fails.
// A symlink inside it points at a locked folder outside, which removal must not open.
const LOCKED = `mkdirSync(join(made, 'locked'));
  writeFileSync(join(made, 'locked', 'file'), 'x');
  symlinkSync(process.env.PRIVATE_TMP_CANARY, join(made, 'locked', 'link'));
  chmodSync(join(made, 'locked'), 0o500);`;
const locksAreEnforced = process.getuid?.() !== 0;

for (const [ending, body, status] of [
  ['ends normally', '', 0],
  ['throws', "throw new Error('the test file fails');", 1],
  ['calls process.exit', 'process.exit(3);', 3],
  ['has locked a directory and passes', LOCKED, 0],
  ['has locked a directory and throws', `${LOCKED} throw new Error('the test file fails');`, 1],
] as const) {
  const skip =
    body.startsWith(LOCKED) && !locksAreEnforced ? 'modes are not enforced for root' : false;
  test(`a process that imported private-tmp leaves nothing when it ${ending}`, { skip }, (t) => {
    const outer = mkdtempSync(join(tmpdir(), 'private-tmp-outer-'));
    const canary = mkdtempSync(join(tmpdir(), 'private-tmp-canary-'));
    mkdirSync(join(canary, 'inner'));
    writeFileSync(join(canary, 'inner', 'file'), 'x');
    chmodSync(join(canary, 'inner'), 0o500);
    t.after(() => {
      spawnSync('chmod', ['-R', 'u+rwx', outer, canary]);
      rmSync(outer, { recursive: true, force: true });
      rmSync(canary, { recursive: true, force: true });
    });

    const result = runWithHelper(outer, join(canary, 'inner'), body);

    assert.equal(result.status, status, result.stderr);
    const seen = JSON.parse(result.stdout) as { root: string; made: string };
    assert.match(seen.root, /\/qaren-node-test-[A-Za-z0-9]{6}$/);
    assert.equal(seen.root.startsWith(`${outer}/`), true);
    assert.equal(seen.made.startsWith(`${seen.root}/`), true);
    assert.deepEqual(readdirSync(outer), []);
    assert.equal(lstatSync(join(canary, 'inner')).mode & 0o777, 0o500);
  });
}
