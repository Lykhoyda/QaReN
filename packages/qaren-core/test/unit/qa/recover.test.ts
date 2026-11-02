import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dismissCandidate,
  plannedSurface,
  recover,
  surfaceGone,
} from '../../../dist/qa/recover.js';
import type { RecoverDeps } from '../../../dist/qa/recover.js';
import {
  ancestorsOf,
  hostAssociationIdentity,
  join,
  type NativeNode,
  type ReactHostEvidence,
  type Screen,
} from '../../../dist/qa/screen.js';
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

function sheetScreen(
  covered = true,
  declines = ['Close'],
  extraNodes: NativeNode[] = [],
  scrimTop = 400,
): Screen {
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
    ...extraNodes,
    ...(declines.length
      ? [
          {
            ref: '@scrim',
            type: 'Other',
            parentIndex: 1,
            hittable: true,
            rect: { x: 0, y: scrimTop, width: 400, height: 800 - scrimTop },
          },
        ]
      : []),
    ...declines.map((label, index) => ({
      ref: `@decline${index}`,
      type: 'Button',
      parentIndex: 1,
      label,
      hittable: true,
      rect: { x: 20 + index * 150, y: scrimTop + 50, width: 100, height: 40 },
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

test('a target after a planned press withholds the decline, including ambiguous ones', () => {
  const after = { ...homeTarget, afterPlannedPress: true };
  const vetoes: string[] = [];
  const record = (entry: { veto: string }) => vetoes.push(entry.veto);
  assert.equal(dismissCandidate(sheetScreen(), [after], record), undefined);
  assert.equal(dismissCandidate(sheetScreen(true, ['Close', 'Skip']), [after], record), undefined);
  assert.deepEqual(vetoes, ['previous-plan-press', 'previous-plan-press']);
  vetoes.length = 0;
  // With nothing to dismiss, the screen's own veto stands instead.
  assert.equal(dismissCandidate(sheetScreen(true, []), [after], record), undefined);
  assert.equal(vetoes.length, 1);
  assert.notEqual(vetoes[0], 'previous-plan-press');
});

test('only complete container absence expires an identified planned surface', () => {
  const at = (id?: string): Screen =>
    screen('app', {
      coverage: { native: 'complete', react: 'complete' },
      reactHostEvidence: {
        complete: true,
        hosts: id ? [{ testID: id, role: null, roleSource: 'none', capabilities: {} }] : [],
        typography: {
          version: 1,
          complete: true,
          durationMs: 0,
          coordinateSpace: 'window-points',
          nodes: id
            ? [
                {
                  hostIndex: 0,
                  parentHostIndex: null,
                  rootIndex: 0,
                  hostType: 'Modal',
                  text: { kind: 'none' },
                },
              ]
            : [],
        },
      },
    });
  const surface = plannedSurface(at('consent'), at())!;
  assert.equal(surfaceGone(at('consent'), surface), false);
  assert.equal(surfaceGone(at('offer'), surface), true);
  assert.equal(surfaceGone(at(), surface), true);
  assert.equal(plannedSurface(at(), at('consent')), undefined);
  assert.equal(surfaceGone({ ...at(), front: 'dialog' }, surface), false);
  assert.equal(
    surfaceGone({ ...at(), coverage: { native: 'incomplete', react: 'complete' } }, surface),
    false,
  );
  assert.equal(surfaceGone({ ...at(), reactHostEvidence: undefined }, surface), false);
  const incomplete = at();
  incomplete.reactHostEvidence!.typography!.complete = false;
  assert.equal(surfaceGone(incomplete, surface), false);
  const nativeId = at('consent');
  nativeId.reactHostEvidence!.hosts[0] = {
    nativeID: 'consent',
    role: null,
    roleSource: 'none',
    capabilities: {},
  };
  assert.equal(surfaceGone(nativeId, surface), false);
  const anonymous = at('consent');
  delete anonymous.reactHostEvidence!.hosts[0].testID;
  assert.equal(surfaceGone(at(), plannedSurface(anonymous)!), false);
  const unknown = plannedSurface(screen('app'))!;
  assert.equal(surfaceGone(at(), unknown), false);
});

test('an uncovered id target still vetoes recovery', () => {
  const snapshot = sheetScreen(false);
  assert.equal(targetEvidence(homeTarget, snapshot), 'pass');
  assert.equal(dismissCandidate(snapshot, [homeTarget]), undefined);
});

for (const exact of [undefined, 'text', 'id'] as const) {
  test(`a planned Offer container protects its Close child without literal contribution (${exact})`, () => {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application' },
      { ref: '@window', type: 'Window', parentIndex: 0 },
      {
        ref: '@offer',
        type: 'Other',
        parentIndex: 1,
        label: 'Offer',
        identifier: exact === 'id' ? 'Offer' : undefined,
        hittable: true,
      },
      { ref: '@close', type: 'Button', parentIndex: 2, label: 'Close', hittable: true },
    ];
    const snapshot = join(nodes, [], 'app', { native: 'complete', react: 'complete' }, undefined, {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    });
    assert.equal(snapshot.visibleText.includes('Offer'), false);
    assert.equal(snapshot.labelText?.includes('Offer') ?? false, false);
    const absent = { phrase: 'Absent', quoted: 'Absent' };
    assert.deepEqual(dismissCandidate(snapshot, [absent]), { label: 'Close' });
    const records: string[] = [];
    assert.equal(
      dismissCandidate(
        snapshot,
        [absent, { phrase: 'Offer', quoted: 'Offer', exact, laterBlock: true }],
        (record) => records.push(...record.elements.map((e) => e.failed)),
      ),
      undefined,
    );
    assert.deepEqual(records, ['target-ancestor']);
  });
}

function flattenedSheetScreen(label?: string, measurementsComplete = true): Screen {
  const window = { x: 0, y: 0, width: 402, height: 874 };
  const sheet = { x: 0, y: 62, width: 402, height: 812 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: window },
    { ref: '@window', type: 'Window', parentIndex: 0, rect: window },
    { ref: '@wrapper', type: 'Other', parentIndex: 1, label: 'Close', rect: sheet },
    {
      ref: '@sheet',
      type: 'Other',
      parentIndex: 2,
      identifier: 'qa-sheet',
      label,
      hittable: true,
      rect: sheet,
    },
    {
      ref: '@close',
      type: 'Button',
      parentIndex: 2,
      identifier: 'qa-sheet-close',
      label: 'Close',
      hittable: true,
      rect: { x: 326, y: 72.67, width: 62, height: 31.33 },
    },
    { ref: '@other-window', type: 'Window', parentIndex: 0, rect: window },
  ];
  const hostEvidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      { testID: 'app-root', role: null, roleSource: 'none', capabilities: {} },
      { testID: 'qa-sheet-home', role: null, roleSource: 'none', capabilities: {} },
      { role: null, roleSource: 'none', capabilities: {} },
      { testID: 'qa-sheet', role: null, roleSource: 'none', capabilities: {} },
      {
        testID: 'qa-sheet-close',
        role: 'button',
        roleSource: 'role',
        capabilities: { press: true },
      },
    ],
    typography: {
      version: 1,
      complete: measurementsComplete,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [
        window,
        window,
        { ...sheet, y: 0 },
        { ...sheet, y: 0 },
        { x: 326, y: 10.67, width: 62, height: 31.33 },
      ].map((rect, hostIndex) => ({
        hostIndex,
        parentHostIndex: hostIndex === 0 ? null : hostIndex - 1,
        rootIndex: 0,
        hostType: hostIndex === 2 ? 'RCTModalHostView' : 'RCTView',
        rect,
        text: { kind: 'none' },
      })),
    },
  };
  return join(
    nodes,
    [
      { testID: 'qa-sheet-home', role: 'view' },
      { testID: 'qa-sheet', role: 'view', label },
      { testID: 'qa-sheet-close', role: 'button', label: 'Close' },
    ],
    'app',
    { native: 'complete', react: 'complete' },
    hostEvidence,
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
  );
}

