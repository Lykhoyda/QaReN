// A pressable whose label only echoes its single text child is one control; distinct same-label controls stay ambiguous.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from '../../../dist/qa/screen.js';
import { literalEvidence } from '../../../dist/qa/evidence.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { prepareTarget, targetVisible, visibleSelector } from '../../../dist/qa/resolve.js';
import { exactIdentities } from '../../../dist/qa/identity.js';
import { refreshRef } from '../../../dist/fast-runner-ref-map.js';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';
import { nativeCapture } from './platform-presence-fixtures.ts';

const app = (): NativeNode[] => [
  { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
  {
    ref: '@win',
    index: 1,
    parentIndex: 0,
    type: 'Window',
    rect: { x: 0, y: 0, width: 402, height: 874 },
  },
];

function pressable(
  nodes: NativeNode[],
  options: { id?: string; y: number; texts: string[] },
): NativeNode[] {
  const parent = nodes.length;
  const out = [
    ...nodes,
    {
      ref: `@p${parent}`,
      index: parent,
      parentIndex: 1,
      type: 'Other',
      label: 'Skip',
      hittable: true,
      rect: { x: 20.4, y: options.y, width: 350.2, height: 48 },
      ...(options.id ? { identifier: options.id } : {}),
    },
  ];
  options.texts.forEach((label, i) =>
    out.push({
      ref: `@t${parent}-${i}`,
      index: out.length,
      parentIndex: parent,
      type: 'StaticText',
      label,
      hittable: true,
      rect: { x: 150, y: options.y + 12, width: 60, height: 24 },
    }),
  );
  return out;
}

const press = { kind: 'press' as const, target: { phrase: 'Skip', quoted: 'Skip' } };

function nestedTitle(): NativeNode[] {
  const rect = { x: 20, y: 100, width: 300, height: 24 };
  return [
    ...app(),
    {
      ref: '@title',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      identifier: 'qa-acceptance-start-title',
      label: 'Device pane baseline',
      hittable: true,
      rect,
    },
    {
      ref: '@echo',
      index: 3,
      parentIndex: 2,
      type: 'StaticText',
      label: 'Device pane baseline',
      hittable: true,
      rect,
    },
  ];
}

for (const verified of [false, true]) {
  test(`nested unidentified title text is one identity with verified=${verified}`, () => {
    const nodes = nestedTitle();
    const capture = nativeCapture();
    const observed = nodes.map((node) => ({
      ...node,
      depth: node.index!,
      enabled: true,
      presence: { ...capture.nodes[1].presence, nodeIndex: node.index! },
    }));
    const presence = verified
      ? validateNativePresence(capture.presenceCapture, observed, 7, 'com.test', 20_000)
      : undefined;
    if (verified) assert.ok(presence);
    const screen = join(verified ? observed : nodes, [], 'app', undefined, undefined, presence);
    for (const quoted of ['Device pane baseline', 'qa-acceptance-start-title']) {
      for (const exact of [undefined, quoted === 'Device pane baseline' ? 'text' : 'id'] as const) {
        const target = { quoted, phrase: quoted, exact };
        for (const kind of ['press', 'wait', 'scroll'] as const) {
          const step =
            kind === 'scroll'
              ? { kind, until: target, direction: 'down' as const }
              : { kind, target };
          assert.equal(exactIdentities(screen, target, kind).length, 1);
          const resolved = prepareTarget(step, screen);
          assert.ok('ref' in resolved, JSON.stringify(resolved));
          assert.equal(resolved.ref, '@title');
        }
        assert.equal(targetVisible(target, screen), true);
        assert.deepEqual(
          visibleSelector(target, screen),
          exact === 'text' ? { text: 'Device pane baseline' } : { id: 'qa-acceptance-start-title' },
        );
      }
    }
    const refreshed = refreshRef({ type: 'StaticText', label: 'Device pane baseline' }, nodes);
    assert.equal(refreshed.kind, 'unique');
    if (refreshed.kind === 'unique') assert.equal(refreshed.node.ref, '@title');
  });
}

for (const patch of [
  { parentIndex: 1 },
  { identifier: 'distinct-title' },
  { rect: { x: 20, y: 150, width: 300, height: 24 } },
  { enabled: false },
]) {
  test(`distinct same-label text remains ambiguous: ${JSON.stringify(patch)}`, () => {
    const nodes = nestedTitle();
    nodes[3] = { ...nodes[3], ...patch };
    const screen = join(nodes, []);
    const target = { quoted: 'Device pane baseline', phrase: 'Device pane baseline' };
    assert.equal(exactIdentities(screen, target, 'press').length, 2);
    const resolved = prepareTarget({ kind: 'press', target }, screen);
    assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS');
    assert.equal(visibleSelector(target, screen), undefined);
    assert.equal(refreshRef({ type: 'StaticText', label: target.quoted }, nodes).kind, 'ambiguous');
  });
}

test('nested text echoes do not split their enclosing pressable identity', () => {
  const nodes = nestedTitle();
  nodes[2] = { ...nodes[2], type: 'Other' };
  nodes.push({ ...nodes[3], ref: '@inner-echo', index: 4, parentIndex: 3 });
  const screen = join(nodes, []);
  const target = { quoted: 'Device pane baseline', phrase: 'Device pane baseline' };
  const resolved = prepareTarget({ kind: 'press', target }, screen);
  assert.ok('ref' in resolved);
  assert.equal(resolved.ref, '@title');
});

test('a pressable echoing its single text child resolves to the pressable', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@p2');
});

