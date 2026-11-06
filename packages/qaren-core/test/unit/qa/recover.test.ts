import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dismissCandidate,
  plannedSurface,
  protectionLapses,
  recover,
  soleDecline,
  surfaceGone,
} from '../../../dist/qa/recover.js';
import type {
  InterruptionDiagnostic,
  RecoverDeps,
  RecoveryTarget,
} from '../../../dist/qa/recover.js';
import {
  ancestorsOf,
  hostAssociationIdentity,
  join,
  modalCoverDiagnostic,
  type Element,
  type NativeNode,
  type ReactHostEvidence,
  type Screen,
} from '../../../dist/qa/screen.js';
import { centreCovered, targetEvidence } from '../../../dist/qa/resolve.js';
import { parsePlan, type Target } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { element, screen as fixtureScreen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { modalOverHome } from './modal-fixtures.ts';

test('protection lapse distinguishes static decline text from possible decline controls', () => {
  const cases = [
    ['text', 'unsupported', true],
    ['input', 'unsupported', true],
    ['text', 'supported', false],
    ['text', 'unknown', false],
    ['button', 'unsupported', false],
    ['link', 'unsupported', false],
    ['cell', 'unsupported', false],
    ['switch', 'unsupported', false],
  ] as const;
  for (const [kind, press, lapses] of cases) {
    const later = element('@later', 'Later', {
      kind,
      semantic: { press, fill: 'unsupported', visibility: 'visible' },
    });
    assert.equal(protectionLapses(fixtureScreen([later])), lapses, `${kind}: ${press}`);
    assert.equal(protectionLapses(fixtureScreen([{ ...later, offscreen: true }])), true);
  }
});

test('described remaining targets conservatively veto even sole declines', () => {
  const snapshot = fixtureScreen([element('@close', 'Close')]);
  for (const kind of ['press', 'fill', 'wait', 'scroll', 'check'] as const) {
    const records: InterruptionDiagnostic[] = [];
    assert.equal(
      dismissCandidate(
        snapshot,
        [
          { quoted: 'Ready', phrase: 'Ready', line: 1, kind: 'wait' },
          { phrase: 'the allow button', line: 2, kind },
        ],
        (record) => records.push(record),
      ),
      undefined,
    );
    assert.equal(records[0]?.veto, 'later-target');
    assert.equal(records[0]?.targetIndex, 1);
  }
});

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
  for (const before of [
    undefined,
    screen('app'),
    { ...at(), coverage: { native: 'incomplete', react: 'complete' } } as Screen,
    { ...at(), reactHostEvidence: undefined },
  ]) {
    assert.equal(surfaceGone(at(), plannedSurface(at('consent'), before)), false);
  }
  assert.equal(surfaceGone(at(), plannedSurface(at('consent'), at('consent'))), false);

  assert.equal(surfaceGone(at('consent'), surface), false);
  assert.equal(surfaceGone(at('offer'), surface), true);
  assert.equal(surfaceGone(at(), surface), true);
  assert.equal(surfaceGone(at(), plannedSurface(at(), at('consent'))), false);
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
      dismissCandidate(snapshot, [absent, { phrase: 'Offer', quoted: 'Offer', exact }], (record) =>
        records.push(...record.elements.map((e) => e.failed)),
      ),
      undefined,
    );
    assert.deepEqual(records, exact === 'id' ? [] : ['target-ancestor']);
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
        { phrase: quoted, quoted, exact },
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
      { phrase: 'qa-sheet', quoted: 'qa-sheet' },
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
        { phrase: 'qa-sheet-home', quoted: 'qa-sheet-home', exact: 'id' },
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

