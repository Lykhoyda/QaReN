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
// With `underClose` the text sits under the promo's own Close (host 6, testID qa-promo-close).
function promoWithHiddenText(request?: { platformPresence?: boolean }, underClose = false): Screen {
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
            parentHostIndex: underClose ? 6 : 3,
            rootIndex: 0,
            hostType: 'RCTText',
            rect: { x: 30, y: underClose ? 790 : 210, width: 100, height: 20 },
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
    f.deps.press = async (ref) => {
      f.actions.push(`press ${ref}`);
      if (ref === '@close') promoUp = false;
      return { ok: true, proven: false, executed: true };
    };
    const { outcome, seen } = await walk(line, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(f.actions, ['press @close']);
    assert.doesNotMatch(seen, /hides|hidden from accessibility/);
    assert.ok(
      outcome.rows.some((row) => /dismissed an app screen with Close/.test(row.reason ?? '')),
    );
    for (const row of outcome.rows)
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

// Slice 2: a Tap on Bravo's hidden text taps Bravo's own button, qa-hidden-card-b (@e12 in ordinary reads).
const BRAVO_PASS =
  'resolved through text hidden from accessibility; tapped its button "qa-hidden-card-b"';
const BRAVO_CLAUSE =
  '; "Bravo plan" is inside a button that hides its children from accessibility and has no accessibilityLabel (the button at 14,262,374,90, testID "qa-hidden-card-b"), so no element carries it. Give the button an accessibilityLabel, or target "qa-hidden-card-b"';
const NO_CHANGE =
  '; its button "qa-hidden-card-b" was tapped once through that text and the tap showed no change';

function withResult(screen: Screen, result: string): Screen {
  const swap = (text: string) => (text === 'Result: none' ? result : text);
  return {
    ...screen,
    elements: screen.elements.map((e) =>
      e.label === 'Result: none' ? { ...e, label: result } : e,
    ),
    visibleText: screen.visibleText.map(swap),
    ...(screen.paintedText ? { paintedText: screen.paintedText.map(swap) } : {}),
  };
}

type Act = Awaited<ReturnType<WalkerDeps['press']>>;
const executed: Act = { ok: true, proven: false, executed: true };
const refused = (error: string): Act => ({
  ok: false,
  proven: false,
  executed: false,
  mutation: 'none',
  error,
});

// The card screen; a tap the runner executes on Bravo changes "Result: none" when `changes` is set.
function bravo(
  options: {
    changes?: boolean;
    acts?: Act[];
    ordinary?: (tapped: boolean, presenceSeen: boolean) => Screen | undefined;
    presence?: (tapped: boolean) => Screen | undefined;
  } = {},
) {
  const ordinary = hiddenCard('p1-obs21-ordinary');
  const presence = hiddenCard('p5-obs22-presence');
  let tapped = false;
  let presenceSeen = false;
  const shown = (screen: Screen) =>
    tapped && options.changes ? withResult(screen, 'Result: B') : screen;
  const f = device(
    () => options.ordinary?.(tapped, presenceSeen) ?? shown(ordinary),
    () => {
      presenceSeen = true;
      return options.presence?.(tapped) ?? shown(presence);
    },
  );
  const acts = [...(options.acts ?? [])];
  const handoffs: string[] = [];
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    const act = ref === '@e12' ? (acts.shift() ?? executed) : executed;
    if (ref === '@e12') handoffs.push(act.mutation === 'none' ? 'refused' : 'executed');
    if (ref === '@e12' && act.mutation !== 'none') tapped = true;
    return act;
  };
  const rows: Parameters<WalkerDeps['row']>[0][] = [];
  f.deps.row = (row) => rows.push(row);
  return { ...f, handoffs, rows };
}

test('B3: a Tap on the hidden text taps the button that has a test id, once, and passes', async () => {
  const f = bravo({ changes: true });
  const { outcome } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(f.actions, ['press @e12']);
  const pass = outcome.rows.at(-1)!;
  assert.equal(pass.outcome, 'pass');
  assert.equal(pass.attempt, 1);
  assert.equal(pass.resolvedBy, 'exact');
  assert.equal(pass.reason, BRAVO_PASS);
  assert.deepEqual(pass.selector, { id: 'qa-hidden-card-b' });
  assert.deepEqual(f.modes, ['ordinary', 'presence', 'ordinary', 'ordinary']);
});

test('B4: a bound press that no longer resolves ends the step without recovery or a second fallback', async () => {
  const card = hiddenCard('p1-obs21-ordinary');
  const withoutBravo = {
    ...card,
    elements: card.elements.filter((e) => e.testID !== 'qa-hidden-card-b'),
  };
  const f = bravo({ ordinary: (_, presenceSeen) => (presenceSeen ? withoutBravo : undefined) });
  const { outcome, reason } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(
    reason,
    'TARGET_NOT_FOUND: "Bravo plan" is text hidden from accessibility; its button "qa-hidden-card-b" no longer resolved uniquely to an eligible button on the next read, so nothing was tapped',
  );
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.modes, ['ordinary', 'presence', 'ordinary']);
});

test('B4: a press the runner refuses each time is never counted as a tap', async () => {
  const f = bravo({
    acts: [refused('RUNNER_REFUSED: test'), refused('RUNNER_REFUSED: test')],
  });
  const { outcome, reason } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.handoffs, ['refused', 'refused']);
  assert.match(
    reason,
    /; its button "qa-hidden-card-b" was not tapped: the runner refused the press: RUNNER_REFUSED: test/,
  );
  assert.doesNotMatch(reason, /was tapped once/);
  assert.ok(f.modes.length <= 8, f.modes.join());
});