test('the echo collapses without a testID too, and its text stays visible', () => {
  const screen = join(pressable(app(), { y: 700, texts: ['Skip'] }), []);
  const resolved = prepareTarget(press, screen);
  assert.ok('ref' in resolved && resolved.ref === '@p2', JSON.stringify(resolved));
  assert.ok(screen.visibleText.includes('Skip'));
});

for (const hittable of [true, false]) {
  test(`nested label wrappers resolve to the nearest control with outer hittable=${hittable}`, () => {
    const nodes = pressable(app(), { y: 700, texts: [] });
    nodes[2].hittable = hittable;
    nodes.push(
      {
        ref: '@button',
        index: 3,
        parentIndex: 2,
        type: 'Button',
        label: 'Skip',
        hittable: true,
        rect: { x: 30, y: 705, width: 320, height: 40 },
      },
      {
        ref: '@text',
        index: 4,
        parentIndex: 3,
        type: 'StaticText',
        label: 'Skip',
        hittable: true,
        rect: { x: 150, y: 712, width: 60, height: 24 },
      },
    );
    for (const node of nodes.slice(2)) node.identifier = 'Skip';
    const resolved = prepareTarget(press, join(nodes, []));
    assert.ok('ref' in resolved, JSON.stringify(resolved));
    assert.equal(resolved.ref, '@button');

    const wrapped = nodes.map((node, i) => ({
      ...node,
      index: i >= 2 ? i + 1 : i,
      parentIndex:
        node.parentIndex !== undefined && node.parentIndex >= 2
          ? node.parentIndex + 1
          : node.parentIndex,
    }));
    wrapped.splice(2, 0, {
      ref: '@outer',
      index: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Skip',
      hittable: true,
      rect: { x: 10, y: 695, width: 380, height: 60 },
    });
    wrapped[3].parentIndex = 2;
    const multiplyWrapped = prepareTarget(press, join(wrapped, []));
    assert.ok('ref' in multiplyWrapped, JSON.stringify(multiplyWrapped));
    assert.equal(multiplyWrapped.ref, '@button');
    wrapped[2].identifier = 'Skip';
    for (const exact of [undefined, 'id', 'text'] as const) {
      const target = { ...press.target, exact };
      const screen = join(wrapped, []);
      assert.equal(exactIdentities(screen, target, 'press').length, 1);
      for (const kind of ['press', 'wait', 'scroll'] as const) {
        const step =
          kind === 'scroll'
            ? { kind, until: target, direction: 'down' as const }
            : { kind, target };
        const resolution = prepareTarget(step, screen);
        assert.ok('ref' in resolution, JSON.stringify(resolution));
        assert.equal(resolution.ref, '@button');
      }
      assert.equal(targetVisible(target, screen), true);
      assert.deepEqual(
        visibleSelector(target, screen),
        exact === 'text' ? { text: 'Skip' } : { id: 'Skip' },
      );
    }
  });
}

