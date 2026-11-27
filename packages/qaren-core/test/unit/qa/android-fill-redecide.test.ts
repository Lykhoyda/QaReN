import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join } from '../../../dist/qa/screen.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';

// An authored quoted Android Fill whose target was refused on the app before the step sent any action of its own
// decides once more on a fresh ordinary read after a 500 ms pause; everything else keeps its behavior.

const ID = 'qa-late-code';
const rect = { x: 60, y: 900, width: 960, height: 140 };
const below = { x: 60, y: 2600, width: 960, height: 140 };
// An app front as the Android runner assembles it: Application > Window > the window's tree.
const nodes = (extra: object[]) =>
  [
    {
      type: 'Application',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
      enabled: true,
      hittable: false,
      visibleToUser: true,
    },
    {
      type: 'Window',
      rect: { x: 0, y: 0, width: 1080, height: 2400 },
      enabled: true,
      hittable: false,
      visibleToUser: true,
      parentIndex: 0,
    },
    ...extra.map((n) => ({
      parentIndex: 1,
      enabled: true,
      hittable: true,
      visibleToUser: true,
      scrollable: false,
      ...n,
    })),
  ].map((n, index) => ({
    ref: `@e${index}`,
    index,
    depth: Math.min(index, 2),
    label: '',
    identifier: '',
    ...n,
  }));
// A system alert in front: only the alert window, under a synthetic `Alert` root, with no app node.
const alertNodes = (extra: object[]) =>
  [
    {
      type: 'Alert',
      rect: { x: 60, y: 900, width: 960, height: 600 },
      enabled: true,
      hittable: false,
      visibleToUser: true,
    },
    {
      type: 'android.widget.TextView',
      identifier: 'alertTitle',
      label: 'Update available',
      rect: { x: 100, y: 950, width: 880, height: 80 },
      parentIndex: 0,
    },
    {
      type: 'android.widget.Button',
      identifier: 'button2',
      label: 'Cancel',
      rect: { x: 300, y: 1350, width: 300, height: 120 },
      parentIndex: 0,
    },
    ...extra.map((n) => ({ parentIndex: 0, ...n })),
  ].map((n, index) => ({
    ref: `@e${index}`,
    index,
    depth: index ? 1 : 0,
    label: '',
    identifier: '',
    enabled: true,
    hittable: true,
    visibleToUser: true,
    scrollable: false,
    ...n,
  }));
const coverage = { native: 'complete', react: 'complete' };
const unusable = { native: 'unknown', react: 'complete' };
const entry = { role: 'textinput', testID: ID, capabilities: { press: false, fill: true } };
const openEntry = {
  role: 'button',
  testID: 'qa-late-open',
  text: 'Open',
  capabilities: { press: true, fill: false },
};
const open = {
  type: 'android.widget.Button',
  identifier: 'qa-late-open',
  label: 'Open',
  rect: { x: 60, y: 300, width: 960, height: 140 },
};
const sending = {
  type: 'android.widget.TextView',
  identifier: 'qa-late-sending',
  label: 'Sending code',
  rect: { x: 60, y: 500, width: 960, height: 80 },
};
// A text row only the post-pause reads carry, so their input has a different ref than any earlier read's.
const note = {
  type: 'android.widget.TextView',
  identifier: 'qa-late-state',
  label: 'Field: input',
  rect: { x: 60, y: 700, width: 960, height: 80 },
};
const placeholder = { type: 'android.view.ViewGroup', identifier: ID, rect };
const input = { type: 'android.widget.EditText', identifier: ID, rect };
const disabledInput = { ...input, enabled: false, hittable: false };
const hiddenInput = { ...input, visibleToUser: false, hittable: false };
const alertInput = {
  type: 'android.widget.EditText',
  identifier: ID,
  focused: true,
  rect: { x: 100, y: 1100, width: 880, height: 140 },
};
const lateButton = {
  type: 'android.widget.Button',
  identifier: ID,
  label: 'Code',
  rect,
  enabled: false,
  hittable: false,
};
const lateButtonEntry = {
  role: 'button',
  testID: ID,
  text: 'Code',
  capabilities: { press: true, fill: false },
  disabled: true,
};
const close = {
  type: 'android.widget.Button',
  identifier: 'qa-late-close',
  label: 'Close',
  rect: { x: 60, y: 1500, width: 960, height: 140 },
};
const closeEntry = {
  role: 'button',
  testID: 'qa-late-close',
  text: 'Close',
  capabilities: { press: true, fill: false },
};
const screenOf = (extra: object[], digest: object[], cover: any = coverage) => ({
  ...join(nodes(extra) as any, digest as any, 'app', cover, undefined, undefined, 'complete'),
  captureCoverage: coverage,
  keyboardVisible: false,
});
const alertOf = (extra: object[] = []) => ({
  ...join(
    alertNodes(extra) as any,
    [],
    'dialog',
    coverage as any,
    undefined,
    undefined,
    'complete',
  ),
  captureCoverage: coverage,
  keyboardVisible: false,
});
// Presence reads that prove each button pressable, so recovery can judge a decline control.
const pressable = (s: any) => ({
  ...s,
  elements: s.elements.map((e: any) => ({
    ...e,
    semantic: {
      press: e.kind === 'button' ? 'supported' : 'unsupported',
      fill: 'unsupported',
      visibility: 'visible',
    },
  })),
});
const T: Record<string, [object[], object[]]> = {
  reactOnly: [[], [entry]],
  placeholder: [[placeholder], []],
  absent: [[], []],
  input: [[input], [entry]],
  freshInput: [[note, input], [entry]],
  disabledInput: [[disabledInput], [entry]],
  belowInput: [[{ ...input, rect: below }], [entry]],
  twins: [[input, { ...input, rect: { ...rect, y: 1200 } }], [entry]],
  freshTwins: [[note, input, { ...input, rect: { ...rect, y: 1200 } }], [entry]],
  // Two inputs carrying the id, both beyond the screen's right edge: each is set aside by its frame.
  offscreenTwins: [
    [
      { ...input, rect: { ...rect, x: 1200 } },
      { ...input, rect: { ...rect, x: 1200, y: 1200 } },
    ],
    [entry],
  ],
  lateButton: [[lateButton], [lateButtonEntry]],
};
const mid = (s: string) => screenOf([open, sending, ...T[s][0]], [openEntry, ...T[s][1]]);
const first = (s: string) => screenOf([...T[s][0]], [...T[s][1]]);
const home = () => screenOf([open], [openEntry]);
const signIn = {
  type: 'android.widget.Button',
  identifier: 'login-screen',
  label: 'Sign in',
  rect: { x: 60, y: 300, width: 960, height: 140 },
};
const loginWall = () =>
  screenOf(
    [signIn],
    [
      {
        role: 'button',
        testID: 'login-screen',
        text: 'Sign in',
        capabilities: { press: true, fill: false },
      },
    ],
  );

