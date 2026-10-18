import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  join,
  semanticActionView,
  visibilityView,
  type NativeNode,
  type Screen,
} from '../../../dist/qa/screen.js';
import { decideScreen, MAX_CANDIDATES } from '../../../dist/qa/resolve.js';
import { scriptedJudge } from './judgment-fixtures.ts';

type Status = 'observed' | 'unknown';
type LabelSource = 'none' | 'descendant' | 'direct';
interface Row {
  type: string;
  labelSource: LabelSource;
  status: Status;
  window: 'main' | 'other' | 'keyboard';
  node?: Partial<NativeNode>;
}

const screenRect = { x: 0, y: 0, width: 402, height: 874 };
const keyboardRect = { x: 0, y: 560, width: 402, height: 314 };
const at = (y: number, height = 40, x = 24, width = 354) => ({ x, y, width, height });
const row = (
  type: string,
  labelSource: LabelSource,
  status: Status,
  window: Row['window'],
  node: Partial<NativeNode> = {},
): Row => ({ type, labelSource, status, window, node });
const times = (count: number, make: () => Row) => Array.from({ length: count }, make);
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'Delete'];

// The live sparse OTP capture after a 2-of-4 fill: app window, a second app window and the keyboard window.
function liveRows(extra: Row[] = []): Row[] {
  return [
    row('Application', 'direct', 'unknown', 'main', { rect: screenRect, label: 'Test App' }),
    row('Window', 'none', 'unknown', 'main', { rect: screenRect }),
    ...times(16, () => row('Other', 'none', 'unknown', 'main', { rect: screenRect })),
    ...times(8, () => row('Other', 'descendant', 'unknown', 'main', { rect: screenRect })),
    row('NavigationBar', 'descendant', 'observed', 'main', { rect: at(50, 44, 0, 402) }),
    row('Button', 'direct', 'observed', 'main', { rect: at(54, 36, 8, 60), label: 'Back' }),
    row('StaticText', 'direct', 'observed', 'main', {
      rect: at(60, 24, 150, 100),
      label: 'OTP code',
    }),
    row('Other', 'none', 'observed', 'main', {
      rect: at(110, 400),
      identifier: 'qa-otp-sparse-view',
    }),
    row('StaticText', 'direct', 'observed', 'main', {
      rect: at(120, 56, 24, 48),
      identifier: 'qa-otp-box-1',
      label: '4',
    }),
    row('StaticText', 'direct', 'observed', 'main', {
      rect: at(120, 56, 84, 48),
      identifier: 'qa-otp-box-2',
      label: '8',
    }),
    row('StaticText', 'none', 'observed', 'main', {
      rect: at(120, 56, 144, 48),
      identifier: 'qa-otp-box-3',
    }),
    row('StaticText', 'none', 'observed', 'main', {
      rect: at(120, 56, 204, 48),
      identifier: 'qa-otp-box-4',
    }),
    row('TextField', 'direct', 'observed', 'main', {
      rect: at(190),
      identifier: 'qa-otp-mirrored-input',
      label: 'Code',
      value: '48',
    }),
    row('StaticText', 'direct', 'observed', 'main', { rect: at(240, 20), label: 'Code 48' }),
    row('StaticText', 'direct', 'observed', 'main', { rect: at(264, 20), label: '48' }),
    row('StaticText', 'direct', 'observed', 'main', { rect: at(288, 20), label: 'Step 4 of 8' }),
    row('StaticText', 'direct', 'observed', 'main', { rect: at(312, 20), label: '148' }),
    row('Button', 'direct', 'observed', 'main', {
      rect: at(350, 44),
      identifier: 'qa-otp-verify',
      label: 'Verify',
    }),
    ...extra,
    row('Window', 'none', 'unknown', 'other', { rect: screenRect }),
    ...times(4, () => row('Other', 'none', 'unknown', 'other', { rect: screenRect })),
    row('Window', 'none', 'unknown', 'keyboard', { rect: keyboardRect }),
    row('Keyboard', 'descendant', 'unknown', 'keyboard', { rect: keyboardRect }),
    ...times(3, () => row('Other', 'none', 'unknown', 'keyboard', { rect: keyboardRect })),
    ...times(5, () => row('Other', 'descendant', 'unknown', 'keyboard', { rect: keyboardRect })),
    row('Other', 'descendant', 'observed', 'keyboard', { rect: at(600, 250, 0, 402) }),
    ...keys.map((label, i) =>
      row('Key', 'direct', 'observed', 'keyboard', {
        rect: at(600 + Math.floor(i / 3) * 56, 50, (i % 3) * 134, 130),
        label,
      }),
    ),
    row('Key', 'none', 'observed', 'keyboard', { rect: at(768, 50, 268, 130) }),
    row('StaticText', 'none', 'unknown', 'keyboard', { rect: at(570, 24, 10, 100) }),
    row('Button', 'direct', 'observed', 'keyboard', { rect: at(564, 36, 330, 60), label: 'Done' }),
  ];
}

const interactiveHosts = [
  { role: 'button', roleSource: 'role', testID: 'qa-otp-verify', capabilities: { press: true } },
  {
    role: null,
    roleSource: 'none',
    testID: 'qa-otp-mirrored-input',
    capabilities: { press: true, fill: true },
  },
] as const;

