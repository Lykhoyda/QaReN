import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recover } from '../../../dist/qa/recover.js';
import type { RecoverDeps } from '../../../dist/qa/recover.js';
import type { Screen } from '../../../dist/qa/screen.js';

function screen(front: Screen['front'], extra: Partial<Screen> = {}): Screen {
  return { elements: [], visibleText: ['Home'], front, ...extra };
}

const marker = (testID: string, offscreen = false): Partial<Screen> => ({
  elements: [
    {
      ref: '@e0',
      kind: 'button',
      testID,
      label: 'Sign in',
      hittable: true,
      disabled: false,
      secure: false,
      offscreen,
    },
  ],
});

function deps(overrides: Partial<RecoverDeps> = {}): { deps: RecoverDeps; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async dialog() {
        calls.push('dialog');
        return { ok: true, proven: true };
      },
      async hideDevMenu() {
        calls.push('hideDevMenu');
        return { ok: true, proven: true };
      },
      async replayLogin() {
        calls.push('replayLogin');
        return 'pass';
      },
      ...overrides,
    },
  };
}

test('a system dialog in front uses the supplied dialog action', async () => {
  const d = deps();
  assert.deepEqual(await recover(screen('dialog'), d.deps), { handled: 'dialog' });
  assert.deepEqual(d.calls, ['dialog']);
});

test('a dialog that cannot be handled fails with the reason', async () => {
  const d = deps({ dialog: async () => ({ ok: false, proven: false, error: 'NO_DIALOG: gone' }) });
  assert.deepEqual(await recover(screen('dialog'), d.deps), {
    fail: 'the system dialog in front could not be handled: NO_DIALOG: gone',
  });
});

test('the dev menu in front is hidden', async () => {
  const d = deps();
  assert.deepEqual(await recover(screen('dev-menu'), d.deps), { handled: 'dev-menu' });
  assert.deepEqual(d.calls, ['hideDevMenu']);
});

test('the login marker on screen replays the login block', async () => {
  const d = deps();
  assert.deepEqual(await recover(screen('app', marker('login')), d.deps, { id: 'login' }), {
    handled: 'login',
  });
  assert.deepEqual(d.calls, ['replayLogin']);
});

test('the login marker matches by label too, and never off screen', async () => {
  const d = deps();
  assert.deepEqual(await recover(screen('app', marker('x')), d.deps, { text: 'Sign in' }), {
    handled: 'login',
  });
  assert.equal(
    await recover(screen('app', marker('login', true)), d.deps, { id: 'login' }),
    undefined,
  );
});

test('a failed login replay fails the step', async () => {
  const d = deps({ replayLogin: async () => 'fail' });
  assert.deepEqual(await recover(screen('app', marker('login')), d.deps, { id: 'login' }), {
    fail: 'the login block did not pass',
  });
});

test('a refused login replay is returned as the refusal', async () => {
  const refuse = { code: 'NATIVE_CAPTURE_FAILED', message: 'capture failed' };
  const d = deps({ replayLogin: async () => ({ refuse }) });
  assert.deepEqual(await recover(screen('app', marker('login')), d.deps, { id: 'login' }), {
    refuse,
  });
});

test('the marker without a login block recovers nothing', async () => {
  const d = deps({ replayLogin: undefined });
  assert.equal(await recover(screen('app', marker('login')), d.deps, { id: 'login' }), undefined);
  assert.deepEqual(d.calls, []);
});

test('a plain app screen recovers nothing', async () => {
  const d = deps();
  assert.equal(await recover(screen('app'), d.deps, { id: 'login' }), undefined);
  assert.deepEqual(d.calls, []);
});

test('the floating dev-menu button in front re-runs the dev-overlay clearing', async () => {
  const d = deps();
  assert.deepEqual(await recover(screen('dev-fab'), d.deps), { handled: 'dev-fab' });
  assert.deepEqual(d.calls, ['hideDevMenu']);
});

test('a floating dev-menu button that stays fails with the reason', async () => {
  const d = deps({
    hideDevMenu: async () => ({
      ok: false,
      proven: false,
      error: 'DEV_MENU_HIDE_UNVERIFIED: still on screen',
    }),
  });
  assert.deepEqual(await recover(screen('dev-fab'), d.deps), {
    fail: 'the dev menu in front could not be hidden: DEV_MENU_HIDE_UNVERIFIED: still on screen',
  });
});