const NOT_ACTUATED = {
  ok: false,
  proven: false,
  executed: true,
  mutation: 'none',
  error: 'INTERACTION_NOT_ACTUATED: the draw order could not be resolved',
};

type Render = (t: number, actions: string[], presence: boolean) => any;
interface App {
  deps: WalkerDeps & Record<string, any>;
  actions: string[];
  reads: boolean[];
  events: string[];
  sleeps: number[];
  clock: () => number;
  cancelAtNextSleep: () => void;
  expireCapture: (k: number) => void;
}
// A device whose screen is a function of the clock, the actions sent and the read's mode. Each capture takes 100 ms;
// only sleep and an optional one-off expiry jump move the clock otherwise.
function app(render: Render, extra: Record<string, any> = {}, fillResult?: () => any): App {
  const actions: string[] = [];
  let time = 0;
  let captures = 0;
  let cancelled = false;
  let cancelOnSleep = false;
  // Whether each read was a presence read, in order.
  const reads: boolean[] = [];
  // Captures, walker decision and dispatch diagnostics, and actions, in order.
  const events: string[] = [];
  let expireAt = 0;
  let armed = 0;
  const sleeps: number[] = [];
  // Every stub authorizes first, as the real handlers do, so a step dispatch is recorded.
  const dispatch = (action: string, context: any) => {
    context.authorize();
    actions.push(action);
    events.push(action);
  };
  const deps: any = {
    platform: 'android',
    judge: {
      ask: async () => {
        throw new Error('a quoted plan must never ask Jev');
      },
      calls: [],
    },
    async captureScreen(o: any) {
      captures += 1;
      if (captures > 200) throw new Error('capture limit');
      const presence = !!o?.platformPresence;
      time += 100;
      const s = render(time, actions, presence);
      reads.push(presence);
      events.push(`capture ${presence ? 'presence' : 'ordinary'} ${s.front}`);
      // The second clock read after this capture (its admission is the first) jumps past the evidence's use window.
      if (captures === expireAt) armed = 1;
      return s;
    },
    async press(ref: string, context: any) {
      dispatch(`press ${ref}`, context);
      return { ok: true, proven: false };
    },
    async fill(ref: string, text: string, context: any) {
      const result = fillResult?.();
      // A handler failure before authorization: nothing is sent.
      if (result?.beforeAuthorize) {
        events.push(`fill-unsent ${ref}`);
        return result.beforeAuthorize;
      }
      dispatch(`fill ${ref} ${text}`, context);
      return result ?? { ok: true, proven: true };
    },
    async scroll(direction: string, context: any) {
      dispatch(`scroll ${direction}`, context);
      return { ok: true, proven: false };
    },
    async back(context: any) {
      dispatch('back', context);
      return { ok: true, proven: false };
    },
    async dialog(action: string, context: any) {
      dispatch(`dialog ${action}`, context);
      return { ok: true, proven: true };
    },
    async hideDevMenu() {
      return { ok: true, proven: true };
    },
    async screenshot(name: string) {
      return name;
    },
    now: () => {
      if (armed && ++armed === 3) {
        time += 10_100;
        armed = 0;
      }
      return time;
    },
    diagnostic: (e: any) => {
      if (e.stage === 'decision' || e.stage === 'dispatch')
        events.push(`${e.stage} ${e.code} line ${e.line}`);
    },
    async sleep(ms: number) {
      sleeps.push(ms);
      if (cancelOnSleep) cancelled = true;
      time += ms;
    },
    cancelled: () => cancelled,
    row: () => undefined,
    ...extra,
  };
  return {
    deps,
    actions,
    reads,
    events,
    sleeps,
    clock: () => time,
    cancelAtNextSleep: () => {
      cancelOnSleep = true;
    },
    expireCapture: (k: number) => {
      expireAt = k;
    },
  };
}
// The screen after the Tap: `after(k, presence)` with k = 1 for the first capture that follows the press
// (mid-plan: 1 the Tap's readback, 2 the Fill's read, 3 recovery's presence read, 4 the fresh read).
const afterTapN = (after: (k: number, presence: boolean, dismissed: boolean) => any): Render => {
  let k = 0;
  return (_t, actions, presence) =>
    actions.length ? after(++k, presence, actions.includes('dialog dismiss')) : home();
};
// The screen after the Tap as a function of the time since the first capture that followed it.
const afterTapMs = (after: (dt: number) => any): Render => {
  let at: number | undefined;
  return (t, actions) => {
    if (!actions.length) return home();
    at ??= t;
    return after(t - at);
  };
};
// The screen as a function of the capture ordinal from the run's start.
const byCapture = (screen: (k: number, presence: boolean) => any): Render => {
  let k = 0;
  return (_t, _actions, presence) => screen(++k, presence);
};

const MID = `1. Tap "qa-late-open"\n2. Fill "${ID}" with "1234"\n`;
const FIRST = `1. Fill "${ID}" with "1234"\n`;
const DIALOG_NEXT = `1. Tap "qa-late-open"\n2. Fill "${ID}" with "1234"\n3. Dismiss the dialog\n`;
const TAP = `1. Tap "qa-late-open"\n2. Tap "${ID}"\n`;
const LATER = `1. Fill "${ID}" with "1234"\n2. Tap "Close"\n`;

