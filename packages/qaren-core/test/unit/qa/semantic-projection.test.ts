import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as projection from '../../../dist/qa/screen.js';
import type { DigestEntry, Element, ReactHostEvidence, Screen } from '../../../dist/qa/screen.js';
import { inputValues, redactEvidence } from '../../../dist/qa/privacy.js';
import { decideScreen, prepareTarget, resolveTarget } from '../../../dist/qa/resolve.js';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

const complete = { native: 'complete', react: 'complete' } as const;

test('headings and normalized images do not block semantic button resolution', async () => {
  const target = parseStep('Tap the save button');
  assert.ok(target && !('refuse' in target));
  for (const [role, type, kind] of [
    ['heading', 'StaticText', 'text'],
    ['img', 'Image', 'image'],
    ['none', 'Other', 'other'],
    ['presentation', 'Other', 'other'],
    ['summary', 'Other', 'other'],
    ['unknown', 'Other', 'other'],
  ] as const) {
    for (const withPresence of [false, true]) {
      for (const representation of ['host', 'digest', 'both']) {
        const observed = projection.join(
          [
            { ref: '@content', type, identifier: 'content', label: 'Welcome', hittable: true },
            { ref: '@save', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
          ],
          representation === 'host' ? [] : [{ role, testID: 'content' }],
          'app',
          complete,
          {
            complete: true,
            hosts:
              representation === 'digest'
                ? []
                : [{ role, roleSource: 'role', testID: 'content', capabilities: {} }],
          },
          withPresence ? presenceOf(['observed', 'observed']) : undefined,
        );
        assert.equal(observed.elements[0].kind, kind);
        assert.equal(observed.elements[0].semantic?.press, 'unsupported');
        assert.equal(observed.pressEvidenceGap, undefined);
        assert.deepEqual(projection.semanticActionView(observed, 'press'), {
          elements: [observed.elements[1]],
        });
        const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0) }));
        const resolved = await resolveTarget(target, observed, judge);
        assert.ok('ref' in resolved);
        assert.equal(resolved.ref, '@save');
        assert.equal(judge.requests.length, 1);
      }
    }
  }
});

test('associated static RCTViews remain inert unless a positive press handler is observed', async () => {
  const target = parseStep('Tap the save button');
  assert.ok(target && !('refuse' in target));
  const rect = { x: 10, y: 20, width: 100, height: 40 };
  for (const role of ['none', 'presentation', 'summary', 'unknown']) {
    for (const press of [false, true]) {
      const observed = projection.join(
        [
          { ref: '@window', type: 'Window', rect: { x: 0, y: 0, width: 400, height: 800 } },
          {
            ref: '@content',
            type: 'Other',
            identifier: 'content',
            parentIndex: 0,
            rect,
            hittable: true,
          },
          { ref: '@save', type: 'Button', label: 'Save', parentIndex: 0, rect, hittable: true },
        ],
        [{ role, testID: 'content', capabilities: { press, fill: false } }],
        'app',
        complete,
        {
          complete: true,
          hosts: [
            {
              role,
              roleSource: 'role',
              testID: 'content',
              capabilities: press ? { press: true } : {},
            },
          ],
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
                rect,
                text: { kind: 'none' },
              },
            ],
          },
        },
        presenceOf(['unknown', 'observed', 'observed']),
      );
      assert.equal(observed.elements[1].semantic?.press, press ? 'supported' : 'unsupported');
      assert.equal(observed.pressEvidenceGap, undefined);
      assert.deepEqual(projection.semanticActionView(observed, 'press'), {
        elements: press ? observed.elements.slice(1) : [observed.elements[2]],
      });
      const judge = scriptedJudge((q) => ({ target_0: choice(q.target_0, press ? 'e1' : 'e0') }));
      const resolved = await resolveTarget(target, observed, judge);
      assert.ok('ref' in resolved);
      assert.equal(resolved.ref, '@save');
    }
  }
});