for (const wrapper of ['layout', 'disabled', 'press-capable'] as const) {
  test(`a Button around a ${wrapper} wrapper retains the nearest actionable identity`, () => {
    const nodes: NativeNode[] = [
      ...app(),
      {
        ref: '@button',
        index: 2,
        parentIndex: 1,
        type: 'Button',
        label: 'Skip',
        identifier: 'Skip',
        hittable: true,
        rect: { x: 20, y: 700, width: 350, height: 48 },
      },
      {
        ref: '@layout',
        index: 3,
        parentIndex: 2,
        type: 'Other',
        label: 'Skip',
        identifier: 'layout',
        hittable: wrapper === 'disabled',
        enabled: wrapper !== 'disabled',
        rect: { x: 30, y: 705, width: 320, height: 40 },
      },
      {
        ref: '@text',
        index: 4,
        parentIndex: 3,
        type: 'StaticText',
        label: 'Skip',
        hittable: true,
        rect: { x: 150, y: 712, width: 60, height: 24 },
      },
    ];
    const screen = join(
      nodes,
      wrapper === 'press-capable'
        ? [{ testID: 'layout', role: 'button', capabilities: { press: true } }]
        : [],
    );
    for (const exact of [undefined, 'text'] as const) {
      const target = { ...press.target, exact };
      const identities = exactIdentities(screen, target, 'press');
      assert.equal(identities.length, 1);
      assert.equal(identities[0].element.ref, '@button');
      const resolved = prepareTarget({ ...press, target }, screen);
      assert.ok('ref' in resolved, JSON.stringify(resolved));
      assert.equal(resolved.ref, '@button');
      assert.equal(targetVisible(target, screen), true);
      assert.deepEqual(
        visibleSelector(target, screen),
        exact === 'text' ? { text: 'Skip' } : { id: 'Skip' },
      );
    }
  });
}

for (const [y, direction] of [
  [-100, 'up'],
  [1000, 'down'],
] as const) {
  test(`a nearest offscreen label ancestor remains reachable by scrolling ${direction}`, () => {
    const nodes = pressable(app(), { y: 700, texts: [] });
    nodes.push(
      {
        ref: '@offscreen',
        index: 3,
        parentIndex: 2,
        type: 'Other',
        label: 'Skip',
        hittable: false,
        rect: { x: 30, y, width: 320, height: 40 },
      },
      {
        ref: '@text',
        index: 4,
        parentIndex: 3,
        type: 'StaticText',
        label: 'Skip',
        hittable: false,
        rect: { x: 150, y: y + 12, width: 60, height: 24 },
      },
    );
    const screen = join(nodes, []);
    for (const exact of [undefined, 'text'] as const) {
      const target = { ...press.target, exact };
      assert.equal(exactIdentities(screen, target, 'press')[0].element.ref, '@offscreen');
      assert.deepEqual(prepareTarget({ ...press, target }, screen), {
        scroll: direction,
        element: exactIdentities(screen, target, 'press')[0].element,
      });
    }
  });
}

test('a Skip pressable and a separate inline Skip link stay ambiguous', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] });
  nodes.push({
    ref: '@link',
    index: nodes.length,
    parentIndex: 1,
    type: 'Link',
    label: 'Skip',
    hittable: true,
    rect: { x: 150, y: 780, width: 60, height: 24 },
  });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  const listed = resolved.reason.slice(resolved.reason.indexOf('candidates: '));
  assert.equal(
    listed,
    'candidates: other id=consent-skip frame=20,700,350,48 native; link no-id frame=150,780,60,24 native',
  );
});

test('two distinct Skip controls stay ambiguous and list value-free candidates', () => {
  const nodes = pressable(pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip'] }), {
    y: 780,
    texts: ['Skip'],
  });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  const listed = resolved.reason.slice(resolved.reason.indexOf('candidates'));
  assert.match(listed, /other id=consent-skip frame=20,700,350,48/);
  assert.match(listed, /other no-id frame=20,780,350,48/);
  assert.equal(listed.includes('Skip'), false, listed);
  const replayed = prepareTarget(
    { ...press, target: { ...press.target, exact: 'text' } },
    join(nodes, []),
  );
  assert.ok(
    'refuse' in replayed && replayed.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(replayed),
  );
  assert.equal(refreshRef({ type: 'Button', label: 'Skip' }, nodes).kind, 'ambiguous');
});