// The front of the latest capture before each accepted decision-stage diagnostic of the line (a readback emits
// one too, after its own capture).
const decidedFronts = (events: string[], line: number) => {
  let front = '';
  const out: string[] = [];
  for (const e of events) {
    if (e.startsWith('capture ')) front = e.split(' ')[2];
    if (e === `decision ACCEPTED line ${line}`) out.push(front);
  }
  return out;
};
const rowText = (r: any) =>
  `${r.outcome}${r.reason ? ': ' + (typeof r.reason === 'string' ? r.reason : JSON.stringify(r.reason)) : ''}`;
const summary = (ledger: any, d: App, line: number) => {
  const steps = (ledger?.steps ?? []).filter((r: any) => r.line === line && r.block !== 'login');
  const seen =
    typeof ledger?.failure?.seen === 'string'
      ? ledger.failure.seen
      : JSON.stringify(ledger?.failure?.seen);
  const control = (ledger?.failure?.screen?.controls ?? []).find((c: any) => c.id === ID);
  const retry = steps.find((r: any) => r.outcome === 'retry' && /deciding again/.test(rowText(r)));
  return {
    verdict: ledger?.verdict,
    actions: d.actions,
    clock: d.clock(),
    ordinaryReads: d.reads.filter((presence) => !presence).length,
    presenceReads: d.reads.filter(Boolean).length,
    sleeps: d.sleeps,
    rows: steps.map(rowText) as string[],
    exclusions: steps.map((r: any) => r.candidateExclusions?.length ?? 0) as number[],
    seen: seen as string | undefined,
    reason: seen?.split('; last observed')[0] as string | undefined,
    subreason: ledger?.failure?.subreason,
    suggestion: ledger?.failure?.suggestion as string | undefined,
    kind: ledger?.failure?.kind,
    lastTarget: control
      ? `${control.role}${control.enabled ? '' : ' disabled'}${control.hittable ? ' hittable' : ''}`
      : undefined,
    retryInterruption: retry?.interruption ? JSON.stringify(retry.interruption) : undefined,
    implicitWaitMs: steps.map((r: any) => r.implicitWaitMs).filter((v: any) => v !== undefined),
    decidedOn: decidedFronts(d.events, line),
    hasFailure: ledger?.failure !== undefined,
  };
};
type Row = ReturnType<typeof summary>;
type Check = [boolean, string];

// Walks the plan (or `walk`), summarises the line of its Fill (or line 2), and asserts every check holds.
const expectRow = async (
  plan: string,
  d: App,
  checks: (r: Row) => Check[],
  walk?: () => Promise<any>,
): Promise<void> => {
  const blocks = parsePlan(plan).blocks!;
  const line = blocks[0].items.find((i: any) => i.kind === 'fill' || i.line === 2)!.line;
  const ledger = walk ? await walk() : await runPlan(blocks, d.deps);
  const r = summary(ledger, d, line);
  const failing = checks(r)
    .filter(([okay]) => !okay)
    .map(([, what]) => what);
  assert.deepEqual(failing, [], JSON.stringify({ ...r, events: d.events }, null, 1));
};

const GENERIC = `TARGET_NOT_FOUND: no eligible element labelled or identified "${ID}" is on screen`;
const CLAUSE = '; decided again on a fresh read';
const RETRY = `retry: ${GENERIC}; deciding again on a fresh read`;
const PASSROW = /^pass/;
const PRESENCE_CLAUSE =
  "; recovery could not read the screen's presence evidence, so nothing was dismissed";
const HIDDEN = `TARGET_NOT_FOUND: "${ID}" is on screen but not visible to the user (hidden in place, typically opacity 0 on it or a parent) and it does not hold input focus; nothing was typed and no scroll was tried. Next step: add a step before this Fill that taps the visible control which focuses this field, or fill the visible field instead`;
const NOT_TEXT =
  /was on screen but was not a text field; quote the testID of the text field itself, or move this testID onto the field in the app$/;
const DISABLED = /on screen and disabled/;
const AMBIGUOUS_ADVICE = /matched more than one control on the last observed screen/;
const fills = (r: Row) => r.actions.filter((a) => a.startsWith('fill')).length;
const ok = (okay: boolean, what: string): Check => [okay, what];
const exactRows = (r: Row, want: (string | RegExp)[]): Check =>
  ok(
    r.rows.length === want.length &&
      want.every((w, i) => (typeof w === 'string' ? r.rows[i] === w : w.test(r.rows[i]))),
    `rows exactly ${want.map(String).join(' | ')}`,
  );
const exactActions = (r: Row, want: string[]): Check =>
  ok(JSON.stringify(r.actions) === JSON.stringify(want), `actions exactly ${want.join(', ')}`);
const onePause = (r: Row): Check =>
  ok(r.sleeps.length === 1 && r.sleeps[0] === 500, 'exactly one 500 ms pause');
const noPause = (r: Row): Check => ok(r.sleeps.length === 0, 'no pause');
const noAlertDecision = (r: Row): Check =>
  ok(!r.decidedOn.includes('dialog'), 'no target decision on the alert');
// Not enrolled: no re-decide row and no clause.
const untouched = (r: Row): Check[] => [
  ok(!r.rows.some((x) => x.includes('deciding again')), 'no re-decide row'),
  ok(!(r.reason ?? '').includes(CLAUSE), 'no clause'),
];
// The re-decide that refuses again: one retry row, one pause, the refusal plus the clause, nothing typed.
const redecidedFail = (r: Row, ordinary: number, presence: number): Check[] => [
  ok(r.verdict === 'FAIL', 'FAIL'),
  ok(r.reason === GENERIC + CLAUSE, 'the refusal plus the clause'),
  ok(fills(r) === 0, 'no fill'),
  onePause(r),
  exactRows(r, [RETRY, /^fail: /]),
  ok(
    r.ordinaryReads === ordinary && r.presenceReads === presence,
    `reads: ${ordinary} ordinary, ${presence} presence`,
  ),
];
// The re-decide that passes: the retry row then the pass row, one Fill of the literal on the fresh read's ref.
const redecidedPass =
  (ref: string) =>
  (r: Row): Check[] => [
    ok(r.verdict === 'PASS', 'PASS'),
    ok(
      JSON.stringify(r.actions.filter((a) => a.startsWith('fill'))) ===
        JSON.stringify([`fill ${ref} 1234`]),
      `one fill of 1234 on ${ref}`,
    ),
    onePause(r),
    exactRows(r, [RETRY, PASSROW]),
    ok(!r.hasFailure, 'no failure'),
    ok(!r.decidedOn.includes('dialog'), 'no decision on a dialog'),
  ];