// A full-screen promo: one Close control over promotional copy, while the step waits for "Home".
function fullScreenPromo(...extra: NativeNode[]): Screen {
  const rect = { x: 0, y: 0, width: 402, height: 874 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect },
    { ref: '@window', type: 'Window', parentIndex: 0, rect },
    {
      ref: '@close',
      type: 'Button',
      parentIndex: 1,
      identifier: 'promo-close',
      label: 'Close',
      hittable: true,
      rect: { x: 340, y: 70, width: 40, height: 30 },
    },
    {
      ref: '@title',
      type: 'StaticText',
      parentIndex: 1,
      identifier: 'promo-title',
      label: 'Save 50% on Premium today',
      rect: { x: 20, y: 300, width: 360, height: 40 },
    },
    {
      ref: '@body',
      type: 'StaticText',
      parentIndex: 1,
      label: 'Offer ends soon',
      rect: { x: 20, y: 360, width: 360, height: 30 },
    },
    ...extra.map((node, index) => ({
      parentIndex: 1,
      rect: { x: 20, y: 420 + index * 50, width: 360, height: 40 },
      ...node,
    })),
  ];
  return join(
    nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { hosts: [], complete: true },
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
  );
}
const waitHome: RecoveryTarget = { phrase: 'Home', quoted: 'Home', kind: 'wait', line: 7 };
const later = (
  quoted: string,
  kind: NonNullable<RecoveryTarget['kind']>,
  extra: Partial<RecoveryTarget> = {},
): RecoveryTarget => ({ phrase: quoted, quoted, kind, line: 9, ...extra });
const decide = (snapshot: Screen, targets: RecoveryTarget[]) => {
  const records: InterruptionDiagnostic[] = [];
  return {
    result: dismissCandidate(snapshot, targets, (record) => records.push(record)),
    records,
  };
};

test('a later press or fill matching promo copy does not keep a sole-Close promo up', () => {
  for (const kind of ['press', 'fill'] as const) {
    const { result, records } = decide(fullScreenPromo(), [waitHome, later('Premium', kind)]);
    assert.deepEqual(result, { label: 'Close' }, kind);
    assert.deepEqual(records, [], kind);
  }
});

test('a later-block press or a described tap matching promo copy still keeps it', () => {
  for (const target of [
    later('Premium', 'press', { laterBlock: true }),
    { phrase: 'the premium offer', line: 9, kind: 'press' as const },
  ]) {
    const { result, records } = decide(fullScreenPromo(), [waitHome, target]);
    assert.equal(result, undefined, target.phrase);
    assert.equal(records[0]?.veto, 'later-target', target.phrase);
  }
});

test('a later wait or check on promo copy still vetoes by presence', () => {
  for (const kind of ['wait', 'check'] as const) {
    const { result, records } = decide(fullScreenPromo(), [waitHome, later('Premium', kind)]);
    assert.equal(result, undefined, kind);
    assert.deepEqual(
      records.map(({ veto, targetIndex, provenance, soleDecline }) => ({
        veto,
        targetIndex,
        provenance,
        soleDecline,
      })),
      [{ veto: 'later-target', targetIndex: 1, provenance: 'presence', soleDecline: true }],
      kind,
    );
  }
});

test('a later same-block press on the container of the sole Close still keeps it', () => {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application' },
    { ref: '@window', type: 'Window', parentIndex: 0 },
    { ref: '@sheet', type: 'Other', parentIndex: 1, identifier: 'promo-sheet' },
    { ref: '@close', type: 'Button', parentIndex: 2, label: 'Close', hittable: true },
  ];
  const snapshot = join(
    nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { hosts: [], complete: true },
    {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    },
  );
  const { result, records } = decide(snapshot, [
    waitHome,
    later('promo-sheet', 'press', { exact: 'id' }),
  ]);
  assert.equal(result, undefined);
  assert.deepEqual(
    records.map(({ veto, soleDecline, elements }) => ({ veto, soleDecline, elements })),
    [
      {
        veto: 'no-candidate',
        soleDecline: true,
        elements: [{ index: 3, failed: 'target-ancestor' }],
      },
    ],
  );
});

test('a later press by the testID of promo text is a coincidence, not ownership', () => {
  const { result } = decide(fullScreenPromo(), [
    waitHome,
    later('promo-title', 'press', { exact: 'id' }),
  ]);
  assert.deepEqual(result, { label: 'Close' });
});

test('a later step naming Close by label or id keeps it, with ownership provenance', () => {
  for (const target of [
    later('Close', 'press'),
    later('Close', 'check'),
    later('promo-close', 'press', { exact: 'id' }),
    later('promo-close', 'wait', { exact: 'id' }),
  ]) {
    const { result, records } = decide(fullScreenPromo(), [waitHome, target]);
    assert.equal(result, undefined, target.quoted);
    assert.equal(records.length, 1, target.quoted);
    assert.equal(records[0].veto, 'later-target');
    assert.equal(records[0].provenance, 'ownership');
    assert.equal(records[0].targetIndex, 1);
  }
});

