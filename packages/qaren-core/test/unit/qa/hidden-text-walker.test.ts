import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { runPlan, walkBlock, type BlockStore } from '../../../dist/qa/walker.js';
import { serializeBlock, writeBlock } from '../../../dist/qa/blocks.js';
import type { Ledger, LedgerRow } from '../../../dist/qa/ledger.js';
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
  // The native button sits off the host's frame, so slice 3 cannot press it and only the refusal remains.
  const f = alpha({ edit: () => moved() });
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

// Slice 3: Alpha's button has neither label nor test id; its native element is @e25 in presence reads
// and @e11 in ordinary reads.
const ALPHA_PASS =
  'resolved through text hidden from accessibility; tapped the unnamed button at 14,161.7,374,90';
const ALPHA_UNBOUND =
  'TARGET_NOT_FOUND: "Alpha plan" is text hidden from accessibility; its unnamed button no longer resolved to exactly one element on the next read, so nothing was tapped';
const ALPHA_NO_CHANGE =
  '; its unnamed button at 14,161.7,374,90 was tapped once through that text and the tap showed no change';

type CardEdit = Parameters<typeof hiddenCard>[1];

// The card screen read afresh each time; captures and presses land in one log, in order.
function alpha(
  options: {
    changes?: boolean;
    acts?: Act[];
    // Changes each presence read after the recovery's, by its number from 1.
    edit?: (presenceRead: number) => CardEdit;
    // Each presence read names Alpha's element @e25-<n>, so a press shows which read it came from.
    numbered?: boolean;
  } = {},
) {
  let tapped = false;
  let presenceReads = 0;
  const shown = (screen: Screen) =>
    tapped && options.changes ? withResult(screen, 'Result: A') : screen;
  const f = device(
    () => shown(hiddenCard('p1-obs21-ordinary')),
    () => {
      presenceReads += 1;
      const read = hiddenCard('p1-obs22-presence', options.edit?.(presenceReads));
      const element = read.elements.find((e) => e.ref === '@e25');
      if (options.numbered && element) element.ref = `@e25-${presenceReads}`;
      return shown(read);
    },
  );
  const log: string[] = [];
  const capture = f.deps.captureScreen;
  f.deps.captureScreen = async (request) => {
    log.push(request?.platformPresence ? 'presence' : 'ordinary');
    return capture(request);
  };
  const acts = [...(options.acts ?? [])];
  const handoffs: string[] = [];
  f.deps.press = async (ref) => {
    log.push(`press ${ref}`);
    f.actions.push(`press ${ref}`);
    const ours = ref.startsWith('@e25');
    const act = ours ? (acts.shift() ?? executed) : executed;
    if (ours) handoffs.push(act.mutation === 'none' ? 'refused' : 'executed');
    if (ours && act.mutation !== 'none') tapped = true;
    return act;
  };
  return { ...f, log, handoffs };
}

const moved = (): CardEdit => (args) => {
  args.nodes[25].rect = { ...args.nodes[25].rect!, y: args.nodes[25].rect!.y + 10 };
};