// Mid-plan reads put the field at @e4; a fresh read with the extra note row puts it at @e5.
const FRESH_REF = '@e5';

for (const [name, shape] of [
  ['R1', 'reactOnly'],
  ['R2', 'placeholder'],
] as const)
  test(`${name}: the field ${shape === 'reactOnly' ? 'only in React' : 'a placeholder view'} on the Fill's read, the input on the next reads: decided again and filled on the fresh read`, async () => {
    await expectRow(
      MID,
      app(afterTapN((k) => mid(k === 3 ? 'input' : k >= 4 ? 'freshInput' : shape))),
      (r) => [
        ...redecidedPass(FRESH_REF)(r),
        exactActions(r, ['press @e2', `fill ${FRESH_REF} 1234`]),
      ],
    );
  });

test('R3: the input 400 ms after the declining read is reached only through the pause', async () => {
  await expectRow(
    MID,
    app(afterTapMs((dt) => mid(dt >= 500 ? 'freshInput' : 'placeholder'))),
    redecidedPass(FRESH_REF),
  );
});

test('R4: the input 1.2 s after the declining read is not polled for: one pause, then the refusal with the clause', async () => {
  await expectRow(MID, app(afterTapMs((dt) => mid(dt >= 1300 ? 'input' : 'placeholder'))), (r) =>
    redecidedFail(r, 4, 2),
  );
});

// The three seconds start at the completion of the first capture after the Tap (100 ms after its dispatch).
test('R5: a placeholder for 3 s after the Tap fails with the clause and the field-testID advice', async () => {
  await expectRow(MID, app(afterTapMs((dt) => mid(dt >= 3000 ? 'input' : 'placeholder'))), (r) => [
    ...redecidedFail(r, 4, 2),
    ok(NOT_TEXT.test(r.suggestion ?? ''), 'field-testID advice'),
  ]);
});

test('R6: a disabled input fails after one re-decide with the disabled advice', async () => {
  await expectRow(MID, app(afterTapN(() => mid('disabledInput'))), (r) => [
    ...redecidedFail(r, 4, 2),
    ok(DISABLED.test(r.suggestion ?? ''), 'disabled advice'),
  ]);
});

test("R6b: an input hidden in place: the refusal's own period is dropped before both texts", async () => {
  await expectRow(
    MID,
    app(afterTapN(() => screenOf([open, sending, hiddenInput], [openEntry, entry]))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.reason === HIDDEN + CLAUSE, 'the sentence, then the clause, no stray period'),
      onePause(r),
      ok(fills(r) === 0, 'no fill'),
      exactRows(r, [`retry: ${HIDDEN}; deciding again on a fresh read`, /^fail: /]),
    ],
  );
});

test('R7: a refusal decided on an alert the next step answers is not decided again', async () => {
  await expectRow(
    DIALOG_NEXT,
    app(afterTapN((k) => (k === 1 ? mid('placeholder') : alertOf()))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok((r.reason ?? '').startsWith('TARGET_NOT_FOUND'), 'a target refusal'),
      exactActions(r, ['press @e2']),
      noPause(r),
      ...untouched(r),
    ],
  );
});

// After the dismissal the app shows the field hidden in place, so the final refusal is visibly the ordinary decision
// that follows recovery, not the first refusal rethrown.
test('R7b: the fresh read is an alert holding a matching input: no decision on it, recovery answers it', async () => {
  const d = app(
    afterTapN((k, _presence, dismissed) =>
      dismissed
        ? screenOf([open, sending, hiddenInput], [openEntry, entry])
        : k >= 4
          ? alertOf([alertInput])
          : mid('placeholder'),
    ),
  );
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(fills(r) === 0, 'nothing typed into the alert'),
    exactActions(r, ['press @e2', 'dialog dismiss']),
    noAlertDecision(r),
    exactRows(r, [
      RETRY,
      /recovered: dialog; retrying the step once$/,
      /^fail: TARGET_NOT_FOUND: "qa-late-code" is on screen but not visible/,
    ]),
    ok(
      /not visible to the user/.test(r.reason ?? '') && !(r.reason ?? '').includes(CLAUSE),
      'the ordinary refusal after recovery, no clause',
    ),
  ]);
});

test('R7c: the fresh read is an alert the next step answers: the first refusal stands', async () => {
  await expectRow(
    DIALOG_NEXT,
    app(afterTapN((k) => (k >= 4 ? alertOf([alertInput]) : mid('placeholder')))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(fills(r) === 0, 'nothing typed into the alert'),
      ok(!r.actions.some((a) => a.startsWith('dialog')), 'no dialog action'),
      noAlertDecision(r),
      ok(r.reason === GENERIC, 'the first refusal, no clause'),
      exactRows(r, [RETRY, /^fail: /]),
    ],
  );
});

test('R8: a step that already sent its Fill is not decided again (identical apart from the advice)', async () => {
  await expectRow(
    MID,
    app(
      (_t, actions) =>
        !actions.length
          ? home()
          : mid(actions.some((a) => a.startsWith('fill')) ? 'placeholder' : 'input'),
      {},
      () => NOT_ACTUATED,
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.reason === GENERIC, 'generic refusal'),
      ok(fills(r) === 1, 'one fill sent'),
      noPause(r),
      exactRows(r, [/^retry: .*retrying once/, /^fail: TARGET_NOT_FOUND/]),
      ...untouched(r),
    ],
  );
});

