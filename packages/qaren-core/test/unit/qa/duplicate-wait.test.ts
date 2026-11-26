import { OverlayHits } from '../../../dist/qa/live-hit.js';
import { CaptureDeadline } from '../../../dist/qa/capture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan } from '../../../dist/qa/plan.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { ancestorsOf, join } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { runPlan, walkBlock } from '../../../dist/qa/walker.js';
import type { WalkerDeps } from '../../../dist/qa/walker.js';
import { aggregateTargetVisible, targetEvidence } from '../../../dist/qa/resolve.js';

import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';

const ID = 'twin-screen';
type Rect = { x: number; y: number; width: number; height: number };
const full: Rect = { x: 0, y: 0, width: 402, height: 874 };
const inner: Rect = { x: 0, y: 116, width: 402, height: 758 };

type ProjectedNode = Omit<NativeNode, 'ref' | 'index'>;

function projectedScreen(nodes: ProjectedNode[]): Screen {
  const screen = join(
    nodes.map((node, index) => ({ hittable: true, ...node, index, ref: `@${index}` })),
    [],
  );
  screen.coverage = { native: 'complete', react: 'complete' };
  screen.keyboardVisible = false;
  screen.nativeGeneration = 7;
  return screen;
}

// Supply the emitted nodes of an ordinary iOS snapshot, with one Window.
function capture(children: ProjectedNode[], label?: string): Screen {
  return projectedScreen([
    { type: 'Application', rect: full, depth: 0, label },
    { type: 'Window', rect: full, depth: 1, parentIndex: 0, label },
    ...children,
  ]);
}

const carrier = (
  rect: Rect,
  evidence: Pick<NativeNode, 'label' | 'hittable'> = {},
): ProjectedNode => ({
  type: 'Other',
  rect,
  identifier: ID,
  depth: 2,
  parentIndex: 1,
  ...evidence,
});
const text = (label: string, rect: Rect): ProjectedNode => ({
  type: 'StaticText',
  rect,
  label,
  depth: 2,
  parentIndex: 1,
});
const aggregate = (label: string, rect: Rect): ProjectedNode => ({
  type: 'Other',
  rect,
  label,
  depth: 2,
  parentIndex: 1,
});
const title = text('Fixture title', { x: 21, y: 151, width: 360, height: 30 });
const siblings = () => capture([title, carrier(full), carrier(inner)], title.label);

interface Fake {
  deps: WalkerDeps;
  actions: string[];
}
function fake(screen: (options?: Parameters<WalkerDeps['captureScreen']>[0]) => Screen): Fake {
  const actions: string[] = [];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen(options) {
      return screen(options);
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      return { ok: true, proven: false };
    },
    async fill(ref) {
      actions.push(`fill ${ref}`);
      return { ok: true, proven: true };
    },
    async scroll(direction) {
      actions.push(`scroll ${direction}`);
      return { ok: true, proven: false };
    },
    async back() {
      actions.push('back');
      return { ok: true, proven: false };
    },
    async dialog() {
      actions.push('dialog');
      return { ok: true, proven: true };
    },
    async screenshot(name) {
      return name;
    },
    now: () => (clock += 100),
    async sleep(ms) {
      clock += ms;
    },
    row: () => undefined,
    platform: 'ios',
  };
  return { deps, actions };
}
const block = (md: string) => {
  const parsed = parsePlan(md);
  assert.ok(parsed.blocks, JSON.stringify(parsed.refused));
  return parsed.blocks[0];
};
const seen = (o: Awaited<ReturnType<typeof walkBlock>>) =>
  renderReason(o.failure?.seen ?? '', (t) => t);
const wait = `1. Wait for "${ID}"\n`;
const carriers = (screen: Screen) => screen.elements.filter((entry) => entry.testID === ID);
const suggestion =
  'Multiple captured elements carry the quoted testID (other at 0,0,402,874; other at 0,116,402,758). Give the intended view a unique testID and quote it in the Wait, or quote exact visible text that identifies it on this screen.';

test('F1: equal-depth duplicate IDs stay failed with bounded locator advice', async () => {
  const screen = siblings();
  const [a, b] = carriers(screen);
  assert.deepEqual(ancestorsOf(a), ancestorsOf(b));
  assert.equal(a.label, undefined);
  assert.equal(b.label, undefined);
  const f = fake(() => screen);
  const outcome = await walkBlock(block(wait), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.kind, 'step');
  assert.match(seen(outcome), /2 elements carry the identifier/);
  assert.ok(outcome.failure?.screen);
  assert.deepEqual(f.actions, []);
  assert.doesNotMatch(outcome.failure?.suggestion ?? '', /twin-screen|Fixture title/);
  assert.equal(outcome.failure?.subreason, 'duplicate-id');
  assert.equal(outcome.failure?.suggestion, suggestion);
});

