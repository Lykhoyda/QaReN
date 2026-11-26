import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serializeBlock, writeBlock } from '../../../dist/qa/blocks.js';
import { CaptureDeadline, captureScreen } from '../../../dist/qa/capture.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { cleanDiagnostic } from '../../../dist/qa/diagnostics.js';
import type { LedgerRow } from '../../../dist/qa/ledger.js';
import { HandlerError } from '../../../dist/qa/adapt.js';
import { attested } from './platform-presence-fixtures.ts';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join as joinScreen, type Screen } from '../../../dist/qa/screen.js';
import { runPlan, walkBlock, type ActResult, type WalkerDeps } from '../../../dist/qa/walker.js';
import { createWriter, resultForWalk } from '../../../dist/qa/wire.js';
import { choice, scriptedJudge } from './judgment-fixtures.ts';

const late = 'The planned transition appeared after the first readback.';
const save = '1. Tap "save"';
const check = '✓ "Review"';
const plan = (markdown = `${save}\n${check}`) => {
  const result = parsePlan(markdown);
  assert.ok(result.blocks, JSON.stringify(result.refused));
  return result.blocks;
};

function page(title = 'Draft', id = 'save', ref = '@old', y = 320): Screen {
  const screen = joinScreen(nativePage(title, id, ref, y), []);
  return { ...screen, front: 'app', coverage: { native: 'complete', react: 'complete' } };
}

function nativePage(title: string, id = 'save', ref = '@old', y = 320) {
  return [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@window',
      index: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: title,
      ref: '@title',
      hittable: true,
      rect: { x: 24, y: 104, width: 350, height: 32 },
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'Button',
      label: 'Save',
      identifier: id,
      ref,
      hittable: true,
      rect: { x: 24, y, width: 350, height: 56 },
    },
  ];
}

const draft = () => page();
const review = () => page('Review', 'save', '@new');

function prompt(title: string, pid?: number): Screen {
  return {
    ...page(title, 'allow', '@allow'),
    front: 'dialog',
    coverage: { native: 'incomplete', react: 'unavailable' },
    captureCoverage: { native: 'complete', react: 'unavailable' },
    appProcessIdentifier: pid,
  };
}

const ios: ActResult = { ok: true, proven: false };
const android: ActResult = {
  ok: false,
  proven: false,
  mutation: 'possible',
  error: 'INTERACTION_EFFECT_UNVERIFIED',
};
const moved: ActResult = {
  ok: false,
  proven: false,
  mutation: 'none',
  error: 'TARGET_MOVED_BEFORE_DISPATCH: private geometry',
};

