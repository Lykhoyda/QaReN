// AI-473: a wrapper whose only content is one same-label control is that control; anything else stays ambiguous.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import type { Screen } from '../../../dist/qa/screen.js';
import type { ReactHostEvidence } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

type Rect = { x: number; y: number; width: number; height: number };
interface Spec {
  type: string;
  label?: string;
  id?: string;
  rect: Rect;
  // Index into the spec list; absent means the window.
  parent?: number;
  hittable?: boolean;
  enabled?: boolean;
  // The React host behind this node, with or without its own press handler.
  host?: { press: boolean };
}

const OUTER: Rect = { x: 217, y: 62, width: 185, height: 56 };
const INNER: Rect = { x: 341, y: 70, width: 40, height: 40 };

// The recorded shape: a header item wrapping an icon button, both labelled "Close". React hosts are
// proven only through a unique testID, so the collapse needs one on each; the recorded no-id pair stays refused.
const recorded = (
  outerPress = false,
  ids: [string, string] | null = ['header-close', 'close-icon'],
): Spec[] => [
  {
    type: 'Button',
    label: 'Close',
    rect: OUTER,
    host: { press: outerPress },
    ...(ids ? { id: ids[0] } : {}),
  },
  {
    type: 'Button',
    label: 'Close',
    rect: INNER,
    parent: 0,
    host: { press: true },
    ...(ids ? { id: ids[1] } : {}),
  },
];

async function capture(specs: Spec[], hosts = true): Promise<Screen> {
  const base = nativeCapture();
  const presence = (index: number) => ({
    ...base.nodes[1].presence,
    nodeIndex: index,
  });
  const nodes: Record<string, unknown>[] = [
    base.nodes[0],
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Window',
      enabled: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
      presence: presence(1),
    },
  ];
  specs.forEach((spec, i) => {
    const index = i + 2;
    const parentIndex = spec.parent === undefined ? 1 : spec.parent + 2;
    nodes.push({
      ref: `@e${index}`,
      index,
      depth: (nodes[parentIndex].depth as number) + 1,
      parentIndex,
      type: spec.type,
      ...(spec.label ? { label: spec.label } : {}),
      ...(spec.id ? { identifier: spec.id } : {}),
      enabled: spec.enabled ?? true,
      hittable: spec.hittable ?? true,
      rect: spec.rect,
      presence: presence(index),
    });
  });
  base.nodes = nodes as typeof base.nodes;
  base.snapshotVerdict.nodeCount = nodes.length;
  const hostOf = new Map<number, number>();
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [],
    },
  };
  specs.forEach((spec, i) => {
    if (!spec.host) return;
    let parent: number | undefined = spec.parent;
    while (parent !== undefined && !hostOf.has(parent)) parent = specs[parent].parent;
    const hostIndex = evidence.hosts.length;
    hostOf.set(i, hostIndex);
    evidence.hosts.push({
      ...(spec.id ? { testID: spec.id } : {}),
      role: null,
      roleSource: 'none',
      capabilities: spec.host.press ? { press: true } : {},
    });
    evidence.typography!.nodes.push({
      hostIndex,
      parentHostIndex: parent === undefined ? null : hostOf.get(parent)!,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: spec.rect,
      text: { kind: 'none' },
    });
  });
  return captureScreen({
    appId: 'com.test',
    native: async () => base,
    react: async () => ({
      interactive: [],
      ...(hosts ? { hostEvidence: evidence } : {}),
      verdict: { state: 'ok', path: 'interactive', complete: hosts },
    }),
  });
}

const tap = (quoted = 'Close', exact?: 'id' | 'text') => ({
  kind: 'press' as const,
  target: { phrase: quoted, quoted, ...(exact ? { exact } : {}) },
});

function ambiguous(result: ReturnType<typeof prepareTarget>): string {
  assert.ok('refuse' in result && result.refuse === 'TARGET_AMBIGUOUS', JSON.stringify(result));
  return result.reason;
}

test('the recorded Close wrapper without its own press handler collapses to the inner button', async () => {
  const screen = await capture(recorded());
  for (const exact of [undefined, 'text'] as const) {
    const result = prepareTarget(tap('Close', exact), screen);
    assert.ok('ref' in result, JSON.stringify(result));
    assert.equal(result.ref, '@e3');
    assert.deepEqual(result.collapsed, [{ ref: '@e2', kind: 'button', frame: OUTER, into: '@e3' }]);
  }
});

test('the recorded no-id pair cannot prove the wrapper has no handler: refused, naming the nesting', async () => {
  const reason = ambiguous(prepareTarget(tap(), await capture(recorded(false, null))));
  assert.match(
    reason,
    /candidates: button no-id frame=217,62,185,56 native; button no-id frame=341,70,40,40 native nested inside candidate 1$/,
  );
});