function capture(rows: Row[], hosts: readonly object[] = interactiveHosts, digest: object[] = []) {
  const windows: Partial<Record<Row['window'], number>> = {};
  rows.forEach((r, i) => {
    if (r.type === 'Window') windows[r.window] = i;
  });
  const nodes = rows.map((r, i) => ({
    ref: `@n${i}`,
    type: r.type,
    enabled: true,
    hittable: ['Button', 'TextField', 'Key'].includes(r.type),
    ...(i === 0 ? {} : { parentIndex: r.type === 'Window' ? 0 : windows[r.window] }),
    ...r.node,
  })) as NativeNode[];
  return join(
    nodes,
    digest as never,
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      hosts: hosts as never,
      typography: {
        version: 1,
        complete: true,
        durationMs: 1,
        coordinateSpace: 'window-points',
        nodes: [],
      },
    } as never,
    {
      source: 'xcui-live',
      nodes: rows.map((r) => ({ status: r.status, labelSource: r.labelSource })),
    } as never,
  );
}

function projected(screen: Screen) {
  const view = visibilityView(screen);
  assert.ok(!('refuse' in view), JSON.stringify(view));
  return view;
}

async function check(screen: Screen, text: string, noul: number) {
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((id) => [id, { type: 'noul', noul }])),
  );
  const decision = await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text,
    line: 1,
  });
  const request = judge.requests.find(
    (r) => (r.state as { assertionEvidence?: unknown } | undefined)?.assertionEvidence,
  );
  return {
    check: decision.check,
    evidence: (
      request?.state as { assertionEvidence?: { observed: unknown[]; unknown: unknown[] } }
    )?.assertionEvidence,
  };
}

test('a screen-wide capability gap does not make content-free containers assertion candidates', async () => {
  const screen = capture(liveRows());
  assert.equal(screen.pressEvidenceGap, '2 interactive React hosts unassociated');
  const view = projected(screen);
  assert.equal(MAX_CANDIDATES, 30);
  assert.equal(view.elements.length, 11);
  assert.equal(view.unknown.length, 16);
  assert.equal(view.capabilityGapContainers, 39);
  const kept = view.unknown.map(({ element, reason }) => [element.nativeKind, reason]);
  assert.equal(
    kept.filter(([kind, reason]) => kind === 'other' && reason === 'content').length,
    12,
  );
  assert.deepEqual(
    view.unknown
      .filter(({ element }) => element.testID?.startsWith('qa-otp-box-'))
      .map(({ element, reason }) => [element.testID, reason]),
    [
      ['qa-otp-box-3', 'content'],
      ['qa-otp-box-4', 'content'],
    ],
  );
  const reached = await check(screen, 'The screen shows Verify and Step 4 of 8', 0.99);
  assert.equal(reached.check, 'pass');
  assert.equal(reached.evidence?.observed.length, 11);
  assert.equal(reached.evidence?.unknown.length, 16);
});

test('the capability gap still leaves action projections and element capabilities unchanged', () => {
  const screen = capture(liveRows());
  for (const kind of ['press', 'fill'] as const) {
    const { diagnostic, ...refusal } = semanticActionView(screen, kind) as {
      diagnostic?: unknown;
    };
    assert.deepEqual(refusal, {
      refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
      reason: `an observation has unknown ${kind} capability (@n2, other${kind === 'press' ? '; 2 interactive React hosts unassociated' : ''})`,
    });
    assert.ok(diagnostic, 'the refusal carries its value-free blocker diagnostic');
  }
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
});

test('containers with their own content or local press evidence stay assertion contributions', () => {
  const rows = liveRows([
    row('Other', 'direct', 'unknown', 'main', { rect: at(420), label: 'Resend in 30s' }),
    row('Other', 'none', 'unknown', 'main', { rect: at(470), identifier: 'qa-otp-resend' }),
  ]);
  const screen = capture(rows, interactiveHosts, [
    { role: 'button', testID: 'qa-otp-resend', capabilities: { press: true, fill: false } },
  ]);
  const view = projected(screen);
  const ids = view.unknown.map(({ element }) => element.label ?? element.testID);
  assert.ok(ids.includes('Resend in 30s'), JSON.stringify(ids));
  assert.ok(ids.includes('qa-otp-resend'), JSON.stringify(ids));
  assert.equal(view.capabilityGapContainers, 39);
});

test('positive and negative judgments keep their uncertainty after the gap containers leave', async () => {
  const screen = capture(liveRows());
  assert.equal((await check(screen, 'The screen shows Done', 0.01)).check, 'unsure');
  assert.equal((await check(screen, 'The screen does not show Resend', 0.99)).check, 'pass');
  assert.equal((await check(screen, 'The screen does not show Resend', 0.5)).check, 'unsure');
});

test('the capability gap alone keeps a rejected claim uncertain', async () => {
  const sole = (hosts: readonly object[]) =>
    capture(
      [
        row('Application', 'direct', 'unknown', 'main', { rect: screenRect, label: 'Test App' }),
        row('Window', 'none', 'unknown', 'main', { rect: screenRect }),
        ...times(3, () => row('Other', 'none', 'unknown', 'main', { rect: screenRect })),
        row('Button', 'direct', 'observed', 'main', { rect: at(350, 44), label: 'Verify' }),
      ],
      hosts,
    );
  const gap = sole([{ role: 'button', roleSource: 'role', capabilities: { press: true } }]);
  assert.equal(gap.pressEvidenceGap, '1 interactive React host unassociated');
  const gapView = projected(gap);
  assert.deepEqual([gapView.elements.length, gapView.unknown.length], [1, 0]);
  assert.equal(gapView.capabilityGapContainers, 3);
  assert.equal((await check(gap, 'The screen shows Done', 0.01)).check, 'unsure');

  const clean = sole([]);
  assert.equal(clean.pressEvidenceGap, undefined);
  assert.equal(projected(clean).capabilityGapContainers, undefined);
  assert.equal((await check(clean, 'The screen shows Done', 0.01)).check, 'fail');
});