test('G1: changes between poll signatures retain the deadline classification', async () => {
  let i = 0;
  const f = fake(() =>
    capture([
      text(`Changing view ${++i}`, { x: 25, y: 160, width: 120, height: 30 }),
      carrier(full),
      carrier(inner),
    ]),
  );
  const outcome = await walkBlock(block(wait), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen(outcome), /ITEM_DEADLINE_EXCEEDED/);
  assert.notEqual(outcome.failure?.subreason, 'duplicate-id');
});

test('G2: a recovery read with the duplicate gone does not get duplicate advice', async () => {
  let readRecovery = false;
  const f = fake((options) => {
    if (options?.platformPresence) {
      readRecovery = true;
      return capture([title], title.label);
    }
    return siblings();
  });
  f.deps.hideDevMenu = async () => ({ ok: false });
  const outcome = await walkBlock(block(wait), f.deps);
  assert.ok(readRecovery);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen(outcome), /2 elements carry the identifier/);
  assert.notEqual(outcome.failure?.subreason, 'duplicate-id');
});

test('F2: the recovery read retains the pair and its newer locator geometry', async () => {
  let readRecovery = false;
  const f = fake((options) => {
    if (options?.platformPresence) {
      readRecovery = true;
      return capture(
        [title, carrier(full), carrier({ ...inner, y: 128, height: 746 })],
        title.label,
      );
    }
    return siblings();
  });
  f.deps.hideDevMenu = async () => ({ ok: false });
  const outcome = await walkBlock(block(wait), f.deps);
  assert.ok(readRecovery);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen(outcome), /2 elements carry the identifier/);
  assert.deepEqual(f.actions, []);
  assert.equal(outcome.failure?.subreason, 'duplicate-id');
  assert.match(outcome.failure?.suggestion ?? '', /other at 0,128,402,746/);
  assert.doesNotMatch(outcome.failure?.suggestion ?? '', /0,116,402,758/);
});

test('F3: bound four captured identities and identify unavailable frame', async () => {
  const f = fake(() =>
    capture([
      carrier({ x: 0, y: 0, width: 0, height: 0 }, { hittable: false }),
      carrier({ x: 25, y: 140, width: 160, height: 40 }),
      carrier({ x: 25, y: 240, width: 160, height: 40 }),
      carrier({ x: 25, y: 340, width: 160, height: 40 }),
    ]),
  );
  const outcome = await walkBlock(block(wait), f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen(outcome), /4 elements carry the identifier/);
  assert.equal(outcome.failure?.subreason, 'duplicate-id');
  assert.match(
    outcome.failure?.suggestion ?? '',
    /frame unavailable.*25,140,160,40.*25,240,160,40.*additional captured matches/,
  );
  assert.doesNotMatch(outcome.failure?.suggestion ?? '', /25,340/);
});

test('F4: protected value overlaps a coordinate in the actual ledger', async () => {
  const f = fake(siblings);
  const privacy = new ObservedPrivacy();
  f.deps.privacy = privacy;
  const inputs = new RunInputs({ SAMPLE: '402' }, ['SAMPLE'], privacy);
  const plan = parsePlan(wait);
  const report = await withInputs(inputs, () => runPlan(plan.blocks!, f.deps));
  assert.equal(report.verdict, 'FAIL');
  assert.equal(report.failure?.subreason, 'duplicate-id');
  assert.match(
    report.failure?.suggestion ?? '',
    /Multiple captured elements.*Give the intended view a unique testID/,
  );
  assert.doesNotMatch(report.failure?.suggestion ?? '', /402/);
});

const quoted = { quoted: ID, phrase: ID };
const genericSuggestion =
  /on the last observation the target .* was on screen but could not take this step; compare its role and state in failure.screen with the step/;
function withRecoveredScreen(last: Screen): Fake {
  const f = fake((options) => (options?.platformPresence ? last : siblings()));
  f.deps.hideDevMenu = async () => ({ ok: false });
  return f;
}

for (const [name, evidence] of [
  [
    'G3: exact visible text now satisfies the quote',
    [text(ID, { x: 24, y: 170, width: 130, height: 35 })],
  ],
  [
    'G4: independent aggregate label now satisfies the quote',
    [aggregate('Fresh status, twin-screen', { x: 24, y: 40, width: 160, height: 35 })],
  ],
  [
    'G5: aggregate evidence on the newer read is ambiguous',
    [
      aggregate('Fresh status, twin-screen', { x: 24, y: 40, width: 160, height: 35 }),
      aggregate('Other status, twin-screen', { x: 214, y: 40, width: 160, height: 35 }),
    ],
  ],
] as const) {
  test(name, async () => {
    const last = capture([carrier(full), carrier(inner), ...evidence], evidence[0].label);
    assert.equal(carriers(last).length, 2);
    if (name.startsWith('G3')) {
      assert.equal(targetEvidence(quoted, last), 'pass');
    } else {
      assert.equal(targetEvidence(quoted, last), 'fail');
      if (name.startsWith('G4')) assert.equal(aggregateTargetVisible(quoted, last), true);
      else assert.throws(() => aggregateTargetVisible(quoted, last), /TARGET_AMBIGUOUS/);
    }
    const f = withRecoveredScreen(last);
    const outcome = await walkBlock(block(wait), f.deps);
    assert.match(seen(outcome), /2 elements carry the identifier/);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(outcome.failure?.subreason, 'present-but-unavailable');
    assert.ok(outcome.failure?.screen);
    assert.match(outcome.failure?.suggestion ?? '', genericSuggestion);
    assert.deepEqual(f.actions, []);
  });
}

