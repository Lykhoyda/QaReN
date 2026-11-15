import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import { CaptureDeadline } from '../../../dist/qa/capture.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { homeAfterPromo, modalOverHome } from './modal-fixtures.ts';
import { hiddenCard, type HiddenCardRead } from './ios-hidden-card-captures.ts';

const ALPHA_CLAUSE =
  '; "Alpha plan" is inside a button that hides its children from accessibility and has no accessibilityLabel (the button at 14,161.7,374,90), so no element carries it. Give the button an accessibilityLabel';
const ADVICE =
  'the target of line 1 is text the app hides from accessibility; quote the testID of the button that holds it if failure.screen lists one, or give that button an accessibilityLabel in the app';

// An iOS device whose ordinary reads and presence reads are the given screens; no dispatch is expected.
function device(ordinary: () => Screen, presence: () => Screen) {
  const modes: string[] = [];
  const actions: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    platform: 'ios',
    async captureScreen(request) {
      modes.push(request?.platformPresence ? 'presence' : 'ordinary');
      return request?.platformPresence ? presence() : ordinary();
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      return { ok: true, proven: false, executed: true };
    },
    async fill() {
      throw new Error('unexpected fill');
    },
    async scroll() {
      actions.push('scroll');
      return { ok: true, proven: false, executed: true };
    },
    async back() {
      throw new Error('unexpected back');
    },
    async dialog() {
      throw new Error('unexpected dialog');
    },
    async hideDevMenu() {
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row() {},
  };
  return { deps, modes, actions };
}

const cards = (presence: HiddenCardRead) => {
  const ordinary = hiddenCard('p1-obs21-ordinary');
  const read = hiddenCard(presence);
  return device(
    () => ordinary,
    () => read,
  );
};

// A line deep in a walk: walkBlock starts without the first-step launch allowance.
async function walk(line: string, deps: WalkerDeps) {
  const outcome = await walkBlock(parsePlan(line).blocks![0], deps);
  const seen = [outcome.failure?.seen ?? '']
    .flat()
    .map((part) => (typeof part === 'string' ? part : `<${Object.values(part).join('')}>`))
    .join('');
  return { outcome, seen, reason: seen.split('; last observed on screen: ')[0] };
}

test('H3: a Tap on a hidden text names its unlabelled button and the fix, with no added read', async () => {
  const f = cards('p1-obs22-presence');
  const { outcome, seen, reason } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen, /^TARGET_NOT_FOUND: /);
  assert.ok(reason.endsWith(ALPHA_CLAUSE), reason);
  assert.equal(outcome.failure?.subreason, 'absent');
  assert.equal(outcome.failure?.suggestion, ADVICE);
  assert.deepEqual(f.modes, ['ordinary', 'presence']);
  assert.deepEqual(f.actions, []);
});

test('H3: a Tap on a hidden text inside a labelled button points at that button, not a new label', async () => {
  const f = cards('p1-obs22-presence');
  const { reason, outcome } = await walk('1. Tap "36 EUR"', f.deps);
  assert.ok(
    reason.endsWith(
      '; "36 EUR" is inside a button that hides its children from accessibility (the button at 14,362.7,374,90); the button is reached by its own label, not by this text',
    ),
    reason,
  );
  assert.equal(
    outcome.failure?.suggestion,
    "the target of line 1 is text the app hides from accessibility inside a button with its own label; quote that button's label, or its testID if failure.screen lists one",
  );
});

test('H4: a Wait for a hidden text names it after the target visibility, with no added read', async () => {
  const f = cards('p2-obs38-presence');
  const { reason } = await walk('1. Wait for "Alpha plan" to appear', f.deps);
  assert.ok(reason.endsWith(`; target visibility: absent${ALPHA_CLAUSE}`), reason);
  assert.deepEqual(f.modes, [...Array(10).fill('ordinary'), 'presence']);
});

test('H4: a literal check on a hidden text, or on a part of one, names it; a Tap on the part does not', async () => {
  const f = cards('p3-obs22-presence');
  const { reason } = await walk('✓ "Alpha plan"', f.deps);
  assert.equal(reason, `"Alpha plan" is not satisfied on screen${ALPHA_CLAUSE}`);
  assert.deepEqual(f.modes, ['ordinary', 'presence']);

  const part = cards('p3-obs22-presence');
  const checked = await walk('✓ "Alpha"', part.deps);
  assert.equal(
    checked.reason,
    '"Alpha" is not satisfied on screen; "Alpha" is inside a button that hides its children from accessibility and has no accessibilityLabel (the button at 14,161.7,374,90), so no element carries it. Give the button an accessibilityLabel',
  );
  assert.deepEqual(part.modes, ['ordinary', 'presence']);

  const tapped = cards('p3-obs22-presence');
  const tap = await walk('1. Tap "Alpha"', tapped.deps);
  assert.equal(
    tap.reason,
    'TARGET_NOT_FOUND: no eligible element labelled or identified "Alpha" is on screen',
  );
  assert.deepEqual(tapped.modes, ['ordinary', 'presence']);
});

// The promo's presence read also holds a hidden text "Fine print" under Home's target button.
function promoWithHiddenText(request?: { platformPresence?: boolean }): Screen {
  const screen = modalOverHome({ ordinary: !request?.platformPresence });
  const evidence = screen.reactHostEvidence!;
  const typography = evidence.typography!;
  const index = evidence.hosts.length;
  return {
    ...screen,
    reactHostEvidence: {
      ...evidence,
      hosts: [
        ...evidence.hosts,
        { role: null, roleSource: 'none', capabilities: {}, hidden: true },
      ],
      typography: {
        ...typography,
        nodes: [
          ...typography.nodes,
          {
            hostIndex: index,
            parentHostIndex: 3,
            rootIndex: 0,
            hostType: 'RCTText',
            rect: { x: 30, y: 210, width: 100, height: 20 },
            text: {
              kind: 'block',
              content: 'Fine print',
              runs: [{ start: 0, end: 10, fontSize: 13 }],
              scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
            },
          },
        ],
      },
    },
  };
}

