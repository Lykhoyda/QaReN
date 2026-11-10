// Cover naming follows the proven React touch owner.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { captureScreen, CaptureDeadline } from '../../../dist/qa/capture.js';
import { capturePrivateScreen } from '../../../dist/qa/privacy.js';
import { centreCovered, coverOwner } from '../../../dist/qa/resolve.js';
import { dismissCandidate } from '../../../dist/qa/recover.js';
import { hostAssociationIdentity, join, touchOwnerAt } from '../../../dist/qa/screen.js';
import type { ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = { x: number; y: number; width: number; height: number };
type PointerEvents = 'auto' | 'none' | 'box-none' | 'box-only';
interface View {
  id: string;
  type: string;
  rect: Rect;
  // Index of the parent React view; absent is the screen root.
  parent?: number;
  pointerEvents?: PointerEvents;
  label?: string;
}

const ROW: Rect = { x: 21, y: 255, width: 360, height: 56 };
const COVER: Rect = { x: 0, y: 110, width: 402, height: 201 };
const INSET: Rect = { x: 0, y: 116, width: 402, height: 758 };
const FULL: Rect = { x: 0, y: 0, width: 402, height: 874 };

// The header-inset sticky case: a row in its scroll list, then a box-none layout holding the sticky
// cover, then the pointer-transparent full-screen and inset views drawn last.
const sticky = (cover: PointerEvents = 'auto'): View[] => [
  { id: '', type: 'ScrollView', rect: { x: 0, y: 206, width: 402, height: 668 } },
  { id: 'qa-hi-row-1', type: 'Button', rect: ROW, parent: 0, label: 'Row 1' },
  {
    id: 'qa-hi-layout',
    type: 'Other',
    rect: { x: 0, y: 110, width: 402, height: 764 },
    pointerEvents: 'box-none',
  },
  {
    id: 'qa-hi-cover',
    type: 'Button',
    rect: COVER,
    parent: 2,
    pointerEvents: cover,
    label: 'Cover control',
  },
  { id: 'qa-hi-later-full-1', type: 'Other', rect: FULL, pointerEvents: 'none' },
  { id: 'qa-hi-later-inset', type: 'Other', rect: INSET, pointerEvents: 'none' },
];

async function capture(
  views: View[],
  // presence: false is an ordinary capture, which carries no native presence and no React typography.
  options: { hosts?: boolean; order?: boolean; presence?: boolean; secondRoot?: boolean } = {},
): Promise<Screen> {
  const {
    hosts = true,
    order = true,
    presence: platformPresence = true,
    secondRoot = false,
  } = options;
  const base = nativeCapture();
  const presence = (index: number) => ({ ...base.nodes[1].presence, nodeIndex: index });
  const nodes: Record<string, unknown>[] = [
    { ...base.nodes[0], rect: FULL },
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      enabled: true,
      hittable: true,
      rect: FULL,
      presence: presence(1),
    },
  ];
  // Native nodes follow the React nesting, in capture order.
  views.forEach((view, i) => {
    const parentIndex = view.parent === undefined ? 1 : view.parent + 2;
    nodes.push({
      ref: `@e${i + 2}`,
      index: i + 2,
      depth: (nodes[parentIndex].depth as number) + 1,
      parentIndex,
      type: view.type,
      identifier: view.id,
      ...(view.label ? { label: view.label } : {}),
      enabled: true,
      hittable: true,
      rect: view.rect,
      presence: presence(i + 2),
    });
  });
  if (!platformPresence) for (const node of nodes) delete node.presence;
  base.nodes = nodes as typeof base.nodes;
  base.snapshotVerdict.nodeCount = nodes.length;
  // Host 0 is the screen root; view i is host i + 1, ranked among its siblings in fiber order.
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [{ role: null, roleSource: 'none', capabilities: {} }],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: FULL,
          text: { kind: 'none' },
        },
      ],
    },
  };
  const siblings = new Map<number, number>();
  views.forEach((view, i) => {
    const parent = view.parent === undefined ? 0 : view.parent + 1;
    const rank = siblings.get(parent) ?? 0;
    siblings.set(parent, rank + 1);
    evidence.hosts.push({
      testID: view.id,
      role: null,
      roleSource: 'none',
      capabilities: view.type === 'Button' ? { press: true } : {},
      ...(view.pointerEvents ? { pointerEvents: view.pointerEvents } : {}),
      ...(order ? { order: rank } : {}),
    });
    evidence.typography!.nodes.push({
      hostIndex: i + 1,
      parentHostIndex: parent,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: view.rect,
      text: { kind: 'none' },
    });
  });
  // A second React root (an overlay surface, say) has no paint order against the screen's.
  if (secondRoot) {
    evidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    evidence.typography!.nodes.push({
      hostIndex: evidence.hosts.length - 1,
      parentHostIndex: null,
      rootIndex: 1,
      hostType: 'RCTView',
      rect: { x: 0, y: 0, width: 1, height: 1 },
      text: { kind: 'none' },
    });
  }
  if (!platformPresence) delete evidence.typography;
  return captureScreen({
    appId: 'com.test',
    native: async () => (platformPresence ? base : { ...base, presenceCapture: undefined }),
    react: async () => ({
      interactive: [],
      ...(hosts ? { hostEvidence: evidence } : {}),
      verdict: { state: 'ok', path: 'interactive', complete: hosts },
    }),
  });
}

const row = (screen: Screen) => screen.elements.find((e) => e.testID === 'qa-hi-row-1')!;
// Who takes a touch at row 1's centre (201, 283): a testID, 'none' or the evidence gap.
const touched = (screen: Screen) => {
  const hit = touchOwnerAt(screen, 201, 283);
  return typeof hit === 'object' ? hit.testID : hit;
};

test('the sticky cover is named, not the pointer-transparent inset view drawn after it', async () => {
  const screen = await capture(sticky());
  const cover = coverOwner(row(screen), screen);
  assert.equal('owner' in cover && cover.owner.testID, 'qa-hi-cover', JSON.stringify(cover));
});

test('a pointer-transparent cover is no cover: the touch reaches the row', async () => {
  const screen = await capture(sticky('none'));
  // The hit test ran and gave the row its own touch, so nothing covers it.
  assert.equal(touched(screen), 'qa-hi-row-1');
  assert.deepEqual(coverOwner(row(screen), screen), { gap: 'reaches-target' });
});

test('without proof of who takes the touch, nothing is named and the gap says why', async () => {
  for (const [options, expected] of [
    [{ presence: false }, 'no-native-presence'],
    [{ hosts: false }, 'react-evidence-incomplete'],
    [{ order: false }, 'unordered-siblings'],
    [{ secondRoot: true }, 'separate-roots'],
  ] as const) {
    const screen = await capture(sticky(), options);
    assert.equal(touched(screen), expected, JSON.stringify(options));
    assert.deepEqual(coverOwner(row(screen), screen), { gap: expected }, JSON.stringify(options));
  }
});

