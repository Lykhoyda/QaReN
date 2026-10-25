import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlock } from '../../../dist/qa/blocks.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { loginBlock, replayBlock, runPlan } from '../../../dist/qa/walker.js';
import type { StoredBlock } from '../../../dist/qa/blocks.js';
import type { Block } from '../../../dist/qa/plan.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
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

test('a recovery revalidation that rejects the screen still records its React coverage gap', async () => {
  const f = app(promo());
  const acquire = f.deps.captureScreen;
  let captures = 0;
  f.deps.captureScreen = async (options) => {
    const observed = await acquire(options);
    if (++captures !== 3) return observed;
    return { ...home(), captureCoverage: { native: 'complete', react: 'unknown' } };
  };
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
  assert.ok(result.steps.some((row) => row.reactCoverage === 'unknown'));
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

test('a later step naming a decline label does not stop an earlier step from closing the sheet', async () => {
  for (const text of [
    '1. Tap "Settings"\n✓ "Done"',
    '1. Tap "Settings"\n✓ "Done"\n### Offer\n2. Tap "Maybe later"',
    '1. Tap "Settings"\n✓ "Done"\n2. Tap "maybe later"',
  ]) {
    const f = app(
      screen([element('@close', 'Close'), element('@later', 'Maybe later', { kind: 'text' })]),
    );
    const result = await runPlan(parsePlan(text).blocks!, f.deps);
    assert.deepEqual(f.actions.slice(0, 2), ['press @close', 'press @settings'], text);
    assert.equal(result.recoveries, 1, text);
  }
});

test('a later step that taps the same decline control keeps it for that step', async () => {
  for (const text of [
    '1. Tap "Settings"\n2. Tap "Close"',
    '1. Tap "Settings"\n### Offer\n2. Tap "close"',
  ]) {
    const f = app(promo());
    assert.equal((await runPlan(parsePlan(text).blocks!, f.deps)).verdict, 'FAIL', text);
    assert.deepEqual(f.actions, [], text);
  }
});

test('replayed decline intent survives stored selectors during recovery and revalidation', async () => {
  for (const replay of [
    replayBlock,
    (block: Block, stored: StoredBlock) => loginBlock(block.slug, stored),
  ]) {
    for (const selector of [{ id: 'offer-decline' }, { text: 'Maybe later' }]) {
      for (const separate of [false, true]) {
        const blocks = parsePlan(
          `✓ "Settings"\n${separate ? '### Offer\n' : ''}1. Tap "Maybe later"`,
        ).blocks!;
        const replayed = blocks.map((block) => {
          const stored: StoredBlock = {
            header: { appId: 'app', plan: block.slug, planHash: block.planHash, platform: 'ios' },
            steps: block.items.map((item) =>
              item.kind === 'check'
                ? { raw: item.raw, kind: 'check', text: item.text }
                : { raw: item.raw, kind: 'press', selector },
            ),
          };
          return replay(block, stored);
        });
        const f = app(
          screen([
            element('@close', 'Close'),
            element('@later', 'Maybe later', { kind: 'text', testID: 'offer-decline' }),
          ]),
        );
        const press = f.deps.press;
        f.deps.press = async (ref, context) => {
          const result = await press(ref, context);
          if (ref === '@close')
            f.show(
              screen([
                element('@settings', 'Settings'),
                element('@later', 'Maybe later', { testID: 'offer-decline' }),
              ]),
            );
          return result;
        };
        const result = await runPlan(replayed, f.deps);
        assert.equal(result.verdict, 'PASS');
        assert.equal(result.recoveries, 1);
        assert.deepEqual(f.actions, ['press @close', 'press @later']);
      }
    }
  }
});

test('a replayed later decline keeps its stored control even when its label changes', async () => {
  const block = parsePlan('✓ "Settings"\n1. Tap "Maybe later"').blocks![0];
  const replayed = replayBlock(block, {
    header: { appId: 'app', plan: block.slug, planHash: block.planHash, platform: 'ios' },
    steps: [
      { kind: 'check', raw: block.items[0].raw, text: 'Settings' },
      { kind: 'press', raw: block.items[1].raw, selector: { id: 'offer-decline' } },
    ],
  });
  const f = app(screen([element('@close', 'Close', { testID: 'offer-decline' })]));
  const result = await runPlan([replayed], f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.recoveries, 0);
  assert.deepEqual(f.actions, []);
});

test('a step that taps a decline label reaches the sheet without auto-dismissal', async () => {
  const f = app(screen([element('@close', 'Close'), element('@later', 'Maybe later')]));
  const result = await runPlan(parsePlan('1. Tap "Maybe later"').blocks!, f.deps);
  assert.deepEqual(f.actions, ['press @later']);
  assert.equal(result.recoveries, 0);
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
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
});

test('an unchanged decline control is never pressed a second time', async () => {
  const f = app(promo());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
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
  assert.equal(result.recoveries, 1);
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

const DECLINED = { label: "Don't Allow", rect: { x: 40, y: 500, width: 160, height: 44 } };
const titled = (title: string): Screen => ({
  ...alert(),
  elements: [element('@title', title, { kind: 'text' }), element('@allow', 'Allow')],
  visibleText: [title, 'Allow'],
});

test('a declined system prompt followed by a different app pop-up declines both, then retries the wait', async () => {
  const f = app(alert());
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    f.show(promo());
    return { ok: true, proven: true, executed: true, dialog: DECLINED };
  };
  ticking(f);
  const logs: string[] = [];
  f.deps.note = (line) => logs.push(line);
  const result = await runPlan(waitPlan(), f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['dialog dismiss', 'press @close']);
  assert.equal(result.recoveries, 2);
  const retries = result.steps.filter((row) => row.outcome === 'retry');
  assert.equal(retries.length, 2);
  assert.match(retries[0].reason ?? '', /recovered: dialog; retrying the step once$/);
  assert.deepEqual(retries[0].dialog, DECLINED);
  assert.match(retries[1].reason ?? '', /recovered: dismissed an app screen with Close/);
  assert.equal(retries[1].dialog, undefined);
  assert.deepEqual(
    logs.filter((line) => line.startsWith('dialog-tap ')),
    [`dialog-tap ${JSON.stringify({ v: 1, line: 1, ...DECLINED })}`],
  );
});

test('the same app pop-up after its own decline fails the step without a second tap', async () => {
  const f = app(promo());
  let gone = 0;
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    // Gone for the decline's read-back and its proof capture, then the app shows the same sheet again.
    gone = 2;
    return { ok: true, proven: false, executed: true };
  };
  f.deps.captureScreen = async () => (gone-- > 0 ? screen([element('@done', 'Done')]) : promo());
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
  assert.match(result.failure?.seen ?? '', /^the app interruption did not disappear/);
  assert.match(
    result.steps.find((row) => row.outcome === 'retry')?.reason ?? '',
    /recovered: dismissed an app screen with Close/,
  );
});

test('a step recovers at most two different pop-ups', async () => {
  const sheets = [screen([element('@a', 'Skip')]), screen([element('@b', 'Close')])];
  const f = app(screen([element('@c', 'Not now')]));
  f.show(sheets[0]);
  let next = 1;
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(sheets[next++] ?? screen([element('@c', 'Not now')]));
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @a', 'press @b']);
  assert.equal(result.recoveries, 2);
  assert.match(result.failure?.seen ?? '', /Settings/);
});

test('a system prompt the app asks again after recovery declined it is left to the plan author', async () => {
  const f = app(alert());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(alert());
    return { ok: true, proven: false, executed: true };
  };
  ticking(f);
  const result = await runPlan(
    parsePlan('1. Tap "Settings"\n2. Wait for "Done" to appear').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 2);
  assert.deepEqual(f.actions, ['dialog dismiss', 'press @settings']);
  assert.equal(result.recoveries, 1);
  assert.match(
    result.failure?.seen ?? '',
    /^"Done" did not appear within 15s.*; the app asked again after recovery declined it; answer it with a dialog step/,
  );
});

test('a different system prompt after a declined one is declined once too', async () => {
  const f = app(titled('Notifications'));
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    f.show(f.actions.length === 1 ? home() : screen([element('@done', 'Done')]));
    return { ok: true, proven: true, executed: true };
  };
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(ref === '@settings' ? titled('Location') : home());
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Settings"\n2. Tap "Done"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, [
    'dialog dismiss',
    'press @settings',
    'dialog dismiss',
    'press @done',
  ]);
  assert.equal(result.recoveries, 2);
});