test('later ID targets own the decline for every step kind with one or multiple controls', () => {
  const second: NativeNode = {
    ref: '@continue',
    type: 'Button',
    label: 'Continue',
    hittable: true,
  };
  for (const extra of [[], [second]]) {
    for (const kind of ['wait', 'check', 'press', 'fill'] as const) {
      const { result, records } = decide(fullScreenPromo(...extra), [
        waitHome,
        later('promo-close', kind, { exact: 'id' }),
      ]);
      assert.equal(result, undefined, kind);
      assert.equal(records.length, 1, kind);
      assert.equal(records[0].veto, 'later-target', kind);
      assert.equal(records[0].provenance, 'ownership', kind);
      assert.equal(records[0].targetIndex, 1, kind);
      assert.equal(records[0].soleDecline, extra.length === 0, kind);
    }
  }
});

test('a later wait or check on decline-labelled static text vetoes by presence', () => {
  const copy: NativeNode = {
    ref: '@copy',
    type: 'StaticText',
    identifier: 'promo-copy',
    label: 'Close',
  };
  for (const kind of ['wait', 'check'] as const) {
    const { result, records } = decide(fullScreenPromo(copy), [
      waitHome,
      later('promo-copy', kind, { exact: 'id' }),
    ]);
    assert.equal(result, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].veto, 'later-target');
    assert.equal(records[0].targetIndex, 1);
    assert.equal(records[0].provenance, 'presence');
  }
});

test('unassociated press or fill hosts keep a later custom control protected by presence', () => {
  const nodes: NativeNode[] = [
    { ref: '@close', type: 'Button', label: 'Close', hittable: true },
    { ref: '@continue', type: 'Other', label: 'Continue', hittable: true },
  ];
  for (const capability of ['press', 'fill'] as const) {
    const snapshot = join(
      nodes,
      [],
      'app',
      { native: 'complete', react: 'complete' },
      {
        complete: true,
        hosts: [
          {
            testID: 'unassociated-control',
            role: null,
            roleSource: 'none',
            capabilities: { [capability]: true },
          },
        ],
      },
      {
        source: 'xcui-live',
        nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
      },
    );
    assert.equal(snapshot.elements[0].semantic?.press, 'supported');
    assert.equal(snapshot.elements[1].semantic?.[capability], 'unknown');
    assert.equal(snapshot[capability === 'press' ? 'pressGapCount' : 'fillGapCount'], 1);
    const { result, records } = decide(snapshot, [waitHome, later('Continue', 'press')]);
    assert.equal(result, undefined);
    assert.equal(records.length, 1);
    assert.equal(records[0].veto, 'later-target');
    assert.equal(records[0].targetIndex, 1);
    assert.equal(records[0].provenance, 'presence');
    assert.equal(records[0].soleDecline, false);
  }
});

test('association gaps and unknown on-screen capabilities cannot prove a sole decline', () => {
  const snapshot = fullScreenPromo();
  assert.equal(soleDecline(snapshot), true);
  for (const gap of [
    { pressEvidenceGap: 'React host evidence incomplete' },
    { pressGapCount: 1 },
    { fillGapCount: 1 },
  ])
    assert.equal(soleDecline({ ...snapshot, ...gap }), false);
  for (const capability of ['press', 'fill'] as const) {
    const uncertain = snapshot.elements.map((element) =>
      element.ref === '@title'
        ? { ...element, semantic: { ...element.semantic!, [capability]: 'unknown' as const } }
        : element,
    );
    assert.equal(soleDecline({ ...snapshot, elements: uncertain }), false);
    assert.equal(
      soleDecline({
        ...snapshot,
        elements: uncertain.map((element) =>
          element.ref === '@title' ? { ...element, offscreen: true } : element,
        ),
      }),
      true,
    );
  }
});

test('a second control in any state remains protected by its later target', () => {
  const input: NativeNode = { ref: '@email', type: 'TextField', label: 'Email', hittable: true };
  const button: NativeNode = { ref: '@go', type: 'Button', label: 'Continue', hittable: true };
  for (const [extra, target] of [
    [input, later('Email', 'fill')],
    [{ ...button, enabled: false }, later('Continue', 'press')],
    [button, later('Continue', 'press')],
  ] as const) {
    const { result, records } = decide(fullScreenPromo(extra), [waitHome, target]);
    assert.equal(result, undefined, target.quoted);
    assert.equal(records[0].provenance, 'presence', target.quoted);
    assert.equal(records[0].soleDecline, false, target.quoted);
  }
});

test('six decline carriers around one actionable Close still protect a later-block Close step', () => {
  const carriers = Array.from(
    { length: 5 },
    (_, index): NativeNode => ({ ref: `@label${index}`, type: 'StaticText', label: 'Close' }),
  );
  const { result, records } = decide(fullScreenPromo(...carriers), [
    waitHome,
    later('Close', 'press'),
  ]);
  assert.equal(result, undefined);
  assert.equal(records[0].exactDeclineCount, 6);
  assert.equal(records[0].provenance, 'ownership');
});

