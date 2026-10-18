import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlock } from '../../../dist/qa/blocks.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { Screen } from '../../../dist/qa/screen.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import { choice, element, screen, scriptedJudge } from './judgment-fixtures.ts';

function app(initial: Screen) {
  let current = initial;
  const actions: string[] = [];
  const deps: WalkerDeps = {
    async captureScreen() {
      return current;
    },
    async press(ref, context) {
      assert.ok(context);
      actions.push(`press ${ref}`);
      current = ref === '@close' ? home() : screen([element('@done', 'Done')]);
      return { ok: true, proven: false, executed: true };
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      throw new Error('unexpected scroll');
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog(action) {
      actions.push(`dialog ${action}`);
      current = home();
      return { ok: true, proven: true, executed: true };
    },
    async hideDevMenu() {
      throw new Error('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    now: () => 0,
    async sleep() {},
    row() {},
  };
  return { deps, actions, show: (next: Screen) => (current = next) };
}

const home = () => screen([element('@settings', 'Settings')]);
const promo = () => screen([element('@close', 'Close')]);
const plan = () => parsePlan('1. Tap "Settings"\n✓ "Done"').blocks!;

test('a present optional pop-up is declined once before retrying the missing target', async () => {
  const f = app(promo());
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @close', 'press @settings']);
  assert.equal(result.recoveries, 1);
  const row = result.steps.find((row) =>
    row.reason?.includes('dismissed an app screen with Close'),
  );
  assert.equal(row?.outcome, 'retry');
  assert.ok(row?.screenshot);
});

test('a permission alert behind a phrase target reaches default decline without asking Jev about it', async () => {
  const f = app({
    ...screen([element('@allow', 'Allow')]),
    front: 'dialog',
    coverage: { native: 'incomplete', react: 'complete' },
    captureCoverage: { native: 'complete', react: 'complete' },
  });
  const judge = scriptedJudge((questions, _index, state) => {
    assert.equal((state as { front: string }).front, 'app');
    return Object.fromEntries(
      Object.entries(questions).map(([id, question]) => [id, choice(question)]),
    );
  });
  f.deps.judge = judge;
  const result = await runPlan(parsePlan('1. Tap the settings button').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['dialog dismiss', 'press @settings']);
});

test('an absent interruption leaves the plan unchanged', async () => {
  const f = app(home());
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.recoveries, 0);
  assert.deepEqual(f.actions, ['press @settings']);
});

test('ambiguous decline controls refuse without tapping either', async () => {
  for (const other of ['Close', 'Not now']) {
    const f = app(screen([element('@close', 'Close'), element('@other', other)]));
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.code, 'INTERRUPTION_AMBIGUOUS');
    assert.deepEqual(f.actions, []);
  }
});

test('an opt-in-only screen fails without consenting', async () => {
  const f = app(screen([element('@allow', 'Allow')]));
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
});

test('a definite failed check can dismiss an interruption and retry the check', async () => {
  const f = app(promo());
  const result = await runPlan(parsePlan('✓ "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(f.actions, ['press @close']);
});

test('a target appearing before dispatch prevents the interruption tap', async () => {
  const f = app(promo());
  let captures = 0;
  f.deps.captureScreen = async () =>
    ++captures < 3
      ? promo()
      : screen([element('@close', 'Close'), element('@settings', 'Settings')]);
  const result = await runPlan(plan(), f.deps);
  assert.notEqual(result.verdict, 'PASS');
  assert.deepEqual(f.actions, []);
});

test('the current target on an unchanged screen prevents dismissal', async () => {
  const f = app(screen([element('@close', 'Close'), element('@settings', 'Settings')]));
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true };
  };
  assert.equal((await runPlan(plan(), f.deps)).verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @settings', 'press @settings']);
});

test('later plan targets prevent dismissal, including targets in another block', async () => {
  for (const text of [
    '1. Tap "Settings"\n2. Tap "Profile"',
    '### First\n1. Tap "Settings"\n### Second\n2. Tap "Profile"',
  ]) {
    const f = app(screen([element('@close', 'Close'), element('@profile', 'Profile')]));
    assert.equal((await runPlan(parsePlan(text).blocks!, f.deps)).verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
  }
});

test('disabled, offscreen and non-control decline words are never tapped', async () => {
  for (const candidate of [
    element('@close', 'Close', { disabled: true }),
    element('@close', 'Close', { offscreen: true }),
    element('@close', 'Close', { kind: 'text' }),
    element('@close', 'Close', {
      semantic: { press: 'unknown', fill: 'unsupported', visibility: 'visible' },
    }),
  ]) {
    const f = app(screen([candidate]));
    assert.equal((await runPlan(plan(), f.deps)).verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
  }
});

test('a decline that leaves the control visible is attempted only once and never retries the plan step', async () => {
  const f = app(promo());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(screen([element('@close', 'Close'), element('@other', 'Changed')]));
    return { ok: true, proven: false, executed: true };
  };
  assert.equal((await runPlan(plan(), f.deps)).verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
});

test('an unchanged decline control is never pressed a second time', async () => {
  const f = app(promo());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true };
  };
  assert.equal((await runPlan(plan(), f.deps)).verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
});

test('without the key-gated veto, a quoted plan uses only deterministic evidence', async () => {
  const f = app(promo());
  f.deps.judge = scriptedJudge(() => {
    throw new Error('unexpected model call');
  });
  assert.equal((await runPlan(plan(), f.deps)).verdict, 'PASS');
});

test('Jev can veto a uniquely selected control, but cannot break a tie or choose another control', async () => {
  for (const probability of [0.1, 0.5]) {
    const f = app(promo());
    f.deps.interruptionVeto = true;
    f.deps.judge = scriptedJudge((questions) => {
      assert.equal(questions.interruption.type, 'noul');
      return { interruption: { type: 'noul', noul: probability } };
    });
    const result = await runPlan(plan(), f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal(result.code, 'INTERRUPTION_VETOED');
    assert.deepEqual(f.actions, []);
  }
  const f = app(screen([element('@close', 'Close'), element('@skip', 'Skip')]));
  f.deps.interruptionVeto = true;
  const judge = scriptedJudge(() => {
    throw new Error('ambiguity must not ask Jev');
  });
  f.deps.judge = judge;
  assert.equal((await runPlan(plan(), f.deps)).code, 'INTERRUPTION_AMBIGUOUS');
  assert.equal(judge.requests.length, 0);
  assert.deepEqual(f.actions, []);
});

test('an explicit Allow permission step still accepts the system prompt', async () => {
  const f = app({ ...screen([element('@allow', 'Allow')]), front: 'dialog' });
  assert.equal(
    (await runPlan(parsePlan('1. Allow the permission prompt').blocks!, f.deps)).verdict,
    'PASS',
  );
  assert.deepEqual(f.actions, ['dialog accept']);
});

test('incomplete raw system-alert evidence stays terminal', async () => {
  const f = app({
    ...screen([element('@allow', 'Allow')]),
    front: 'dialog',
    coverage: { native: 'incomplete', react: 'complete' },
    captureCoverage: { native: 'incomplete', react: 'complete' },
  });
  const result = await runPlan(parsePlan('1. Tap the settings button').blocks!, f.deps);
  assert.match(result.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.deepEqual(f.actions, []);
});

test('a non-executing decline cannot count as recovery even if the screen changes', async () => {
  const f = app(promo());
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    await press(ref, context);
    return { ok: true, proven: false, executed: false };
  };
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /INTERRUPTION_NOT_DISPATCHED/);
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 0);
});

test('interruption support actions do not become required commands in the saved block', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-interruption-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = app(promo());
  const result = await runPlan(plan(), f.deps, [], {
    appRoot: root,
    appId: 'app',
    platform: 'ios',
  });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.blocksWritten, ['plan']);
  const saved = loadBlock(root, 'plan')!;
  assert.match(saved, /Settings/);
  assert.ok(!saved.includes('Close'));
});

