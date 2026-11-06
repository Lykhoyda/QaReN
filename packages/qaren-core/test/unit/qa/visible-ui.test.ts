// AI-474: count only what a user can see and tap; exclude a duplicate only on proof, probe the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join, reachOf } from '../../../dist/qa/screen.js';
import type { NativeNode, Screen } from '../../../dist/qa/screen.js';
import { contend, prepareTarget } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { HitProbeResult } from '../../../dist/qa/live-hit.js';
import { element, scriptedJudge, walker } from './judgment-fixtures.ts';

type Rect = { x: number; y: number; width: number; height: number };
const SCREEN: Rect = { x: 0, y: 0, width: 402, height: 874 };
const LIST: Rect = { x: 0, y: 100, width: 402, height: 600 };
const VISIBLE: Rect = { x: 20, y: 200, width: 120, height: 44 };

// A window holding a scroll list; `rows` are buttons inside the list, `loose` are direct window children.
function screen(
  rows: Array<Partial<NativeNode> & { rect: Rect }>,
  loose: NativeNode[] = [],
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@e0', index: 0, type: 'Application', rect: SCREEN },
    { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: SCREEN },
    { ref: '@e2', index: 2, parentIndex: 1, type: 'ScrollView', rect: LIST },
  ];
  for (const row of rows)
    nodes.push({
      type: 'Button',
      label: 'Close',
      hittable: true,
      parentIndex: 2,
      ...row,
      ref: `@e${nodes.length}`,
      index: nodes.length,
    });
  for (const node of loose)
    nodes.push({
      ...node,
      ref: `@e${nodes.length}`,
      index: nodes.length,
      parentIndex: node.parentIndex ?? 1,
    });
  const joined = join(nodes, [], 'app', { native: 'complete', react: 'complete' });
  joined.nativeGeneration = 7;
  return joined;
}

const tap = { kind: 'press' as const, target: { phrase: 'Close', quoted: 'Close' } };

test('reach names what a user can reach, from frames alone', () => {
  const s = screen(
    [
      { rect: VISIBLE },
      { rect: { ...VISIBLE, y: 760 } }, // below the list's viewport, still on screen
      { rect: { ...VISIBLE, y: 680 } }, // straddles the viewport's bottom edge
    ],
    [
      { ref: '', type: 'Button', label: 'Away', rect: { ...VISIBLE, x: 500 } },
      { ref: '', type: 'Button', label: 'Nowhere' },
    ],
  );
  assert.deepEqual(s.elements.slice(3).map(reachOf), [
    'reachable',
    'clipped-by-viewport',
    'reachable',
    'offscreen-by-frame',
    'unknown',
  ]);
});

test('a duplicate whose whole frame is clipped is excluded, and the exclusion is recorded', () => {
  const result = prepareTarget(tap, screen([{ rect: VISIBLE }, { rect: { ...VISIBLE, y: 760 } }]));
  assert.ok('ref' in result, JSON.stringify(result));
  assert.equal(result.ref, '@e3');
  assert.deepEqual(result.candidateExclusions, [
    { ref: '@e4', kind: 'button', frame: { ...VISIBLE, y: 760 }, reason: 'clipped-by-viewport' },
  ]);
});

test('a partly exposed duplicate stays in contention', () => {
  const result = prepareTarget(tap, screen([{ rect: VISIBLE }, { rect: { ...VISIBLE, y: 680 } }]));
  assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  assert.deepEqual(result.contenders, ['@e3', '@e4']);
});

for (const type of ['ScrollView', 'android.widget.ScrollView']) {
  for (const axis of ['x', 'y'] as const) {
    test(`${type} excludes a duplicate in an empty nested ${axis} viewport`, () => {
      const frame = { x: 100, y: 100, width: 50, height: 50, [axis]: 280 };
      const s = join(
        [
          { ref: '@e0', index: 0, type: 'Application', rect: SCREEN },
          { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: SCREEN },
          {
            ref: '@e2',
            index: 2,
            parentIndex: 1,
            type,
            rect: { x: 100, y: 100, width: 100, height: 100 },
          },
          {
            ref: '@e3',
            index: 3,
            parentIndex: 2,
            type,
            rect: { x: 100, y: 100, width: 100, height: 100, [axis]: 300 },
          },
          {
            ref: '@e4',
            index: 4,
            parentIndex: 3,
            type: 'Button',
            label: 'Close',
            hittable: true,
            rect: frame,
          },
          {
            ref: '@e5',
            index: 5,
            parentIndex: 1,
            type: 'Button',
            label: 'Close',
            hittable: true,
            rect: VISIBLE,
          },
        ],
        [],
        'app',
        { native: 'complete', react: 'complete' },
      );
      assert.equal(reachOf(s.elements[4]), 'clipped-by-viewport');
      const result = prepareTarget(tap, s);
      assert.ok('ref' in result, JSON.stringify(result));
      assert.equal(result.ref, '@e5');
      assert.deepEqual(result.candidateExclusions, [
        { ref: '@e4', kind: 'button', frame, reason: 'clipped-by-viewport' },
      ]);
    });
  }
}