function rig(read: (index: number, time: number, sent: number) => Screen, result = ios) {
  let time = 0;
  let deliveries = 0;
  const sends: string[] = [];
  const actions: string[] = [];
  const rows: LedgerRow[] = [];
  const events: Record<string, unknown>[] = [];
  const reads: number[] = [];
  const deps: WalkerDeps = {
    platform: 'ios',
    now: () => time,
    async sleep(ms) {
      time += ms;
    },
    async captureScreen() {
      const index = reads.length;
      reads.push(time);
      return read(index, time, sends.length);
    },
    async press(ref, context) {
      context.authorize();
      sends.push(ref);
      if (result.mutation !== 'none' && result.executed !== false) deliveries++;
      return sends.length === 1 ? result : { ok: true, proven: true };
    },
    async fill() {
      actions.push('fill');
      return ios;
    },
    async scroll() {
      actions.push('scroll');
      return ios;
    },
    async back() {
      actions.push('back');
      return ios;
    },
    async dialog(action, context) {
      context.authorize();
      actions.push(`dialog ${action}`);
      return { ok: true, proven: true };
    },
    async screenshot() {
      actions.push('shot');
      return 'shot.png';
    },
    row: (row) => rows.push(row),
    pressRetry: (event: Record<string, unknown>) => events.push(event),
  };
  return {
    deps,
    reads,
    sends,
    actions,
    rows,
    events,
    deliveries: () => deliveries,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function queued(screens: (() => Screen)[], result = ios) {
  return rig((index) => screens[Math.min(index, screens.length - 1)](), result);
}

for (const [platform, result] of [
  ['ios', ios],
  ['android', android],
] as const) {
  for (const scenario of ['shared', 'distinct', 'after-resolution'] as const) {
    test(`H1/H2 ${platform} ${scenario} transition uses one source send and an independent Check`, async () => {
      const f = rig((index, time, sent) => {
        if (sent > 1) return page('Done');
        if (index < 2 || (scenario === 'after-resolution' && time < 35)) return draft();
        return page('Review', scenario === 'shared' ? 'save' : 'continue', '@new');
      }, result);
      f.deps.platform = platform;
      if (scenario === 'after-resolution') {
        const send = f.deps.press;
        f.deps.press = (...args) => {
          f.advance(20);
          return send(...args);
        };
      }
      const resultLedger = await runPlan(plan(), f.deps);
      assert.deepEqual(f.sends, ['@old']);
      assert.equal(f.deliveries(), 1);
      assert.equal(resultLedger.verdict, 'PASS');
      assert.deepEqual(
        f.rows.map(({ attempt, outcome }) => [attempt, outcome]),
        [
          [1, 'pass'],
          [1, 'pass'],
        ],
      );
      assert.equal(f.rows[0].reason, late);
      assert.equal(f.rows[0].ref, undefined);
      assert.deepEqual(f.rows[0].selector, { id: 'save' });
      assert.ok(f.reads.length >= 5);
      assert.equal(f.events.length, 1);
      assert.equal(f.events[0].proofReads, 2);
      assert.equal(f.events[0].operationId, f.rows[0].operationId);
    });
  }
}

const hidden = () => {
  const screen = draft();
  return {
    ...screen,
    elements: screen.elements.map((e) => (e.testID === 'save' ? { ...e, disabled: true } : e)),
  };
};
const ambiguous = () => {
  const screen = draft();
  return {
    ...screen,
    elements: [
      ...screen.elements,
      { ...screen.elements.find((e) => e.testID === 'save')!, ref: '@twin', disabled: true },
    ],
  };
};

for (const [label, changed, subreason] of [
  ['wrong surface', () => page('Interrupted', 'save', '@wrong'), 'screen-changed'],
  ['replacement', () => page('Draft', 'copy', '@wrong'), 'target-changed'],
  ['hidden', hidden, 'target-changed'],
  ['ambiguous', ambiguous, 'target-changed'],
  ['indistinguishable surface', () => page('Draft', 'save', '@wrong'), 'no-effect'],
] as const) {
  test(`H3 ${label} refuses the original line with sticky evidence`, async () => {
    const f = queued([draft, draft, changed, draft]);
    const ledger = await runPlan(plan(), f.deps);
    assert.deepEqual(f.sends, ['@old']);
    assert.equal(ledger.verdict, 'FAIL');
    assert.equal(ledger.failure?.subreason, `press-retry-${subreason}`);
    assert.deepEqual(
      f.rows.map(({ attempt, outcome }) => [attempt, outcome]),
      [[1, 'fail']],
    );
    assert.deepEqual(f.actions, []);
  });
}

for (const [name, disposition] of [
  ['clean unproven', ios],
  ['unknown timeout', { ok: false, proven: false, error: 'RUNNER_TIMEOUT: private data' }],
  ['possible', android],
  ['explicit non-invocation', { ok: false, proven: false, executed: false }],
  ['moved', moved],
] as const) {
  test(`H4 ${name} spends the read budget without sending again`, async () => {
    const f = queued([draft], disposition);
    const result = await walkBlock(plan()[0], f.deps, undefined, undefined, undefined, undefined, {
      singleAttempt: true,
    });
    assert.deepEqual(f.sends, ['@old']);
    assert.equal(
      f.deliveries(),
      'executed' in disposition || ('mutation' in disposition && disposition.mutation === 'none')
        ? 0
        : 1,
    );
    assert.equal(result.failure?.subreason, 'press-retry-no-effect');
    assert.deepEqual(f.reads.slice(2), [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    assert.equal(f.events[0].readsStarted, 8);
  });
}

for (const quoted of [true, false]) {
  test(`H5 initial ${quoted ? 'quoted' : 'phrase'} Press dialog gets no recovery action`, async () => {
    const phraseDraft = () => {
      const screen = draft();
      return {
        ...screen,
        elements: screen.elements.filter((element) => element.kind === 'button'),
      };
    };
    let dismissed = false;
    const f = rig((_index, _time, sent) =>
      sent === 0 || dismissed ? phraseDraft() : prompt('Allow access'),
    );
    const dialog = f.deps.dialog;
    f.deps.dialog = async (...args) => {
      dismissed = true;
      return dialog(...args);
    };
    f.deps.judge = scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          choice(question, Object.keys(question.criteria ?? {})[0]),
        ]),
      ),
    );
    const ledger = await runPlan(plan(quoted ? save : '1. Tap the Save button'), f.deps);
    assert.deepEqual(f.sends, ['@old'], JSON.stringify(ledger.failure));
    assert.deepEqual(f.actions, []);
    assert.equal(ledger.failure?.subreason, 'press-retry-screen-changed');
    assert.equal(f.events[0].initialDialog, true);
  });
}