test('the veto sees masked input evidence and recovery screenshots respect privacy', async () => {
  const secret = 'private-interruption-value';
  const f = app(
    screen([
      element('@close', 'Close'),
      element('@secret', 'Secret', {
        kind: 'input',
        nativeKind: 'input',
        secure: true,
        value: secret,
      }),
    ]),
  );
  const judge = scriptedJudge((_questions, _index, state) => {
    assert.ok(!JSON.stringify(state).includes(secret));
    return { interruption: { type: 'noul', noul: 0.9 } };
  });
  f.deps.judge = judge;
  f.deps.interruptionVeto = true;
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(judge.requests.length, 1);
  assert.ok(!JSON.stringify(result).includes(secret));
  const recovery = result.steps.find((row) => row.reason?.includes('dismissed an app screen'));
  assert.equal(recovery?.screenshot, undefined);
});

test('saved-block replay excludes completed blocks from the later-target guard', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-interruption-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const blocks = parsePlan(
    '### Before\n1. Tap "Home"\n### Target\n2. Tap "Settings"\n✓ "Done"',
  ).blocks!;
  for (const interrupted of [false, true]) {
    const f = app(screen([element('@home', 'Home')]));
    let reachedTarget = false;
    let closed = false;
    let targetCaptures = 0;
    const capture = f.deps.captureScreen;
    f.deps.captureScreen = async (options) =>
      reachedTarget && interrupted && !closed && ++targetCaptures >= 6
        ? screen([element('@close', 'Close'), element('@past', 'Home', { kind: 'text' })])
        : capture(options);
    f.deps.press = async (ref) => {
      f.actions.push(`press ${ref}`);
      if (ref === '@home') {
        reachedTarget = true;
        f.show(home());
      } else if (ref === '@close') {
        closed = true;
        f.show(home());
      } else if (!interrupted || closed) f.show(screen([element('@done', 'Done')]));
      return { ok: true, proven: false, executed: true };
    };
    const result = await runPlan(blocks, f.deps, [], {
      appRoot: root,
      appId: 'app',
      platform: 'ios',
    });
    assert.equal(result.verdict, 'PASS');
    if (interrupted) {
      assert.equal(result.path, 'replay');
      assert.equal(result.recoveries, 1);
      assert.deepEqual(f.actions, [
        'press @home',
        'press @settings',
        'press @settings',
        'press @close',
        'press @settings',
      ]);
    }
  }
});