test('a duplicate under the keyboard is excluded only when its whole frame is covered', () => {
  const keyboard: NativeNode = {
    ref: '',
    type: 'Keyboard',
    rect: { x: 0, y: 560, width: 402, height: 314 },
  };
  const covered = screen(
    [{ rect: VISIBLE }],
    [
      { ref: '', type: 'Button', label: 'Close', hittable: true, rect: { ...VISIBLE, y: 600 } },
      keyboard,
    ],
  );
  const result = prepareTarget(tap, covered);
  assert.ok('ref' in result, JSON.stringify(result));
  assert.equal(result.candidateExclusions?.[0].reason, 'under-keyboard');
  const straddling = screen(
    [{ rect: VISIBLE }],
    [
      { ref: '', type: 'Button', label: 'Close', hittable: true, rect: { ...VISIBLE, y: 540 } },
      keyboard,
    ],
  );
  assert.ok('refuse' in prepareTarget(tap, straddling));
});

test('a later window over a candidate is a hint, never an exclusion', () => {
  const s = screen(
    [{ rect: VISIBLE }],
    [
      { ref: '', type: 'Window', rect: SCREEN, parentIndex: 0 },
      // The later window's own Close; the list's Close sits behind that window.
      {
        ref: '',
        type: 'Button',
        label: 'Close',
        hittable: true,
        parentIndex: 4,
        rect: { ...VISIBLE, y: 300 },
      },
    ],
  );
  const result = prepareTarget(tap, s);
  assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  assert.equal(result.contenders?.length, 2);
});

test('when every duplicate is excluded the step is not found and names each exclusion', () => {
  const result = prepareTarget(
    tap,
    screen([{ rect: { ...VISIBLE, y: 760 } }, { rect: { ...VISIBLE, y: 800 } }]),
  );
  assert.ok('refuse' in result && result.refuse === 'TARGET_NOT_FOUND', JSON.stringify(result));
  assert.equal(result.missing, undefined);
  assert.match(
    result.reason,
    /excluded: button no-id frame=20,760,120,44 native \(clipped-by-viewport\)/,
  );
});

test('ambiguity lists excluded candidates with their reasons', () => {
  const result = prepareTarget(
    tap,
    screen([{ rect: VISIBLE }, { rect: { ...VISIBLE, y: 680 } }, { rect: { ...VISIBLE, y: 760 } }]),
  );
  assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  assert.match(
    result.reason,
    /candidates: button no-id frame=20,200,120,44 native; button no-id frame=20,680,120,44 native; excluded: button no-id frame=20,760,120,44 native \(clipped-by-viewport\)$/,
  );
});

// Walker: duplicates the runner can identify are probed live, inside the observation's expiry.
function probing(
  s: Screen,
  results: Record<string, HitProbeResult>,
  platform: 'ios' | 'android' = 'ios',
) {
  const w = walker(
    [s],
    scriptedJudge(() => assert.fail('exact targets are model-free')),
  );
  const probes: string[] = [];
  w.deps.platform = platform;
  w.deps.hitProbe = async (ref, _context, generation, identity) => {
    assert.equal(generation, 7);
    assert.ok(identity.identifier || identity.label);
    probes.push(ref);
    return results[ref] ?? 'unavailable';
  };
  // The ledger row for the tap, with its reason; streamed rows are value-free.
  const run = async () => {
    const result = await runPlan(parsePlan('1. Tap "Close"').blocks!, w.deps);
    const row = ('steps' in result ? result.steps : []).find((r) => r.line === 1);
    assert.ok(row, JSON.stringify(result));
    return row;
  };
  return { ...w, probes, run };
}

const ids = (...names: string[]) =>
  names.map((identifier, i) => ({ identifier, rect: { ...VISIBLE, y: 200 + i * 60 } }));

test('a refused step keeps the exclusions the live read made', async () => {
  const [a, b] = ids('a', 'b');
  const f = probing(screen([{ ...a, enabled: false }, b]), { '@e4': 'not-hittable' });
  const row = await f.run();
  assert.deepEqual(f.actions, []);
  assert.match(String(row.reason), /TARGET_NOT_FOUND/);
  assert.deepEqual(
    row.candidateExclusions?.map(({ ref, reason }) => [ref, reason]),
    [['@e4', 'not-hittable']],
  );
});