test('R8b: a Fill sent once, then a login replay: the item still sent an action, so no second Fill (identical apart from the advice)', async () => {
  // home -> (Tap) the input -> (Fill, not actuated) the login wall -> (Sign in) the placeholder.
  let stage = 'home';
  const d = app(
    () =>
      stage === 'home'
        ? home()
        : stage === 'input'
          ? mid('input')
          : stage === 'wall'
            ? loginWall()
            : mid('placeholder'),
    {},
    () => {
      stage = 'wall';
      return NOT_ACTUATED;
    },
  );
  const press = d.deps.press;
  d.deps.press = async (ref: string, context: any) => {
    stage = stage === 'home' ? 'input' : stage === 'wall' ? 'signed-in' : stage;
    return press(ref, context);
  };
  d.deps.login = {
    marker: { id: 'login-screen' },
    block: { ...parsePlan('1. Tap "Sign in"\n').blocks![0], slug: 'login' },
  };
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(r.reason === GENERIC, 'generic refusal'),
    exactActions(r, ['press @e2', 'fill @e4 1234', 'press @e2']),
    noPause(r),
    exactRows(r, [
      /retrying once$/,
      /recovered: login; retrying the step once$/,
      /^fail: TARGET_NOT_FOUND/,
    ]),
    ...untouched(r),
  ]);
});

test('R9: a step that scrolled toward its field is not decided again', async () => {
  await expectRow(
    MID,
    app((_t, actions) =>
      !actions.length
        ? home()
        : mid(actions.some((a) => a.startsWith('scroll')) ? 'disabledInput' : 'belowInput'),
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.actions.filter((a) => a.startsWith('scroll')).length === 1, 'one scroll was sent'),
      ok(fills(r) === 0, 'no fill'),
      noPause(r),
      ...untouched(r),
    ],
  );
});

test('R10: iOS keeps its behavior (apart from the advice)', async () => {
  await expectRow(
    MID,
    app(
      afterTapN((k) => mid(k >= 3 ? 'input' : 'placeholder')),
      { platform: 'ios' },
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.reason === GENERIC, 'the generic refusal, no clause'),
      ok(fills(r) === 0, 'no fill'),
      noPause(r),
      exactRows(r, [/^fail: TARGET_NOT_FOUND/]),
      ...untouched(r),
    ],
  );
});

test('R11: a Tap on a disabled target keeps its behavior', async () => {
  await expectRow(TAP, app(afterTapN(() => mid('lateButton'))), (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(r.reason === GENERIC, 'generic refusal'),
    noPause(r),
    ...untouched(r),
  ]);
});

test("R11b: a Tap declined on a disabled button keeps today's advice, enabled on the next read or not", async () => {
  await expectRow(
    TAP,
    app(
      afterTapN((k) =>
        k >= 3
          ? screenOf(
              [open, sending, { ...lateButton, enabled: true, hittable: true }],
              [openEntry, { ...lateButtonEntry, disabled: false }],
            )
          : mid('lateButton'),
      ),
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.reason === GENERIC, 'generic refusal'),
      ok(/could not take this step/.test(r.suggestion ?? ''), "today's advice"),
      noPause(r),
      ...untouched(r),
    ],
  );
});

test('R12: a stored-selector Fill is not decided again (identical apart from the advice)', async () => {
  const d = app(() => first('reactOnly'));
  const block = {
    slug: 'stored',
    title: 'Stored',
    planHash: '',
    items: [
      {
        kind: 'fill',
        target: { quoted: ID, phrase: ID, exact: 'id' },
        text: '1234',
        line: 1,
        raw: `Fill "${ID}" with "1234"`,
        source: 'grammar',
      },
    ],
  };
  await expectRow(
    FIRST,
    d,
    (r) => [
      ok(
        r.rows.length === 1 &&
          r.rows[0].startsWith('fail: TARGET_NOT_FOUND') &&
          !r.rows[0].includes(CLAUSE),
        'refused TARGET_NOT_FOUND, no clause',
      ),
      noPause(r),
    ],
    async () => {
      const outcome = await walkBlock(block as any, d.deps);
      return {
        verdict: outcome.block.outcome === 'pass' ? 'PASS' : 'FAIL',
        steps: outcome.rows,
        failure: outcome.failure,
      };
    },
  );
});

test('R13: initial ambiguity stays final', async () => {
  await expectRow(MID, app(afterTapN(() => mid('twins'))), (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok((r.reason ?? '').startsWith('TARGET_AMBIGUOUS'), 'TARGET_AMBIGUOUS'),
    noPause(r),
    ...untouched(r),
  ]);
});

test("R13b: the fresh decision's ambiguity keeps its code and carries the clause", async () => {
  await expectRow(MID, app(afterTapN((k) => mid(k >= 4 ? 'freshTwins' : 'placeholder'))), (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(
      /^TARGET_AMBIGUOUS: .*; decided again on a fresh read$/.test(r.reason ?? ''),
      'TARGET_AMBIGUOUS with the clause',
    ),
    ok(fills(r) === 0, 'no fill'),
    exactRows(r, [RETRY, /^fail: TARGET_AMBIGUOUS/]),
  ]);
});

test("R14: a mid-plan field absent on the Fill's read, the input next: decided again and filled", async () => {
  await expectRow(
    MID,
    app(afterTapN((k) => mid(k === 3 ? 'input' : k >= 4 ? 'freshInput' : 'absent'))),
    redecidedPass(FRESH_REF),
  );
});

test('R15: the launch poll still finds a first Fill target that appears after 2 s', async () => {
  await expectRow(
    FIRST,
    app((t) => first(t >= 2000 ? 'input' : 'absent')),
    (r) => [
      ok(r.verdict === 'PASS', 'PASS'),
      ok(!r.rows.some((x) => x.startsWith('retry')), 'no retry row'),
      ok(
        r.sleeps.every((s) => s === 500),
        'only poll sleeps',
      ),
      ok(r.implicitWaitMs[0] >= 1900, 'the launch wait measured'),
    ],
  );
});

