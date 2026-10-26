import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const LEGACY = '/tmp/qaren-session.json';
const WRAPPER = fileURLToPath(new URL('../../dist/agent-device-wrapper.js', import.meta.url));

test('a session left at the 1.x /tmp location is neither adopted nor copied', (t) => {
  try {
    // Exclusive create: never overwrite or follow anything already at the shared path.
    writeFileSync(
      LEGACY,
      JSON.stringify({ platform: 'ios', deviceId: 'PLANTED-UDID', appId: 'planted.app' }),
      { flag: 'wx' },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    t.skip(`${LEGACY} already exists on this host`);
    return;
  }
  const planted = lstatSync(LEGACY).ino;
  const home = mkdtempSync(join(tmpdir(), 'qaren-session-'));
  const project = join(home, 'app');
  const state = join(home, 'state');
  try {
    execFileSync('mkdir', ['-p', project]);
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(WRAPPER)}); console.log(JSON.stringify(m.getActiveSession()));`,
      ],
      { cwd: project, env: { ...process.env, XDG_STATE_HOME: state }, encoding: 'utf8' },
    );
    assert.equal(out.trim().split('\n').at(-1), 'null');
    const written = existsSync(join(state, 'qaren')) ? readdirSync(join(state, 'qaren')) : [];
    assert.deepEqual(
      written.filter((name) => name.startsWith('session-')),
      [],
    );
  } finally {
    // Remove only the file this test created, never one that replaced it.
    if (lstatSync(LEGACY, { throwIfNoEntry: false })?.ino === planted) rmSync(LEGACY);
    rmSync(home, { recursive: true, force: true });
  }
});