test('a duplicate the live hit read proves untouchable is excluded and the other is pressed', async () => {
  const f = probing(screen(ids('a', 'b')), { '@e3': 'hittable', '@e4': 'not-hittable' });
  const row = await f.run();
  assert.deepEqual(f.probes, ['@e3', '@e4'], JSON.stringify(row));
  assert.deepEqual(f.actions, ['press @e3']);
  assert.deepEqual(row.candidateExclusions, [
    { ref: '@e4', kind: 'button', frame: { ...VISIBLE, y: 260 }, reason: 'not-hittable' },
  ]);
});

for (const kept of ['hittable', 'moved', 'unavailable'] as const)
  test(`a ${kept} live read keeps the duplicate, so the step stays ambiguous`, async () => {
    const f = probing(screen(ids('a', 'b')), { '@e3': 'hittable', '@e4': kept });
    const row = await f.run();
    assert.deepEqual(f.actions, []);
    assert.match(String(row.reason), /TARGET_AMBIGUOUS/);
  });

test('duplicates the runner cannot identify are not probed and the refusal says why', async () => {
  const f = probing(screen([{ rect: VISIBLE }, { rect: { ...VISIBLE, y: 260 } }]), {});
  const row = await f.run();
  assert.deepEqual(f.probes, []);
  assert.deepEqual(f.actions, []);
  assert.match(String(row.reason), /cannot probe/);
});

test('at most four duplicates are probed; the rest stay in contention', async () => {
  const f = probing(screen(ids('a', 'b', 'c', 'd', 'e')), {
    '@e3': 'not-hittable',
    '@e4': 'not-hittable',
    '@e5': 'not-hittable',
    '@e6': 'not-hittable',
  });
  await f.run();
  assert.equal(f.probes.length, 4);
  assert.deepEqual(f.actions, ['press @e7']);
});

test('no live read runs off iOS', async () => {
  const f = probing(screen(ids('a', 'b')), { '@e4': 'not-hittable' }, 'android');
  await f.run();
  assert.deepEqual(f.probes, []);
  assert.deepEqual(f.actions, []);
});

test('a probe that would outlive the observation does not run', async () => {
  const f = probing(screen(ids('a', 'b')), { '@e4': 'not-hittable' });
  let time = 0;
  f.deps.now = () => time;
  f.deps.hitProbe = async (ref) => {
    f.probes.push(ref);
    time += 60_000; // the first read spends the observation; its late verdict is not evidence
    return 'not-hittable';
  };
  const row = await f.run();
  assert.deepEqual(f.probes, ['@e3'], JSON.stringify(row));
  assert.deepEqual(f.actions, []);
  assert.equal(row.candidateExclusions, undefined);
});

for (const scenario of ['disabled', 'stored-label', 'wrong-kind', 'react-only'] as const) {
  test(`frame exclusion facts survive a ${scenario} survivor refusal`, () => {
    const s = screen([
      { rect: VISIBLE, identifier: 'Close' },
      { rect: { ...VISIBLE, y: 760 }, identifier: 'Close' },
    ]);
    const survivor = s.elements[3];
    if (scenario === 'disabled' || scenario === 'stored-label') survivor.disabled = true;
    if (scenario === 'react-only') {
      survivor.ref = 'react:input';
      survivor.kind = 'input';
    }
    const step =
      scenario === 'wrong-kind' || scenario === 'react-only'
        ? { kind: 'fill' as const, target: tap.target, text: 'x' }
        : scenario === 'stored-label'
          ? { ...tap, target: { ...tap.target, exact: 'text' as const } }
          : tap;
    const result = prepareTarget(step, s);
    assert.ok('refuse' in result, JSON.stringify(result));
    assert.equal(
      result.refuse,
      scenario === 'stored-label' ? 'REPLAY_SELECTOR' : 'TARGET_NOT_FOUND',
    );
    assert.deepEqual(result.candidateExclusions, [
      { ref: '@e4', kind: 'button', frame: { ...VISIBLE, y: 760 }, reason: 'clipped-by-viewport' },
    ]);
  });
}

test('scroll resolutions retain frame and live exclusion facts', () => {
  const s = screen([{ rect: { ...VISIBLE, y: 760 } }]);
  const survivor = element('@e4', 'Close', { offscreen: true, hittable: false });
  s.elements.push(survivor);
  const result = prepareTarget(tap, s);
  assert.ok('scroll' in result, JSON.stringify(result));
  assert.equal(result.element, survivor);
  assert.deepEqual(result.candidateExclusions, [
    { ref: '@e3', kind: 'button', frame: { ...VISIBLE, y: 760 }, reason: 'clipped-by-viewport' },
  ]);
  const facts = [{ ref: '@e3', kind: 'button' as const, reason: 'not-hittable' as const }];
  const collapsed = [{ ref: '@e5', kind: 'button' as const, into: '@e4' }];
  const live = contend(tap, s, [survivor], facts, collapsed);
  assert.ok('scroll' in live, JSON.stringify(live));
  assert.deepEqual(live.candidateExclusions, facts);
  assert.deepEqual(live.collapsed, collapsed);
});