test('a pressable with more than one text descendant is not an echo', () => {
  const nodes = pressable(app(), { id: 'consent-skip', y: 700, texts: ['Skip', 'for now'] });
  const resolved = prepareTarget(press, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
  assert.match(resolved.reason, /text no-id frame=150,712,60,24/);
});

// Android: a titled card is a button whose header-role text repeats its label beside other text.
const complete = { native: 'complete', react: 'complete' } as const;
function androidCard(heading?: boolean): NativeNode[] {
  const display = { x: 0, y: 0, width: 1080, height: 2400 };
  const node = (index: number, parentIndex: number, type: string, label: string, y: number) => ({
    ref: `@e${index}`,
    index,
    parentIndex,
    type,
    label,
    rect: { x: 84, y, width: 828, height: 61 },
    enabled: true,
    visibleToUser: true,
    hittable: true,
  });
  return [
    { ref: '@e0', index: 0, type: 'Application', rect: display, enabled: true },
    { ref: '@e1', index: 1, parentIndex: 0, type: 'Window', rect: display, enabled: true },
    {
      ...node(2, 1, 'android.widget.Button', 'Card 1', 581),
      identifier: 'qa-capture-row-one-1',
      rect: { x: 42, y: 581, width: 996, height: 437 },
    },
    { ...node(3, 2, 'android.view.View', 'Card 1', 623), ...(heading ? { heading } : {}) },
    node(4, 2, 'android.widget.TextView', 'Ready', 700),
    node(5, 2, 'android.widget.TextView', 'Collection notes', 780),
    node(6, 2, 'android.widget.TextView', 'A small idea', 860),
  ];
}

test('a card button pressed by its label folds in its same-label heading text', () => {
  const screen = join(androidCard(true), [], 'app', complete);
  assert.equal(screen.elements[3].kind, 'text');
  assert.ok(screen.visibleText.includes('Card 1'));
  assert.deepEqual(literalEvidence(screen, 'Card 1', 'contains'), { verdict: 'pass' });
  const target = { quoted: 'Card 1', phrase: 'Card 1' };
  assert.deepEqual(
    exactIdentities(screen, target, 'press').map((i) => i.element.ref),
    ['@e2'],
  );
  const resolved = prepareTarget({ kind: 'press', target }, screen);
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@e2');
});

test('a card without heading or aggregation provenance keeps both same-label identities', () => {
  const screen = join(androidCard(), [], 'app', complete);
  assert.equal(screen.elements[3].kind, 'other');
  const target = { quoted: 'Card 1', phrase: 'Card 1' };
  const resolved = prepareTarget({ kind: 'press', target }, screen);
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
});

test('a heading that differs from its card label stays its own text identity', () => {
  const nodes = androidCard(true);
  nodes[3] = { ...nodes[3], label: 'Card 1 title' };
  const resolved = prepareTarget(
    { kind: 'press', target: { quoted: 'Card 1 title', phrase: 'Card 1 title' } },
    join(nodes, [], 'app', complete),
  );
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@e3');
});

// iOS can expose, beside app-root, a hittable full-screen no-identifier container labelled like the first control.
function echoContainer(controls: number, contained = true): NativeNode[] {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@root',
      index: 1,
      parentIndex: 0,
      type: 'Other',
      identifier: 'app-root',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: '@echo',
      index: 2,
      parentIndex: 0,
      type: 'Other',
      label: 'Next',
      hittable: true,
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
  ];
  const parentIndex = contained ? 2 : 1;
  for (let i = 0; i < controls; i++)
    nodes.push({
      ref: `@next${i}`,
      index: nodes.length,
      parentIndex,
      type: 'Button',
      identifier: `onboarding-next-${i}`,
      label: 'Next',
      hittable: true,
      rect: { x: 293, y: 700 + i * 50, width: 88, height: 38 },
    });
  nodes.push(
    {
      ref: '@title',
      index: nodes.length,
      parentIndex,
      type: 'StaticText',
      label: 'Welcome',
      rect: { x: 24, y: 120, width: 300, height: 30 },
    },
    {
      ref: '@body',
      index: nodes.length + 1,
      parentIndex,
      type: 'StaticText',
      label: 'Plan your day',
      rect: { x: 24, y: 160, width: 300, height: 30 },
    },
  );
  return nodes;
}

const tapNext = { kind: 'press' as const, target: { phrase: 'Next', quoted: 'Next' } };