test('a system prompt sharing a declined pop-up label is still declined as a different interruption', async () => {
  const prompt: Screen = {
    ...alert(),
    elements: [
      element('@title', 'Save?', { kind: 'text' }),
      element('@cancel', 'Cancel'),
      element('@ok', 'OK'),
    ],
    visibleText: ['Save?', 'Cancel', 'OK'],
  };
  let gone = 0;
  let current: Screen = screen([element('@c', 'Cancel')]);
  const f = app(current);
  f.deps.captureScreen = async () =>
    gone > 0 ? (gone--, screen([element('@done', 'Done')])) : current;
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    if (ref === '@c') {
      gone = 2;
      current = prompt;
    } else current = screen([element('@done', 'Done')]);
    return { ok: true, proven: false, executed: true };
  };
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    current = home();
    return { ok: true, proven: true, executed: true };
  };
  const result = await runPlan(plan(), f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['press @c', 'dialog dismiss', 'press @settings']);
  assert.equal(result.recoveries, 2);
});

test('a dialog step keeps its single recovery', async () => {
  const f = app(alert());
  let calls = 0;
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    calls += 1;
    return { ok: true, proven: calls === 3, executed: true };
  };
  const result = await runPlan(parsePlan('1. Allow the permission prompt').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.recoveries, 1);
});