test('a declined recovery logs one value-free rejection while preserving the original failure', async () => {
  const control = element('@private', 'Skip');
  control.semantic!.press = 'unknown';
  const f = app(screen([control]));
  const logs: string[] = [];
  f.deps.note = (line) => logs.push(line);
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
  const records = logs.filter((line) => line.startsWith('interruption-rejected='));
  assert.equal(records.length, 1);
  const record = JSON.parse(records[0].slice('interruption-rejected='.length));
  assert.equal(record.line, 1);
  assert.equal(typeof record.observation, 'number');
  assert.deepEqual(record.elements, [{ index: 0, failed: 'press-not-supported' }]);
  assert.doesNotMatch(records[0], /Skip|Settings|private|@/);
  const successful = app(promo());
  successful.deps.note = (line) => logs.push(line);
  logs.length = 0;
  assert.equal((await runPlan(plan(), successful.deps)).verdict, 'PASS');
  assert.equal(logs.filter((line) => line.startsWith('interruption-rejected=')).length, 0);
});

const waitPlan = (extra = '') => parsePlan(`1. Wait for "Settings" to appear\n${extra}`).blocks!;
const alert = (): Screen => ({
  ...screen([element('@allow', 'Allow')]),
  front: 'dialog',
  coverage: { native: 'incomplete', react: 'complete' },
  captureCoverage: { native: 'complete', react: 'complete' },
});
function ticking(f: ReturnType<typeof app>) {
  let clock = 0;
  f.deps.now = () => clock;
  f.deps.sleep = async (ms) => {
    clock += ms;
  };
  const rows: Parameters<WalkerDeps['row']>[0][] = [];
  f.deps.row = (row) => rows.push(row);
  return rows;
}
// A pop-up whose hero changes on every capture until its decline is pressed.
function changingPopup(f: ReturnType<typeof app>, skip = element('@close', 'Skip')) {
  let frame = 0;
  let dismissed = false;
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    dismissed = true;
    return press(ref, context);
  };
  f.deps.captureScreen = async () =>
    dismissed ? home() : screen([element('@hero', `Hero ${frame++}`), skip]);
}

test('a quoted wait behind an unchanged optional pop-up declines it once and retries the wait', async () => {
  const f = app(screen([element('@close', 'Skip')]));
  const rows = ticking(f);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
  const retry = rows.find((row) => row.outcome === 'retry');
  assert.match(
    result.steps.find((row) => row.outcome === 'retry')?.reason ?? '',
    /^"Settings" did not appear within 15s; the screen did not change across \d+ observations; recovered: dismissed an app screen with Skip/,
  );
  assert.deepEqual(
    rows.filter((row) => row.operationId === retry?.operationId).map((row) => row.outcome),
    ['retry', 'pass'],
  );
});