// Device C1: a quoted tap takes an ordinary capture, which cannot associate React hosts with native
// nodes, so the refusal names no cover and says which evidence was missing.
// Device C1: a quoted tap takes an ordinary capture, which cannot tie React hosts to native nodes, so its
// refusal takes the one presence recapture to prove the cover.
async function walkCoveredTap(
  presenceRead: 'complete' | 'incomplete',
  identity: 'testID' | 'label' = 'testID',
  recapturedMatches: 0 | 1 | 2 = 1,
  kind: 'press' | 'fill' = 'press',
) {
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  w.deps.platform = 'ios';
  const modes: boolean[] = [];
  w.deps.captureScreen = async (options) => {
    const presence = options?.platformPresence === true;
    modes.push(presence);
    const views = sticky();
    if (kind === 'fill') views[1].type = 'TextField';
    const screen = await capture(views, { presence });
    const target = screen.elements.find((element) => element.testID === 'qa-hi-row-1')!;
    if (identity === 'label') delete target.testID;
    if (presence && recapturedMatches === 0)
      screen.elements = screen.elements.filter((element) => element !== target);
    if (presence && recapturedMatches === 2) screen.elements.push({ ...target, ref: '@duplicate' });
    screen.nativeGeneration = 7;
    if (presence && presenceRead === 'incomplete') {
      screen.coverage = { ...screen.coverage!, native: 'incomplete' };
      screen.captureCoverage = {
        ...(screen.captureCoverage ?? screen.coverage),
        native: 'incomplete',
      };
    }
    return screen;
  };
  const diagnostics: Record<string, unknown>[] = [];
  w.deps.diagnostic = (event) => diagnostics.push(event as unknown as Record<string, unknown>);
  w.deps.hitProbe = async () => 'not-hittable';
  let presses = 0;
  w.deps.press = async () => {
    presses += 1;
    return {
      ok: false,
      proven: false,
      mutation: 'none',
      error: 'LIVE_HIT_UNPROVEN: LIVE_HIT_UNPROVEN: not-hittable; no tap was performed.',
    };
  };
  const phrase = identity === 'testID' ? 'qa-hi-row-1' : 'Row 1';
  const step = kind === 'fill' ? `Fill "${phrase}" with "x"` : `Tap "${phrase}"`;
  const result = await runPlan(parsePlan(`1. ${step}`).blocks!, w.deps);
  const row = ('steps' in result ? result.steps : []).filter((r) => r.line === 1).at(-1);
  const gaps = diagnostics
    .filter((event) => event.code === 'CENTRE_COVERED')
    .map((event) => (event.clearanceDiagnostic as { coverGap?: unknown }).coverGap);
  return { row, modes, gaps, presses, streamed: w.rows };
}

test('a covered quoted tap names the sticky cover from one presence recapture', async () => {
  const { row, modes, gaps, presses, streamed } = await walkCoveredTap('complete');
  // Every decision capture stays ordinary; only the refusal takes the one presence recapture.
  assert.equal(modes.filter(Boolean).length, 1, JSON.stringify(modes));
  assert.equal(modes.at(-1), true);
  assert.equal(presses, 1, 'the recapture grants no further press');
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.deepEqual(
    row?.coveredBy,
    { ref: '@e5', kind: 'button', frame: COVER },
    JSON.stringify(row),
  );
  assert.deepEqual(streamed.at(-1)?.coveredBy, row?.coveredBy, 'the streamed row carries it too');
  assert.match(String(row?.reason), /covered by button at 0,110,402,201/);
  assert.doesNotMatch(String(row?.reason), /covered by \w+ at 0,116,402,758|no cover named/);
  assert.deepEqual(gaps, [null]);
});

test('an incomplete presence recapture leaves the cover unproven and adds no refusal', async () => {
  const complete = await walkCoveredTap('complete');
  const { row, modes, gaps, presses } = await walkCoveredTap('incomplete');
  assert.equal(modes.filter(Boolean).length, 1, JSON.stringify(modes));
  assert.equal(presses, 1);
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.equal(row?.coveredBy, undefined, JSON.stringify(row));
  // The same refusal, with only the cover explanation differing.
  const stem = (reason: unknown) =>
    String(reason).replace(/; (covered by|no cover named)[^;]*/, '');
  assert.equal(stem(row?.reason), stem(complete.row?.reason));
  assert.match(String(row?.reason), /no cover named \(presence-recapture-incomplete\)/);
  assert.deepEqual(gaps, ['presence-recapture-incomplete']);
});

for (const identity of ['testID', 'label'] as const) {
  for (const matches of [0, 2] as const) {
    test(`a cover recapture with ${matches} ${identity} matches leaves attribution unproven`, async () => {
      const { row, modes, gaps, presses, streamed } = await walkCoveredTap(
        'complete',
        identity,
        matches,
        'fill',
      );
      assert.equal(modes.filter(Boolean).length, 1);
      assert.equal(presses, 0);
      assert.equal(row?.outcome, 'fail');
      assert.equal(row?.coveredBy, undefined);
      assert.equal(streamed.at(-1)?.coveredBy, undefined);
      assert.match(String(row?.reason), /no cover named \(target-not-recaptured\)/);
      assert.deepEqual(gaps, ['target-not-recaptured']);
    });
  }
}

test('an unchanged readback after a refused clearance scroll retains the proven cover', async () => {
  const screen = await capture(sticky());
  const w = walker(
    [screen],
    scriptedJudge((questions) =>
      Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, choice(question)])),
    ),
  );
  w.deps.platform = 'ios';
  w.deps.press = async () => assert.fail('clearance must refuse before dispatch');
  w.deps.scroll = async (direction) => {
    w.actions.push(`scroll ${direction}`);
    return { ok: false, proven: false, mutation: 'possible', error: 'scroll was not proven' };
  };
  const diagnostics: Record<string, unknown>[] = [];
  w.deps.diagnostic = (event) => diagnostics.push(event as unknown as Record<string, unknown>);
  const result = await runPlan(parsePlan('1. Tap the Row 1').blocks!, w.deps);
  const terminal = ('steps' in result ? result.steps : []).filter((r) => r.line === 1).at(-1);
  assert.equal(w.actions.length, 1);
  assert.match(w.actions[0], /^scroll /);
  assert.equal(terminal?.outcome, 'fail');
  assert.deepEqual(terminal?.coveredBy, { ref: '@e5', kind: 'button', frame: COVER });
  assert.match(String(terminal?.reason), /covered by button at 0,110,402,201/);
  const event = diagnostics.find((event) => event.code === 'CENTRE_COVERED');
  assert.ok(event);
  assert.equal((event.clearanceDiagnostic as { coverGap: unknown }).coverGap, null);
});

test('a hit on a host with no native node of its own names nothing', async () => {
  // The cover's own testID is gone, so its host cannot be tied to a native node.
  const views = sticky().map((view) => (view.id === 'qa-hi-cover' ? { ...view, id: '' } : view));
  const screen = await capture(views);
  assert.equal(touched(screen), 'unassociated-host');
  assert.deepEqual(coverOwner(row(screen), screen), { gap: 'unassociated-host' });
});