test('R16: a first Fill target absent for ever keeps the launch sentence', async () => {
  await expectRow(
    FIRST,
    app(() => first('absent')),
    (r) => [
      ok(
        r.reason ===
          'TARGET_NOT_FOUND_AFTER_LAUNCH: the first step after launch found its target absent for 15 s',
        'launch sentence, no clause',
      ),
      ok(r.clock === 15000, 'clock 15000'),
      ...untouched(r),
    ],
  );
});

test('R17: a first Fill on a placeholder (no launch poll), the input from the next capture: filled on the fresh read', async () => {
  await expectRow(
    FIRST,
    app(byCapture((k) => first(k >= 3 ? 'freshInput' : k === 2 ? 'input' : 'placeholder'))),
    redecidedPass('@e3'),
  );
});

test('R17b: the launch poll stops on a placeholder, the re-decide then reads the input', async () => {
  await expectRow(
    FIRST,
    app(byCapture((k) => first(k <= 2 ? 'absent' : k <= 4 ? 'placeholder' : 'freshInput'))),
    (r) => [
      ok(r.verdict === 'PASS', 'PASS'),
      exactActions(r, ['fill @e3 1234']),
      exactRows(r, [RETRY, PASSROW]),
      ok(r.clock < 3000, 'no second launch poll'),
    ],
  );
});

test('R17c: the re-decide retires the launch allowance: a first Fill on a placeholder, then absent', async () => {
  await expectRow(FIRST, app(byCapture((k) => first(k <= 2 ? 'placeholder' : 'absent'))), (r) => [
    ...redecidedFail(r, 2, 2),
    ok(r.clock < 2000, 'no launch poll after the re-decide'),
    ok(r.implicitWaitMs.length === 0, 'no implicit wait'),
  ]);
});

const cancelled = (r: Row): Check[] => [
  ok(r.verdict === 'FAIL', 'FAIL'),
  onePause(r),
  ok(r.reason === 'RUN_CANCELLED', 'ends RUN_CANCELLED'),
  ok(fills(r) === 0, 'no fill'),
  exactRows(r, [/; deciding again on a fresh read$/, /^fail: RUN_CANCELLED$/]),
];

test('R18: a cancellation during the pause ends the step RUN_CANCELLED with no read after it', async () => {
  const d = app(afterTapN(() => mid('placeholder')));
  d.cancelAtNextSleep();
  await expectRow(MID, d, (r) => [
    ...cancelled(r),
    ok(r.ordinaryReads === 3 && r.presenceReads === 1, 'no read after the pause'),
  ]);
});

test("R18b: a cancellation during the pause does not carry recovery's withheld clause onto its row", async () => {
  const d = app(
    afterTapN((k, presence) =>
      presence
        ? screenOf([open, sending, input], [openEntry, entry], unusable)
        : mid('placeholder'),
    ),
    { presenceUnavailable: true, note: () => undefined },
  );
  d.cancelAtNextSleep();
  await expectRow(MID, d, (r) => [
    ...cancelled(r),
    ok(!(r.seen ?? '').includes('presence evidence'), 'no withheld clause on the failure'),
  ]);
});

test('R18c: a cancellation during the pause leaves the first pass candidate exclusions on the retry row only', async () => {
  const d = app(afterTapN(() => mid('offscreenTwins')));
  d.cancelAtNextSleep();
  await expectRow(MID, d, (r) => [
    ...cancelled(r),
    ok(r.exclusions[0] === 2, 'two exclusions on the retry row'),
    ok(r.exclusions[1] === 0, 'none on the cancelled row'),
  ]);
});

test('R19: an alert on the fresh read is dismissed by recovery, then the input is filled', async () => {
  const d = app(
    afterTapN((k, _presence, dismissed) =>
      dismissed ? mid('freshInput') : k >= 4 ? alertOf() : mid('placeholder'),
    ),
  );
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'PASS', 'PASS'),
    exactActions(r, ['press @e2', 'dialog dismiss', `fill ${FRESH_REF} 1234`]),
    onePause(r),
    exactRows(r, [RETRY, /recovered: dialog; retrying the step once$/, PASSROW]),
    noAlertDecision(r),
  ]);
});

test("R20: the fresh read's disabled field is decided on, not recovery's enabled input", async () => {
  await expectRow(
    MID,
    app(afterTapN((k) => mid(k === 3 ? 'input' : k >= 4 ? 'disabledInput' : 'placeholder'))),
    (r) => [
      ...redecidedFail(r, 4, 2),
      ok(DISABLED.test(r.suggestion ?? ''), 'disabled advice from the fresh read'),
    ],
  );
});

test("R20b: recovery's read shows the input, the fresh read nothing: refused with the clause", async () => {
  await expectRow(
    MID,
    app(afterTapN((k) => mid(k === 3 ? 'input' : k >= 4 ? 'absent' : 'placeholder'))),
    (r) => redecidedFail(r, 4, 2),
  );
});

test("R21: recovery's presence read refused, the fresh read shows the input: filled", async () => {
  const d = app(
    afterTapN((k, presence) =>
      presence
        ? screenOf([open, sending, input], [openEntry, entry], unusable)
        : mid(k >= 4 ? 'freshInput' : 'placeholder'),
    ),
    { presenceUnavailable: true, note: () => undefined },
  );
  await expectRow(MID, d, redecidedPass(FRESH_REF));
});

test("R22: a first-pass previous-plan-press veto stays on the retry row, not on the fresh decision's receipt", async () => {
  await expectRow(
    MID,
    app(
      afterTapN((k, presence) => {
        if (k >= 4) return mid('disabledInput');
        const s = screenOf([open, sending, close], [openEntry, closeEntry]);
        return presence ? pressable(s) : s;
      }),
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.subreason !== 'previous-plan-press', 'no carried veto'),
      ok(DISABLED.test(r.suggestion ?? ''), 'disabled advice'),
      ok(r.reason === GENERIC + CLAUSE, 'the clause'),
      ok(/previous-plan-press/.test(r.retryInterruption ?? ''), 'the veto kept on the retry row'),
      exactRows(r, [RETRY, /^fail: .*; decided again on a fresh read$/]),
    ],
  );
});