for (const [name, pid, expected] of [
  ['iOS', 123, 'PASS'],
  ['Android', undefined, 'FAIL'],
] as const) {
  test(`H5 a late ${name} Dialog requires positive process continuity and its own dispatch`, async () => {
    const f = queued([
      () => ({ ...draft(), appProcessIdentifier: pid }),
      () => prompt('Allow access', pid),
    ]);
    f.deps.platform = pid ? 'ios' : 'android';
    const ledger = await runPlan(plan(`${save}\n2. Dismiss the system dialog`), f.deps);
    assert.equal(ledger.verdict, expected);
    assert.deepEqual(f.sends, ['@old']);
    assert.equal(f.actions.filter((action) => action.startsWith('dialog ')).length, pid ? 1 : 0);
    assert.equal(ledger.failure?.subreason, pid ? undefined : 'press-retry-evidence-unavailable');
  });
}

test('H5 expiry is exclusive and a single Review read cannot prove progress', async () => {
  const f = queued([draft, draft, review, draft]);
  f.deps.walkDeadlineMs = 500;
  const ledger = await runPlan(plan(), f.deps);
  assert.equal(ledger.failure?.subreason, 'press-retry-screen-changed');
  assert.deepEqual(f.reads, [0, 0, 0]);
  assert.equal(f.events[0].proofReads, 1);
});

test('H5 a final overrun after stillness yields unavailable evidence', async () => {
  const f = queued([
    draft,
    draft,
    draft,
    () => {
      throw new CaptureDeadline();
    },
  ]);
  f.deps.walkDeadlineMs = 1000;
  const ledger = await runPlan(plan(), f.deps);
  assert.equal(ledger.failure?.subreason, 'press-retry-evidence-unavailable');
  assert.equal(f.events[0].readOverran, true);
});

for (const videoPolicy of ['strict', 'non-strict'] as const) {
  for (const failure of ['empty', 'runner-down'] as const)
    test(`H6 ${videoPolicy} latches a native ${failure} read after a late pass`, async () => {
      const f = queued([draft]);
      f.deps.videoPolicy = videoPolicy;
      let nativeReads = 0;
      const readsPerGuard: number[] = [];
      f.deps.captureScreen = async (options) => {
        const start = nativeReads;
        try {
          return await captureScreen({
            ...options,
            requirePrivateInputs: true,
            async native() {
              const index = nativeReads++;
              if (index === 2 && failure === 'runner-down')
                throw new HandlerError('RN_FAST_RUNNER_DOWN', 'synthetic runner loss', {
                  runnerRelaunch: true,
                });
              return {
                ...attested(index === 2 ? [] : nativePage(index < 2 ? 'Draft' : 'Review')),
                snapshotGeneration: 7,
                keyboardVisible: false,
              };
            },
            async react() {
              return {};
            },
            now: f.deps.now,
          });
        } finally {
          if (options?.pressGuardRead) readsPerGuard.push(nativeReads - start);
        }
      };
      const ledger = await runPlan(plan(), f.deps);
      assert.equal(ledger.verdict, 'PASS');
      assert.equal(ledger.videoPublication, 'unknown');
      assert.equal(ledger.nonStrictPublication, undefined);
      assert.deepEqual(f.actions, []);
      assert.equal(f.events[0].readsStarted, 3);
      assert.equal(f.events[0].readsAdmitted, 2);
      assert.deepEqual(readsPerGuard, [1, 1, 1]);
    });

  test(`H6 ${videoPolicy} sends fixed terminal detail and no late screen data`, async () => {
    const f = queued([draft, draft, () => page('LATE-CANARY-59388')]);
    f.deps.videoPolicy = videoPolicy;
    const wire: string[] = [];
    const writer = createWriter((line) => wire.push(line), 'press-test');
    const ledger = await runPlan(plan(), f.deps);
    writer.diagnostic(f.events[0]);
    assert.equal(writer.result(resultForWalk(ledger, 'lease')), 1);
    assert.equal(f.rows[0].reason, ledger.failure?.seen);
    assert.ok(!JSON.stringify({ wire, ledger }).includes('LATE-CANARY-59388'));
    assert.strictEqual(f.rows[0].screenshot, undefined);
    assert.equal(ledger.failure?.subreason, 'press-retry-screen-changed');
  });
}

const diagnostic = {
  kind: 'press-retry',
  line: 1,
  operationId: 1,
  outcome: 'passed-late',
  readsStarted: 3,
  readsAdmitted: 2,
  proofReads: 2,
  screenChanged: true,
  targetChanged: false,
  initialUnchanged: true,
  initialDialog: false,
  readOverran: false,
  firstDisposition: 'possible',
  networkIdle: 'unknown',
};

