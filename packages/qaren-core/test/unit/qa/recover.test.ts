import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dismissCandidate, recover } from '../../../dist/qa/recover.js';
import type { RecoverDeps } from '../../../dist/qa/recover.js';
import { join, type NativeNode, type Screen } from '../../../dist/qa/screen.js';
import { centreCovered, targetEvidence } from '../../../dist/qa/resolve.js';
import { parsePlan, type Target } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

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

const homeTarget: Target = { phrase: 'home', quoted: 'home', exact: 'id' };

function sheetScreen(covered = true, declines = ['Close']): Screen {
  const rect = { x: 0, y: 0, width: 400, height: 800 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect },
    { ref: '@window', type: 'Window', parentIndex: 0, rect },
    {
      ref: '@scroll',
      type: 'ScrollView',
      parentIndex: 1,
      rect: { x: 0, y: 100, width: 400, height: 650 },
    },
    {
      ref: '@home',
      type: 'StaticText',
      parentIndex: 2,
      identifier: 'home',
      label: 'Welcome Home',
      rect: { x: 20, y: covered ? 500 : 200, width: 200, height: 40 },
    },
    ...(declines.length
      ? [
          {
            ref: '@scrim',
            type: 'Other',
            parentIndex: 1,
            hittable: true,
            rect: { x: 0, y: 400, width: 400, height: 400 },
          },
        ]
      : []),
    ...declines.map((label, index) => ({
      ref: `@decline${index}`,
      type: 'Button',
      parentIndex: 1,
      label,
      hittable: true,
      rect: { x: 20 + index * 150, y: 450, width: 100, height: 40 },
    })),
  ];
  return join(nodes, [], 'app', { native: 'complete', react: 'complete' }, undefined, {
    source: 'xcui-live',
    nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
  });
}

test('a centre-covered id target allows the sheet decline', () => {
  const snapshot = sheetScreen();
  assert.equal(centreCovered(snapshot.elements[3], snapshot), true);
  assert.equal(targetEvidence(homeTarget, snapshot), 'fail');
  assert.deepEqual(dismissCandidate(snapshot, [homeTarget]), { label: 'Close' });
});

test('an uncovered id target still vetoes recovery', () => {
  const snapshot = sheetScreen(false);
  assert.equal(targetEvidence(homeTarget, snapshot), 'pass');
  assert.equal(dismissCandidate(snapshot, [homeTarget]), undefined);
});

test('a later target covered by the scrim does not veto recovery', () => {
  assert.deepEqual(
    dismissCandidate(sheetScreen(), [{ phrase: 'absent', quoted: 'absent' }, homeTarget]),
    { label: 'Close' },
  );
});

for (const exact of [undefined, 'text'] as const) {
  test(`a text target uses uncovered contains matches for recovery (${exact})`, () => {
    const target = { phrase: 'Home', quoted: 'Home', exact };
    assert.deepEqual(dismissCandidate(sheetScreen(), [target]), { label: 'Close' });
    assert.equal(dismissCandidate(sheetScreen(false), [target]), undefined);
  });
}

test('a covered target with two decline controls still refuses as ambiguous', () => {
  const candidate = dismissCandidate(sheetScreen(true, ['Close', 'Not now']), [homeTarget]);
  assert.ok(candidate && 'refuse' in candidate);
  assert.equal(candidate.refuse.code, 'INTERRUPTION_AMBIGUOUS');
});

test('a wait for an id behind the scrim dismisses Close once and then passes', async () => {
  let snapshot = sheetScreen();
  const f = walker(
    [snapshot],
    scriptedJudge(() => assert.fail('no model needed')),
  );
  f.deps.captureScreen = async () => snapshot;
  f.deps.hideDevMenu = async () => assert.fail('no dev menu');
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    snapshot = sheetScreen(true, []);
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(parsePlan('1. Wait for "home"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @decline0']);
  assert.equal(result.recoveries, 1);
  const retry = result.steps.find((row) => row.outcome === 'retry');
  assert.ok(retry?.operationId);
  assert.deepEqual(
    result.steps.filter((row) => row.operationId === retry.operationId).map((row) => row.outcome),
    ['retry', 'pass'],
  );
  assert.match(retry.reason ?? '', /recovered: dismissed an app screen with Close/);
});