test('R23: a refusal after the fresh decision sent a Fill keeps its words', async () => {
  await expectRow(
    MID,
    app(
      afterTapN((k) => mid(k >= 4 && k < 6 ? 'freshInput' : 'placeholder')),
      {},
      () => NOT_ACTUATED,
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(fills(r) === 1, 'one fill sent'),
      ok(r.reason === GENERIC, 'no clause after a step action'),
      exactRows(r, [RETRY, /retrying once$/, /^fail: TARGET_NOT_FOUND/]),
    ],
  );
});

test('R24: the fresh app read expires and its refresh is an alert: the pending decision is not taken on it', async () => {
  const d = app(
    afterTapN((k, _presence, dismissed) =>
      dismissed
        ? mid('placeholder')
        : k === 4
          ? mid('freshInput')
          : k >= 5
            ? alertOf([alertInput])
            : mid('placeholder'),
    ),
  );
  // Captures: 1 the Tap's read, 2 its readback, 3 the Fill's read, 4 recovery's, 5 the fresh app read.
  d.expireCapture(5);
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(fills(r) === 0, 'nothing typed into the alert'),
    noAlertDecision(r),
    ok(r.actions.includes('dialog dismiss'), 'recovery answered the alert'),
    ok(r.rows[0] === RETRY, 'the re-decide row first'),
    ok(!(r.reason ?? '').includes(CLAUSE), 'no clause'),
  ]);
});

test('R25: a refusal decided on an alert is not decided again, even when recovery then reads the app (identical apart from the advice)', async () => {
  await expectRow(
    MID,
    app(afterTapN((k) => (k === 2 ? alertOf() : mid(k >= 4 ? 'freshInput' : 'placeholder')))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(fills(r) === 0, 'no fill'),
      noPause(r),
      ...untouched(r),
    ],
  );
});

test("R26: refused on the app while recovery's read is a plan-owned alert: the fresh read's input is filled", async () => {
  await expectRow(
    DIALOG_NEXT,
    app(afterTapN((k) => (k === 3 ? alertOf() : mid(k >= 4 ? 'freshInput' : 'placeholder')))),
    (r) => [
      ok(
        JSON.stringify(r.actions.filter((a) => a.startsWith('fill'))) ===
          `["fill ${FRESH_REF} 1234"]`,
        'one Fill on the fresh read',
      ),
      exactRows(r, [RETRY, PASSROW]),
    ],
  );
});

// The first pass: the field known only to React (refused, not missing: no launch poll) and a Close the next step owns.
const vetoedFirstPass = (presence: boolean) => {
  const s = screenOf([close], [entry, closeEntry]);
  return presence ? pressable(s) : s;
};

test("R27: a first-pass later-target veto does not replace the fresh decision's ambiguity advice", async () => {
  await expectRow(
    LATER,
    app(byCapture((k, presence) => (k >= 3 ? first('freshTwins') : vetoedFirstPass(presence)))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(
        /^TARGET_AMBIGUOUS: .*; decided again on a fresh read$/.test(r.reason ?? ''),
        'the fresh ambiguity with the clause',
      ),
      ok(AMBIGUOUS_ADVICE.test(r.suggestion ?? ''), 'the ambiguity advice'),
      ok(
        !/later|Close/.test(r.suggestion ?? '') && !/later step|Tap "Close"/.test(r.seen ?? ''),
        'no advice from the superseded veto',
      ),
      exactRows(r, [RETRY, /^fail: TARGET_AMBIGUOUS/]),
    ],
  );
});

test("R27b: a first-pass later-target veto does not replace the fresh decision's disabled advice", async () => {
  await expectRow(
    LATER,
    app(
      byCapture((k, presence) =>
        k >= 3
          ? presence
            ? screenOf([disabledInput], [entry], unusable)
            : first('disabledInput')
          : vetoedFirstPass(presence),
      ),
      { presenceUnavailable: true, note: () => undefined },
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(DISABLED.test(r.suggestion ?? ''), 'the disabled advice of the fresh decision'),
      ok(
        r.reason === GENERIC + CLAUSE + PRESENCE_CLAUSE,
        'the clause, then the refused-presence clause',
      ),
      exactRows(r, [RETRY, /^fail: /]),
    ],
  );
});

test("R28: after a Fill handler fails before authorization, the next attempt's refusal has no clause", async () => {
  const d = app(
    afterTapN((k) => mid(k >= 4 && k < 6 ? 'freshInput' : 'placeholder')),
    {},
    () => ({
      beforeAuthorize: {
        ok: false,
        proven: false,
        executed: false,
        mutation: 'none',
        error: `NO_TEXT_INPUT_TARGET: device_fill could not snapshot the screen to bind "${FRESH_REF}" (runner-unavailable); no text was entered.`,
      },
    }),
  );
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'FAIL', 'FAIL'),
    ok(fills(r) === 0, 'nothing sent'),
    ok(d.events.includes(`fill-unsent ${FRESH_REF}`), 'the handler was entered on the fresh ref'),
    ok(r.reason === GENERIC, 'no clause on the later ordinary refusal'),
    exactRows(r, [RETRY, /NO_TEXT_INPUT_TARGET.*retrying once$/, /^fail: TARGET_NOT_FOUND/]),
  ]);
});

