import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../../../dist/qa/plan.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import type { WalkSequence } from '../../../dist/qa/walker.js';
import type { Block } from '../../../dist/qa/plan.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { NativeCaptureError } from '../../../dist/qa/capture.js';
import { InputPrivacyRefusal, RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { loginBlock, runPlan, walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';
import type { LedgerRow, StepStart } from '../../../dist/qa/ledger.js';

function screen(
  labels: string[],
  front: Screen['front'] = 'app',
  testIDs: Record<string, string> = {},
): Screen {
  return {
    elements: labels.map((label, i) => ({
      ref: `@e${i}`,
      kind: 'button',
      label,
      ...(testIDs[label] ? { testID: testIDs[label] } : {}),
      hittable: true,
      disabled: false,
      secure: false,
      offscreen: false,
      semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
      where: 'middle',
      side: 'center',
    })),
    visibleText: labels,
    front,
    coverage: { native: 'complete', react: 'complete' },
  };
}

function fake(
  screens: (Screen | Error)[],
  extra: Partial<WalkerDeps> = {},
  redBox = false,
): { deps: WalkerDeps; rows: LedgerRow[]; calls: string[] } {
  const rows: LedgerRow[] = [];
  const calls: string[] = [];
  let clock = 0;
  const queue = [...screens];
  const ok: ActResult = { ok: true, proven: false };
  const deps: WalkerDeps = {
    async captureScreen() {
      calls.push('capture');
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return redBox ? { ...next, renderError: true } : next;
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return ok;
    },
    async fill(ref, text) {
      calls.push(`fill ${ref} ${text}`);
      return { ok: true, proven: true };
    },
    async scroll(direction) {
      calls.push(`scroll ${direction}`);
      return ok;
    },
    async back() {
      calls.push('back');
      return ok;
    },
    async dialog(action) {
      calls.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      calls.push('hideDevMenu');
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: (row) => {
      rows.push(row);
    },
    ...extra,
  };
  return { deps, rows, calls };
}

function block(markdown: string): Block {
  const parsed = parsePlan(markdown);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
}

test('an unchanged screen with a dialog in front recovers once and the retry passes', async () => {
  const covered = screen(['Settings'], 'dialog');
  const f = fake([
    covered,
    covered,
    covered,
    covered,
    covered,
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.equal(ledger.escapes, 0);
  assert.equal(ledger.llmTurns, 0);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith('capture')),
    ['press @e0', 'press @e0', 'dialog dismiss', 'press @e0'],
  );
  const recovered = ledger.steps.find((r) => r.reason?.includes('recovered: dialog'));
  assert.equal(recovered?.outcome, 'retry');
  assert.equal(ledger.steps.at(-1)?.outcome, 'pass');
  assert.deepEqual(
    f.rows.map((row) => [row.attempt, row.outcome]),
    [
      [1, 'retry'],
      [2, 'retry'],
      [1, 'pass'],
    ],
  );
  assert.ok(f.rows[0].operationId);
  assert.ok(f.rows.every((row) => row.operationId === f.rows[0].operationId));
});

test('each line announces a value-free start before its rows, under the same operation', async () => {
  const covered = screen(['Settings'], 'dialog');
  const events: string[] = [];
  const starts: StepStart[] = [];
  const f = fake(
    [covered, covered, covered, covered, covered, screen(['Settings']), screen(['Profile'])],
    {
      start: (start) => {
        starts.push(start);
        events.push(`start ${start.operationId}`);
      },
    },
  );
  const row = f.deps.row;
  f.deps.row = (r) => {
    events.push(`${r.outcome} ${r.operationId}`);
    row(r);
  };
  const ledger = await runPlan([block('1. Tap "Settings"\n✓ "Profile"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  const [tap, check] = [...new Set(f.rows.map((r) => r.operationId))];
  assert.ok(tap && check && tap !== check);
  assert.equal(events[0], `start ${tap}`);
  assert.equal(events.indexOf(`start ${check}`), events.indexOf(`pass ${tap}`) + 1);
  assert.equal(events.at(-1), `pass ${check}`);
  assert.deepEqual(
    starts.map((s) => [s.operationId, s.line, s.kind]),
    [...starts.slice(0, -1).map(() => [tap, 1, 'step']), [check, 2, 'check']],
  );
  assert.ok(
    starts.every(
      (s) => JSON.stringify(Object.keys(s).sort()) === '["kind","line","operationId","t"]',
    ),
  );
});

test('a second failure of the same item fails without a second recovery', async () => {
  const f = fake([screen(['Settings'], 'dialog')]);
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.recoveries, 1);
  assert.equal(f.calls.filter((c) => c === 'dialog dismiss').length, 1);
  assert.match(ledger.failure?.seen ?? '', /did not change after recovery/);
  assert.equal(f.calls.filter((c) => c.startsWith('press')).length, 3);
  assert.deepEqual(
    f.rows.map((row) => [row.attempt, row.outcome]),
    [
      [1, 'retry'],
      [2, 'retry'],
      [1, 'fail'],
    ],
  );
  assert.ok(f.rows[0].operationId);
  assert.ok(f.rows.every((row) => row.operationId === f.rows[0].operationId));
});

test('a target missing behind a dialog recovers once', async () => {
  const f = fake([
    screen(['Allow'], 'dialog'),
    screen(['Allow'], 'dialog'),
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.equal(outcome.recoveries, 1);
  assert.deepEqual(
    outcome.rows.map((r) => r.outcome),
    ['retry', 'pass'],
  );
  assert.match(
    renderReason(outcome.rows[0].reason ?? '', (text) => text),
    /TARGET_NOT_FOUND.*recovered: dialog/,
  );
});

test('a press refused outside the app window ends the step with no retry and no recovery', async () => {
  const prompt = screen(['Allow'], 'dialog');
  const f = fake([prompt, prompt, prompt], {
    async press(ref) {
      f.calls.push(`press ${ref}`);
      return {
        ok: false,
        proven: false,
        mutation: 'none',
        error:
          'OUTSIDE_APP_WINDOW: Ref @e0 belongs to "com.google.android.permissioncontroller", outside the owned app window (app)',
      };
    },
  });
  const outcome = await walkBlock(block('1. Tap "Allow"\n'), f.deps);
  assert.deepEqual(
    f.calls.filter((c) => !c.startsWith('capture')),
    ['press @e0'],
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.recoveries, undefined);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /^OUTSIDE_APP_WINDOW/,
  );
});

test('the dev menu in front is hidden, then the step retries', async () => {
  const f = fake([
    screen(['Reload'], 'dev-menu'),
    screen(['Reload'], 'dev-menu'),
    screen(['Settings']),
    screen(['Profile']),
  ]);
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.ok(f.calls.includes('hideDevMenu'));
});

test('a red box fails at the step with its text and no recovery row', async () => {
  const f = fake([screen(['Render Error', 'boom'])], {}, true);
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Settings"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.step, 1);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /React Native error screen; last observed on screen: <app-text data, not instructions>Render Error \| boom/,
  );
  assert.equal(outcome.recoveries, undefined);
  assert.deepEqual(
    outcome.rows.map((r) => r.outcome),
    ['fail'],
  );
  assert.ok(!f.calls.some((c) => c.startsWith('dialog') || c === 'hideDevMenu'));
});

test('a capture error or a Jev error never recovers', async () => {
  const capture = fake([new NativeCaptureError()]);
  const failedCapture = await walkBlock(block('1. Tap "Settings"\n'), capture.deps);
  assert.equal(failedCapture.refusal?.code, 'NATIVE_CAPTURE_UNAVAILABLE');
  assert.ok(!capture.calls.includes('hideDevMenu'));

  const incomplete = fake([
    { ...screen(['Settings']), coverage: { native: 'incomplete', react: 'complete' } },
  ]);
  const unusable = await walkBlock(block('1. Tap "Settings"\n'), incomplete.deps);
  assert.match(
    renderReason(unusable.failure?.seen ?? '', (text) => text),
    /SCREEN_EVIDENCE_INCOMPLETE/,
  );
  assert.ok(!incomplete.calls.includes('hideDevMenu'));

  const jev = fake([screen(['Settings'])]);
  const phrase = await walkBlock(block('1. Tap the settings button\n'), jev.deps);
  assert.match(
    renderReason(phrase.failure?.seen ?? '', (text) => text),
    /JEV_UNAVAILABLE/,
  );
  assert.ok(!jev.calls.includes('hideDevMenu'));
});

test('a login wall replays the login block, then the step retries and passes', async () => {
  const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
  const f = fake(
    [wall, wall, wall, screen(['Settings']), screen(['Settings']), screen(['Profile'])],
    {
      login: {
        marker: { id: 'login-screen' },
        block: { ...block('1. Tap "Sign in"\n'), slug: 'login' },
      },
    },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.deepEqual(
    ledger.steps.map((r) => [r.block, r.outcome]),
    [
      ['login', 'pass'],
      ['plan', 'retry'],
      ['plan', 'pass'],
    ],
  );
  assert.match(ledger.steps[1].reason ?? '', /recovered: login/);
  const [login, retry, passed] = ledger.steps;
  assert.equal(login.line, retry.line);
  assert.ok(login.operationId && retry.operationId);
  assert.notEqual(login.operationId, retry.operationId);
  assert.equal(retry.operationId, passed.operationId);
  assert.deepEqual(
    f.rows.map((row) => row.operationId),
    ledger.steps.map((row) => row.operationId),
  );
  assert.ok(f.rows.every((row) => row.block === '' && row.text === ''));
});

test('no recovery runs inside the login replay', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const f = fake([wall], {
    login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the login block did not pass/,
  );
  assert.deepEqual(
    outcome.rows.map((r) => [r.block, r.outcome]),
    [
      ['login', 'fail'],
      ['plan', 'fail'],
    ],
  );
});

test('a configured but unreadable login block fails at the step', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const f = fake([wall], { login: { marker: { id: 'login-screen' } } });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /the login block did not pass/,
  );
});

test('slot runs report only existing saved-login recovery outcomes, even when the sink fails', async () => {
  for (const expected of ['pass', 'fail', 'refused'] as const) {
    for (const brokenSink of [false, true]) {
      const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
      const events: unknown[] = [];
      const f = fake(
        expected === 'pass'
          ? [wall, wall, wall, screen(['Settings']), screen(['Settings']), screen(['Profile'])]
          : [wall],
        {
          login: {
            marker: { id: 'login-screen' },
            ...(expected === 'fail'
              ? {}
              : {
                  block: { ...block('1. Tap "Sign in"\n'), slug: 'private-title' },
                }),
          },
          loginOutcome: (outcome) => {
            events.push(outcome);
            if (brokenSink) throw Error('private-sink');
          },
        },
      );
      if (expected === 'refused') {
        let reads = 0;
        f.deps.captureScreen = async () => {
          if (++reads >= 3) throw new NativeCaptureError();
          return wall;
        };
      }
      const ledger = await withInputs(
        new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']),
        () => runPlan([block('1. Tap "Settings"\n')], f.deps),
      );
      assert.equal(
        ledger.verdict,
        expected === 'pass' ? 'PASS' : expected === 'refused' ? 'REFUSED' : 'FAIL',
      );
      assert.deepEqual(events, [expected]);
    }
  }
});

test('a saved-login input-privacy refusal is reported while the original abort still propagates', async () => {
  const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
  const events: string[] = [];
  const error = new InputPrivacyRefusal();
  const f = fake([wall], {
    login: { marker: { id: 'login-screen' }, block: block('1. Tap "Sign in"') },
    loginOutcome: (outcome) => events.push(outcome),
    press: async () => {
      throw error;
    },
  });
  await assert.rejects(
    withInputs(new RunInputs({ PASSWORD: 'private-value' }, ['PASSWORD']), () =>
      runPlan([block('1. Tap "Settings"')], f.deps),
    ),
    (caught) => caught === error,
  );
  assert.deepEqual(events, ['refused']);
});

const passwordInput: Screen = {
  ...screen([]),
  elements: [
    {
      ref: '@e1',
      kind: 'input',
      testID: 'password',
      placeholder: 'Password',
      hittable: true,
      disabled: false,
      secure: false,
      offscreen: false,
      semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
    },
  ],
};
const loginWall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
const typingLogin = {
  marker: { id: 'login-screen' },
  block: block('### Login\n1. Type "hunter2-secret" into "password"\n'),
};

test('a login before any plan pass publishes from after the replay', async () => {
  const f = fake(
    [
      loginWall,
      loginWall,
      passwordInput,
      screen(['Settings']),
      screen(['Settings']),
      screen(['Profile']),
    ],
    { login: typingLogin },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.videoPublication, 'eligible');
  assert.equal(typeof ledger.publishFromMs, 'number');
  assert.ok(!JSON.stringify(ledger).includes('hunter2-secret'));
});

test('a typed login value on screen after the replay withholds the video', async () => {
  const f = fake(
    [
      loginWall,
      loginWall,
      passwordInput,
      screen(['Settings']),
      screen(['Settings']),
      screen(['Signed in as hunter2-secret']),
    ],
    { login: typingLogin },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.videoPublication, 'withheld-privacy');
});

test('a typed login value on the last login screen withholds the video', async () => {
  const f = fake(
    [
      loginWall,
      loginWall,
      passwordInput,
      screen(['Settings', 'hunter2-secret']),
      screen(['Settings']),
      screen(['Profile']),
    ],
    { login: typingLogin },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.videoPublication, 'withheld-privacy');
});

test('a login after a plan step passed withholds the video with no publish window', async () => {
  const f = fake(
    [
      screen(['Settings']),
      screen(['Home']),
      loginWall,
      loginWall,
      passwordInput,
      screen(['Profile']),
      screen(['Profile']),
      screen(['Done']),
    ],
    { login: typingLogin },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n2. Tap "Profile"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 1);
  assert.equal(ledger.videoPublication, 'withheld-fill');
  assert.equal(ledger.publishFromMs, undefined);
});

test('a second login after the publish window opened withholds the video', async () => {
  const f = fake(
    [
      loginWall,
      loginWall,
      passwordInput,
      screen(['Settings']),
      screen(['Settings']),
      screen(['Home']),
      loginWall,
      loginWall,
      passwordInput,
      screen(['Profile']),
      screen(['Profile']),
      screen(['Done']),
    ],
    { login: typingLogin },
  );
  const ledger = await runPlan([block('1. Tap "Settings"\n2. Tap "Profile"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.recoveries, 2);
  assert.equal(ledger.videoPublication, 'withheld-fill');
  assert.equal(ledger.publishFromMs, undefined);
});

test('a plan fill withholds the video even after a pre-plan login', async () => {
  const name: Screen = {
    ...passwordInput,
    elements: [{ ...passwordInput.elements[0], testID: 'name', placeholder: 'Name' }],
  };
  const f = fake([loginWall, loginWall, passwordInput, name, name, screen(['Saved'])], {
    login: typingLogin,
  });
  const ledger = await runPlan([block('1. Type "Ada" into "name"\n')], f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(ledger.videoPublication, 'withheld-fill');
});

test('a stored login block becomes exact-target items', () => {
  const login = loginBlock('login', {
    header: { appId: 'app', plan: 'login', planHash: 'h', platform: 'ios' },
    steps: [
      { raw: '1. Tap the sign in button', kind: 'press', selector: { id: 'sign-in' } },
      { raw: '2. Type "a" into email', kind: 'fill', selector: { text: 'Email' }, text: 'a' },
      { raw: '✓ "Welcome"', kind: 'check', text: 'Welcome' },
      { raw: '✓ The home screen is shown', kind: 'check' },
      { raw: '3. Accept the dialog', kind: 'dialog', action: 'accept' },
    ],
  });
  assert.deepEqual(
    login.items.map((item) => ({ ...item, raw: undefined })),
    [
      {
        kind: 'press',
        target: { quoted: 'sign-in', phrase: 'sign-in', exact: 'id' },
        line: 1,
        source: 'grammar',
        raw: undefined,
      },
      {
        kind: 'fill',
        target: { quoted: 'Email', phrase: 'Email', exact: 'text' },
        text: 'a',
        line: 2,
        source: 'grammar',
        raw: undefined,
      },
      { kind: 'check', text: 'Welcome', literal: true, line: 3, source: 'grammar', raw: undefined },
      {
        kind: 'check',
        text: 'The home screen is shown',
        literal: false,
        line: 4,
        source: 'grammar',
        raw: undefined,
      },
      { kind: 'dialog', action: 'accept', line: 5, source: 'grammar', raw: undefined },
    ],
  );
});

test('a selector miss after a replay recovery is terminal, not a second re-walk', async () => {
  const covered = screen(['Settings'], 'dialog', { Settings: 'settings' });
  const f = fake([covered, covered, covered, covered, covered, screen(['Other'])]);
  const replayed = block('1. Tap "settings"\n');
  const exact: Block = {
    ...replayed,
    items: replayed.items.map((item) =>
      item.kind === 'press'
        ? { ...item, target: { quoted: 'settings', phrase: 'settings', exact: 'id' } }
        : item,
    ),
  };
  const outcome = await walkBlock(exact, f.deps, 0, [], undefined, undefined, { mode: 'replay' });
  assert.equal(outcome.recoveries, 1);
  assert.equal(outcome.miss, undefined);
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /REPLAY_SELECTOR/,
  );
});

test('a stale login selector fails the login plainly and reports the screen after it', async () => {
  const wall = screen(['Welcome'], 'app', { Welcome: 'login-screen' });
  const after = screen(['Password required']);
  const f = fake([wall, wall, after, after], {
    login: {
      marker: { id: 'login-screen' },
      block: loginBlock('login', {
        header: { appId: 'app', plan: 'login', planHash: 'h', platform: 'ios' },
        steps: [{ raw: '1. Tap the sign in button', kind: 'press', selector: { id: 'sign-in' } }],
      }),
    },
  });
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Settings"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.deepEqual(
    outcome.rows.map((r) => [r.block, r.outcome]),
    [
      ['login', 'fail'],
      ['plan', 'fail'],
    ],
  );
  assert.ok(!renderReason(outcome.rows[0].reason ?? '', (text) => text).includes('re-walking'));
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /login block did not pass.*Password required/,
  );
});

for (const plan of ['1. Tap "Settings"\n', '✓ "Render Error"\n', '✓ The home screen is shown\n']) {
  test(`render error terminates before accepting ${plan.trim()}`, async () => {
    const overlay = {
      ...screen(['Render Error', 'boom']),
      renderError: true,
      coverage: { native: 'incomplete', react: 'unknown' } as const,
    };
    const f = fake([overlay]);
    const sequence: WalkSequence = { observation: 0 };
    const outcome = await walkBlock(block(plan), f.deps, undefined, undefined, undefined, sequence);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(outcome.refusal, undefined);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /boom/,
    );
    assert.equal(outcome.recoveries, undefined);
    assert.ok(!f.calls.some((c) => c.startsWith('press') || c === 'hideDevMenu'));
  });
}

test('a press opening a render error fails instead of accepting screen change', async () => {
  const f = fake([
    screen(['Settings']),
    { ...screen(['Render Error', 'boom']), renderError: true },
  ]);
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Settings"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /boom/,
  );
  assert.equal(outcome.recoveries, undefined);
});

test('a render error inside login replay terminates login and the parent step', async () => {
  const wall = screen(['Sign in'], 'app', { 'Sign in': 'login-screen' });
  const overlay = { ...screen(['Render Error', 'login boom']), renderError: true };
  const f = fake([wall, wall, wall, overlay], {
    login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
  });
  const sequence: WalkSequence = { observation: 0 };
  const outcome = await walkBlock(
    block('1. Tap "Settings"\n'),
    f.deps,
    undefined,
    undefined,
    undefined,
    sequence,
  );
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(outcome.rows.some((r) => r.block === 'login' && r.outcome === 'fail'));
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /login boom/,
  );
  assert.equal(outcome.recoveries, undefined);
});

test('a dev-menu no-op never counts as hidden or recovered', async () => {
  const f = fake([screen(['Reload'], 'dev-menu')], {
    hideDevMenu: async () => ({ ok: true, proven: false, executed: false }),
  });
  const outcome = await walkBlock(block('1. Tap "Settings"\n'), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(
    renderReason(outcome.failure?.seen ?? '', (text) => text),
    /dev menu in front could not be hidden/,
  );
  assert.equal(outcome.recoveries, undefined);
  assert.ok(outcome.rows.every((row) => row.outcome !== 'retry'));
});

for (const [plan, method] of [
  ['1. Tap "Settings"\n', 'press'],
  ['1. Go back\n', 'back'],
  ['1. Scroll down\n', 'scroll'],
  ['1. Accept the dialog\n', 'dialog'],
  ['1. Dismiss the dialog\n', 'dialog'],
  ['1. Type "hello" into "Settings"\n', 'fill'],
] as const) {
  test(`recovery permits only one additional dispatch: ${plan.trim()}`, async () => {
    const covered = screen(['Settings'], 'dev-menu');
    if (method === 'fill') {
      covered.elements[0].kind = 'input';
      covered.elements[0].semantic = {
        press: 'unsupported',
        fill: 'supported',
        visibility: 'visible',
      };
    }
    let dispatches = 0;
    const f = fake([covered], {
      [method]: async () => {
        dispatches++;
        return { ok: false, proven: false, mutation: 'none' };
      },
    });
    const outcome = await walkBlock(block(plan), f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(outcome.recoveries, 1);
    assert.equal(dispatches, 3);
    assert.match(
      renderReason(outcome.failure?.seen ?? '', (text) => text),
      /did not change after recovery/,
    );
  });
}

for (const front of ['app', 'dialog', 'dev-menu'] as const) {
  test(`S9: an ambiguous target on a ${front} front is terminal: no recovery, login replay or retry`, async () => {
    const twins = screen(['Save', 'Save'], front, { Save: 'login-screen' });
    const f = fake([twins], {
      login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
    });
    const ledger = await runPlan([block('1. Tap "Save"\n')], f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.match(ledger.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
    assert.equal(ledger.recoveries ?? 0, 0);
    assert.deepEqual(
      f.calls.filter((c) => c !== 'capture'),
      [],
    );
  });
}

for (const kind of ['press', 'fill'] as const) {
  test(`S8: a ${kind} the handler refuses as ambiguous at dispatch is terminal, never retried`, async () => {
    const calls: string[] = [];
    const refusal: ActResult = {
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'TARGET_AMBIGUOUS: more than one element carries the target',
      ambiguous: true,
    };
    const f = fake([screen(['Save'])], {
      async press(ref) {
        calls.push(`press ${ref}`);
        return refusal;
      },
      async fill(ref) {
        calls.push(`fill ${ref}`);
        return refusal;
      },
      login: { marker: { id: 'login-screen' }, block: block('### Login\n1. Tap "Sign in"\n') },
    });
    const line = kind === 'press' ? '1. Tap "Save"\n' : '1. Type "x" into "Save"\n';
    const s = screen(['Save']);
    if (kind === 'fill') s.elements[0].kind = 'input';
    f.deps.captureScreen = async () => s;
    const ledger = await runPlan([block(line)], f.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.match(ledger.failure?.seen ?? '', /TARGET_AMBIGUOUS/);
    assert.equal(calls.length, 1);
    assert.equal(ledger.steps.filter((r) => r.outcome === 'retry').length, 0);
  });
}