test('G6: default successful Wait still stores its unique ID', async () => {
  const f = fake(() =>
    capture(
      [carrier(inner, { label: title.label }), { ...title, depth: 3, parentIndex: 2 }],
      title.label,
    ),
  );
  const outcome = await walkBlock(block(wait), f.deps);
  assert.equal(outcome.block.outcome, 'pass');
  assert.deepEqual(outcome.rows.at(-1)?.selector, { id: ID });
  assert.deepEqual(f.actions, []);
});

test('G7: an unresolved newer text observation withholds duplicate advice', async () => {
  const last = { ...siblings(), unresolvedText: [ID] };
  assert.equal(targetEvidence(quoted, last), 'unsure');
  const f = withRecoveredScreen(last);
  const outcome = await walkBlock(block(wait), f.deps);
  assert.match(seen(outcome), /2 elements carry the identifier/);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(outcome.failure?.subreason, 'present-but-unavailable');
  assert.ok(outcome.failure?.screen);
  assert.match(outcome.failure?.suggestion ?? '', genericSuggestion);
});

function overlayRead(withText: boolean): Screen {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const spec: [string, number | undefined, Rect, string?, string?][] = [
    ['Application', undefined, full],
    ['Window', 0, full],
    ['Other', 1, full],
    ['Other', 2, rect(0, 0, 402, 792)],
    ['ScrollView', 3, rect(0, 20, 402, 762)],
    ['Other', 4, rect(0, 20, 402, 762)],
    ['StaticText', 5, rect(21, 249, 360, 56), 'unique-row', withText ? ID : 'Earlier row'],
    ['Other', 2, full, ID, 'Fixture header'],
    ['Other', 2, inner, ID, 'Fixture body'],
  ];
  return projectedScreen(
    spec.map(([type, parentIndex, frame, identifier, label]) => ({
      type,
      parentIndex,
      rect: frame,
      identifier,
      label,
    })),
  );
}

async function waitHitsAtDeadline(recoverRead?: Screen) {
  let now = 0;
  let recoveries = 0;
  const probed: string[] = [];
  const f = fake(() => overlayRead(false));
  f.deps.now = () => ++now;
  f.deps.sleep = async (ms) => {
    now += ms;
  };
  f.deps.captureScreen = async (options) => {
    if (options?.platformPresence) {
      recoveries += 1;
      if (recoverRead) return recoverRead;
      throw new CaptureDeadline();
    }
    return overlayRead(now >= 14_500);
  };
  f.deps.hitProbe = async (ref, context) => {
    probed.push(ref);
    assert.ok(context);
    now = context.deadline - 2;
    return 'hittable';
  };
  f.deps.hideDevMenu = async () => ({ ok: false });
  const outcome = await walkBlock(block(wait), f.deps);
  assert.equal(recoveries, 1);
  assert.deepEqual(probed, ['@6']);
  assert.equal(outcome.block.outcome, 'fail');
  assert.match(seen(outcome), /2 elements carry the identifier/);
  assert.deepEqual(
    outcome.rows
      .at(-1)
      ?.overlayChecks?.map(({ observation, liveHit }) => ({ observation, liveHit })),
    [{ observation: 30, liveHit: 'hittable' }],
  );
  assert.ok(outcome.failure?.screen);
  assert.deepEqual(f.actions, []);
  return outcome;
}

test('G8: admitted same-read live hit supports exact text even if the Wait runs out of time', async () => {
  const last = overlayRead(true);
  assert.equal(targetEvidence(quoted, last), 'fail');
  const hits = new OverlayHits(last);
  hits.set(last.elements.find((entry) => entry.ref === '@6')!, 'hittable');
  assert.equal(targetEvidence(quoted, last, hits), 'pass');
  assert.equal(aggregateTargetVisible(quoted, last, hits), false);
  const outcome = await waitHitsAtDeadline();
  assert.equal(outcome.failure?.subreason, 'present-but-unavailable');
  assert.ok(outcome.failure?.screen);
  assert.match(outcome.failure?.suggestion ?? '', genericSuggestion);
});

test('F5: a newly admitted recovery screen does not inherit the live hit', async () => {
  const last = overlayRead(true);
  assert.equal(targetEvidence(quoted, last), 'fail');
  const outcome = await waitHitsAtDeadline(last);
  assert.equal(outcome.failure?.subreason, 'duplicate-id');
  assert.match(outcome.failure?.suggestion ?? '', /other at 0,0,402,874; other at 0,116,402,758/);
});