test('explicit interactive roles retain press gaps and input roles retain fill gaps', () => {
  for (const role of [
    'button',
    'link',
    'switch',
    'checkbox',
    'radio',
    'togglebutton',
    'tab',
    'menuitem',
    'combobox',
    'adjustable',
    'slider',
    'textinput',
    'search',
    'textbox',
    'searchbox',
  ]) {
    const observed = projection.join(
      [{ ref: '@container', type: 'Other', hittable: true }],
      [],
      'app',
      complete,
      {
        complete: true,
        hosts: [{ role, roleSource: 'role', testID: 'unassociated', capabilities: {} }],
      },
    );
    refused(projection.semanticActionView(observed, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    if (['textinput', 'search', 'textbox', 'searchbox'].includes(role))
      refused(projection.semanticActionView(observed, 'fill'), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
});

test('role-derived kinds retain button and input classification alongside static roles', () => {
  const entries = [
    { role: 'heading', testID: 'title' },
    { role: 'img', testID: 'logo' },
    { role: 'button', testID: 'save', capabilities: { press: true } },
    { role: 'textinput', testID: 'email', capabilities: { fill: true } },
  ];
  for (const native of [false, true]) {
    const observed = projection.join(
      native
        ? entries.map((entry) => ({
            ref: `@${entry.testID}`,
            type: 'Other',
            identifier: entry.testID,
            hittable: true,
          }))
        : [],
      entries,
      'app',
      complete,
      { hosts: [], complete: true },
    );
    assert.deepEqual(
      observed.elements.map((e) => e.kind),
      ['text', 'image', 'button', 'input'],
    );
    assert.equal(observed.elements[2].semantic?.press, 'supported');
    assert.equal(observed.elements[3].semantic?.fill, 'supported');
  }
});

function element(ref: string, overrides: Partial<Element> = {}): Element {
  return {
    ref,
    kind: 'button',
    label: 'Save',
    hittable: true,
    disabled: false,
    secure: false,
    offscreen: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
    ...overrides,
  };
}

function attested(elements: Element[]): Screen {
  return { elements, visibleText: [], front: 'app', coverage: complete };
}

function refused(result: ReturnType<typeof projection.semanticActionView>, code: string): void {
  assert.ok('refuse' in result, 'projection must refuse rather than select an incomplete subset');
  assert.equal(result.refuse, code);
  assert.ok(result.reason.length > 0);
}

test('join adds native capabilities without upgrading geometry to visibility', () => {
  const screen = projection.join(
    [
      { ref: '@save', type: 'Button', label: 'Save', hittable: true },
      { ref: '@email', type: 'TextField', label: 'Email', value: 'a@example.test' },
      { ref: '@text', type: 'StaticText', label: 'Welcome', hittable: true },
      { ref: '@image', type: 'Image', label: 'Logo', hittable: true },
      { ref: '@wrapper', type: 'Other', hittable: true, index: 4, parentIndex: 0, depth: 1 },
    ],
    [],
    'app',
    complete,
  );

  assert.deepEqual(screen.coverage, complete);
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'unsupported',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[1].semantic?.fill, 'supported');
  assert.deepEqual(
    screen.elements.slice(2).map((e) => e.semantic?.press),
    ['unknown', 'unknown', 'unknown'],
    'without React host evidence nothing proves a view is not pressable',
  );
  assert.ok(screen.elements.every((e) => e.semantic?.visibility === 'unknown'));
  assert.deepEqual(projection.assertionView(screen), ['Save', 'Email: a@example.test', 'Welcome']);
  assert.deepEqual(
    projection.actionView(screen).map((e) => e.ref),
    ['@save', '@text', '@image', '@wrapper'],
  );
});

test('native text, image and plain views are not pressable unless React evidence says otherwise', () => {
  const screen = projection.join(
    [
      { ref: '@title', type: 'StaticText', label: 'Welcome', hittable: true },
      { ref: '@logo', type: 'Image', hittable: true },
      { ref: '@container', type: 'Other', hittable: true },
      { ref: '@row', type: 'Other', label: 'Open settings', hittable: true },
      { ref: '@more', type: 'StaticText', label: 'Read more', hittable: true },
      { ref: '@field', type: 'TextField', label: 'Email', hittable: true },
      { ref: '@cell', type: 'Cell', label: 'Inbox', hittable: true },
      { ref: '@go', type: 'Other', identifier: 'go', label: 'Go', hittable: true },
      { ref: '@pager', type: 'ScrollView', label: 'Explore', hittable: true },
      { ref: '@map', type: 'Map', hittable: true },
      { ref: '@group', type: 'android.view.ViewGroup', hittable: true },
    ],
    [
      { role: 'button', text: 'Open settings' },
      { role: 'text', text: 'Read more', capabilities: { press: true } },
      { role: 'button', testID: 'go', capabilities: { press: true } },
    ],
    'app',
    complete,
    { hosts: [], complete: true },
  );
  assert.deepEqual(
    screen.elements.map((e) => e.semantic?.press),
    [
      'unsupported',
      'unsupported',
      'unsupported',
      'unknown',
      'unknown',
      'unknown',
      'unknown',
      'supported',
      'unsupported',
      'unknown',
      // An Android layout view is plain, as iOS's Other is.
      'unsupported',
    ],
    'an unrecognized native type proves nothing about press',
  );
  const plain = projection.join(
    [
      { ref: '@title', type: 'StaticText', label: 'Welcome', hittable: true },
      { ref: '@container', type: 'Other', hittable: true },
      { ref: '@skip', type: 'Button', label: 'Skip', hittable: true },
    ],
    [],
    'app',
    complete,
    { hosts: [], complete: true },
  );
  assert.deepEqual(
    projection.semanticActionView(plain, 'press'),
    { elements: [plain.elements[2]] },
    'static content no longer blocks choosing among proven controls',
  );
  const backed = projection.join(
    [
      { ref: '@title', type: 'StaticText', label: 'Welcome', hittable: true },
      { ref: '@go', type: 'Other', identifier: 'go', label: 'Go', hittable: true },
    ],
    [{ role: 'button', testID: 'go', capabilities: { press: true } }],
    'app',
    complete,
    { hosts: [], complete: true },
  );
  assert.deepEqual(
    projection.semanticActionView(backed, 'press'),
    { elements: [backed.elements[1]] },
    'a uniquely associated React control is chosen next to static text',
  );
});

test('an unlabeled, unidentified plain view is inert, so the visibility view never needs its presence', () => {
  const nodes = [
    { ref: '@title', type: 'StaticText', label: 'Welcome', hittable: true },
    { ref: '@container', type: 'Other', hittable: true },
    { ref: '@pager', type: 'ScrollView', hittable: true },
  ];
  const presence = {
    source: 'xcui-live' as const,
    nodes: [
      { status: 'observed' as const, labelSource: 'direct' as const },
      { status: 'unknown' as const, labelSource: 'none' as const },
      { status: 'unknown' as const, labelSource: 'none' as const },
    ],
  };
  const inert = projection.join(
    nodes,
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    presence,
  );
  assert.deepEqual(
    inert.elements.map((e) => [e.semantic?.press, e.semantic?.fill]),
    [
      ['unsupported', 'unsupported'],
      ['unsupported', 'unsupported'],
      ['unsupported', 'unsupported'],
    ],
  );
  assert.deepEqual(projection.visibilityView(inert), {
    elements: [inert.elements[0]],
    unknown: [],
    unassociatedReact: 0,
  });

  const strayInput = projection.join(
    nodes,
    [],
    'app',
    complete,
    { hosts: [{ role: null, roleSource: 'none', capabilities: { fill: true } }], complete: true },
    presence,
  );
  assert.equal(strayInput.elements[1].semantic?.fill, 'unknown');
  assert.deepEqual(projection.visibilityView(strayInput), {
    elements: [strayInput.elements[0]],
    unknown: [],
    unassociatedReact: 0,
    capabilityGapContainers: 2,
  });
  refused(projection.semanticActionView(strayInput, 'fill'), 'SCREEN_EVIDENCE_INCOMPLETE');
});

const band = (y: number, height = 40) => ({ x: 0, y, width: 400, height });
const scrolled = [
  { ref: '@app', type: 'Application', rect: band(0, 800) },
  { ref: '@window', type: 'Window', parentIndex: 0, rect: band(0, 800) },
  { ref: '@list', type: 'ScrollView', parentIndex: 1, rect: band(100, 600) },
];
function presenceOf(statuses: ('observed' | 'unknown')[]) {
  return {
    source: 'xcui-live' as const,
    nodes: statuses.map((status) => ({ status, labelSource: 'direct' as const })),
  };
}

test('a verified node outside its scroll view or window is offscreen; centre-inside, empty and observed nodes are not', () => {
  const nodes = [
    ...scrolled,
    { ref: '@shown', type: 'StaticText', label: 'Shown', parentIndex: 2, rect: band(200) },
    { ref: '@below', type: 'StaticText', label: 'Below', parentIndex: 2, rect: band(720) },
    { ref: '@sheet', type: 'StaticText', label: 'Sheet', parentIndex: 1, rect: band(800) },
    { ref: '@seen', type: 'StaticText', label: 'Seen', parentIndex: 2, rect: band(760) },
    { ref: '@edge', type: 'StaticText', label: 'Edge', parentIndex: 2, rect: band(679) },
    { ref: '@empty', type: 'StaticText', label: 'Empty', parentIndex: 2, rect: band(720, 0) },
  ];
  const statuses = ['unknown', 'unknown', 'unknown', 'observed', 'unknown', 'unknown', 'observed'];
  const screen = projection.join(
    nodes,
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    presenceOf([...statuses, 'unknown', 'unknown']),
  );
  assert.deepEqual(
    screen.elements.map((e) => [e.ref, e.semantic?.visibility]),
    [
      ['@app', 'unknown'],
      ['@window', 'unknown'],
      ['@list', 'unknown'],
      ['@shown', 'visible'],
      ['@below', 'offscreen'],
      ['@sheet', 'offscreen'],
      ['@seen', 'visible'],
      ['@edge', 'unknown'],
      ['@empty', 'unknown'],
    ],
  );
  assert.deepEqual(projection.visibilityView(screen), {
    elements: [screen.elements[3], screen.elements[6]],
    unknown: screen.elements.slice(7).map((element) => ({ element, reason: 'visibility' })),
    unassociatedReact: 0,
  });

  const settled = projection.join(
    nodes.slice(0, 7),
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    presenceOf(statuses),
  );
  assert.deepEqual(
    projection.visibilityView(settled),
    { elements: [settled.elements[3], settled.elements[6]], unknown: [], unassociatedReact: 0 },
    'offscreen content is not visible content and needs no presence',
  );
  assert.equal(
    projection.join(
      nodes.slice(0, 7),
      [],
      'app',
      complete,
      { hosts: [], complete: true },
      undefined,
    ).elements[4].semantic?.visibility,
    'unknown',
    'geometry is offscreen evidence only inside a verified capture',
  );
});

test('an offscreen native control is a model-free scroll hint; an unobserved one on screen still refuses', async () => {
  const more = (y: number) => [
    ...scrolled,
    {
      ref: '@more',
      type: 'Button',
      label: 'Show more',
      parentIndex: 2,
      rect: band(y),
      hittable: true,
    },
  ];
  const statuses = presenceOf(['unknown', 'unknown', 'unknown', 'unknown']);
  const below = projection.join(
    more(720),
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    statuses,
  );
  assert.deepEqual(projection.semanticActionView(below, 'press'), {
    elements: [below.elements[3]],
  });
  assert.deepEqual(prepareTarget({ kind: 'press', target: { phrase: 'show more' } }, below), {
    scroll: 'down',
    element: below.elements[3],
    origin: 'named-offscreen',
  });

  const shown = projection.join(
    more(300),
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    statuses,
  );
  refused(projection.semanticActionView(shown, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');

  const observed = presenceOf(['unknown', 'unknown', 'unknown', 'observed']);
  const scrolledIn = projection.join(
    more(300),
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    observed,
  );
  const judge = scriptedJudge((questions) => ({ target_1: choice(questions.target_1) }));
  const f = walker([below, scrolledIn], judge);
  const result = await runPlan(parsePlan('1. Tap show more').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['scroll down', 'press @more']);
});

test('an unassociated React host interactive only by role and without a testID leaves plain views not pressable', () => {
  const nodes = [
    ...scrolled.slice(0, 2),
    { ref: '@group', type: 'Other', parentIndex: 1, rect: band(60, 200) },
  ];
  const presence = presenceOf(['unknown', 'unknown', 'unknown']);
  const press = (host: ReactHostEvidence['hosts'][number]) =>
    projection.join(nodes, [], 'app', complete, { hosts: [host], complete: true }, presence)
      .elements[2].semantic?.press;
  assert.equal(
    press({ role: 'adjustable', roleSource: 'accessibilityRole', capabilities: {} }),
    'unsupported',
  );
  assert.equal(
    press({ nativeID: '20', role: 'tablist', roleSource: 'role', capabilities: {} }),
    'unsupported',
  );
  assert.equal(
    press({ testID: 'sheet', role: 'adjustable', roleSource: 'role', capabilities: {} }),
    'unknown',
  );
  assert.equal(press({ role: null, roleSource: 'none', capabilities: { press: true } }), 'unknown');
});

test('an unnamed handlerless digest entry sharing a label does not make a plain view possibly pressable', () => {
  const nodes = [
    ...scrolled.slice(0, 2),
    { ref: '@sheet', type: 'Other', label: 'Bottom Sheet', parentIndex: 1, rect: band(60, 200) },
  ];
  const presence = presenceOf(['unknown', 'unknown', 'unknown']);
  const none = { press: false, fill: false };
  const press = (entry: DigestEntry) =>
    projection.join(nodes, [entry], 'app', complete, { hosts: [], complete: true }, presence)
      .elements[2].semantic?.press;
  assert.equal(
    press({ role: 'adjustable', label: 'Bottom Sheet', capabilities: none, handlerless: true }),
    'unsupported',
  );
  assert.equal(press({ role: 'adjustable', label: 'Bottom Sheet', capabilities: none }), 'unknown');
});

test('an unnamed handlerless React entry is not an unaccounted competitor; named or handled ones are', () => {
  const nodes = [
    ...scrolled.slice(0, 2),
    { ref: '@hi', type: 'StaticText', label: 'Hi', parentIndex: 1, rect: band(60) },
  ];
  const presence = presenceOf(['unknown', 'unknown', 'observed']);
  const none = { press: false, fill: false };
  const unaccounted = (digest: DigestEntry[]) =>
    projection.join(nodes, digest, 'app', complete, { hosts: [], complete: true }, presence)
      .semanticUnassociatedReact;
  assert.equal(unaccounted([{ role: 'adjustable', handlerless: true, capabilities: none }]), 0);
  assert.equal(unaccounted([{ role: 'switch', capabilities: none }]), 1);
  assert.equal(
    unaccounted([{ role: 'button', testID: 'ghost', handlerless: true, capabilities: none }]),
    1,
  );
});

test('identical unidentified sibling views directly under a native scroll view are platform chrome', () => {
  const bar = { type: 'Other', label: 'Vertical scroll bar, 2 pages', rect: band(100, 600) };
  const view = (parents: number[]) => {
    const nodes = [
      ...scrolled,
      ...parents.map((parentIndex, i) => ({ ...bar, ref: `@bar${i}`, parentIndex })),
      { ref: '@text', type: 'StaticText', label: 'Hi', parentIndex: 2, rect: band(200) },
    ];
    const statuses = nodes.map((n) => (n.ref === '@text' ? 'observed' : 'unknown') as const);
    const screen = projection.join(
      nodes,
      [],
      'app',
      complete,
      { hosts: [], complete: true },
      presenceOf(statuses),
    );
    return projection.visibilityView(screen);
  };
  const chrome = view([2, 2]);
  assert.ok('elements' in chrome);
  assert.deepEqual(
    chrome.elements.map((e) => e.ref),
    ['@text'],
  );
  assert.deepEqual(chrome.unknown, []);
  assert.equal(chrome.unassociatedReact, 0);
  for (const parents of [[2], [1, 1]]) {
    const evidence = view(parents);
    assert.ok('elements' in evidence);
    assert.deepEqual(
      evidence.elements.map((e) => e.ref),
      ['@text'],
    );
    assert.deepEqual(
      evidence.unknown.map(({ element, reason }) => [element.ref, reason]),
      parents.map((_, i) => [`@bar${i}`, 'visibility']),
    );
    assert.equal(evidence.unassociatedReact, 0);
  }
});

test('a verified text identical to its parent text counts once; other identical pairs stay distinct', () => {
  const text = { type: 'StaticText', identifier: 'title', label: 'Welcome', rect: band(60) };
  const save = { type: 'Button', identifier: 'save', label: 'Save', rect: band(300) };
  const nodes = [
    ...scrolled.slice(0, 2),
    { ...text, ref: '@title', parentIndex: 1 },
    { ...text, ref: '@title-inner', parentIndex: 2 },
    { ...text, ref: '@title-innermost', parentIndex: 3 },
    { ref: '@bar', type: 'Other', label: 'Scroll bar', parentIndex: 1, rect: band(700) },
    { ref: '@bar-twin', type: 'Other', label: 'Scroll bar', parentIndex: 1, rect: band(700) },
    { ...save, ref: '@save', parentIndex: 1 },
    { ...save, ref: '@save-inner', parentIndex: 7 },
  ];
  const observed = presenceOf(['unknown', 'unknown', ...Array(7).fill('observed')]);
  const digest = [{ role: 'text', testID: 'title', label: 'Welcome' }];
  const join = (presence = observed) =>
    projection.join(nodes, digest, 'app', complete, { hosts: [], complete: true }, presence);
  const screen = join();
  assert.deepEqual(
    screen.elements.map((e) => e.ref),
    ['@app', '@window', '@title', '@bar', '@bar-twin', '@save', '@save-inner'],
  );
  assert.deepEqual(screen.visibleText, ['Welcome', 'Save']);
  assert.equal(screen.semanticUnassociatedReact, 0, 'the unique exact ID still accounts for React');

  const differing = presenceOf([
    'unknown',
    'unknown',
    'observed',
    'unknown',
    ...Array(5).fill('observed'),
  ]);
  assert.equal(
    join(differing).elements.filter((e) => e.testID === 'title').length,
    3,
    'differing presence evidence keeps every observation',
  );
  assert.deepEqual(
    projection.join(nodes, digest, 'app', complete).elements.map((e) => e.ref),
    nodes.map((node) => node.ref),
    'identified nested texts remain distinct without verified presence evidence',
  );
});

test('a plain container offering no operation contributes only through its own named descendants', () => {
  type Source = 'direct' | 'value' | 'descendant' | 'none';
  const containers: [string, string | undefined, Source, 'observed' | 'unknown'][] = [
    ['hero', 'Welcome', 'descendant', 'observed'],
    ['card', undefined, 'none', 'observed'],
    ['', 'Welcome', 'descendant', 'unknown'],
  ];
  const view = (
    rows: typeof containers,
    hosts: ReactHostEvidence['hosts'] = [],
    digest: DigestEntry[] = [],
  ): ReturnType<typeof projection.visibilityView> => {
    const nodes = [
      ...scrolled.slice(0, 2),
      ...rows.map(([identifier, label]) => ({
        ref: `@${identifier || 'group'}`,
        type: 'Other',
        identifier,
        label,
        parentIndex: 1,
        rect: band(60, 200),
      })),
      { ref: '@text', type: 'StaticText', label: 'Welcome', parentIndex: 2, rect: band(60) },
    ];
    const presence = {
      source: 'xcui-live' as const,
      nodes: [
        { status: 'unknown' as const, labelSource: 'none' as const },
        { status: 'unknown' as const, labelSource: 'none' as const },
        ...rows.map(([, , labelSource, status]) => ({ status, labelSource })),
        { status: 'observed' as const, labelSource: 'direct' as const },
      ],
    };
    return projection.visibilityView(
      projection.join(nodes, digest, 'app', complete, { hosts, complete: true }, presence),
    );
  };
  const skipped = view(containers);
  assert.ok('elements' in skipped);
  assert.deepEqual(
    skipped.elements.map((e) => e.ref),
    ['@text'],
  );
  assert.deepEqual(skipped.unknown, []);
  assert.equal(skipped.unassociatedReact, 0);
  const strayPress = view(containers, [
    { role: null, roleSource: 'none', capabilities: { press: true } },
  ]);
  assert.ok('elements' in strayPress);
  assert.deepEqual(strayPress.unknown, []);
  assert.equal(strayPress.capabilityGapContainers, 3);
  for (const [evidence, expected] of [
    [view([['meter', '40%', 'value', 'observed']]), [['@meter', 'name-provenance']]],
    [
      view(containers, [], [{ role: 'text', testID: 'card', value: '3 tasks' }]),
      [['@card', 'content']],
    ],
  ] as const) {
    assert.ok('elements' in evidence);
    assert.deepEqual(
      evidence.elements.map((e) => e.ref),
      ['@text'],
    );
    assert.deepEqual(
      evidence.unknown.map(({ element, reason }) => [element.ref, reason]),
      expected,
    );
    assert.equal(evidence.unassociatedReact, 0);
  }
});

test('native control types supply operation evidence independently of digest roles', () => {
  for (const type of [
    'Button',
    'Switch',
    'Toggle',
    'Link',
    'android.widget.ImageButton',
    'android.widget.ToggleButton',
    'android.widget.CheckBox',
    'android.widget.RadioButton',
  ]) {
    const screen = projection.join(
      [{ ref: '@control', type, hittable: true }],
      [],
      'app',
      complete,
    );
    assert.equal(screen.elements[0].semantic?.press, 'supported', type);
    assert.deepEqual(projection.semanticActionView(screen, 'press'), { elements: screen.elements });
  }
  for (const type of [
    'TextField',
    'SecureTextField',
    'SearchField',
    'TextView',
    'android.widget.EditText',
  ]) {
    const screen = projection.join([{ ref: '@input', type, hittable: true }], [], 'app', complete);
    assert.equal(screen.elements[0].semantic?.fill, 'supported', type);
    assert.deepEqual(projection.semanticActionView(screen, 'fill'), { elements: screen.elements });
  }
});

test('a default React button role without producer capabilities remains unknown', () => {
  const screen = projection.join(
    [{ ref: '@custom', type: 'Other', identifier: 'custom', hittable: true }],
    [{ role: 'button', testID: 'custom' }],
    'app',
    complete,
  );
  assert.equal(screen.elements[0].kind, 'button');
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('only a unique exact-ID association can supply React capabilities', () => {
  const screen = projection.join(
    [
      { ref: '@custom', type: 'Other', identifier: 'custom' },
      { ref: '@label', type: 'Other', label: 'Save' },
      { ref: '@a', type: 'Other', identifier: 'duplicate-native' },
      { ref: '@b', type: 'Other', identifier: 'duplicate-native' },
      { ref: '@c', type: 'Other', identifier: 'duplicate-react' },
      { ref: '@false', type: 'Other', identifier: 'no-handler' },
    ],
    [
      { role: 'button', testID: 'custom', capabilities: { press: true, fill: true } },
      { role: 'button', text: 'Save', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-native', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-react', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-react', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'no-handler', capabilities: { press: false, fill: false } },
    ],
  );

  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'supported',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[1].kind, 'button', 'legacy label enrichment is unchanged');
  assert.deepEqual(
    screen.elements.slice(1, 6).map((e) => e.semantic?.press),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
  );
  assert.equal(screen.elements[5].semantic?.fill, 'unknown');
  assert.equal(screen.semanticUnassociatedReact, 4);
  assert.equal(screen.coverage, undefined);
});

test('legacy identifier trimming does not grant semantic exact-ID authority', () => {
  const screen = projection.join(
    [{ ref: '@custom', type: 'Other', identifier: ' custom ' }],
    [{ role: 'button', testID: 'custom', capabilities: { press: true, fill: true } }],
  );
  assert.equal(screen.elements[0].testID, 'custom');
  assert.equal(screen.elements[0].kind, 'button');
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'unknown',
    fill: 'unknown',
    visibility: 'unknown',
    disabled: false,
  });
});

test('semantic actions keep separate native controls with equal IDs and exclude disabled controls', () => {
  const screen = projection.join(
    [
      { ref: '@a', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
      { ref: '@b', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
      { ref: '@disabled', type: 'Other', enabled: false },
    ],
    [],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(screen, 'press'), {
    elements: screen.elements.slice(0, 2),
  });
  assert.equal(screen.elements.length, 3);
});

test('an unknown capability refusal names the operation, ref and kind but not the label', () => {
  const screen = attested([
    element('@e14', {
      kind: 'text',
      label: 'Welcome back, Anton',
      semantic: { press: 'unknown', fill: 'unknown', visibility: 'visible' },
    }),
  ]);
  const result = projection.semanticActionView(screen, 'press');
  assert.ok('refuse' in result);
  assert.equal(result.reason, 'an observation has unknown press capability (@e14, text)');
});

test('unknown capabilities, missing facts and non-hittable controls cannot create an action winner', () => {
  for (const competitor of [
    element('@unknown', { semantic: { press: 'unknown', fill: 'unknown', visibility: 'visible' } }),
    element('@missing', { semantic: undefined }),
    element('@no-hit', { hittable: false }),
    element('react:later', {
      hittable: false,
      offscreen: true,
      semantic: { press: 'supported', fill: 'unknown', visibility: 'unknown' },
    }),
  ]) {
    refused(
      projection.semanticActionView(attested([element('@save'), competitor]), 'press'),
      'SCREEN_EVIDENCE_INCOMPLETE',
    );
  }
});

test('operation exclusions and attested offscreen evidence are independent of legacy flags', () => {
  const input = element('@input', {
    kind: 'input',
    semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
  });
  const later = element('react:later', {
    hittable: false,
    offscreen: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'offscreen' },
  });
  const hidden = element('@hidden', {
    semantic: { press: 'unknown', fill: 'unknown', visibility: 'hidden' },
  });
  const screen = attested([input, later, hidden]);
  assert.deepEqual(projection.semanticActionView(screen, 'fill'), { elements: [input] });
  assert.deepEqual(projection.semanticActionView(screen, 'press'), { elements: [later] });
  assert.equal(later.offscreen, false, 'semantic projection does not rewrite legacy observations');
});

test('visibility keeps independent readable contributions and disabled controls', () => {
  const text = element('@text', {
    kind: 'text',
    hittable: false,
    semantic: { press: 'unknown', fill: 'unsupported', visibility: 'visible' },
  });
  const disabled = element('@disabled', { disabled: true, testID: 'save' });
  const duplicate = element('@duplicate', { disabled: true, testID: 'save' });
  const hidden = element('@hidden', {
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'hidden' },
  });
  const offscreen = element('@offscreen', {
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'offscreen' },
  });
  const structural = element('@structural', {
    kind: 'other',
    label: undefined,
    semantic: { press: 'unsupported', fill: 'unsupported', visibility: 'unknown' },
  });
  const screen = attested([text, disabled, duplicate, hidden, offscreen, structural]);

  assert.deepEqual(projection.visibilityView(screen), {
    elements: [text, disabled, duplicate],
    unknown: [],
    unassociatedReact: 0,
  });
  assert.equal(screen.elements.length, 6);
  assert.deepEqual(projection.assertionView(screen), [], 'semantic evidence is not literal text');
});

test('both projections require complete coverage, including for an empty observation list', () => {
  for (const coverage of [
    undefined,
    { native: 'unknown', react: 'complete' },
    { native: 'complete', react: 'unknown' },
    { native: 'incomplete', react: 'complete' },
    { native: 'complete', react: 'incomplete' },
  ] satisfies Array<Screen['coverage']>) {
    const screen = { ...attested([]), coverage };
    refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.semanticActionView(screen, 'fill'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.visibilityView(screen), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
  assert.deepEqual(projection.semanticActionView(attested([]), 'press'), { elements: [] });
  assert.deepEqual(projection.visibilityView(attested([])), {
    elements: [],
    unknown: [],
    unassociatedReact: 0,
  });
});

test('a coverage refusal names the capture and projected coverage of each side', () => {
  const screen: Screen = {
    ...attested([]),
    captureCoverage: complete,
    coverage: { native: 'incomplete', react: 'unknown' },
  };
  for (const result of [
    projection.semanticActionView(screen, 'press'),
    projection.visibilityView(screen),
  ]) {
    assert.ok('refuse' in result);
    assert.match(result.reason, /capture native=complete react=complete/);
    assert.match(result.reason, /projected native=incomplete react=unknown/);
  }
  const bare = projection.visibilityView({ ...attested([]), coverage: undefined });
  assert.ok('refuse' in bare);
  assert.match(bare.reason, /capture missing; projected missing/);
});

test('reference collisions refuse before any exclusions or content coalescing', () => {
  const screen = attested([element('@same'), element('@same', { disabled: true })]);
  refused(projection.semanticActionView(screen, 'press'), 'AMBIGUOUS_REFS');
  refused(projection.visibilityView(screen), 'AMBIGUOUS_REFS');
  assert.equal(screen.elements.length, 2);
  const duplicatedReact = projection.join(
    [],
    [
      { role: 'button', testID: 'save' },
      { role: 'button', testID: 'save' },
    ],
    'app',
    complete,
  );
  refused(projection.semanticActionView(duplicatedReact, 'press'), 'AMBIGUOUS_REFS');
  refused(projection.visibilityView(duplicatedReact), 'AMBIGUOUS_REFS');
  assert.equal(duplicatedReact.semanticUnassociatedReact, 2);
  refused(
    projection.semanticActionView({ ...duplicatedReact, coverage: undefined }, 'press'),
    'AMBIGUOUS_REFS',
  );
  refused(projection.visibilityView({ ...duplicatedReact, coverage: undefined }), 'AMBIGUOUS_REFS');
});

test('unknown visibility stays explicit even when native geometry or legacy flags suggest visibility', () => {
  const screen = projection.join(
    [
      {
        ref: '@native',
        type: 'Button',
        label: 'Save',
        hittable: true,
        rect: { x: 0, y: 0, width: 40, height: 40 },
      },
    ],
    [],
    'app',
    complete,
  );
  assert.deepEqual(projection.visibilityView(screen), {
    elements: [],
    unknown: [{ element: screen.elements[0], reason: 'visibility' }],
    unassociatedReact: 0,
  });
  const disabled = projection.join(
    [{ ref: '@disabled', type: 'Button', enabled: false }],
    [],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(disabled, 'press'), { elements: [] });
  assert.deepEqual(projection.visibilityView(disabled), {
    elements: [],
    unknown: [{ element: disabled.elements[0], reason: 'visibility' }],
    unassociatedReact: 0,
  });
  refused(
    projection.visibilityView(attested([element('@missing', { semantic: undefined })])),
    'SCREEN_EVIDENCE_INCOMPLETE',
  );
  for (const type of ['Application', 'Window', 'Other', 'StaticText', 'Image', undefined]) {
    const unknown = projection.join([{ ref: '@unknown', type }], [], 'app', complete);
    assert.deepEqual(projection.visibilityView(unknown), {
      elements: [],
      unknown: [{ element: unknown.elements[0], reason: 'visibility' }],
      unassociatedReact: 0,
    });
    refused(projection.semanticActionView(unknown, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
});

test('accessibility-only labels do not become readable assertions without control evidence', () => {
  for (const kind of ['image', 'other'] as const) {
    const screen = attested([
      element('@label', {
        kind,
        semantic: { press: 'unknown', fill: 'unknown', visibility: 'visible' },
      }),
    ]);
    assert.deepEqual(projection.visibilityView(screen), {
      elements: [],
      unknown: [{ element: screen.elements[0], reason: 'content' }],
      unassociatedReact: 0,
    });
    refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
});

test('unmatched React observations remain unknown, not proven offscreen', () => {
  const screen = projection.join(
    [],
    [{ role: 'button', testID: 'later', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'unknown',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[0].offscreen, true, 'legacy exact paths remain unchanged');
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.deepEqual(projection.visibilityView(screen), {
    elements: [],
    unknown: [{ element: screen.elements[0], reason: 'visibility' }],
    unassociatedReact: 1,
  });
});

test('unaddressable React observations cannot disappear to manufacture complete empty evidence', async () => {
  const screen = projection.join(
    [],
    [{ role: 'button', text: 'Save', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.deepEqual(screen.elements, [], 'legacy identity output still omits unaddressable entries');
  const judge = scriptedJudge(() => assert.fail('no established contribution is available'));
  for (const copy of [screen, { ...screen }, structuredClone(screen)]) {
    refused(projection.semanticActionView(copy, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.deepEqual(projection.visibilityView(copy), {
      elements: [],
      unknown: [],
      unassociatedReact: 1,
    });
    assert.equal(copy.semanticUnassociatedReact, 1);
    const decision = await decideScreen(
      copy,
      judge,
      { kind: 'check', literal: false, text: 'Save is visible', line: 1 },
      { kind: 'wait', target: { phrase: 'Save' }, line: 2 },
    );
    assert.deepEqual(decision.check, {
      refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
      reason: 'no established assertion contribution is available',
    });
    assert.equal(decision.visibility, undefined);
    assert.equal(decision.target, undefined);
    assert.equal(judge.requests.length, 0);
    const standalone = await decideScreen(copy, judge, undefined, {
      kind: 'wait',
      target: { phrase: 'Save' },
      line: 2,
    });
    assert.deepEqual(standalone.visibility, decision.check);
  }
  assert.equal(judge.requests.length, 0);
});

test('anonymous same-label controls are not removed from semantic accounting by the legacy join', () => {
  const screen = projection.join(
    [{ ref: '@save', type: 'Button', label: 'Save', hittable: true, rect: band(100) }],
    [{ role: 'button', text: 'Save', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.equal(screen.elements.length, 1, 'legacy label association is unchanged');
  assert.deepEqual(projection.actionView(screen), screen.elements);
  assert.deepEqual(projection.assertionView(screen), ['Save']);
  screen.elements[0].semantic!.visibility = 'visible';
  for (const copy of [
    screen,
    { ...screen, elements: screen.elements.map((e) => ({ ...e })) },
    structuredClone(screen),
  ]) {
    refused(projection.semanticActionView(copy, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.deepEqual(projection.visibilityView(copy), {
      elements: copy.elements,
      unknown: [],
      unassociatedReact: 1,
    });
    assert.equal(copy.semanticUnassociatedReact, 1);
  }
});

test('ambiguous React association refuses without hiding either enabled native control', () => {
  const screen = projection.join(
    [
      { ref: '@a', type: 'Button', identifier: 'save', hittable: true, enabled: true },
      { ref: '@b', type: 'Button', identifier: 'save', hittable: true, enabled: true },
    ],
    [
      {
        role: 'button',
        testID: 'save',
        disabled: true,
        capabilities: { press: true, fill: false },
      },
    ],
    'app',
    complete,
  );
  assert.equal(screen.elements[0].disabled, true, 'legacy enrichment is preserved');
  assert.deepEqual(
    screen.elements.map((e) => [e.ref, e.semantic?.press]),
    [
      ['@a', 'supported'],
      ['@b', 'supported'],
    ],
  );
  assert.deepEqual(screen.elements.map(projection.semanticDisabled), [false, false]);
  assert.deepEqual(
    screen.elements.map((e) => projection.semanticDisabled({ ...e })),
    [false, false],
  );
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(screen.semanticUnassociatedReact, 1);
});

test('joined disabled facts survive spreading and cloning native and unique React evidence', () => {
  const screen = projection.join(
    [
      { ref: '@enabled', type: 'Button', identifier: 'enabled', enabled: true, hittable: true },
      {
        ref: '@native-disabled',
        type: 'Button',
        identifier: 'native-disabled',
        enabled: false,
        hittable: true,
      },
      {
        ref: '@react-disabled',
        type: 'Button',
        identifier: 'react-disabled',
        enabled: true,
        hittable: true,
      },
    ],
    [
      { role: 'button', testID: 'enabled', disabled: false },
      { role: 'button', testID: 'native-disabled', disabled: false },
      { role: 'button', testID: 'react-disabled', disabled: true },
    ],
    'app',
    complete,
  );
  for (const copy of [
    screen,
    { ...screen, elements: screen.elements.map((e) => ({ ...e, semantic: { ...e.semantic! } })) },
    structuredClone(screen),
  ]) {
    assert.equal(copy.semanticUnassociatedReact, 0);
    assert.deepEqual(
      copy.elements.map((e) => e.semantic?.disabled),
      [false, true, true],
    );
    assert.deepEqual(copy.elements.map(projection.semanticDisabled), [false, true, true]);
    assert.deepEqual(projection.semanticActionView(copy, 'press'), {
      elements: [copy.elements[0]],
    });
  }
});

test('semanticDisabled is the action owner and falls back only when its fact is missing', () => {
  const enabled = element('@enabled', {
    disabled: true,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible', disabled: false },
  });
  const disabled = element('@disabled', {
    disabled: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible', disabled: true },
  });
  const copied = attested([
    { ...enabled, semantic: { ...enabled.semantic! } },
    { ...disabled, semantic: { ...disabled.semantic! } },
  ]);
  assert.equal(projection.semanticDisabled(copied.elements[0]), false);
  assert.equal(projection.semanticDisabled(copied.elements[1]), true);
  assert.deepEqual(projection.semanticActionView(copied, 'press'), {
    elements: [copied.elements[0]],
  });
  assert.deepEqual(projection.visibilityView(copied), {
    elements: copied.elements,
    unknown: [],
    unassociatedReact: 0,
  });
  assert.equal(
    projection.semanticDisabled(element('@legacy', { semantic: undefined, disabled: true })),
    true,
  );
  assert.equal(projection.semanticDisabled(element('@missing', { disabled: true })), true);
  assert.equal(projection.semanticDisabled(element('@enabled-legacy')), false);
});

test('projections retain private source values before excluding observations', () => {
  const screen = projection.join(
    [
      {
        ref: '@secure',
        type: 'SecureTextField',
        identifier: 'password',
        label: 'Password',
        value: 'native-secret',
        rect: band(100),
        enabled: false,
      },
      { ref: '@save', type: 'Button', label: 'Save', hittable: true },
    ],
    [{ role: 'textinput', testID: 'password', text: 'Password', value: 'react-secret' }],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(screen, 'press'), {
    elements: [screen.elements[1]],
  });
  assert.equal(screen.elements[0].value, undefined);
  assert.deepEqual(inputValues(screen), ['native-secret', 'react-secret']);
  assert.equal(redactEvidence(screen, 'native-secret react-secret'), '••• •••');
  assert.equal(projection.assertionView(screen)[0], 'Password');
  screen.elements[0].semantic!.visibility = 'hidden';
  screen.elements[1].semantic!.visibility = 'visible';
  assert.deepEqual(projection.visibilityView(screen), {
    elements: [screen.elements[1]],
    unknown: [],
    unassociatedReact: 0,
  });
  assert.deepEqual(inputValues(screen), ['native-secret', 'react-secret']);
});

test('the domain retains all 31 independent candidates and contributions for resolver budgeting', () => {
  const controls = Array.from({ length: 31 }, (_, i) => element(`@${i}`, { testID: 'save' }));
  const screen = attested(controls);
  const action = projection.semanticActionView(screen, 'press');
  const visibility = projection.visibilityView(screen);
  assert.deepEqual(action, { elements: controls });
  assert.deepEqual(visibility, { elements: controls, unknown: [], unassociatedReact: 0 });
  assert.ok('elements' in action && action.elements.every((e, i) => e === controls[i]));
  assert.ok('elements' in visibility && visibility.elements.every((e, i) => e === controls[i]));
});

test('an observed navigation bar title matching its bar is a native heading witness', async () => {
  const nav = (title: string, statuses: ('observed' | 'unknown')[], barId = 'Tasks') => {
    const nodes = [
      ...scrolled.slice(0, 2),
      {
        ref: '@bar',
        type: 'NavigationBar',
        identifier: barId,
        label: barId,
        parentIndex: 1,
        rect: band(60, 50),
      },
      { ref: '@title', type: 'StaticText', label: title, parentIndex: 2, rect: band(70, 20) },
    ];
    const presence = {
      source: 'xcui-live' as const,
      nodes: statuses.map((status, i) => ({
        status,
        labelSource: i === 2 ? ('descendant' as const) : ('direct' as const),
      })),
    };
    return projection.join(nodes, [], 'app', complete, { hosts: [], complete: true }, presence);
  };
  const shown = nav('Tasks', ['unknown', 'unknown', 'unknown', 'observed']);
  assert.deepEqual(shown.elements[3].semantic?.heading, {
    kind: 'navigation-title',
    barRef: '@bar',
  });
  assert.equal(
    nav('Settings', ['unknown', 'unknown', 'unknown', 'observed']).elements[3].semantic?.heading,
    undefined,
  );
  assert.equal(
    nav('Tasks', ['unknown', 'unknown', 'unknown', 'unknown']).elements[3].semantic?.heading,
    undefined,
  );

  const judge = scriptedJudge((questions, _i, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 0, kind: 'navigation-title' },
    ]);
    assert.deepEqual(state.assertionEvidence.unknown, []);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.match(state.assertionEvidence.observed[0], /platform-observed navigation bar title/);
    return { visibility_1: { type: 'noul', noul: 0.9 } };
  });
  const wait = (phrase: string) => ({ kind: 'wait' as const, target: { phrase }, line: 1 });
  assert.deepEqual(
    (await decideScreen(shown, judge, undefined, wait('the tasks heading'))).visibility,
    {
      verdict: 'present',
    },
  );
  assert.deepEqual(
    (await decideScreen(shown, judge, undefined, wait('the tasks accessibility heading')))
      .visibility,
    { verdict: 'pending' },
    'a navigation title is not a declared accessibility role',
  );
});

test('a navigation title needs exactly one observed match and never replaces React heading evidence', () => {
  const bar = {
    ref: '@bar',
    type: 'NavigationBar',
    identifier: 'Tasks',
    label: 'Tasks',
    parentIndex: 1,
    rect: band(60, 50),
  };
  const title = (ref: string, y: number, identifier?: string) => ({
    ref,
    type: 'StaticText',
    label: 'Tasks',
    parentIndex: 2,
    rect: band(y, 20),
    ...(identifier ? { identifier } : {}),
  });
  const presence = (statuses: ('observed' | 'unknown')[]) => ({
    source: 'xcui-live' as const,
    nodes: statuses.map((status, i) => ({
      status,
      labelSource: i === 2 ? ('descendant' as const) : ('direct' as const),
    })),
  });
  const large = projection.join(
    [...scrolled.slice(0, 2), bar, title('@small', 70), title('@large', 120)],
    [],
    'app',
    complete,
    { hosts: [], complete: true },
    presence(['unknown', 'unknown', 'unknown', 'unknown', 'observed']),
  );
  assert.equal(large.elements[3].semantic?.heading, undefined);
  assert.deepEqual(large.elements[4].semantic?.heading, {
    kind: 'navigation-title',
    barRef: '@bar',
  });

  const declared = projection.join(
    [...scrolled.slice(0, 2), bar, title('@title', 70, 'screen-title')],
    [],
    'app',
    complete,
    {
      complete: true,
      hosts: [{ testID: 'screen-title', role: 'heading', roleSource: 'role', capabilities: {} }],
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
            hostType: 'RCTText',
            rect: band(70, 20),
            text: { kind: 'block', content: 'Tasks', runs: [{ start: 0, end: 5, fontSize: 17 }] },
          },
        ],
      },
    },
    presence(['unknown', 'unknown', 'unknown', 'observed']),
  );
  assert.equal(declared.elements[3].semantic?.heading?.kind, 'declared-heading');
});

test('React observations hidden from accessibility are neither unaccounted evidence nor competitors', () => {
  const nodes = [
    ...scrolled.slice(0, 2),
    { ref: '@title', type: 'StaticText', label: 'Tasks', parentIndex: 1, rect: band(60) },
    { ref: '@group', type: 'Other', parentIndex: 1, rect: band(120, 200) },
  ];
  const presence = presenceOf(['unknown', 'unknown', 'observed', 'unknown']);
  const view = (hidden: boolean) =>
    projection.join(
      nodes,
      [
        {
          role: 'button',
          testID: 'home-btn',
          text: 'Go to Feed',
          capabilities: { press: true, fill: false },
          ...(hidden ? { hidden } : {}),
        },
      ],
      'app',
      complete,
      {
        complete: true,
        hosts: [
          {
            testID: 'home-btn',
            role: 'button',
            roleSource: 'role',
            capabilities: { press: true },
            ...(hidden ? { hidden: true as const } : {}),
          },
        ],
      },
      presence,
    );
  const hidden = view(true);
  assert.equal(hidden.semanticUnassociatedReact, 0);
  assert.equal(hidden.pressEvidenceGap, undefined);
  assert.equal(hidden.elements[3].semantic?.press, 'unsupported');
  assert.equal(
    hidden.elements.some((e) => e.ref === 'react:home-btn'),
    false,
  );
  assert.deepEqual(projection.visibilityView(hidden), {
    elements: [hidden.elements[2]],
    unknown: [],
    unassociatedReact: 0,
  });

  const shown = view(false);
  assert.equal(shown.semanticUnassociatedReact, 1);
  assert.equal(shown.pressEvidenceGap, '1 interactive React host unassociated');
});