for (const contained of [true, false]) {
  test(`a descendant-labelled no-identifier container collapses only a tree-contained control (tree-contained=${contained})`, () => {
    const screen = join(echoContainer(1, contained), []);
    screen.elements[2].semantic!.nativePresence = {
      kind: 'other',
      labelSource: 'descendant',
      structural: false,
    };
    const resolved = prepareTarget(tapNext, screen);
    if (!contained) {
      assert.ok(
        'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
        JSON.stringify(resolved),
      );
      return;
    }
    assert.ok('ref' in resolved, JSON.stringify(resolved));
    assert.equal(resolved.ref, '@next0');
  });
}

test('frame containment without label provenance preserves ambiguity', () => {
  const nodes = echoContainer(1, false).map(({ parentIndex: _parentIndex, ...node }) => node);
  const resolved = prepareTarget(tapNext, join(nodes, []));
  assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS');
});

for (const tree of [true, false]) {
  test(`stacked unidentified labels require descendant evidence (tree=${tree})`, () => {
    const fullFrame = { x: 0, y: 0, width: 402, height: 874 };
    const nodes: NativeNode[] = [
      { ref: '@app', index: 0, type: 'Application', rect: fullFrame },
      {
        ref: '@root',
        index: 1,
        parentIndex: 0,
        type: 'Other',
        identifier: 'app-root',
        rect: fullFrame,
      },
      {
        ref: '@outer',
        index: 2,
        parentIndex: 0,
        type: 'Other',
        label: 'Skip',
        hittable: true,
        rect: fullFrame,
      },
      {
        ref: '@inner',
        index: 3,
        parentIndex: 2,
        type: 'Other',
        label: 'Skip',
        hittable: true,
        rect: fullFrame,
      },
      {
        ref: '@button',
        index: 4,
        parentIndex: 3,
        type: 'Button',
        identifier: 'consent-skip',
        label: 'Skip',
        hittable: true,
        rect: { x: 293, y: 700, width: 88, height: 38 },
      },
      {
        ref: '@text',
        index: 5,
        parentIndex: 4,
        type: 'StaticText',
        label: 'Skip',
        rect: { x: 305, y: 710, width: 60, height: 20 },
      },
    ];
    const observed = tree
      ? nodes
      : nodes
          .filter((node) => node.type !== 'StaticText')
          .map(({ parentIndex: _parentIndex, ...node }) => node);
    const resolved = prepareTarget(press, join(observed, []));
    if (!tree) {
      assert.ok('refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS');
      return;
    }
    assert.ok('ref' in resolved, JSON.stringify(resolved));
    assert.equal(resolved.ref, '@button');
    assert.equal(resolved.element.testID, 'consent-skip');
  });
}

test('a frame-contained sibling Other and Button remain ambiguous for press, replay and refresh', () => {
  const nodes = echoContainer(1, false);
  nodes[2].label = 'Skip';
  nodes[3].label = 'Skip';
  nodes[3].parentIndex = 0;
  const screen = join(nodes, []);
  for (const exact of [undefined, 'text'] as const) {
    const resolved = prepareTarget({ ...press, target: { ...press.target, exact } }, screen);
    assert.ok(
      'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
      JSON.stringify(resolved),
    );
  }
  assert.equal(refreshRef({ type: 'Button', label: 'Skip' }, nodes).kind, 'ambiguous');
});