for (const exact of [undefined, 'id', 'text'] as const) {
  test(`a flattened modal protects its planned container despite the presentation offset (${exact})`, async () => {
    const quoted = exact === 'text' ? 'Offer' : 'qa-sheet';
    const snapshot = flattenedSheetScreen(exact === 'text' ? quoted : undefined);
    const close = snapshot.elements.find((e) => e.testID === 'qa-sheet-close')!;
    const sheet = snapshot.elements.find((e) => e.testID === 'qa-sheet')!;
    assert.equal(ancestorsOf(close).includes(sheet), false);
    assert.equal(hostAssociationIdentity(close), 'frame-mismatch');
    assert.equal(hostAssociationIdentity(sheet), 'frame-mismatch');
    assert.equal(centreCovered(sheet, snapshot), false);
    let presses = 0;
    const d = deps({
      dismiss: async () => {
        presses++;
        return 'pass';
      },
    });
    assert.equal(
      await recover(snapshot, d.deps, undefined, [
        { phrase: 'Item 1', quoted: 'Item 1' },
        { phrase: quoted, quoted, exact, laterBlock: true },
      ]),
      undefined,
    );
    assert.equal(presses, 0);
  });
}

test('missing measurements do not erase the planned React container ancestry', async () => {
  const snapshot = flattenedSheetScreen(undefined, false);
  let presses = 0;
  const d = deps({
    dismiss: async () => {
      presses++;
      return 'pass';
    },
  });
  assert.equal(
    await recover(snapshot, d.deps, undefined, [
      { phrase: 'Item 1', quoted: 'Item 1' },
      { phrase: 'qa-sheet', quoted: 'qa-sheet', laterBlock: true },
    ]),
    undefined,
  );
  assert.equal(presses, 0);
});