test('uncertain current-target evidence on a sole-Close promo still vetoes', () => {
  const { result, records } = decide({ ...fullScreenPromo(), unresolvedText: ['Home'] }, [
    waitHome,
    later('Premium', 'press'),
  ]);
  assert.equal(result, undefined);
  assert.equal(records[0].veto, 'current-target');
});

test('a press that opened the promo still withholds the decline', () => {
  const { result, records } = decide(fullScreenPromo(), [{ ...waitHome, afterPlannedPress: true }]);
  assert.equal(result, undefined);
  assert.equal(records[0].veto, 'previous-plan-press');
});

test('Home Pressables behind a presented sole-Close modal do not defeat the sole decline', () => {
  const snapshot = modalOverHome();
  assert.equal(snapshot.pressGapCount, 0);
  assert.equal(snapshot.pressEvidenceGap, undefined);
  assert.equal(soleDecline(snapshot), true);
  const waitTarget: RecoveryTarget = {
    phrase: 'qa-promo-home-target',
    quoted: 'qa-promo-home-target',
    exact: 'id',
    kind: 'wait',
    line: 11,
  };
  const { result, records } = decide(snapshot, [waitTarget, later('See Pro offers', 'press')]);
  assert.deepEqual(result, { label: 'Close' });
  assert.deepEqual(records, []);
  const observed = decide(snapshot, [waitTarget, later('See Pro offers', 'check')]);
  assert.equal(observed.result, undefined);
  assert.equal(observed.records[0].veto, 'later-target');
  assert.equal(observed.records[0].provenance, 'presence');
});

test('Home Pressables still count as gaps without a presented modal or with Home native', () => {
  // Without a modal the promo's covered React ancestor still applies, so even Close stays unproven.
  assert.equal(modalOverHome({ modalType: 'RCTView' }).pressGapCount, 3);
  // Native showing Home means the modal does not cover it, so the unmatched offer stays a gap.
  assert.equal(modalOverHome({ homeNative: true }).pressGapCount, 1);
  for (const options of [{ modalType: 'RCTView' }, { homeNative: true }])
    assert.equal(soleDecline(modalOverHome(options)), false, JSON.stringify(options));
});

test('a second control inside the presented modal still defeats the sole decline', () => {
  const snapshot = modalOverHome({ secondControl: true });
  assert.equal(snapshot.pressGapCount, 0);
  assert.equal(soleDecline(snapshot), false);
});

test('a rejection names which modal-cover condition failed, with counts', () => {
  const facts = (screen: Screen) => {
    const { refused, modalCount, associatedCount, associatedOutside, modalTypes } =
      modalCoverDiagnostic(screen)!;
    return { refused, modalCount, associatedCount, associatedOutside, modalTypes };
  };
  assert.deepEqual(facts(modalOverHome()), {
    refused: undefined,
    modalCount: 1,
    associatedCount: 2,
    associatedOutside: 0,
    modalTypes: ['RCTModalHostView'],
  });
  assert.equal(modalCoverDiagnostic(modalOverHome())!.identities.matched, 2);
  assert.deepEqual(facts(modalOverHome({ modalType: 'ModalHostView' })), {
    refused: 'modal-count',
    modalCount: 0,
    associatedCount: 0,
    associatedOutside: 0,
    modalTypes: ['ModalHostView'],
  });
  assert.deepEqual(facts(modalOverHome({ homeNative: true })), {
    refused: 'associated-outside',
    modalCount: 1,
    associatedCount: 4,
    associatedOutside: 2,
    modalTypes: ['RCTModalHostView'],
  });
  const { records } = decide(modalOverHome({ homeNative: true }), [
    { phrase: 'qa-promo-home-target', quoted: 'qa-promo-home-target', kind: 'wait', line: 12 },
  ]);
  assert.equal(records[0].cover?.refused, 'associated-outside');
  assert.doesNotMatch(JSON.stringify(records), /qa-|Close|Target|Pro offer/);
});

// A mid-walk opt-in: copy, one soft decline and one accepting control.
const optIn = (decline = 'Skip', accept = 'Yes, notify me', ...extra: Element[]): Screen =>
  fixtureScreen([
    element('@title', 'Never miss an update', { kind: 'text', testID: 'optin-title' }),
    element('@decline', decline),
    element('@accept', accept),
    ...extra,
  ]);
const afterPress: RecoveryTarget = { ...waitHome, afterPlannedPress: true };