for (const [name, first] of [
  ['FOCUS_TARGET_OCCLUDED', refused('FOCUS_TARGET_OCCLUDED: covered')],
  ['KEYBOARD_DISMISS_FAILED', refused('KEYBOARD_DISMISS_FAILED: kept')],
] as const) {
  test(`B4: after a ${name} refusal the existing once-only retry may hand over again, and one executed tap ends it`, async () => {
    const f = bravo({ acts: [first, executed] });
    f.deps.dismissKeyboard = async () => 'js';
    const { outcome, reason } = await walk('1. Tap "Bravo plan"', f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.deepEqual(f.handoffs, ['refused', 'executed']);
    assert.ok(reason.includes(NO_CHANGE), reason);
  });
}

test('B4: a hidden-text press refused as covered gets one clearance drag and one re-press, then fails naming both', async () => {
  // Where the cover-before-drag check meets the fallback: a refusal keeps the fallback's authority,
  // the covered branch proves the cover and drags once, and its once-only re-press is the last.
  const f = bravo({
    acts: [refused('FOCUS_TARGET_OCCLUDED: covered'), refused('FOCUS_TARGET_OCCLUDED: covered')],
  });
  const { outcome, reason } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.actions, ['press @e12', 'scroll', 'press @e12']);
  assert.deepEqual(f.handoffs, ['refused', 'refused']);
  assert.match(
    reason,
    /^FOCUS_TARGET_OCCLUDED: covered; "Bravo plan" stayed off screen after one scroll/,
  );
  assert.ok(reason.includes(BRAVO_CLAUSE), reason);
  assert.ok(
    reason.endsWith(
      '; its button "qa-hidden-card-b" was not tapped: the runner refused the press: FOCUS_TARGET_OCCLUDED: covered',
    ),
    reason,
  );
});

test('B4: an executed tap that changes nothing is never repeated by the inner retry', async () => {
  const f = bravo();
  const { outcome, reason } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.actions, ['press @e12']);
  assert.match(reason, /^TARGET_NOT_FOUND: /);
  assert.ok(reason.includes(BRAVO_CLAUSE), reason);
  assert.ok(reason.endsWith(NO_CHANGE), reason);
  assert.ok(f.modes.length <= 8, f.modes.join());
});

test('B4: an executed tap that changes nothing is never repeated after an outer recovery pass', async () => {
  let promoUp = false;
  const f = bravo({
    presence: (tapped) => {
      if (tapped && promoUp === false) promoUp = true;
      return promoUp ? modalOverHome() : undefined;
    },
    ordinary: () => (promoUp ? modalOverHome({ ordinary: true }) : undefined),
  });
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    if (ref === '@close') {
      f.actions.push(`press ${ref}`);
      promoUp = false;
      return executed;
    }
    return press(ref, context);
  };
  const { outcome } = await walk('1. Tap "Bravo plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.actions.filter((a) => a === 'press @e12').length, 1, f.actions.join());
  assert.ok(f.actions.includes('press @close'), f.actions.join());
});

test('B4: a Wait and a literal check on the hidden text fail with the cause and never tap', async () => {
  const waited = bravo();
  const wait = await walk('1. Wait for "Bravo plan" to appear', waited.deps);
  assert.ok(wait.reason.endsWith(`; target visibility: absent${BRAVO_CLAUSE}`), wait.reason);
  const checked = bravo();
  const check = await walk('✓ "Bravo plan"', checked.deps);
  assert.ok(check.reason.endsWith(BRAVO_CLAUSE), check.reason);
  assert.deepEqual([...waited.actions, ...checked.actions], []);
});

test("B4: Android and a described Tap keep today's failure", async () => {
  const android = bravo();
  android.deps.platform = 'android';
  const tap = await walk('1. Tap "Bravo plan"', android.deps);
  assert.equal(
    tap.reason,
    'TARGET_NOT_FOUND: no eligible element labelled or identified "Bravo plan" is on screen',
  );
  assert.deepEqual(android.actions, []);
  const described = bravo();
  const outcome = await walk('1. Tap the Bravo card', described.deps);
  assert.equal(outcome.outcome.block.outcome, 'fail');
  assert.deepEqual(described.actions, []);
  assert.doesNotMatch(outcome.seen, /hidden from accessibility/);
});

test('B5: the recovery dismisses a surface before any hidden-text button is pressed', async () => {
  let promoUp = true;
  const f = device(
    () => (promoUp ? promoWithHiddenText({}, true) : homeAfterPromo()),
    () => (promoUp ? promoWithHiddenText({ platformPresence: true }, true) : homeAfterPromo()),
  );
  const rows: Parameters<WalkerDeps['row']>[0][] = [];
  f.deps.row = (row) => rows.push(row);
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    if (ref === '@close') promoUp = false;
    return executed;
  };
  const { outcome } = await walk('1. Tap "Fine print"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.actions, ['press @close']);
  const reasons = outcome.rows.map((row) => row.reason ?? '');
  assert.ok(
    reasons.some((reason) => /dismissed an app screen with Close/.test(reason)),
    reasons.join(' | '),
  );
  for (const reason of reasons) assert.doesNotMatch(reason, /resolved through text hidden/);
});