test('a quoted wait behind a changing optional pop-up declines it once and retries the wait', async () => {
  const f = app(home());
  changingPopup(f);
  ticking(f);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
  assert.match(
    result.steps.find((row) => row.outcome === 'retry')?.reason ?? '',
    /^VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED; recovered: dismissed an app screen with Skip/,
  );
});

test('a quoted wait behind a system alert declines it by default and retries the wait', async () => {
  const f = app(alert());
  ticking(f);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['dialog dismiss']);
  assert.equal(result.recoveries, 1);
  assert.match(
    result.steps.find((row) => row.outcome === 'retry')?.reason ?? '',
    /^"Settings" did not appear within 15s; the screen did not change across \d+ observations; recovered: dialog/,
  );
});

test('a system alert is left to the plan when its next step is a dialog step', async () => {
  const f = app(alert());
  ticking(f);
  const result = await runPlan(waitPlan('2. Dismiss the permission dialog'), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 1);
  assert.match(result.failure?.seen ?? '', /^"Settings" did not appear within 15s/);
  assert.deepEqual(f.actions, []);
  assert.equal(result.recoveries, 0);
});

test('a quoted wait with no pop-up passes without recovery', async () => {
  const f = app(home());
  const rows = ticking(f);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.recoveries, 0);
  assert.deepEqual(f.actions, []);
  assert.deepEqual(
    rows.map((row) => [row.line, row.outcome]),
    [[1, 'pass']],
  );
});

test('a quoted wait whose recovery finds nothing keeps its original failure on both unmet exits', async () => {
  for (const changing of [false, true]) {
    const skip = element('@close', 'Skip', { disabled: true });
    const f = app(screen([skip]));
    if (changing) changingPopup(f, skip);
    ticking(f);
    const logs: string[] = [];
    f.deps.note = (line) => logs.push(line);
    const result = await runPlan(waitPlan(), f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(f.actions, []);
    assert.equal(result.recoveries, 0);
    assert.match(
      result.failure?.seen ?? '',
      changing
        ? /VISIBILITY_UNSURE: ITEM_DEADLINE_EXCEEDED/
        : /^"Settings" did not appear within 15s/,
    );
    const records = logs.filter((line) => line.startsWith('interruption-rejected='));
    assert.equal(records.length, 1);
    assert.equal(
      JSON.parse(records[0].slice('interruption-rejected='.length)).veto,
      'no-candidate',
    );
  }
});

test('a quoted wait that fails again after one decline does not recover a second time', async () => {
  const f = app(screen([element('@close', 'Skip')]));
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(screen([element('@done', 'Done')]));
    return { ok: true, proven: false, executed: true };
  };
  ticking(f);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
  assert.match(result.failure?.seen ?? '', /^"Settings" did not appear within 15s/);
});

// Android has no platform presence capture yet, so the recovery's presence read is incomplete.
const withoutPresence = (elements = [element('@close', 'Skip')]): Screen => ({
  ...screen(elements),
  coverage: { native: 'incomplete', react: 'complete' },
  captureCoverage: { native: 'complete', react: 'complete' },
});

test('on Android a failed check keeps its own reason when recovery has no presence capture', async () => {
  const f = app(withoutPresence());
  f.deps.presenceUnavailable = true;
  const logs: string[] = [];
  f.deps.note = (line) => logs.push(line);
  const result = await runPlan(parsePlan('✓ "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure?.seen ?? '', /"Settings" is not satisfied on screen/);
  assert.doesNotMatch(result.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.deepEqual(f.actions, []);
  assert.equal(result.recoveries ?? 0, 0);
  assert.deepEqual(
    logs.filter((line) => line.startsWith('recovery-skipped=')),
    ['recovery-skipped=presence-unavailable'],
  );
});

test('with presence capture available the incomplete recovery read still refuses', async () => {
  const f = app(withoutPresence());
  const logs: string[] = [];
  f.deps.note = (line) => logs.push(line);
  const result = await runPlan(parsePlan('✓ "Settings"').blocks!, f.deps);
  assert.match(result.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE: NATIVE_PRESENCE_UNUSABLE/);
  assert.deepEqual(f.actions, []);
  assert.equal(logs.filter((line) => line.startsWith('recovery-skipped=')).length, 0);
});

test('on Android a system dialog in front is still declined by recovery', async () => {
  const f = app(alert());
  f.deps.presenceUnavailable = true;
  const result = await runPlan(parsePlan('1. Tap "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['dialog dismiss', 'press @settings']);
});