test('N3: a Tap on the hidden text presses the unnamed button by the reference of a presence read just before, once, and passes', async () => {
  const f = alpha({ changes: true });
  const { outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.deepEqual(f.log, ['ordinary', 'presence', 'presence', 'press @e25', 'presence']);
  const pass = outcome.rows.at(-1)!;
  assert.equal(pass.outcome, 'pass');
  assert.equal(pass.attempt, 1);
  assert.equal(pass.resolvedBy, 'exact');
  assert.equal(pass.reason, ALPHA_PASS);
  assert.equal(pass.selector, undefined);
});

test('N3: with comparison screenshots on, no read sits between the proving presence read and the press', async () => {
  const f = alpha({ changes: true, numbered: true });
  f.deps.comparisonScreenshot = async () => new Uint8Array([1]);
  const { outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  // The recovery's read is presence read 1; the fallback pass proves on read 2 and presses its element.
  assert.deepEqual(f.log.slice(0, 4), ['ordinary', 'presence', 'presence', 'press @e25-2']);
  assert.equal(f.handoffs.length, 1);
});

for (const [name, edit] of [
  ['the button moved', moved],
  [
    'a second unnamed button appeared at its frame',
    (): CardEdit => (args) => {
      args.nodes.push({ ...args.nodes[25], ref: '@twin' });
      args.nativePresence.nodes.push({ ...args.nativePresence.nodes[25] });
    },
  ],
] as const) {
  test(`N4: when the proof no longer holds on the fallback pass's read (${name}) nothing is tapped`, async () => {
    const f = alpha({ edit: (n) => (n > 1 ? edit() : undefined) });
    const { outcome, reason } = await walk('1. Tap "Alpha plan"', f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.ok(reason.startsWith(ALPHA_UNBOUND), reason);
    assert.deepEqual(f.actions, []);
    assert.deepEqual(f.log, ['ordinary', 'presence', 'presence']);
  });
}

test('N4: an executed tap that changes nothing is never repeated by the inner retry', async () => {
  const f = alpha();
  const { outcome, reason } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.actions, ['press @e25']);
  assert.match(reason, /^TARGET_NOT_FOUND: /);
  assert.ok(reason.includes(ALPHA_CLAUSE), reason);
  assert.ok(reason.endsWith(ALPHA_NO_CHANGE), reason);
  assert.ok(f.log.length <= 9, f.log.join());
});

for (const [title, fixture, clause] of [
  ['Alpha plan', alpha, ALPHA_NO_CHANGE],
  ['Bravo plan', bravo, NO_CHANGE],
] as const) {
  test(`one executed hidden-text tap stays spent when "${title}" becomes accessible before retry`, async () => {
    const f = fixture();
    const capture = f.deps.captureScreen;
    let readsAfterTap = 0;
    f.deps.captureScreen = async (request) => {
      const screen = await capture(request);
      if (!f.handoffs.includes('executed') || ++readsAfterTap === 1) return screen;
      return {
        ...screen,
        elements: [
          ...screen.elements,
          {
            ref: '@visible-title',
            kind: 'button',
            label: title,
            hittable: true,
            disabled: false,
            secure: false,
            offscreen: false,
          },
        ],
        visibleText: [...screen.visibleText, title],
      };
    };
    const { outcome, reason } = await walk(`1. Tap "${title}"`, f.deps);
    assert.ok(readsAfterTap > 1);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.actions.filter((action) => action.startsWith('press ')).length, 1);
    assert.ok(reason.endsWith(clause), reason);
    assert.ok(outcome.rows.every((row) => row.selector === undefined));
  });
}

for (const [title, fixture] of [
  ['Alpha plan', alpha],
  ['Bravo plan', bravo],
] as const) {
  test(`a delayed system dialog verifies the hidden-text tap on "${title}" without another press`, async () => {
    const f = fixture();
    const capture = f.deps.captureScreen;
    let readsAfterTap = 0;
    let answered = false;
    f.deps.captureScreen = async (request) => {
      const screen = await capture(request);
      if (answered || !f.handoffs.includes('executed') || ++readsAfterTap === 1) return screen;
      return { ...screen, front: 'dialog' };
    };
    f.deps.dialog = async (action) => {
      f.actions.push(`dialog ${action}`);
      answered = true;
      return { ok: true, proven: true, executed: true };
    };
    const { outcome } = await walk(`1. Tap "${title}"\n2. Accept the dialog`, f.deps);
    assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
    assert.deepEqual(f.actions, [
      title === 'Alpha plan' ? 'press @e25' : 'press @e12',
      'dialog accept',
    ]);
    assert.ok(
      outcome.rows.some(
        (row) => row.outcome === 'pass' && row.reason?.includes('the next step owns it'),
      ),
    );
  });
}

test('N4: an executed tap that changes nothing is never repeated after an outer recovery pass', async () => {
  let promoUp = false;
  const f = alpha();
  const capture = f.deps.captureScreen;
  // The promo shows from the inner retry's ordinary read on, after the tap's readback saw no change.
  f.deps.captureScreen = async (request) => {
    const screen = await capture(request);
    if (f.handoffs.length && !request?.platformPresence && !f.actions.includes('press @close'))
      promoUp = true;
    return promoUp ? modalOverHome({ ordinary: !request?.platformPresence }) : screen;
  };
  const press = f.deps.press;
  f.deps.press = async (ref, context) => {
    if (ref === '@close') {
      f.actions.push(`press ${ref}`);
      promoUp = false;
      return executed;
    }
    return press(ref, context);
  };
  const { outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.actions.filter((a) => a.startsWith('press @e25')).length, 1, f.actions.join());
  assert.ok(f.actions.includes('press @close'), f.actions.join());
});

test('N4: a press refused as covered gets one clearance, a new presence read and proof, and one more press', async () => {
  const f = alpha({
    changes: true,
    numbered: true,
    acts: [refused('FOCUS_TARGET_OCCLUDED: covered')],
  });
  const { outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.deepEqual(f.handoffs, ['refused', 'executed'], f.log.join());
  assert.equal(f.actions.filter((a) => a === 'scroll').length, 1, f.log.join());
  const presses = f.log.flatMap((entry, i) => (entry.startsWith('press @e25') ? [i] : []));
  // Each press follows a presence read directly and presses that read's own element.
  for (const i of presses) {
    assert.equal(f.log[i - 1], 'presence', f.log.join());
    const read = f.log.slice(0, i).filter((entry) => entry === 'presence').length;
    assert.equal(f.log[i], `press @e25-${read}`, f.log.join());
  }
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
});

test('N4: after KEYBOARD_DISMISS_FAILED the keyboard is hidden once and the button proven again before one more press', async () => {
  const f = alpha({
    changes: true,
    numbered: true,
    acts: [refused('KEYBOARD_DISMISS_FAILED: kept')],
  });
  let dismissals = 0;
  f.deps.dismissKeyboard = async () => {
    dismissals += 1;
    return 'js';
  };
  const { outcome } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'pass', JSON.stringify(outcome.failure));
  assert.equal(dismissals, 1);
  assert.deepEqual(f.handoffs, ['refused', 'executed'], f.log.join());
  const presses = f.log.flatMap((entry, i) => (entry.startsWith('press @e25') ? [i] : []));
  const last = presses.at(-1)!;
  assert.equal(f.log[last - 1], 'presence', f.log.join());
  const read = f.log.slice(0, last).filter((entry) => entry === 'presence').length;
  assert.equal(f.log[last], `press @e25-${read}`, f.log.join());
});

test('N4: after a press refused as covered, a read that no longer proves the button presses nothing more', async () => {
  // Presence read 1 is the recovery's and read 2 the proof for the first press; from read 3 it moved.
  const f = alpha({
    edit: (n) => (n > 2 ? moved() : undefined),
    acts: [refused('FOCUS_TARGET_OCCLUDED: covered')],
  });
  const { outcome, reason } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.deepEqual(f.handoffs, ['refused'], f.log.join());
  assert.ok(
    reason.includes('its unnamed button no longer resolved to exactly one element'),
    reason,
  );
});

test('N4: a press the runner refuses each time is never counted as a tap', async () => {
  const f = alpha({
    acts: [refused('RUNNER_REFUSED: test'), refused('RUNNER_REFUSED: test')],
  });
  const { outcome, reason } = await walk('1. Tap "Alpha plan"', f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.ok(
    f.handoffs.every((h) => h === 'refused'),
    f.handoffs.join(),
  );
  assert.match(
    reason,
    /; its unnamed button at 14,161\.7,374,90 was not tapped: the runner refused the press: RUNNER_REFUSED: test/,
  );
  assert.doesNotMatch(reason, /was tapped once/);
});

test('N6: Wait and literal check lines on the unnamed hidden text fail with the cause and never tap', async () => {
  const waited = alpha();
  const wait = await walk('1. Wait for "Alpha plan" to appear', waited.deps);
  assert.ok(wait.reason.endsWith(`; target visibility: absent${ALPHA_CLAUSE}`), wait.reason);
  const checked = alpha();
  const check = await walk('✓ "Alpha plan"', checked.deps);
  assert.ok(check.reason.endsWith(ALPHA_CLAUSE), check.reason);
  assert.deepEqual([...waited.actions, ...checked.actions], []);
});

test("N6: Android keeps today's failure for the unnamed button", async () => {
  const android = alpha();
  android.deps.platform = 'android';
  const tap = await walk('1. Tap "Alpha plan"', android.deps);
  assert.equal(
    tap.reason,
    'TARGET_NOT_FOUND: no eligible element labelled or identified "Alpha plan" is on screen',
  );
  assert.deepEqual(android.actions, []);
});

// N5: the saved block. A plan whose Tap passes through the unnamed button has no selector to store.
const ALPHA_PLAN = `## QA

### Alpha card

1. Wait for "Result: none" to appear
2. Tap "Alpha plan"
`;
const BRAVO_PLAN = ALPHA_PLAN.replace('### Alpha card', '### Bravo card').replace(
  '"Alpha plan"',
  '"Bravo plan"',
);

function appRoot(): string {
  const dir = mkdtempSync(joinPath(tmpdir(), 'qaren-hidden-'));
  mkdirSync(joinPath(dir, '.qaren'));
  return dir;
}

const cardStore = (dir: string): BlockStore => ({
  appRoot: dir,
  platform: 'ios',
  appId: 'com.example.app',
});

test('N5: a block whose Tap passed through the unnamed button is reported not saved, and the run passes', async () => {
  const dir = appRoot();
  const f = alpha({ changes: true });
  const result = (await runPlan(
    parsePlan(ALPHA_PLAN).blocks!,
    f.deps,
    [],
    cardStore(dir),
  )) as Ledger;
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  const tapLine = parsePlan(ALPHA_PLAN).blocks![0].items[1].line;
  assert.equal(result.blocks[0].unsavable, `line ${tapLine}: element has no testID or label`);
  assert.deepEqual(result.blocksWritten ?? [], []);
});

test('N5: an older saved block replays its prefix, walks the Tap afresh from that line and never refuses', async () => {
  const dir = appRoot();
  const block = parsePlan(ALPHA_PLAN).blocks![0];
  const [wait, tap] = block.items;
  const seeded = serializeBlock(
    block,
    [
      { block: block.slug, line: wait.line, outcome: 'pass', selector: { text: 'Result: none' } },
      { block: block.slug, line: tap.line, outcome: 'pass', selector: { id: 'qa-hidden-card-a' } },
    ] as LedgerRow[],
    cardStore(dir),
  );
  assert.ok('yaml' in seeded, JSON.stringify(seeded));
  writeBlock(dir, block.slug, seeded.yaml);
  const path = joinPath(dir, '.qaren', 'actions', `${block.slug}.yaml`);
  const before = readFileSync(path, 'utf8');
  const f = alpha({ changes: true });
  const result = (await runPlan(
    parsePlan(ALPHA_PLAN).blocks!,
    f.deps,
    [],
    cardStore(dir),
  )) as Ledger;
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  assert.equal(result.path, `replay→walk@${tap.line}`);
  assert.match(
    result.steps.find((row) => row.line === tap.line && row.outcome === 'retry')?.reason ?? '',
    /REPLAY_SELECTOR/,
  );
  assert.equal(result.steps.at(-1)?.reason, ALPHA_PASS);
  assert.equal(result.blocks[0].unsavable, `line ${tap.line}: element has no testID or label`);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test("N5: a block with slice 2's Tap is still saved with the button's id", async () => {
  const dir = appRoot();
  const f = bravo({ changes: true });
  const result = (await runPlan(
    parsePlan(BRAVO_PLAN).blocks!,
    f.deps,
    [],
    cardStore(dir),
  )) as Ledger;
  assert.equal(result.verdict, 'PASS', JSON.stringify(result.failure));
  const slug = parsePlan(BRAVO_PLAN).blocks![0].slug;
  assert.deepEqual(result.blocksWritten, [slug]);
  assert.match(
    readFileSync(joinPath(dir, '.qaren', 'actions', `${slug}.yaml`), 'utf8'),
    /# 2\. Tap "Bravo plan"\n- tapOn: \{ id: "qa-hidden-card-b" \}/,
  );
});