test('a repeated prompt with the same title and buttons stays declined when its message changes', async () => {
  const prompt = (message: string): Screen => ({
    ...alert(),
    elements: [
      element('@title', 'Notifications', { kind: 'text' }),
      element('@message', message, { kind: 'text' }),
      element('@deny', "Don't Allow"),
      element('@allow', 'Allow'),
    ],
    visibleText: ['Notifications', message, "Don't Allow", 'Allow'],
  });
  const f = app(prompt('Receive updates'));
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(prompt('Receive reminders'));
    return { ok: true, proven: false, executed: true };
  };
  ticking(f);
  const result = await runPlan(
    parsePlan('1. Tap "Settings"\n2. Wait for "Done" to appear').blocks!,
    f.deps,
  );
  assert.deepEqual(f.actions, ['dialog dismiss', 'press @settings']);
  assert.equal(result.recoveries, 1);
  assert.match(result.failure?.seen ?? '', /the app asked again after recovery declined it/);
});

test('a dispatched decline counts when its read-back refuses incomplete capture', async () => {
  const f = app(promo());
  let dispatched = false;
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    dispatched = true;
    return { ok: true, proven: false, executed: true };
  };
  f.deps.captureScreen = async () => {
    if (dispatched) throw new NativeSnapshotIncomplete(1, ['truncated']);
    return promo();
  };
  const result = await runPlan(plan(), f.deps);
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.verdict, 'REFUSED');
  assert.equal(result.recoveries, 1);
});

test('a second app interruption still respects later plan targets and consent boundaries', async () => {
  for (const second of [
    screen([element('@skip', 'Skip'), element('@profile', 'Profile')]),
    screen([element('@allow', 'Allow')]),
  ]) {
    const f = app(promo());
    f.deps.press = async (ref) => {
      f.actions.push(`press ${ref}`);
      f.show(second);
      return { ok: true, proven: false, executed: true };
    };
    const result = await runPlan(parsePlan('1. Tap "Settings"\n2. Tap "Profile"').blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.deepEqual(f.actions, ['press @close']);
    assert.equal(result.recoveries, 1);
  }
});

test('a system prompt after an app decline stays with the next dialog step', async () => {
  const f = app(promo());
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    f.show(alert());
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(
    parsePlan('1. Tap "Settings"\n2. Dismiss the permission dialog').blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @close']);
  assert.equal(result.recoveries, 1);
});

test('a repeat prompt after two different declines still explains that the author must answer it', async () => {
  const f = app(titled('Notifications'));
  f.deps.dialog = async (action) => {
    f.actions.push(`dialog ${action}`);
    f.show(titled(f.actions.length === 1 ? 'Camera' : 'Notifications'));
    return { ok: true, proven: true, executed: true };
  };
  const result = await runPlan(parsePlan('1. Tap "Settings"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['dialog dismiss', 'dialog dismiss']);
  assert.equal(result.recoveries, 2);
  assert.match(result.failure?.seen ?? '', /the app asked again after recovery declined it/);
});