test('scroll clipping withholds a named owner outside every viewport edge', async () => {
  const viewport = { x: 100, y: 200, width: 200, height: 500 };
  for (const [x, y] of [
    [201, 100],
    [201, 700],
    [99, 300],
    [300, 300],
  ]) {
    const frame = { x: x - 10, y: y - 10, width: 20, height: 20 };
    const screen = await capture([
      { id: 'target', type: 'Button', rect: frame },
      { id: '', type: 'ScrollView', rect: viewport },
      { id: 'clipped-row', type: 'Button', rect: frame, parent: 1 },
    ]);
    assert.equal(touchOwnerAt(screen, x, y), 'clipped', `${x},${y}`);
    assert.deepEqual(coverOwner(screen.elements.find((e) => e.testID === 'target')!, screen), {
      gap: 'clipped',
    });
  }
});

test('partially clipped owners use the touch point within all nested viewports', async () => {
  const screen = await capture([
    { id: '', type: 'ScrollView', rect: { x: 100, y: 200, width: 200, height: 500 } },
    { id: '', type: 'ScrollView', rect: { x: 50, y: 250, width: 200, height: 500 }, parent: 0 },
    {
      id: 'partial-row',
      type: 'Button',
      rect: { x: 50, y: 200, width: 250, height: 550 },
      parent: 1,
    },
  ]);
  for (const [x, y] of [
    [99, 300],
    [250, 300],
    [150, 249],
    [150, 700],
  ])
    assert.equal(touchOwnerAt(screen, x, y), 'clipped', `${x},${y}`);
  for (const [x, y] of [
    [100, 250],
    [249, 699],
  ]) {
    const owner = touchOwnerAt(screen, x, y);
    assert.equal(typeof owner === 'object' ? owner.testID : owner, 'partial-row', `${x},${y}`);
  }
});

type CapturedClearance =
  | 'text'
  | 'target'
  | 'outside'
  | 'ancestor'
  | 'nested-press'
  | 'nested-press-text'
  | 'incomplete'
  | 'typography-incomplete'
  | 'none'
  | 'unmatched'
  | 'unresolved'
  | 'roots'
  | 'clipped'
  | 'transparent'
  | 'transparent-covered'
  | 'persistent';

function capturedToast(name: string, clearance?: CapturedClearance): Screen {
  type Args = Parameters<typeof join>;
  const input: {
    nodes: Args[0];
    digest: Args[1];
    front: Args[2];
    coverage: Args[3];
    reactHostEvidence: NonNullable<Args[4]>;
    nativePresence: NonNullable<Args[5]>;
    nativeAcquisition: Args[6];
  } = JSON.parse(
    readFileSync(new URL(`../../fixtures/ios-cover-toast/${name}.json`, import.meta.url), 'utf8'),
  );
  const { hosts, typography } = input.reactHostEvidence;
  if (clearance && clearance !== 'persistent') {
    assert.ok(typography);
    const target = hosts.findIndex((host) => host.testID === 'qa-cover-toast-continue');
    const text = typography.nodes.findIndex((node) => node.parentHostIndex === target);
    assert.equal(typography.nodes[text].hostType, 'RCTText');
    const toast = hosts.findIndex((host) => host.testID === 'qa-cover-toast');
    hosts[toast].pointerEvents = 'none';
    if (clearance !== 'transparent-covered') {
      // Observation 27 flattens the toast's six native nodes into siblings.
      const kept = input.nodes.flatMap((_, i) => (i < 45 || i > 50 ? [i] : []));
      const remap = new Map(kept.map((index, i) => [index, i]));
      input.nodes = kept.map((index) => ({
        ...input.nodes[index],
        index: remap.get(index),
        parentIndex: remap.get(input.nodes[index].parentIndex!),
      }));
      assert.ok(typeof input.nativePresence === 'object');
      input.nativePresence.nodes = kept.map((index) => input.nativePresence.nodes[index]);
      const removed = new Set([toast]);
      for (const node of typography.nodes)
        if (removed.has(node.parentHostIndex!)) removed.add(node.hostIndex);
      const hostMap = new Map(
        hosts.flatMap((_, i) => (removed.has(i) ? [] : [i])).map((index, i) => [index, i]),
      );
      input.reactHostEvidence.hosts = hosts.filter((_, i) => !removed.has(i));
      typography.nodes = typography.nodes.flatMap((node) =>
        removed.has(node.hostIndex)
          ? []
          : [
              {
                ...node,
                hostIndex: hostMap.get(node.hostIndex)!,
                parentHostIndex:
                  node.parentHostIndex === null ? null : hostMap.get(node.parentHostIndex)!,
              },
            ],
      );
      input.digest = input.digest.filter((entry) => entry.testID !== 'qa-cover-toast-close');
    }
    const currentHosts = input.reactHostEvidence.hosts;
    const currentTarget = currentHosts.findIndex(
      (host) => host.testID === 'qa-cover-toast-continue',
    );
    const currentText = typography.nodes.findIndex(
      (node) => node.parentHostIndex === currentTarget,
    );
    const targetNode = input.nodes.findIndex(
      (node) => node.identifier === 'qa-cover-toast-continue',
    );
    input.nativePresence.nodes[targetNode] = {
      ...input.nativePresence.nodes[targetNode],
      status: 'observed',
    };
    delete input.nativePresence.nodes[targetNode].unknownReason;
    if (clearance === 'target' || clearance === 'ancestor')
      currentHosts[currentText].pointerEvents = 'none';
    if (clearance === 'ancestor') currentHosts[currentTarget].pointerEvents = 'none';
    if (clearance === 'nested-press') currentHosts[currentText].capabilities.press = true;
    if (clearance === 'nested-press-text') {
      const text = typography.nodes[currentText];
      for (const node of typography.nodes) {
        if (node.hostIndex >= currentText) node.hostIndex++;
        if (node.parentHostIndex !== null && node.parentHostIndex >= currentText)
          node.parentHostIndex++;
      }
      currentHosts.splice(currentText, 0, {
        role: 'button',
        roleSource: 'accessibilityRole',
        capabilities: { press: true },
        order: 0,
      });
      typography.nodes.splice(currentText, 0, {
        ...text,
        hostIndex: currentText,
        parentHostIndex: currentTarget,
        hostType: 'RCTView',
        text: { kind: 'none' },
      });
      text.parentHostIndex = currentText;
    }
    if (clearance === 'incomplete') input.reactHostEvidence.complete = false;
    if (clearance === 'typography-incomplete') typography.complete = false;
    if (clearance === 'none') currentHosts[0].pointerEvents = 'none';
    if (clearance === 'unmatched') typography.nodes[currentTarget].rect!.width++;
    if (
      clearance === 'outside' ||
      clearance === 'unresolved' ||
      clearance === 'roots' ||
      clearance === 'transparent'
    ) {
      const index = currentHosts.length;
      currentHosts.push({
        role: null,
        roleSource: 'none',
        capabilities: {},
        ...(clearance === 'unresolved' ? {} : { order: 99 }),
        ...(clearance === 'transparent' ? { pointerEvents: 'none' as const } : {}),
      });
      typography.nodes.push({
        ...typography.nodes[currentText],
        hostIndex: index,
        parentHostIndex:
          clearance === 'roots' ? null : typography.nodes[currentTarget].parentHostIndex,
      });
    }
    if (clearance === 'clipped') {
      const scroll = input.nodes.find((node) => node.type === 'ScrollView');
      assert.ok(scroll?.rect);
      scroll.rect.height = 500;
    }
  }
  return {
    ...join(
      input.nodes,
      input.digest,
      input.front,
      input.coverage,
      input.reactHostEvidence,
      input.nativePresence,
      input.nativeAcquisition,
    ),
    captureCoverage: { native: input.nativeAcquisition, react: input.coverage?.react },
    keyboardVisible: false,
  };
}