test("R29: the real Android capture projection: decided and filled on the fresh ordinary read's ref", async () => {
  const captureId = 'android-capture-4';
  const presenceOf = (i: number) => ({
    captureId,
    generation: 4,
    nodeIndex: i,
    status: i < 2 ? 'unknown' : 'observed',
    labelSource: 'none',
    ...(i < 2 ? {} : { observedUptimeMs: 150 }),
  });
  const realRead = (shape: 'placeholder' | 'input' | 'freshInput', presence: boolean) => {
    const field =
      shape === 'placeholder'
        ? { type: 'android.view.ViewGroup', identifier: ID }
        : { type: 'android.widget.EditText', identifier: ID };
    const raw = [
      { type: 'Application', rect: { x: 0, y: 0, width: 1080, height: 2400 }, hittable: false },
      {
        type: 'Window',
        parentIndex: 0,
        rect: { x: 0, y: 0, width: 1080, height: 2400 },
        hittable: false,
      },
      ...(shape === 'freshInput' ? [{ ...note, parentIndex: 1 }] : []),
      { ...field, parentIndex: 1, label: '', rect },
    ];
    const nodes = raw.map((n: any, index) => ({
      ref: `@e${index}`,
      index,
      depth: index === 0 ? 0 : index === 1 ? 1 : 2,
      label: '',
      identifier: '',
      packageName: 'com.test',
      enabled: true,
      hittable: true,
      selected: false,
      checked: false,
      visibleToUser: true,
      ...n,
      ...(presence ? { presence: presenceOf(index) } : {}),
    }));
    return captureScreen({
      requirePrivateInputs: true,
      appId: 'com.test',
      platformPresence: presence,
      now: () => 0,
      native: async (budget: number) => ({
        nodes,
        truncated: false,
        pointScale: 2.625,
        normalizationDroppedNodes: 0,
        snapshotGeneration: 4,
        keyboardVisible: false,
        snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
        ...(presence
          ? {
              presenceCapture: {
                version: 2,
                source: 'android-a11y-live',
                enumeration: 'app-windows',
                captureId,
                appId: 'com.test',
                generation: 4,
                startedUptimeMs: 100,
                endedUptimeMs: 200,
                complete: true,
                appliedBudgetMs: budget,
                pointScale: 2.625,
              },
            }
          : {}),
      }),
      react: async () => ({
        interactive:
          shape === 'placeholder'
            ? []
            : [{ testID: ID, role: 'textinput', capabilities: { fill: true } }],
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    } as any);
  };
  let k = 0;
  // Each read's observation ordinal and mode, as the walker requested it.
  const modes: string[] = [];
  const d = app(() => {
    throw new Error('replaced');
  });
  const fake = d.deps.captureScreen;
  d.deps.captureScreen = async (o: any) => {
    await fake(o).catch(() => undefined); // keeps the fake's clock
    k += 1;
    const presence = o?.platformPresence === true;
    modes.push(`${o?.observation}:${presence ? 'presence' : 'ordinary'}`);
    const s = await realRead(k === 1 ? 'placeholder' : k === 2 ? 'input' : 'freshInput', presence);
    d.events.push(`capture ${presence ? 'presence' : 'ordinary'} ${s.front}`);
    return s;
  };
  await expectRow(FIRST, d, (r) => [
    ok(r.verdict === 'PASS', 'PASS'),
    exactActions(r, ['fill @e3 1234']),
    exactRows(r, [RETRY, PASSROW]),
    ok(
      JSON.stringify(modes) === '["1:ordinary","2:presence","3:ordinary","4:ordinary"]',
      `reads ${modes.join(',')}`,
    ),
    ok(
      JSON.stringify(d.events.filter((e) => !e.startsWith('dispatch')).slice(0, 7)) ===
        JSON.stringify([
          'capture ordinary app',
          'decision ACCEPTED line 1',
          'capture presence app',
          'capture ordinary app',
          'decision ACCEPTED line 1',
          'fill @e3 1234',
          'capture ordinary app',
        ]),
      'decided and filled on observation 3, the fresh ordinary read',
    ),
  ]);
});

const ASKED_AGAIN = `${GENERIC}${CLAUSE}; the app asked again after recovery declined it; answer it with a dialog step`;

test('R30: recovery answering the same alert again keeps the clause before its repeated-prompt clause', async () => {
  // 1 the Fill's read and 2 recovery's read: an alert, dismissed; 3 and 4: the placeholder (refused, recovery idle);
  // 5 the fresh read: the placeholder (refused with the clause); 6 recovery's read: the same alert again.
  await expectRow(
    FIRST,
    app(byCapture((k) => (k <= 2 || k >= 6 ? alertOf() : first('placeholder')))),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(r.reason === ASKED_AGAIN, 'the clause, then the repeated-prompt clause'),
      exactActions(r, ['dialog dismiss']),
      onePause(r),
      exactRows(r, [/recovered: dialog; retrying the step once$/, RETRY, /^fail: /]),
      ok(r.rows[2]?.startsWith(`fail: ${ASKED_AGAIN}`) === true, 'the fail row keeps both clauses'),
    ],
  );
});

test('R31: the fresh decision refuses, recovery dismisses an alert, and the next ordinary attempt fills', async () => {
  const d = app(
    afterTapN((k, _presence, dismissed) =>
      dismissed ? mid('freshInput') : k === 5 ? alertOf() : mid('placeholder'),
    ),
  );
  await expectRow(MID, d, (r) => [
    ok(r.verdict === 'PASS', 'PASS'),
    exactActions(r, ['press @e2', 'dialog dismiss', `fill ${FRESH_REF} 1234`]),
    onePause(r),
    exactRows(r, [RETRY, /recovered: dialog; retrying the step once$/, PASSROW]),
    noAlertDecision(r),
  ]);
});

// The presence read proves no element can be filled, so the described target has no candidate and Jev is not asked.
test('R32: a described Fill refused with no candidates is not decided again', async () => {
  await expectRow(
    `1. Tap "qa-late-open"\n2. Fill the code field with "1234"\n`,
    app(
      afterTapN((_k, presence) => (presence ? pressable(mid('placeholder')) : mid('placeholder'))),
    ),
    (r) => [
      ok(r.verdict === 'FAIL', 'FAIL'),
      ok(
        r.reason === 'TARGET_NOT_FOUND: the screen has no eligible candidates',
        'the no-candidates refusal',
      ),
      ok(fills(r) === 0, 'no fill'),
      noPause(r),
      ...untouched(r),
    ],
  );
});