for (const type of ['Modal', 'RCTModalHostView']) {
  test(`a modal host separates its controls from the underlying React home (${type})`, () => {
    const snapshot = flattenedSheetScreen();
    snapshot.reactHostEvidence!.typography!.nodes[2].hostType = type;
    assert.deepEqual(
      dismissCandidate(snapshot, [
        { phrase: 'Item 1', quoted: 'Item 1' },
        { phrase: 'qa-sheet-home', quoted: 'qa-sheet-home', exact: 'id', laterBlock: true },
      ]),
      { label: 'Close' },
    );
  });
}

for (const exact of ['id', 'text'] as const) {
  test(`a covered planned decline control is not used as recovery (${exact})`, () => {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application' },
      {
        ref: '@window',
        type: 'Window',
        parentIndex: 0,
        rect: { x: 0, y: 0, width: 400, height: 800 },
      },
      {
        ref: '@close',
        type: 'Button',
        parentIndex: 1,
        identifier: 'close',
        label: 'Close',
        hittable: true,
        rect: { x: 20, y: 450, width: 100, height: 40 },
      },
      {
        ref: '@overlay',
        type: 'Other',
        parentIndex: 1,
        hittable: true,
        rect: { x: 0, y: 400, width: 400, height: 400 },
      },
    ];
    const snapshot = join(nodes, [], 'app', { native: 'complete', react: 'complete' }, undefined, {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    });
    const quoted = exact === 'id' ? 'close' : 'Close';
    assert.equal(centreCovered(snapshot.elements[2], snapshot), true);
    assert.equal(dismissCandidate(snapshot, [{ phrase: quoted, quoted, exact }]), undefined);
  });
}