async function waitOutCover(
  options: {
    clearAt?: number;
    poll?:
      | 'missing'
      | 'duplicate'
      | 'no-geometry'
      | 'deadline'
      | 'incomplete'
      | 'cancel'
      | 'late'
      | 'unproven-clear';
    platform?: 'ios' | 'android';
    kind?: 'press' | 'fill';
    initialClearance?: boolean;
    selfCover?: boolean;
    refusePress?: boolean;
    privatePoll?: boolean;
    controls?: boolean;
    labelIdentity?: boolean;
    nativeOcclusion?: boolean;
    movingCover?: boolean;
    ambiguousAfterWait?: boolean;
    replaceOnPresence?: 'recapture' | 'poll';
    removeOnPresence?: boolean;
    retryReplacement?: boolean;
    recovery?: boolean;
    inferredOverlay?: boolean;
    ownerEntry?: 'incomplete' | 'missing' | 'duplicate' | 'gap';
    acceptLiveHit?: boolean;
    liveHitReason?: 'unavailable' | 'ambiguous' | 'expired' | 'moved';
    unquoted?: boolean;
    pixelOnly?: boolean;
    pixelFailureAt?: number;
    pixelNoMutation?: boolean;
    capturedClearance?: CapturedClearance;
  } = {},
) {
  const continueTarget =
    options.replaceOnPresence || options.removeOnPresence || options.retryReplacement;
  const coveredViews = sticky();
  coveredViews[3] = { ...coveredViews[3], type: 'Other' };
  if (continueTarget)
    coveredViews[1] = { ...coveredViews[1], id: 'primary-continue', label: 'Continue' };
  coveredViews.push({
    id: 'toast-close',
    type: 'Button',
    label: 'Close',
    parent: 3,
    rect: { x: 350, y: 120, width: 40, height: 40 },
  });
  if (options.controls) {
    for (const [index, label] of [
      'Dismiss',
      'Cancel',
      'Skip',
      'Later',
      'Private wording',
      'No thanks',
      'Not now',
    ].entries())
      coveredViews.push({
        id: `control-${index}`,
        type: 'Button',
        label,
        parent: 3,
        rect: { x: 350, y: 170 + index * 10, width: 30, height: 10 },
      });
  }
  if (options.kind === 'fill') coveredViews[1].type = 'TextField';
  const refusalViews = coveredViews.map((view, index) =>
    options.selfCover && index === 3 ? { ...view, pointerEvents: 'none' as const } : view,
  );
  const clearViews = coveredViews.slice(0, 2);
  if (options.ambiguousAfterWait)
    clearViews.push({
      id: 'duplicate-label',
      type: 'Button',
      label: 'Row 1',
      rect: { x: 20, y: 500, width: 100, height: 40 },
    });
  const offViews = refusalViews.map((view, index) =>
    index === 1 ? { ...view, rect: { ...ROW, y: 1000 } } : view,
  );
  const w = walker(
    [],
    scriptedJudge((questions) =>
      Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          choice(question, options.unquoted && !w.actions.length ? 'none' : 'e0'),
        ]),
      ),
    ),
  );
  w.deps.platform = options.platform ?? 'ios';
  let captures = 0;
  let capturesAfterPress = 0;
  const pressedRefs: string[] = [];
  if (options.recovery) w.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  let waitStarted: number | undefined;
  const budgets: number[] = [];
  const polledObservations: number[] = [];
  const diagnostics: { code?: string; observation?: number }[] = [];
  w.deps.diagnostic = (event) => diagnostics.push(event);
  const media: unknown[] = [];
  const shots: string[] = [];
  w.deps.videoPolicy = 'non-strict';
  w.deps.mediaWithheld = (event) => media.push(event);
  w.deps.screenshot = async (name) => {
    shots.push(name);
    return name;
  };
  let cancelled = false;
  w.deps.cancelled = () => cancelled;
  const notes: string[] = [];
  w.deps.note = (note) => notes.push(note);
  let currentScreen: Screen;
  let entryRecaptures = 0;
  let pendingOwnerRead = false;
  let comparisonShots = 0;
  const comparisonPhases: Array<{ presses: number; waitedMs?: number; covered: boolean }> = [];
  if (options.pixelOnly)
    w.deps.comparisonScreenshot = async () => {
      comparisonShots++;
      comparisonPhases.push({
        presses,
        waitedMs: waitStarted === undefined ? undefined : w.deps.now() - waitStarted,
        covered: centreCovered(
          currentScreen.elements.find((element) => element.testID === 'qa-hi-row-1')!,
          currentScreen,
        ),
      });
      if (comparisonShots === options.pixelFailureAt)
        throw new Error('comparison screenshot unavailable');
      const stride = FULL.width * 3 + 1;
      const raw = Buffer.alloc(stride * FULL.height);
      for (let y = 0; y < FULL.height; y++)
        raw.fill(landed ? 255 : 0, y * stride + 1, (y + 1) * stride);
      const chunk = (type: string, bytes: Uint8Array) => {
        const body = Buffer.concat([Buffer.from(type), bytes]);
        const size = Buffer.alloc(4);
        const crc = Buffer.alloc(4);
        size.writeUInt32BE(bytes.length);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([size, body, crc]);
      };
      const header = Buffer.alloc(13);
      header.writeUInt32BE(FULL.width);
      header.writeUInt32BE(FULL.height, 4);
      header[8] = 8;
      header[9] = 2;
      return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
      ]);
    };
  const captureNext: typeof w.deps.captureScreen = async (opts) => {
    captures++;
    const presence = opts?.platformPresence === true;
    const covered = await capture(coveredViews, { presence });
    if (options.controls) {
      covered.elements.find((e) => e.testID === 'control-5')!.semantic!.disabled = true;
      covered.elements.find((e) => e.testID === 'control-6')!.offscreen = true;
    }
    delete covered.keyboardVisible;
    const refusalScreen = options.selfCover ? await capture(refusalViews, { presence }) : covered;
    delete refusalScreen.keyboardVisible;
    const clear = await capture(clearViews, { presence });
    if (options.pixelOnly) clear.pointScale = 1;
    delete clear.keyboardVisible;
    const off = await capture(offViews, { presence });
    const offTarget = off.elements.find(
      (e) => e.testID === (continueTarget ? 'primary-continue' : 'qa-hi-row-1'),
    )!;
    offTarget.offscreen = true;
    if (options.unquoted) offTarget.semantic!.visibility = 'offscreen';
    const withoutId = (screen: Screen) => {
      if (options.labelIdentity)
        delete screen.elements.find((e) => e.testID === 'qa-hi-row-1')?.testID;
      return screen;
    };
    const ownerRead =
      presence &&
      (pendingOwnerRead || (!options.inferredOverlay && options.ownerEntry !== undefined)) &&
      opts?.budgetMs === undefined;
    if (presence) pendingOwnerRead = false;
    if (ownerRead) {
      entryRecaptures++;
      if (options.ownerEntry === 'incomplete')
        return { ...covered, captureCoverage: { native: 'incomplete', react: 'complete' } };
      const target = covered.elements.find((element) => element.testID === 'qa-hi-row-1')!;
      if (options.ownerEntry === 'missing')
        covered.elements = covered.elements.filter((element) => element !== target);
      if (options.ownerEntry === 'duplicate') covered.elements.push({ ...target, ref: '@e99' });
      if (options.ownerEntry === 'gap') return capture(coveredViews, { hosts: false, presence });
    }
    if (options.removeOnPresence && presence) {
      covered.elements = covered.elements.filter((e) => e.testID !== 'primary-continue');
      assert.deepEqual(
        dismissCandidate(covered, [{ quoted: 'Continue', phrase: 'Continue' }]),
        { label: 'Close' },
        'the persistent cover would offer Close to ordinary recovery',
      );
      return covered;
    }
    if (options.retryReplacement && presses > 0) {
      if (++capturesAfterPress === 1) return clear;
      return capture(
        clearViews.map((view, index) =>
          index === 1 ? { ...view, id: 'secondary-continue' } : view,
        ),
        { presence },
      );
    }
    if (
      options.replaceOnPresence &&
      presence &&
      (options.replaceOnPresence === 'recapture' || opts?.budgetMs !== undefined)
    ) {
      const replacement = await capture(
        clearViews.map((view, index) =>
          index === 1 ? { ...view, id: 'secondary-continue' } : view,
        ),
        { presence },
      );
      delete replacement.keyboardVisible;
      return replacement;
    }
    if (opts?.budgetMs !== undefined) {
      budgets.push(opts.budgetMs);
      polledObservations.push(opts.observation!);
      waitStarted ??= w.deps.now() - 500;
      if (options.poll === 'late') {
        await w.deps.sleep(opts.budgetMs);
        return withoutId(clear);
      }
      if (options.poll === 'unproven-clear')
        return capture(coveredViews.slice(0, 2), { hosts: false, presence });
      if (options.movingCover) {
        const shifted = await capture(
          coveredViews.map((view, index) =>
            index === 3 ? { ...view, rect: { ...COVER, y: 120 } } : view,
          ),
          { presence },
        );
        delete shifted.keyboardVisible;
        return shifted;
      }
      if (options.poll === 'deadline') throw new CaptureDeadline();
      if (options.poll === 'cancel') cancelled = true;
      if (options.privatePoll) {
        capturePrivateScreen(covered, [
          {
            values: ['private-cover-canary'],
            secure: true,
            elements: [],
            associationUnique: false,
          },
        ]);
        covered.visibleText.push('private-cover-canary');
      }
      if (
        options.poll === 'missing' ||
        options.poll === 'duplicate' ||
        options.poll === 'no-geometry'
      ) {
        const screen = await capture(coveredViews, { presence });
        const target = screen.elements.find((e) => e.testID === 'qa-hi-row-1')!;
        if (options.poll === 'missing')
          screen.elements = screen.elements.filter((e) => e !== target);
        if (options.poll === 'duplicate') screen.elements.push({ ...target, ref: '@e99' });
        if (options.poll === 'no-geometry')
          screen.elements[screen.elements.indexOf(target)] = { ...target };
        return screen;
      }
      if (options.poll === 'incomplete')
        return { ...covered, captureCoverage: { native: 'incomplete', react: 'complete' } };
      if (options.clearAt !== undefined && w.deps.now() - waitStarted >= options.clearAt)
        return withoutId(clear);
    }
    if (
      options.pixelOnly &&
      waitStarted !== undefined &&
      options.clearAt !== undefined &&
      w.deps.now() - waitStarted >= options.clearAt
    )
      return withoutId(clear);
    if (options.nativeOcclusion) return presses === 0 ? withoutId(clear) : withoutId(refusalScreen);
    return withoutId(captures === 1 && !options.initialClearance ? off : refusalScreen);
  };
  w.deps.captureScreen = async (opts) => {
    if (options.capturedClearance) {
      if (opts?.budgetMs !== undefined) {
        budgets.push(opts.budgetMs);
        waitStarted ??= w.deps.now() - 500;
      }
      currentScreen = capturedToast(
        waitStarted !== undefined || opts?.platformPresence
          ? 'presence'
          : !w.actions.length
            ? 'before-scroll'
            : 'after-scroll',
        waitStarted !== undefined ? options.capturedClearance : undefined,
      );
    } else currentScreen = await captureNext(opts);
    if (options.inferredOverlay) currentScreen.keyboardVisible = false;
    return currentScreen;
  };
  let presses = 0;
  let landed = 0;
  const pressOptions: Array<Parameters<typeof w.deps.press>[2]> = [];
  w.deps.press = async (ref, _context, option) => {
    pressOptions.push(option);
    pressedRefs.push(ref);
    assert.equal(
      ref,
      options.capturedClearance
        ? currentScreen.elements.find((element) => element.testID === 'qa-cover-toast-continue')
            ?.ref
        : '@e3',
      'only the planned target may be pressed',
    );
    presses++;
    if (
      options.inferredOverlay &&
      !options.acceptLiveHit &&
      option?.requireLiveHit &&
      (options.capturedClearance
        ? waitStarted === undefined
        : currentScreen.elements.some((element) => element.testID === 'qa-hi-cover'))
    ) {
      pendingOwnerRead = true;
      return {
        ok: false,
        proven: false,
        mutation: 'none',
        error: `LIVE_HIT_UNPROVEN: ${options.liveHitReason ?? 'not-hittable'}; no tap was performed`,
      };
    }
    if (options.nativeOcclusion)
      return {
        ok: false,
        proven: false,
        mutation: 'none',
        error: 'FOCUS_TARGET_OCCLUDED: target covered',
      };
    if (options.retryReplacement) return { ok: true, proven: false };
    if (!options.refusePress && !options.pixelNoMutation) landed++;
    return options.refusePress
      ? { ok: false, proven: false, mutation: 'none', error: 'not dispatched' }
      : { ok: true, proven: !options.pixelOnly };
  };
  const kind = options.unquoted
    ? 'Tap Row 1'
    : continueTarget || options.capturedClearance
      ? 'Tap "Continue"'
      : options.kind === 'fill'
        ? 'Fill "qa-hi-row-1" with "x"'
        : options.labelIdentity || options.ambiguousAfterWait
          ? 'Tap "Row 1"'
          : 'Tap "qa-hi-row-1"';
  const result = await runPlan(parsePlan(`1. ${kind}`).blocks!, w.deps);
  return {
    result,
    row: ('steps' in result ? result.steps : []).at(-1),
    actions: w.actions,
    streamed: w.rows,
    polledObservations,
    diagnostics,
    budgets,
    presses,
    pressedRefs,
    captures,
    media,
    shots,
    landed,
    pressOptions,
    notes,
    entryRecaptures,
    comparisonShots,
    comparisonPhases,
  };
}