for (const line of ['1. Tap "Fine print"', '✓ "Fine print"']) {
  test(`H4/H5: when the recovery acts, a hidden text on its earlier read adds nothing (${line})`, async () => {
    let promoUp = true;
    const f = device(
      () => (promoUp ? promoWithHiddenText() : homeAfterPromo()),
      () => (promoUp ? promoWithHiddenText({ platformPresence: true }) : homeAfterPromo()),
    );
    const rows: Parameters<WalkerDeps['row']>[0][] = [];
    f.deps.row = (row) => rows.push(row);
    f.deps.press = async (ref) => {
      f.actions.push(`press ${ref}`);
      if (ref === '@close') promoUp = false;
      return { ok: true, proven: false, executed: true };
    };
    const { outcome, seen } = await walk(line, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(f.actions, ['press @close']);
    assert.doesNotMatch(seen, /hides|hidden from accessibility/);
    for (const row of rows)
      assert.doesNotMatch(row.reason ?? '', /hides|hidden from accessibility/);
    assert.notEqual(outcome.failure?.suggestion, ADVICE);
  });
}

test('H4: with screen text withheld by privacy the clause keeps the plan literal and no app text', async () => {
  const privacy = new ObservedPrivacy();
  const inputs = new RunInputs({ SECRET: 'zq-s3cret-7781' }, ['SECRET'], privacy);
  const f = cards('p3-obs22-presence');
  f.deps.privacy = privacy;
  const ledger = await withInputs(inputs, () =>
    runPlan(parsePlan('✓ "Alpha plan"').blocks!, f.deps),
  );
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure!.seen, /screen text withheld/);
  // The run's own masking of the base reason may take the separator before the clause.
  assert.ok(ledger.failure!.seen.includes(ALPHA_CLAUSE.slice(2)), ledger.failure!.seen);
  for (const text of ['12 EUR', 'Bravo plan', 'Charlie plan', 'Result: none'])
    assert.ok(!ledger.failure!.seen.includes(text), text);
});

const TODAY_TAP =
  'TARGET_NOT_FOUND: no eligible element labelled or identified "Alpha plan" is on screen';

test("H5: a newest read without typography keeps today's text exactly", async () => {
  const ordinary = hiddenCard('p1-obs21-ordinary');
  const f = device(
    () => ordinary,
    () => ({ ...hiddenCard('p1-obs22-presence'), reactHostEvidence: undefined }),
  );
  const { reason, outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(reason, TODAY_TAP);
  assert.notEqual(outcome.failure?.suggestion, ADVICE);
});

test("H5: Android keeps today's text and advice for the same reads", async () => {
  for (const line of ['1. Tap "Alpha plan"', '✓ "Alpha plan"']) {
    const f = cards('p1-obs22-presence');
    f.deps.platform = 'android';
    const { reason, outcome } = await walk(line, f.deps);
    assert.doesNotMatch(reason, /hides its children|hidden from accessibility/, line);
    assert.notEqual(outcome.failure?.suggestion, ADVICE, line);
  }
});

test('H5: a read whose miss diagnostic is evidence-incomplete adds no clause', async () => {
  const ordinary = hiddenCard('p1-obs21-ordinary');
  const presence = hiddenCard('p1-obs22-presence');
  const f = device(
    () => ordinary,
    () => ({ ...presence, captureCoverage: { native: 'incomplete', react: 'complete' } }),
  );
  const { reason } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.doesNotMatch(reason, /hides its children|hidden from accessibility/);
});

test("H5: the previous line's hidden text adds nothing to a Wait whose first capture expired", async () => {
  const presence = hiddenCard('p1-obs22-presence');
  let expired = false;
  const f = device(
    () => presence,
    () => presence,
  );
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (request) => {
    if (expired) throw new CaptureDeadline();
    return capture(request);
  };
  f.deps.row = (row) => {
    if (row.line === 1 && row.outcome === 'pass') expired = true;
  };
  const { outcome, reason } = await walk(
    '✓ "Charlie plan"\n1. Wait for "Alpha plan" to appear',
    f.deps,
  );
  assert.equal(outcome.failure?.step, 2);
  assert.match(reason, /^TARGET_WAIT_TIMEOUT: /);
  assert.doesNotMatch(reason, /hides its children|hidden from accessibility/);
});

test("H5: a visible disabled element named by the target keeps today's text despite a hidden twin", async () => {
  // Charlie's button carries its label natively and its hidden text "Charlie plan" in React.
  const disable = (screen: Screen): Screen => ({
    ...screen,
    elements: screen.elements.map((e) =>
      e.label === 'Charlie plan' ? { ...e, disabled: true } : e,
    ),
  });
  const ordinary = disable(hiddenCard('p1-obs21-ordinary'));
  const presence = disable(hiddenCard('p1-obs22-presence'));
  const f = device(
    () => ordinary,
    () => presence,
  );
  const { reason, outcome } = await walk('1. Tap "Charlie plan"', f.deps);
  assert.equal(outcome.failure?.subreason, 'present-but-unavailable');
  assert.doesNotMatch(reason, /hides its children|hidden from accessibility/);
});