test('a covered large target containing an unrelated Close frame recovers with one press', async () => {
  const card: NativeNode = {
    ref: '@large-home',
    type: 'Other',
    parentIndex: 2,
    identifier: 'large-home',
    rect: { x: 0, y: 300, width: 400, height: 300 },
  };
  let snapshot = sheetScreen(true, ['Close'], [card]);
  const target = snapshot.elements.find((e) => e.testID === 'large-home')!;
  assert.equal(centreCovered(target, snapshot), true);
  assert.deepEqual(dismissCandidate(snapshot, [{ phrase: 'large-home', quoted: 'large-home' }]), {
    label: 'Close',
  });
  const f = walker(
    [snapshot],
    scriptedJudge(() => assert.fail('no model needed')),
  );
  f.deps.captureScreen = async () => snapshot;
  f.deps.hideDevMenu = async () => assert.fail('no dev menu');
  f.deps.press = async (ref) => {
    f.actions.push(`press ${ref}`);
    snapshot = sheetScreen(true, [], [card]);
    return { ok: true, proven: false, executed: true };
  };
  const result = await runPlan(parsePlan('1. Wait for "large-home"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', `${result.failure?.seen}; actions=${f.actions}`);
  assert.deepEqual(f.actions, ['press @decline0']);
  assert.equal(result.recoveries, 1);
});

for (const exact of [undefined, 'id'] as const) {
  test(`an uncovered id carrier with an offscreen twin still vetoes recovery (${exact})`, () => {
    const snapshot = sheetScreen(
      false,
      ['Close'],
      [
        {
          ref: '@offscreen-home',
          type: 'StaticText',
          parentIndex: 2,
          identifier: 'home',
          rect: { x: 20, y: 900, width: 200, height: 40 },
        },
      ],
    );
    const carriers = snapshot.elements.filter((e) => e.testID === 'home');
    assert.equal(carriers.length, 2);
    assert.equal(carriers[0].offscreen, false);
    assert.equal(centreCovered(carriers[0], snapshot), false);
    assert.equal(carriers[1].offscreen, true);
    assert.equal(dismissCandidate(snapshot, [{ ...homeTarget, exact }]), undefined);
  });
}

for (const exact of [undefined, 'text'] as const) {
  for (const identity of [
    { label: 'Status' },
    { placeholder: 'Status' },
    { testID: 'Status' },
    {},
  ] as const) {
    test(`composed input text vetoes recovery only when uncovered (${exact}, ${JSON.stringify(identity)})`, () => {
      const quoted = `${Object.keys(identity).length ? 'Status' : 'input'}: Ready`;
      const target = { phrase: quoted, quoted, exact };
      for (const covered of [false, true]) {
        const snapshot = sheetScreen(
          true,
          ['Close'],
          [
            {
              ref: '@field',
              type: 'TextField',
              parentIndex: 2,
              label:
                'label' in identity
                  ? identity.label
                  : 'placeholder' in identity
                    ? identity.placeholder
                    : undefined,
              identifier: 'testID' in identity ? identity.testID : undefined,
              value: 'Ready',
              rect: { x: 20, y: covered ? 550 : 250, width: 200, height: 40 },
            },
          ],
        );
        if ('placeholder' in identity) {
          const field = snapshot.elements.find((e) => e.ref === '@field')!;
          delete field.label;
          field.placeholder = identity.placeholder;
        }
        assert.ok(snapshot.visibleText.includes(quoted));
        for (const targets of [[target], [{ phrase: 'absent', quoted: 'absent' }, target]]) {
          assert.deepEqual(
            dismissCandidate(snapshot, targets),
            covered ? { label: 'Close' } : undefined,
          );
        }
      }
    });
  }

  test(`input-value text vetoes recovery only when uncovered (${exact})`, () => {
    const target = { phrase: 'Ready', quoted: 'Ready', exact };
    for (const covered of [false, true]) {
      const snapshot = sheetScreen(
        true,
        ['Close'],
        [
          {
            ref: '@field',
            type: 'TextField',
            parentIndex: 2,
            label: 'Status',
            value: 'Ready',
            rect: { x: 20, y: covered ? 550 : 250, width: 200, height: 40 },
          },
        ],
      );
      const field = snapshot.elements.find((e) => e.ref === '@field')!;
      assert.equal(field.value, 'Ready');
      assert.equal(centreCovered(field, snapshot), covered);
      assert.deepEqual(
        dismissCandidate(snapshot, [target]),
        covered ? { label: 'Close' } : undefined,
      );
    }
  });
}

test('a later target covered by the scrim does not veto recovery', () => {
  assert.deepEqual(
    dismissCandidate(sheetScreen(), [{ phrase: 'absent', quoted: 'absent' }, homeTarget]),
    { label: 'Close' },
  );
});

for (const exact of [undefined, 'text'] as const) {
  for (const covered of [true, false]) {
    test(`unresolved text preserves uncertainty beside a ${covered ? 'covered' : 'visible'} occurrence (${exact})`, () => {
      const snapshot = sheetScreen(
        covered,
        ['Close'],
        [
          {
            ref: '@stale-page',
            type: 'Other',
            parentIndex: 1,
            rect: { x: -400, y: 180, width: 400, height: 600 },
          },
          {
            ref: '@stale-input',
            type: 'TextView',
            parentIndex: 4,
            label: 'Welcome Home',
            rect: { x: 24, y: 20, width: 354, height: 100 },
          },
        ],
      );
      assert.equal(
        snapshot.elements.find((e) => e.ref === '@stale-input')!.visibilityEvidence,
        'unresolved',
      );
      assert.deepEqual(snapshot.unresolvedText, ['Welcome Home']);
      const target = { phrase: 'Welcome Home', quoted: 'Welcome Home', exact };
      assert.equal(targetEvidence(target, snapshot), covered ? 'unsure' : 'pass');
      for (const quoted of ['Welcome Home', 'Home']) {
        const recoveryTarget = { phrase: quoted, quoted, exact };
        for (const targets of [
          [recoveryTarget],
          [{ phrase: 'absent', quoted: 'absent' }, recoveryTarget],
        ]) {
          const vetoes: string[] = [];
          assert.equal(
            dismissCandidate(snapshot, targets, (record) => vetoes.push(record.veto)),
            undefined,
          );
          assert.deepEqual(vetoes, [targets.length === 1 ? 'current-target' : 'later-target']);
        }
      }
      assert.equal(targetEvidence(homeTarget, snapshot), covered ? 'fail' : 'pass');
      assert.deepEqual(
        dismissCandidate(snapshot, [homeTarget]),
        covered ? { label: 'Close' } : undefined,
      );
    });
  }

  test(`a text target uses uncovered contains matches for recovery (${exact})`, () => {
    const target = { phrase: 'Home', quoted: 'Home', exact };
    assert.deepEqual(dismissCandidate(sheetScreen(), [target]), { label: 'Close' });
    assert.equal(dismissCandidate(sheetScreen(false), [target]), undefined);
  });

  test(`a structural app label does not veto recovery for covered text (${exact})`, () => {
    const snapshot = sheetScreen(true, ['Close'], [], 500);
    const app = snapshot.elements[0];
    app.label = 'Welcome Home';
    assert.equal(app.semantic?.nativePresence?.structural, true);
    assert.equal(centreCovered(app, snapshot), false);
    const target = { phrase: 'Welcome Home', quoted: 'Welcome Home', exact };
    assert.equal(targetEvidence(target, snapshot), 'fail');
    assert.deepEqual(dismissCandidate(snapshot, [target]), { label: 'Close' });
  });

  for (const type of ['Image', 'Other'] as const) {
    test(`an excluded ${type} label does not veto recovery for covered text (${exact})`, () => {
      const snapshot = sheetScreen(
        true,
        ['Close'],
        [
          {
            ref: '@excluded',
            type,
            parentIndex: 2,
            label: 'Welcome Home',
            rect: { x: 20, y: 200, width: 200, height: 40 },
          },
        ],
      );
      const excluded = snapshot.elements.find((e) => e.ref === '@excluded')!;
      assert.equal(centreCovered(excluded, snapshot), false);
      const target = { phrase: 'Welcome Home', quoted: 'Welcome Home', exact };
      assert.equal(targetEvidence(target, snapshot), 'fail');
      assert.deepEqual(dismissCandidate(snapshot, [target]), { label: 'Close' });
      assert.deepEqual(
        dismissCandidate(snapshot, [{ phrase: 'absent', quoted: 'absent' }, target]),
        { label: 'Close' },
      );
    });
  }
}

test('a covered target with two decline controls still refuses as ambiguous', () => {
  const candidate = dismissCandidate(sheetScreen(true, ['Close', 'Not now']), [homeTarget]);
  assert.ok(candidate && 'refuse' in candidate);
  assert.equal(candidate.refuse.code, 'INTERRUPTION_AMBIGUOUS');
});

for (const exact of [undefined, 'text'] as const) {
  test(`a text wait rejects proven coverage and preserves uncovered evidence (${exact})`, () => {
    const target = { phrase: 'Welcome Home', quoted: 'Welcome Home', exact };
    assert.equal(targetEvidence(target, sheetScreen()), 'fail');
    assert.equal(targetEvidence(target, sheetScreen(false)), 'pass');
    const unknown = screen('app', {
      visibleText: ['Welcome Home'],
      coverage: { native: 'complete', react: 'complete' },
      elements: [{ ...sheetScreen().elements[3] }],
    });
    assert.equal(centreCovered(unknown.elements[0], unknown), false);
    assert.equal(targetEvidence(target, unknown), 'pass');
  });

  test(`a composed-input wait rejects only proven coverage (${exact})`, () => {
    const target = { phrase: 'Status: Ready', quoted: 'Status: Ready', exact };
    for (const covered of [true, false]) {
      const snapshot = sheetScreen(
        true,
        ['Close'],
        [
          {
            ref: '@field',
            type: 'TextField',
            parentIndex: 2,
            label: 'Status',
            value: 'Ready',
            rect: { x: 20, y: covered ? 550 : 250, width: 200, height: 40 },
          },
        ],
      );
      assert.equal(targetEvidence(target, snapshot), covered ? 'fail' : 'pass');
    }
  });
}

test('an uncovered text occurrence still satisfies a wait with a covered twin', () => {
  const snapshot = sheetScreen(
    true,
    ['Close'],
    [
      {
        ref: '@uncovered-home',
        type: 'StaticText',
        parentIndex: 2,
        label: 'Welcome Home',
        rect: { x: 20, y: 200, width: 200, height: 40 },
      },
    ],
  );
  const target = { phrase: 'Welcome Home', quoted: 'Welcome Home' };
  assert.equal(targetEvidence(target, snapshot), 'pass');
  assert.throws(() => targetEvidence({ ...target, exact: 'text' }, snapshot), /TARGET_AMBIGUOUS/);
});

for (const [kind, quoted] of [
  ['an id', 'home'],
  ['text', 'Welcome Home'],
] as const) {
  test(`a wait for ${kind} behind the scrim dismisses Close once and then passes`, async () => {
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
    const result = await runPlan(parsePlan(`1. Wait for "${quoted}"`).blocks!, f.deps);
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
}