test('permission shape labels a permitted decline but never overrides planned press protection', () => {
  for (const [decline, accept] of [
    ['Skip', 'Yes, notify me'],
    ['Skip', 'Yes, notify me about all updates'],
    ['Not now', 'Allow notifications'],
    ["Don't allow", 'Allow'],
    ['Don’t allow', 'Enable'],
    ['Maybe later', 'Turn on'],
  ]) {
    const snapshot = optIn(decline, accept);
    assert.deepEqual(decide(snapshot, [waitHome]).result, {
      label: decline,
      screenClass: 'permission-opt-in',
    });
    const { result, records } = decide(snapshot, [afterPress]);
    assert.equal(result, undefined);
    assert.equal(records[0]?.veto, 'previous-plan-press');
  }
});

test('the closed accept-all list keeps every decline outside protection too', () => {
  for (const accept of ['Allow all', 'aCcEpT aLl', 'Agree to all', 'ENABLE ALL']) {
    for (const decline of ['Skip', 'Close', 'Not now', 'Later', "Don't allow", 'Don’t allow']) {
      assert.equal(decide(optIn(decline, accept), [waitHome]).result, undefined);
    }
  }
});

test('a recognised opt-in is a separate surface for a missing tap target', () => {
  const missing: RecoveryTarget = {
    phrase: 'Settings',
    quoted: 'Settings',
    kind: 'press',
    line: 7,
  };
  assert.deepEqual(dismissCandidate(optIn(), [missing], undefined, 'surface'), {
    label: 'Skip',
    screenClass: 'permission-opt-in',
  });
  // Two controls without the opt-in shape still prove no surface.
  assert.equal(
    dismissCandidate(optIn('Skip', 'View all offers'), [missing], undefined, 'surface'),
    undefined,
  );
});

test('non-permission shapes gain no receipt class', () => {
  for (const accept of [
    'Agree',
    'Continue',
    'Accept',
    'View all offers',
    'Yes, do not notify me',
  ]) {
    assert.deepEqual(decide(optIn('Skip', accept), [waitHome]).result, { label: 'Skip' });
  }
});

// A sheet whose modal container `sheet` holds the Close control `sheet-close`.
function presented(
  options: {
    modalId?: string;
    closeId?: string;
    closeInside?: boolean;
    extraModal?: string;
  } = {},
): Screen {
  const { modalId = 'sheet', closeId = 'sheet-close', closeInside = true, extraModal } = options;
  const node = (hostIndex: number, parentHostIndex: number | null, hostType: string) => ({
    hostIndex,
    parentHostIndex,
    rootIndex: 0,
    hostType,
    text: { kind: 'none' as const },
  });
  const host = (testID?: string) => ({
    ...(testID ? { testID } : {}),
    role: null,
    roleSource: 'none' as const,
    capabilities: {},
  });
  return {
    ...fixtureScreen([
      element('@title', 'What is new', { kind: 'text', testID: 'sheet-title' }),
      element('@close', 'Close', closeId ? { testID: closeId } : {}),
    ]),
    reactHostEvidence: {
      complete: true,
      hosts: [host(modalId), host(closeId), ...(extraModal ? [host(extraModal)] : [])],
      typography: {
        version: 1,
        complete: true,
        durationMs: 0,
        coordinateSpace: 'window-points',
        nodes: [
          node(0, null, 'RCTModalHostView'),
          node(1, closeInside ? 0 : null, 'View'),
          ...(extraModal ? [node(2, null, 'RCTModalHostView')] : []),
        ],
      },
    },
  };
}
const key = (id: string) => JSON.stringify(['RCTModalHostView', id]);

test('a new identified sheet over a retained modal never overrides planned press protection', () => {
  const { result, records } = decide(presented({ extraModal: 'home' }), [afterPress]);
  assert.equal(result, undefined);
  assert.equal(records[0]?.veto, 'previous-plan-press');
  assert.deepEqual(decide(presented({ extraModal: 'home' }), [waitHome]).result, {
    label: 'Close',
  });
});

test('only departure of the identified planned destination releases protection', () => {
  const surface = plannedSurface(presented(), presented({ modalId: 'before' }));
  assert.deepEqual(surface, { container: key('sheet') });
  assert.equal(surfaceGone(presented({ extraModal: 'home' }), surface), false);
  assert.equal(surfaceGone(presented({ modalId: 'other' }), surface), true);
  assert.equal(surfaceGone(presented(), plannedSurface(fixtureScreen([]))), false);
});