test('a no-identifier container enclosing two same-label controls does not hide their ambiguity', () => {
  const resolved = prepareTarget(tapNext, join(echoContainer(2), []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
});

test('a tree-enclosing same-label control collapses to the innermost control', () => {
  const nodes = echoContainer(1);
  nodes[2] = { ...nodes[2], type: 'Button', identifier: 'page-card', rect: nodes[3].rect };
  const resolved = prepareTarget(tapNext, join(nodes, []));
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@next0');
});

test('a differently framed same-label ancestor without aggregation provenance stays ambiguous', () => {
  const nodes = echoContainer(1);
  nodes[2] = { ...nodes[2], type: 'Button', identifier: 'page-card' };
  const resolved = prepareTarget(tapNext, join(nodes, []));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
});

for (const android of [false, true]) {
  for (const buttonWrapper of [false, true]) {
    test(`${android ? 'Android' : 'iOS'}: same-frame Skip wrapper selects its inner button, buttonWrapper=${buttonWrapper}`, () => {
      const frame = { x: 332, y: 70, width: 54, height: 32 };
      const nodes: NativeNode[] = [
        ...app(),
        {
          ref: '@outer',
          index: 2,
          parentIndex: 1,
          type: android
            ? buttonWrapper
              ? 'android.widget.Button'
              : 'android.view.ViewGroup'
            : buttonWrapper
              ? 'Button'
              : 'Other',
          identifier: 'qa-skip-echo-outer',
          label: 'Skip',
          hittable: true,
          rect: frame,
        },
        {
          ref: '@inner',
          index: 3,
          parentIndex: 2,
          type: android ? 'android.widget.Button' : 'Button',
          identifier: 'qa-skip-echo-button',
          label: 'Skip',
          hittable: true,
          rect: { ...frame },
        },
      ];
      for (const labelSource of [undefined, 'direct'] as const) {
        const screen = join(nodes, []);
        if (labelSource)
          screen.elements[2].semantic!.nativePresence = {
            kind: screen.elements[2].kind,
            labelSource,
            structural: false,
          };
        for (const exact of [undefined, 'text'] as const) {
          const resolved = prepareTarget({ ...press, target: { ...press.target, exact } }, screen);
          assert.ok('ref' in resolved, JSON.stringify(resolved));
          assert.equal(resolved.ref, '@inner');
        }
        const explicit = prepareTarget(
          { ...press, target: { phrase: 'outer', quoted: 'qa-skip-echo-outer', exact: 'id' } },
          screen,
        );
        assert.ok('ref' in explicit, JSON.stringify(explicit));
        assert.equal(explicit.ref, '@outer');
      }
      const refreshed = refreshRef({ type: 'Button', label: 'Skip' }, nodes);
      assert.equal(refreshed.kind, 'unique');
      if (refreshed.kind === 'unique')
        assert.equal(refreshed.node.identifier, 'qa-skip-echo-button');
      const unavailable = prepareTarget(
        press,
        join(
          nodes.map((node, index) => (index === 3 ? { ...node, hittable: false } : node)),
          [],
        ),
      );
      assert.ok('refuse' in unavailable && unavailable.refuse === 'TARGET_AMBIGUOUS');
      nodes[3].parentIndex = 1;
      const unrelated = prepareTarget(press, join(nodes, []));
      assert.ok('refuse' in unrelated && unrelated.refuse === 'TARGET_AMBIGUOUS');
      assert.equal(refreshRef({ type: 'Button', label: 'Skip' }, nodes).kind, 'ambiguous');
    });
  }
}

for (const type of ['Other', 'Button']) {
  for (const container of [false, true]) {
    test(`identified nested ${type} Skip controls select the inner button (container=${container})`, () => {
      const nodes = app();
      if (container)
        nodes.push({
          ref: '@container',
          index: 2,
          parentIndex: 1,
          type: 'Other',
          label: 'Skip',
          hittable: true,
          rect: { x: 0, y: 0, width: 402, height: 874 },
        });
      const outer = nodes.length;
      nodes.push(
        {
          ref: '@outer',
          index: outer,
          parentIndex: container ? 2 : 1,
          type,
          identifier: 'qa-skip-echo-outer',
          label: 'Skip',
          hittable: true,
          rect: { x: 20, y: 700, width: 350, height: 48 },
        },
        {
          ref: '@inner',
          index: outer + 1,
          parentIndex: outer,
          type: 'Button',
          identifier: 'qa-skip-echo-button',
          label: 'Skip',
          hittable: true,
          rect: { x: 30, y: 705, width: 320, height: 40 },
        },
        {
          ref: '@text',
          index: outer + 2,
          parentIndex: outer + 1,
          type: 'StaticText',
          label: 'Skip',
          hittable: true,
          rect: { x: 150, y: 712, width: 60, height: 24 },
        },
      );
      const screen = join(nodes, []);
      for (const exact of [undefined, 'text'] as const) {
        const resolved = prepareTarget({ ...press, target: { ...press.target, exact } }, screen);
        assert.ok('ref' in resolved, JSON.stringify(resolved));
        assert.equal(resolved.ref, '@inner');
        assert.equal(resolved.element.testID, 'qa-skip-echo-button');
      }
      const explicit = prepareTarget(
        {
          ...press,
          target: { phrase: 'qa-skip-echo-outer', quoted: 'qa-skip-echo-outer', exact: 'id' },
        },
        screen,
      );
      assert.ok('ref' in explicit, JSON.stringify(explicit));
      assert.equal(explicit.ref, '@outer');
      const refreshed = refreshRef({ type: 'Button', label: 'Skip' }, nodes);
      assert.equal(refreshed.kind, 'unique');
      if (refreshed.kind === 'unique')
        assert.equal(refreshed.node.identifier, 'qa-skip-echo-button');
    });
  }
}

// F10 qa-merged-rows: label-only rows (`Item N, Status N`) and containers inheriting "Act" from their first child.
function mergedRows(rows: number[]): NativeNode[] {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      ref: '@scroll',
      index: 1,
      parentIndex: 0,
      type: 'ScrollView',
      identifier: 'qa-merged-rows',
      label: 'Act',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: '@content',
      index: 2,
      parentIndex: 1,
      type: 'Other',
      label: 'Act',
      rect: { x: 0, y: 0, width: 402, height: 1200 },
    },
    {
      ref: '@bar',
      index: 3,
      parentIndex: 2,
      type: 'Other',
      label: 'Act',
      rect: { x: 0, y: 0, width: 402, height: 76 },
    },
    {
      ref: '@act',
      index: 4,
      parentIndex: 3,
      type: 'Other',
      identifier: 'qa-merged-act',
      label: 'Act',
      hittable: true,
      rect: { x: 16, y: 16, width: 70, height: 44 },
    },
    {
      ref: '@act-text',
      index: 5,
      parentIndex: 4,
      type: 'StaticText',
      label: 'Act',
      rect: { x: 36, y: 28, width: 30, height: 20 },
    },
  ];
  for (const [position, n] of rows.entries())
    nodes.push({
      ref: `@row${n}`,
      index: nodes.length,
      parentIndex: 2,
      type: 'Other',
      identifier: `qa-merged-row-${n}`,
      label: `Item ${n}, Status ${n}`,
      hittable: true,
      rect: { x: 0, y: 120 + position * 80, width: 402, height: 80 },
    });
  return nodes;
}