test('a shared testID leaves the hosts unproven, so an id target stays ambiguous', async () => {
  const reason = ambiguous(
    prepareTarget(tap('close', 'id'), await capture(recorded(false, ['close', 'close']))),
  );
  assert.match(reason, /id=close frame=341,70,40,40 native nested inside candidate 1$/);
});

test('without React host evidence the nested pair stays ambiguous', async () => {
  assert.match(
    ambiguous(prepareTarget(tap(), await capture(recorded(), false))),
    /nested inside candidate 1$/,
  );
});

test('a wrapper with its own press handler is a second action and stays ambiguous', async () => {
  assert.match(
    ambiguous(prepareTarget(tap(), await capture(recorded(true)))),
    /nested inside candidate 1/,
  );
});

test('a wrapper with any other content stays ambiguous', async () => {
  for (const sibling of [
    { type: 'Image', rect: { x: 225, y: 70, width: 40, height: 40 }, parent: 0 },
    {
      type: 'StaticText',
      label: 'Done',
      rect: { x: 270, y: 70, width: 60, height: 40 },
      parent: 0,
    },
    {
      type: 'Button',
      label: 'Help',
      rect: { x: 225, y: 70, width: 40, height: 40 },
      parent: 0,
      host: { press: true },
    },
  ] satisfies Spec[])
    ambiguous(prepareTarget(tap(), await capture([...recorded(), sibling])));
});

test('an inner control that a user cannot press never collapses, and never resolves to the outer', async () => {
  for (const change of [{ hittable: false }, { enabled: false }, { rect: { ...INNER, y: 900 } }])
    ambiguous(
      prepareTarget(
        tap(),
        await capture(recorded().map((spec, i) => (i === 1 ? { ...spec, ...change } : spec))),
      ),
    );
});

test('geometry must prove the inner strictly inside the outer', async () => {
  for (const rect of [
    { ...INNER, x: 362 }, // touches the right edge
    { ...INNER, width: 0 },
    { ...INNER, x: 400 }, // spills past the outer
  ])
    ambiguous(
      prepareTarget(
        tap(),
        await capture(recorded().map((spec, i) => (i === 1 ? { ...spec, rect } : spec))),
      ),
    );
});

test('sibling ancestry is not nesting even when the frames enclose', async () => {
  const reason = ambiguous(
    prepareTarget(
      tap(),
      await capture(recorded().map((spec, i) => (i === 1 ? { ...spec, parent: undefined } : spec))),
    ),
  );
  assert.doesNotMatch(reason, /nested/);
});

test('a three-level chain of wrappers collapses to the innermost control', async () => {
  const screen = await capture([
    {
      type: 'Button',
      label: 'Close',
      id: 'bar',
      rect: { x: 200, y: 50, width: 200, height: 80 },
      host: { press: false },
    },
    { type: 'Button', label: 'Close', id: 'item', rect: OUTER, parent: 0, host: { press: false } },
    { type: 'Button', label: 'Close', id: 'icon', rect: INNER, parent: 1, host: { press: true } },
  ]);
  const result = prepareTarget(tap(), screen);
  assert.ok('ref' in result, JSON.stringify(result));
  assert.equal(result.ref, '@e4');
  assert.deepEqual(
    result.collapsed?.map(({ ref, into }) => [ref, into]),
    [
      ['@e3', '@e4'],
      ['@e2', '@e4'],
    ],
  );
});

test('a collapsed pair beside a third same-label control stays ambiguous', async () => {
  ambiguous(
    prepareTarget(
      tap(),
      await capture([
        ...recorded(),
        {
          type: 'Button',
          label: 'Close',
          id: 'footer-close',
          rect: { x: 20, y: 700, width: 100, height: 40 },
          host: { press: true },
        },
      ]),
    ),
  );
});

test('two same-label inner branches stay ambiguous', async () => {
  ambiguous(
    prepareTarget(
      tap(),
      await capture([
        ...recorded(),
        {
          type: 'Button',
          label: 'Close',
          id: 'second-icon',
          rect: { ...INNER, x: 230 },
          parent: 0,
          host: { press: true },
        },
      ]),
    ),
  );
});

test('capture order does not change the collapse', async () => {
  // The inner listed before an unrelated control, then the outer's other descendants: same result.
  const specs = recorded();
  const screen = await capture([
    { type: 'StaticText', label: 'Title', rect: { x: 20, y: 70, width: 100, height: 40 } },
    ...specs.map((spec) => ({ ...spec, ...(spec.parent === undefined ? {} : { parent: 1 }) })),
  ]);
  const result = prepareTarget(tap(), screen);
  assert.ok('ref' in result, JSON.stringify(result));
  assert.equal(result.ref, '@e4');
});