test('H6 diagnostic is closed and eligible without runtime inputs', () => {
  assert.deepEqual(cleanDiagnostic(diagnostic), diagnostic);
  for (const invalid of [
    { line: 0 },
    { operationId: 0 },
    { readsStarted: 1.5 },
    { readsStarted: 9 },
    { readsAdmitted: 4 },
    { proofReads: 1 },
    { initialDialog: 'false' },
    { firstDisposition: 'tap' },
    { networkIdle: 'yes' },
    { extra: 'rejected' },
  ])
    assert.equal(cleanDiagnostic({ ...diagnostic, ...invalid }), undefined);
  const wire: string[] = [];
  createWriter((line) => wire.push(line), 'press-test').diagnostic(diagnostic);
  assert.ok(wire.some((line) => line.includes('"press-retry"')));
});

for (const separate of [false, true]) {
  test(`H7 saved replay preserves original selector and ${separate ? 'cross-block' : 'same-block'} Check`, async () => {
    const appRoot = mkdtempSync(join(tmpdir(), 'press-retry-'));
    try {
      const blocks = plan(
        separate ? `### Save\n${save}\n### Review\n${check}` : `${save}\n${check}`,
      );
      const store = { appRoot, appId: 'com.example.app', platform: 'ios' as const };
      for (const block of blocks) {
        const stored = serializeBlock(
          block,
          block.items.map((item) => ({
            block: block.slug,
            line: item.line,
            text: item.raw,
            attempt: 1,
            kind: 'step',
            resolvedBy: 'exact',
            t: 0,
            outcome: 'pass',
            ...(item.kind === 'press' ? { selector: { id: 'save' } } : {}),
          })),
          store,
        );
        assert.ok('yaml' in stored);
        writeBlock(appRoot, block.slug, stored.yaml);
      }
      const f = queued([draft, draft, review]);
      const ledger = await runPlan(blocks, f.deps, [], store);
      assert.deepEqual(f.sends, ['@old']);
      assert.equal(ledger.verdict, 'PASS');
      assert.equal(f.rows[0].source, 'replayed');
      assert.deepEqual(f.rows[0].selector, { id: 'save' });
      assert.equal(f.rows[0].reason, late);
      assert.ok(f.reads.length >= 5);
      const file = join(appRoot, '.qaren', 'actions', `${blocks[0].slug}.yaml`);
      const bytes = readFileSync(file);
      const wrong = queued([draft, draft, () => page('Wrong')]);
      const failed = await runPlan(blocks, wrong.deps, [], store);
      assert.deepEqual(wrong.sends, ['@old']);
      assert.equal(failed.failure?.subreason, 'press-retry-screen-changed');
      assert.equal(wrong.rows[0].source, 'replayed');
      assert.equal(wrong.rows[0].operationId, wrong.events[0].operationId);
      assert.deepEqual(readFileSync(file), bytes);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
}

for (const [name, before, candidate, successor, expected] of [
  ['already present', () => page('Review'), review, check, 'press-retry-no-effect'],
  [
    'ambiguous exact ID',
    draft,
    () => {
      const screen = page('Review', 'next');
      return {
        ...screen,
        elements: [
          ...screen.elements,
          { ...screen.elements.find((e) => e.testID === 'next')!, ref: '@twin', disabled: true },
        ],
      };
    },
    '2. Tap "next"',
    'press-retry-screen-changed',
  ],
  ['phrase successor', draft, review, '2. Tap the continue button', 'press-retry-screen-changed'],
  ['no execution', draft, review, check, 'press-retry-screen-changed'],
] as const) {
  test(`H7 ${name} cannot prove the original Press`, async () => {
    const f = queued([before, before, candidate], name === 'no execution' ? moved : ios);
    const ledger = await runPlan(plan(`${save}\n${successor}`), f.deps);
    assert.deepEqual(f.sends, ['@old']);
    assert.equal(ledger.failure?.subreason, expected);
    assert.equal(f.rows.length, 1);
  });
}

test('H5 an incomplete read resets the proof pair and a later change of process terminates it', async () => {
  const f = queued([
    () => ({ ...draft(), appProcessIdentifier: 123 }),
    () => ({ ...draft(), appProcessIdentifier: 123 }),
    () => ({ ...review(), appProcessIdentifier: 123 }),
    () => {
      throw new NativeSnapshotIncomplete(0, ['unattested']);
    },
    () => ({ ...review(), appProcessIdentifier: 456 }),
  ]);
  f.deps.appProcess = { expected: 123 };
  const ledger = await runPlan(plan(), f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.match(ledger.failure?.seen ?? '', /APP_PROCESS_CHANGED/);
  assert.equal(f.events[0].outcome, 'process-ended');
  assert.equal(f.events[0].proofReads, 0);
  assert.deepEqual(f.sends, ['@old']);
  assert.deepEqual(f.actions, []);
});