test('a quoted tap after scrolling waits for clearance and presses only its target', async () => {
  const { row, streamed, actions, presses, budgets } = await waitOutCover({ clearAt: 1000 });
  assert.equal(row?.outcome, 'pass', JSON.stringify(row));
  assert.equal(presses, 1);
  assert.deepEqual(actions, ['scroll down'], 'only the original offscreen resolution scroll');
  assert.equal(row?.coverWaitMs, 1000);
  assert.equal(streamed.at(-1)?.coverWaitMs, 1000);
  assert.equal(row?.coveredBy, undefined, 'the admitted clear observation owns dispatch');
  assert.deepEqual(budgets, [4500, 4000]);
});

test('a quoted tap after scrolling waits five seconds and names the persistent cover Close', async () => {
  const { row, presses, budgets } = await waitOutCover();
  assert.equal(row?.outcome, 'fail');
  assert.equal(presses, 0);
  assert.equal(row?.coverWaitMs, 5000);
  assert.match(String(row?.reason), /covered by other at 0,110,402,201/);
  assert.match(String(row?.reason), /waited 5000 ms; the cover holds 1 pressable controls/);
  assert.match(String(row?.reason), /decline-labelled: Close/);
  assert.equal(budgets.length, 9);
});

test('a refused live hit after scrolling waits and names the persistent cover Close', async () => {
  const {
    row,
    streamed,
    presses,
    landed,
    actions,
    diagnostics,
    polledObservations,
    entryRecaptures,
    notes,
  } = await waitOutCover({ inferredOverlay: true });
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.match(String(row?.reason), /the live hit read refused the press \(not-hittable\)/);
  assert.equal(presses, 1, 'the live hit read refuses without a mutation');
  assert.equal(landed, 0, 'the persistent cover must leave the receiver untouched');
  assert.equal(entryRecaptures, 1, 'one owner presence recapture, with none for refusal text');
  assert.deepEqual(actions, ['scroll down']);
  assert.deepEqual(row?.coveredBy, { ref: '@e5', kind: 'other', frame: COVER });
  assert.equal(row?.coverWaitMs, 5000, JSON.stringify(row));
  assert.equal(streamed.at(-1)?.coverWaitMs, 5000);
  assert.match(String(row?.reason), /waited 5000 ms/);
  assert.match(String(row?.reason), /the cover holds 1 pressable controls/);
  assert.match(String(row?.reason), /decline-labelled: Close/);
  assert.equal(
    diagnostics.filter((event) => event.code === 'CENTRE_COVERED').at(-1)?.observation,
    polledObservations.at(-1),
  );
  assert.deepEqual(
    notes
      .filter((note) => note.startsWith('cover-wait '))
      .map((note) => JSON.parse(note.slice(11))),
    [
      { line: 1, phase: 'start', at: 0 },
      { line: 1, phase: 'end', at: 5000, waitedMs: 5000, cleared: false },
    ],
  );
});