const digest = (rows: number[]) => [
  { role: 'button', testID: 'qa-merged-act', capabilities: { press: true, fill: false } },
  ...rows.map((n) => ({
    role: 'button',
    testID: `qa-merged-row-${n}`,
    capabilities: { press: true, fill: false },
  })),
];

const tap = (quoted: string) => ({ kind: 'press' as const, target: { phrase: quoted, quoted } });

test('a re-kinded merged-label row keeps its accessibility-label evidence', () => {
  const screen = join(mergedRows([1, 2]), digest([1, 2]));
  assert.deepEqual(literalEvidence(screen, 'Item 2', 'contains'), { verdict: 'pass', label: true });
});

test('a quoted title equal to one segment of exactly one merged label taps that row', () => {
  const screen = join(mergedRows([1, 2, 12]), digest([1, 2, 12]));
  for (const [quoted, ref] of [
    ['Item 2', '@row2'],
    ['Item 1', '@row1'],
    ['Status 12', '@row12'],
  ] as const) {
    const resolved = prepareTarget(tap(quoted), screen);
    assert.ok('ref' in resolved, `${quoted}: ${JSON.stringify(resolved)}`);
    assert.equal(resolved.ref, ref);
  }
  const missing = prepareTarget(tap('Item'), screen);
  assert.ok('refuse' in missing && missing.refuse === 'TARGET_NOT_FOUND', JSON.stringify(missing));
});

test('a segment shared by two merged labels stays ambiguous', () => {
  const nodes = mergedRows([2]);
  nodes.push({
    ...nodes[nodes.length - 1],
    ref: '@row2b',
    index: nodes.length,
    identifier: 'qa-merged-row-2b',
    label: 'Item 2, Status 9',
    rect: { x: 0, y: 600, width: 402, height: 80 },
  });
  const resolved = prepareTarget(tap('Item 2'), join(nodes, digest([2])));
  assert.ok(
    'refuse' in resolved && resolved.refuse === 'TARGET_AMBIGUOUS',
    JSON.stringify(resolved),
  );
});

test('containers inheriting the first control label collapse into it on the F10 shape', () => {
  const resolved = prepareTarget(tap('Act'), join(mergedRows([1, 2]), digest([1, 2])));
  assert.ok('ref' in resolved, JSON.stringify(resolved));
  assert.equal(resolved.ref, '@act');
});