test('a refused live hit waits for clearance then taps once without stale strictness', async () => {
  const { row, streamed, actions, presses, landed, pressOptions, notes } = await waitOutCover({
    inferredOverlay: true,
    clearAt: 1000,
  });
  assert.equal(row?.outcome, 'pass', JSON.stringify(row));
  assert.equal(presses, 2, 'one refused read and one landed tap');
  assert.equal(landed, 1);
  assert.deepEqual(actions, ['scroll down']);
  assert.deepEqual(pressOptions, [{ requireLiveHit: true }, undefined]);
  assert.equal(row?.coverWaitMs, 1000);
  assert.equal(streamed.at(-1)?.coverWaitMs, 1000);
  assert.deepEqual(
    notes
      .filter((note) => note.startsWith('cover-wait '))
      .map((note) => JSON.parse(note.slice(11))),
    [
      { line: 1, phase: 'start', at: 0 },
      { line: 1, phase: 'end', at: 1000, waitedMs: 1000, cleared: true },
    ],
  );
});

test('a pixel-only tap after a cleared live-hit wait lands exactly once', async () => {
  const { row, presses, landed, comparisonShots, actions } = await waitOutCover({
    inferredOverlay: true,
    clearAt: 1000,
    pixelOnly: true,
  });
  assert.equal(row?.outcome, 'pass', JSON.stringify(row));
  assert.equal(presses, 2, 'one refused read and one landed tap');
  assert.equal(landed, 1, 'a visual toggle must not be tapped twice');
  assert.equal(comparisonShots, 3, 'one clear baseline and two stable changed crops');
  assert.equal(row?.coverWaitMs, 1000);
  assert.deepEqual(actions, ['scroll down']);
});

for (const clearance of ['text', 'target', 'transparent'] as const) {
  test(`captured clearance ${clearance}: the wait clears and exactly one target tap lands (T8/T9b)`, async () => {
    const screen = capturedToast('presence', clearance);
    const target = screen.elements.find((element) => element.testID === 'qa-cover-toast-continue')!;
    assert.equal(hostAssociationIdentity(target), 'matched');
    assert.equal(centreCovered(target, screen), false);
    assert.deepEqual(coverOwner(target, screen), { gap: 'unassociated-host' });
    const { row, presses, landed, pressOptions, actions } = await waitOutCover({
      inferredOverlay: true,
      capturedClearance: clearance,
    });
    assert.equal(row?.outcome, 'pass', JSON.stringify(row));
    assert.equal(row?.coverWaitMs, 500);
    assert.equal(presses, 2, 'one non-mutating live-hit read, then one target tap');
    assert.equal(landed, 1);
    assert.deepEqual(pressOptions, [{ requireLiveHit: true }, undefined]);
    assert.deepEqual(actions, ['scroll down']);
  });
}

for (const clearance of [
  'outside',
  'ancestor',
  'nested-press',
  'nested-press-text',
  'incomplete',
  'typography-incomplete',
  'none',
  'unmatched',
  'unresolved',
  'roots',
  'clipped',
  'transparent-covered',
  'persistent',
] as const) {
  test(`captured clearance ${clearance}: uncertain or covered touch waits to the deadline (T9/T10)`, async () => {
    const screen = capturedToast('presence', clearance);
    const target = screen.elements.find((element) => element.testID === 'qa-cover-toast-continue')!;
    const gaps = {
      incomplete: 'react-evidence-incomplete',
      'typography-incomplete': 'typography-incomplete',
      unresolved: 'unordered-siblings',
      roots: 'separate-roots',
      none: 'none',
    };
    if (clearance !== 'persistent')
      assert.deepEqual(coverOwner(target, screen), { gap: gaps[clearance] ?? 'unassociated-host' });
    if (clearance === 'clipped' || clearance === 'transparent-covered')
      assert.equal(centreCovered(target, screen), true);
    const { row, presses, landed, budgets } = await waitOutCover({
      inferredOverlay: true,
      capturedClearance: clearance,
    });
    assert.equal(row?.outcome, 'fail', JSON.stringify(row));
    assert.equal(row?.coverWaitMs, 5000);
    assert.equal(presses, 1, 'no dispatch after the refused live hit');
    assert.equal(landed, 0);
    assert.equal(budgets.length, 9);
    assert.match(
      String(row?.reason),
      /waited 5000 ms; the cover holds 1 pressable controls \(decline-labelled: Close\)/,
    );
  });
}

for (const pixelFailureAt of [1, 2]) {
  test(`pixel probe: screenshot ${pixelFailureAt} fails after clearance without proving a non-mutating tap`, async () => {
    const { row, landed, comparisonPhases } = await waitOutCover({
      inferredOverlay: true,
      clearAt: 1000,
      pixelOnly: true,
      pixelNoMutation: true,
      pixelFailureAt,
    });
    assert.equal(row?.outcome, 'fail', JSON.stringify(row));
    assert.equal(landed, 0);
    assert.deepEqual(
      comparisonPhases[0],
      { presses: 1, waitedMs: 1000, covered: false },
      'the first picture is the baseline after clearance, never a covered pre-wait baseline',
    );
    if (pixelFailureAt === 2)
      assert.deepEqual(
        comparisonPhases[1],
        { presses: 2, waitedMs: 1000, covered: false },
        'the failing second picture is a post-tap comparison, not a baseline retake',
      );
    assert.ok(
      comparisonPhases.every(
        (phase) => !phase.covered && phase.waitedMs !== undefined && phase.waitedMs >= 1000,
      ),
    );
  });
}

test('an incomplete owner recapture on the non-overlay path is not repeated for naming', async () => {
  const { row, entryRecaptures, budgets, presses } = await waitOutCover({
    ownerEntry: 'incomplete',
  });
  assert.equal(row?.outcome, 'fail');
  assert.equal(entryRecaptures, 1, 'entry and refusal naming share one presence read');
  assert.equal(presses, 0);
  assert.equal(row?.coverWaitMs, undefined);
  assert.deepEqual(budgets, []);
  assert.match(String(row?.reason), /no cover named \(presence-recapture-incomplete\)/);
});

const liveHitRefusalText = (cover: string, reason = 'not-hittable') =>
  '"qa-hi-row-1" stayed off screen after one scroll: its centre is past the visible area or under the keyboard' +
  cover +
  '; inferred band cutter @e5 (other) at 0,110,402,201 moved the band top from 206 to 311' +
  `; the live hit read refused the press (${reason}); no tap was performed`;

for (const [ownerEntry, gap] of [
  ['incomplete', 'presence-recapture-incomplete'],
  ['missing', 'target-not-recaptured'],
  ['duplicate', 'target-not-recaptured'],
  ['gap', 'react-evidence-incomplete'],
] as const) {
  test(`a refused live hit with ${ownerEntry} owner evidence keeps its refusal without waiting`, async () => {
    const { row, entryRecaptures, budgets, landed } = await waitOutCover({
      inferredOverlay: true,
      ownerEntry,
    });
    assert.equal(entryRecaptures, 1);
    assert.equal(landed, 0);
    assert.equal(row?.coverWaitMs, undefined);
    assert.deepEqual(budgets, []);
    assert.equal(row?.reason, liveHitRefusalText(`; no cover named (${gap})`));
  });
}

test('an accepted live hit under a named owner taps once without waiting', async () => {
  const { row, presses, landed, pressOptions, budgets, notes } = await waitOutCover({
    inferredOverlay: true,
    acceptLiveHit: true,
  });
  assert.equal(row?.outcome, 'pass', JSON.stringify(row));
  assert.equal(presses, 1);
  assert.equal(landed, 1);
  assert.deepEqual(pressOptions, [{ requireLiveHit: true }]);
  assert.equal(row?.coverWaitMs, undefined);
  assert.deepEqual(budgets, []);
  assert.ok(!notes.some((note) => note.startsWith('cover-wait ')));
});

for (const liveHitReason of ['unavailable', 'ambiguous', 'expired', 'moved'] as const) {
  test(`a live hit ${liveHitReason} refusal names the owner without starting a wait`, async () => {
    const { row, presses, landed, budgets } = await waitOutCover({
      inferredOverlay: true,
      liveHitReason,
    });
    assert.equal(presses, 1);
    assert.equal(landed, 0);
    assert.equal(row?.coverWaitMs, undefined);
    assert.deepEqual(budgets, []);
    assert.equal(
      row?.reason,
      liveHitRefusalText('; covered by other at 0,110,402,201', liveHitReason),
    );
  });
}

test('a centre-covered clearance scroll keeps its exact live-hit refusal without waiting', async () => {
  const { row, actions, presses, landed, budgets } = await waitOutCover({
    inferredOverlay: true,
    initialClearance: true,
  });
  assert.equal(presses, 1);
  assert.equal(landed, 0);
  assert.deepEqual(actions, ['scroll up']);
  assert.equal(row?.coverWaitMs, undefined);
  assert.deepEqual(budgets, []);
  assert.equal(row?.reason, liveHitRefusalText('; covered by other at 0,110,402,201'));
});

test('a second live-hit refusal retains the earlier wait without stale control counts', async () => {
  const { row, budgets, landed, pressOptions, notes, entryRecaptures } = await waitOutCover({
    inferredOverlay: true,
    clearAt: 500,
    refusePress: true,
  });
  assert.equal(landed, 0);
  assert.equal(row?.coverWaitMs, 500);
  assert.deepEqual(budgets, [4500]);
  assert.deepEqual(pressOptions, [{ requireLiveHit: true }, undefined, { requireLiveHit: true }]);
  assert.match(String(row?.reason), /waited 500 ms earlier in this step/);
  assert.doesNotMatch(String(row?.reason), /pressable controls|decline-labelled|Close/);
  assert.deepEqual(row?.coveredBy, { ref: '@e5', kind: 'other', frame: COVER });
  assert.equal(entryRecaptures, 2, 'wait entry and ordinary refusal naming each take one read');
  assert.match(String(row?.reason), /the live hit read refused the press/);
  assert.equal(notes.filter((note) => note.startsWith('cover-wait ')).length, 2);
});

test('a repeat live-hit refusal counts controls only on its own presence capture', async () => {
  const { row, budgets, landed, pressOptions, entryRecaptures } = await waitOutCover({
    inferredOverlay: true,
    unquoted: true,
    clearAt: 500,
    refusePress: true,
  });
  assert.equal(landed, 0);
  assert.equal(row?.coverWaitMs, 500, JSON.stringify(row));
  assert.deepEqual(budgets, [4500]);
  assert.deepEqual(pressOptions, [{ requireLiveHit: true }, undefined, { requireLiveHit: true }]);
  assert.match(
    String(row?.reason),
    /waited 500 ms earlier in this step; the cover holds 1 pressable controls \(decline-labelled: Close\)/,
  );
  assert.equal(entryRecaptures, 0, 'the dispatch captures already carry presence');
});

for (const poll of [
  'missing',
  'duplicate',
  'no-geometry',
  'deadline',
  'incomplete',
  'late',
  'unproven-clear',
] as const) {
  test(`cover wait never taps with ${poll} evidence`, async () => {
    const { row, presses } = await waitOutCover({ poll });
    assert.equal(row?.outcome, 'fail');
    assert.equal(presses, 0);
    assert.ok(row?.coverWaitMs !== undefined);
    if (poll === 'missing' || poll === 'duplicate')
      assert.match(String(row?.reason), /target.*(missing|ambiguous)/);
    if (poll === 'no-geometry') assert.equal(row?.coverWaitMs, 5000);
    if (poll === 'incomplete') {
      assert.match(String(row?.reason), /covered by other at 0,110,402,201/);
      assert.match(String(row?.reason), /capture evidence became incomplete/);
    }
  });
}

for (const options of [
  { platform: 'android' },
  { kind: 'fill' },
  { initialClearance: true },
  { selfCover: true },
] as const) {
  test(`existing cover branch stays unchanged for ${JSON.stringify(options)}`, async () => {
    const { row, budgets } = await waitOutCover(options);
    assert.equal(row?.coverWaitMs, undefined);
    assert.deepEqual(budgets, []);
  });
}

test('the same item cannot spend another cover wait on a dispatch retry', async () => {
  const { budgets, presses, row } = await waitOutCover({ clearAt: 500, refusePress: true });
  assert.equal(presses, 1);
  assert.deepEqual(budgets, [4500]);
  assert.match(
    String(row?.reason),
    /waited 500 ms earlier in this step; the cover holds 1 pressable controls/,
  );
});

test('cancellation during a cover poll aborts without pressing', async () => {
  const { result, presses, budgets } = await waitOutCover({ poll: 'cancel' });
  assert.equal(result.verdict, 'FAIL');
  assert.match(JSON.stringify(result), /RUN_CANCELLED/);
  assert.equal(presses, 0);
  assert.deepEqual(budgets, [4500]);
});

test('wait captures admit private input history and withhold media without leaking values', async () => {
  const { result, streamed, media, shots, presses } = await waitOutCover({ privatePoll: true });
  assert.equal(presses, 0);
  assert.ok(media.length > 0);
  assert.deepEqual(shots, []);
  assert.doesNotMatch(JSON.stringify({ result, streamed, media }), /private-cover-canary/);
});

test('cover diagnostics count only enabled on-screen pressables and bound decline labels', async () => {
  const { row, presses } = await waitOutCover({ controls: true });
  assert.equal(presses, 0);
  assert.match(String(row?.reason), /the cover holds 6 pressable controls/);
  assert.match(String(row?.reason), /decline-labelled: Close, Dismiss, Cancel, Skip\)/);
  assert.doesNotMatch(String(row?.reason), /Private wording|No thanks|Not now|Later/);
});

test('native-occlusion clearance never starts a cover wait', async () => {
  const { budgets, row, presses } = await waitOutCover({ nativeOcclusion: true });
  assert.equal(presses, 1);
  assert.deepEqual(budgets, []);
  assert.equal(row?.coverWaitMs, undefined);
});

test('a unique label-only identity gets its normal tap after the cover leaves', async () => {
  const { row, presses } = await waitOutCover({ labelIdentity: true, clearAt: 500 });
  assert.equal(row?.outcome, 'pass', JSON.stringify(row));
  assert.equal(presses, 1);
  assert.equal(row?.coverWaitMs, 500);
});

test('a persistent moving cover refuses on the last admitted poll observation', async () => {
  const { row, diagnostics, polledObservations } = await waitOutCover({ movingCover: true });
  assert.equal(row?.coveredBy?.frame.y, 120);
  assert.match(String(row?.reason), /covered by other at 0,120,402,201/);
  assert.equal(
    diagnostics.filter((event) => event.code === 'CENTRE_COVERED').at(-1)?.observation,
    polledObservations.at(-1),
  );
});

test('a real ambiguity after clearance retains its refusal and never enters recovery', async () => {
  const { row, presses } = await waitOutCover({ ambiguousAfterWait: true, clearAt: 500 });
  assert.equal(presses, 0);
  assert.match(String(row?.reason), /TARGET_AMBIGUOUS/);
  assert.doesNotMatch(String(row?.reason), /TARGET_NOT_FOUND/);
});

test('a quoted label after scrolling names a persistent cover and never presses Close', async () => {
  const { row, presses, actions } = await waitOutCover({ labelIdentity: true });
  assert.equal(row?.outcome, 'fail');
  assert.equal(row?.coverWaitMs, 5000);
  assert.equal(presses, 0);
  assert.deepEqual(actions, ['scroll down']);
  assert.match(String(row?.reason), /the cover holds 1 pressable controls/);
  assert.match(String(row?.reason), /decline-labelled: Close/);
});

for (const replaceOnPresence of ['recapture', 'poll'] as const) {
  test(`a same-label replacement during the cover ${replaceOnPresence} is never pressed`, async () => {
    const { row, presses, actions } = await waitOutCover({ replaceOnPresence, recovery: true });
    assert.equal(row?.outcome, 'fail', JSON.stringify(row));
    assert.equal(presses, 0, 'secondary-continue must not replace primary-continue');
    assert.deepEqual(actions, ['scroll down']);
    if (replaceOnPresence === 'recapture') {
      assert.match(String(row?.reason), /identity selected before the cover read/);
      assert.match(String(row?.reason), /no cover named \(target-not-recaptured\)/);
    } else {
      assert.match(String(row?.reason), /target became missing/);
      assert.match(String(row?.reason), /covered by other/);
      assert.match(String(row?.reason), /decline-labelled: Close/);
    }
  });
}

test('a target missing during the cover read never triggers Close recovery', async () => {
  const { result, row, pressedRefs, streamed } = await waitOutCover({
    removeOnPresence: true,
    recovery: true,
  });
  assert.equal(row?.outcome, 'fail', JSON.stringify(result));
  assert.match(String(row?.reason), /TARGET_NOT_FOUND/);
  assert.deepEqual(pressedRefs, []);
  assert.ok(streamed.every((entry) => entry.block !== '@interruption'));
});

test('a cleared target cannot be replaced on the ordinary dispatch retry', async () => {
  const { row, pressedRefs, streamed } = await waitOutCover({
    retryReplacement: true,
    clearAt: 500,
    recovery: true,
  });
  assert.ok(streamed.some((entry) => entry.outcome === 'retry'));
  assert.equal(row?.outcome, 'fail', JSON.stringify(row));
  assert.match(String(row?.reason), /identity selected before the cover read/);
  assert.deepEqual(pressedRefs, ['@e3'], 'only primary-continue may receive the first tap');
});
