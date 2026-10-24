import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { captureScreen } from '../../../dist/qa/capture.js';
import { validateHostTypography } from '../../../dist/qa/host-typography.js';
import type { HostTypography } from '../../../dist/qa/host-typography.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import {
  semanticActionView,
  validateReactHostEvidence,
  visibilityView,
} from '../../../dist/qa/screen.js';
import type { ReactHostEvidence } from '../../../dist/qa/screen.js';
import { runPlan, WAIT_POLL_MS } from '../../../dist/qa/walker.js';
import { PHRASE_WAIT_BUDGET_MS } from '../../../dist/qa/timing.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { element, screen as syntheticScreen, scriptedJudge, walker } from './judgment-fixtures.ts';

function fixture() {
  const native = nativeCapture();
  const makeNode = (
    type: string,
    label: string,
    index: number,
    parentIndex: number,
    x: number,
    y: number,
    width: number,
    height: number,
    identifier?: string,
  ) => ({
    ...native.nodes[1],
    type,
    label,
    index,
    parentIndex,
    identifier,
    ref: `@e${index}`,
    depth: parentIndex < 2 ? parentIndex + 1 : 3,
    rect: { x, y, width, height },
    presence: { ...native.nodes[1].presence, nodeIndex: index },
  });
  native.nodes = [
    native.nodes[0],
    makeNode('Window', '', 1, 0, 20, 40, 400, 800),
    makeNode('Button', 'Open panel', 2, 1, 30, 50, 350, 400, 'panel'),
    makeNode('StaticText', 'Welcome', 3, 2, 40, 70, 250, 40),
    makeNode('StaticText', 'Your workspace', 4, 2, 40, 130, 250, 20),
  ];
  native.snapshotVerdict.nodeCount = native.nodes.length;
  const typography: HostTypography = {
    version: 1,
    complete: true,
    durationMs: 10,
    coordinateSpace: 'window-points',
    nodes: [
      {
        hostIndex: 0,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: 'RCTView',
        rect: { x: 10, y: 10, width: 350, height: 400 },
        text: { kind: 'none' },
      },
      {
        hostIndex: 1,
        parentHostIndex: 0,
        rootIndex: 0,
        hostType: 'RCTText',
        rect: { x: 20, y: 30, width: 250, height: 40 },
        text: {
          kind: 'block',
          content: 'Welcome',
          runs: [
            { start: 0, end: 3, fontSize: 24 },
            { start: 3, end: 7, fontSize: 22 },
          ],
          scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
        },
      },
      {
        hostIndex: 2,
        parentHostIndex: 1,
        rootIndex: 0,
        hostType: 'RCTVirtualText',
        text: { kind: 'inline', ownerHostIndex: 1 },
      },
      {
        hostIndex: 3,
        parentHostIndex: 0,
        rootIndex: 0,
        hostType: 'RCTText',
        rect: { x: 20, y: 90, width: 250, height: 20 },
        text: {
          kind: 'block',
          content: 'Your workspace',
          runs: [{ start: 0, end: 14, fontSize: 14 }],
          scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
        },
      },
    ],
  };
  for (const node of typography.nodes) {
    if (node.hostType !== 'RCTVirtualText')
      node.accessibility = { accessible: 'absent', authoredLabel: 'absent' };
  }
  const hosts: ReactHostEvidence['hosts'] = typography.nodes.map((_, i) => ({
    ...(i === 0 ? { testID: 'panel' } : {}),
    role: null,
    roleSource: 'none',
    capabilities: {},
  }));
  const hostEvidence = { hosts, complete: true, typography };
  const capture = () =>
    captureScreen({
      appId: 'com.test',
      native: async () => native,
      react: async () => ({
        interactive: [],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence,
      }),
    });
  return { native, hostEvidence, typography, capture };
}

const wait = (phrase = 'the welcome heading') => ({
  kind: 'wait' as const,
  target: { phrase },
  line: 1,
});

test('rich-text contract fixture reaches domain, resolver and walker without manufacturing a role', async () => {
  const f = fixture();
  const screen = await f.capture();
  assert.deepEqual(screen.elements[3].semantic?.heading, {
    kind: 'typographic-title',
    hostIndex: 1,
    anchorRef: '@e2',
    bodyRefs: ['@e4'],
  });
  assert.equal(screen.reactHostEvidence?.hosts[1].role, null);
  assert.equal(screen.elements[3].kind, 'text');
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(questions.visibility_1.type, 'noul');
    assert.match(
      questions.visibility_1.instructions,
      /^Does `assertionEvidence` support this WHOLE expectation: the welcome heading\?/,
    );
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.match(questions.visibility_1.instructions, /Heading claims require `qualifiedHeadings`/);
    assert.match(questions.visibility_1.criteria.true, /whole expectation/);
    assert.match(
      questions.visibility_1.criteria.false,
      /relevant unknown evidence leaves the answer uncertain/,
    );
    assert.equal(state.assertionEvidence.observed.length, 3, 'anchor remains a contribution');
    assert.deepEqual(state.assertionEvidence.unknown, []);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 1, kind: 'typographic-title' },
    ]);
    assert.match(state.assertionEvidence.observed[1], /platform-observed typographic title/);
    assert.match(state.assertionEvidence.observed[1], /not a declared accessibility role/);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  const w = walker([screen], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, w.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(w.actions, []);
});

test('associated declared headings need no typographic prominence but still need identity and presence', async () => {
  const f = fixture();
  f.hostEvidence.hosts[1].role = 'heading';
  f.hostEvidence.hosts[1].roleSource = 'role';
  f.typography.nodes[1].text.runs.forEach((run) => {
    run.fontSize = 14;
  });
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'declared-heading');
  const judge = scriptedJudge((_, __, state) => {
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 1, kind: 'declared-heading' },
    ]);
    assert.match(state.assertionEvidence.observed[1], /associated declared heading role/);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  assert.deepEqual(
    (await decideScreen(screen, judge, undefined, wait('the welcome accessibility heading')))
      .visibility,
    { verdict: 'present' },
  );
  f.native.nodes[3].presence.status = 'unknown';
  delete f.native.nodes[3].presence.observedUptimeMs;
  assert.equal((await f.capture()).elements[3].semantic?.heading, undefined);
});

test('a title text with an identical native child is one heading, not two competing observations', async () => {
  const f = fixture();
  const title = f.native.nodes[3];
  f.native.nodes.push({
    ...title,
    ref: '@e5',
    index: 5,
    parentIndex: 3,
    depth: title.depth + 1,
    presence: { ...title.presence, nodeIndex: 5 },
  });
  f.native.snapshotVerdict.nodeCount = f.native.nodes.length;
  const screen = await f.capture();
  assert.deepEqual(
    screen.elements.map((e) => e.ref),
    ['@e0', '@e1', '@e2', '@e3', '@e4'],
  );
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
});

test('an offscreen host association establishes no heading evidence', async () => {
  const f = fixture();
  f.hostEvidence.hosts[0].role = 'heading';
  f.hostEvidence.hosts[0].roleSource = 'role';
  assert.equal((await f.capture()).elements[2].semantic?.heading?.kind, 'declared-heading');
  f.typography.nodes[0].rect = { ...f.typography.nodes[0].rect!, y: 860 };
  f.native.nodes[2].rect = { ...f.native.nodes[2].rect, y: 900 };
  f.native.nodes[2].presence.status = 'unknown';
  delete f.native.nodes[2].presence.observedUptimeMs;
  const below = await f.capture();
  assert.equal(below.elements[2].semantic?.visibility, 'offscreen');
  assert.equal(below.elements[2].semantic?.heading, undefined);
});

const unsupported: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'no typography',
    (f) => {
      delete f.hostEvidence.typography;
    },
  ],
  [
    'incomplete typography',
    (f) => {
      f.typography.complete = false;
    },
  ],
  [
    'no named anchor',
    (f) => {
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'nativeID is not testID',
    (f) => {
      f.hostEvidence.hosts[0].nativeID = 'panel';
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'nonexact anchor',
    (f) => {
      f.hostEvidence.hosts[0].testID = ' panel ';
    },
  ],
  [
    'unmeasured anchor',
    (f) => {
      delete f.typography.nodes[0].rect;
    },
  ],
  [
    'anchor frame mismatch',
    (f) => {
      f.typography.nodes[0].rect!.x++;
    },
  ],
  [
    'incompatible anchor type',
    (f) => {
      f.typography.nodes[0].hostType = 'RCTText';
    },
  ],
  [
    'duplicate host anchor',
    (f) => {
      f.hostEvidence.hosts[2].testID = 'panel';
    },
  ],
  [
    'duplicate native anchor',
    (f) => {
      f.native.nodes[4].identifier = 'panel';
    },
  ],
  [
    'no native window',
    (f) => {
      f.native.nodes[1].type = 'Other';
    },
  ],
  [
    'second native window',
    (f) => {
      f.native.nodes[4].type = 'Window';
    },
  ],
  [
    'anchor outside window',
    (f) => {
      f.native.nodes[2].parentIndex = 0;
      f.native.nodes[2].depth = 1;
      f.native.nodes[3].depth = 2;
      f.native.nodes[4].depth = 2;
    },
  ],
  [
    'text outside anchor path',
    (f) => {
      f.native.nodes[3].parentIndex = 1;
      f.native.nodes[3].depth = 2;
    },
  ],
  [
    'host text outside anchor path',
    (f) => {
      f.typography.nodes[1].parentHostIndex = null;
      f.typography.nodes[1].rootIndex = 1;
      f.typography.nodes[2].rootIndex = 1;
    },
  ],
  [
    'text mismatch',
    (f) => {
      f.native.nodes[3].label = 'Welcome!';
    },
  ],
  [
    'text rect mismatch',
    (f) => {
      f.typography.nodes[1].rect!.y++;
    },
  ],
  [
    'unknown native text presence',
    (f) => {
      f.native.nodes[3].presence.status = 'unknown';
      delete f.native.nodes[3].presence.observedUptimeMs;
    },
  ],
  [
    'descendant label',
    (f) => {
      f.native.nodes[3].presence.labelSource = 'descendant';
    },
  ],
  [
    'unsupported rich text',
    (f) => {
      f.typography.nodes[2].text = { kind: 'unsupported' };
    },
  ],
  [
    'unresolved text classification',
    (f) => {
      f.typography.nodes[2].text = { kind: 'none' };
    },
  ],
  [
    'unmeasured body',
    (f) => {
      delete f.typography.nodes[3].rect;
    },
  ],
  [
    'equal fonts even if bold',
    (f) => {
      f.typography.nodes[1].text.runs.forEach((r) => {
        r.fontSize = 14;
      });
    },
  ],
  [
    'one small rich-text run',
    (f) => {
      f.typography.nodes[1].text.runs[1].fontSize = 14;
    },
  ],
  [
    'equal measured heights',
    (f) => {
      f.typography.nodes[1].rect!.height = 20;
      f.native.nodes[3].rect.height = 20;
    },
  ],
  [
    'title after body',
    (f) => {
      f.typography.nodes[1].rect!.y = 120;
      f.native.nodes[3].rect.y = 160;
    },
  ],
  [
    'title overlaps body',
    (f) => {
      f.typography.nodes[1].rect!.y = 70;
      f.native.nodes[3].rect.y = 110;
    },
  ],
  [
    'different scaling',
    (f) => {
      f.typography.nodes[3].text.scaling.allowFontScaling = false;
    },
  ],
  [
    'different scaling bound',
    (f) => {
      f.typography.nodes[3].text.scaling.maxFontSizeMultiplier = 2;
    },
  ],
  [
    'body in another container',
    (f) => {
      f.typography.nodes[3].parentHostIndex = null;
      f.typography.nodes[3].rootIndex = 1;
    },
  ],
  [
    'body native name differs',
    (f) => {
      f.native.nodes[4].label = 'Different';
    },
  ],
];

for (const [name, change] of unsupported) {
  test(`heading evidence withheld: ${name}`, async () => {
    const f = fixture();
    change(f);
    const screen = await f.capture();
    assert.equal(screen.elements[3].semantic?.heading, undefined);
    const judge = scriptedJudge(() => assert.fail('unsupported heading must not reach the judge'));
    const decision = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: 'the welcome heading', line: 2 },
      wait(),
    );
    assert.deepEqual(decision.visibility, { verdict: 'pending' });
    assert.equal(decision.check, 'unsure');
    assert.equal(judge.requests.length, 0);
  });
}

test('an unobserved anchor scopes the title while remaining an explicit unknown contribution', async () => {
  const f = fixture();
  f.native.nodes[2].presence.status = 'unknown';
  delete f.native.nodes[2].presence.observedUptimeMs;
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
  const projected = visibilityView(screen);
  assert.deepEqual(projected, {
    elements: screen.elements.slice(3),
    unknown: [{ element: screen.elements[2], reason: 'visibility' }],
    unassociatedReact: 0,
  });
  assert.deepEqual(semanticActionView(screen, 'press'), {
    refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
    reason: 'a native control lacks positive platform presence',
  });
  const judge = scriptedJudge((questions, _, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.equal(state.assertionEvidence.observed.length, 2);
    assert.deepEqual(state.assertionEvidence.unknown, [
      { description: 'Button "Open panel" [testID panel]', reason: 'visibility' },
    ]);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 0, kind: 'typographic-title' },
    ]);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  const { visibility } = await decideScreen(screen, judge, undefined, wait());
  assert.deepEqual(visibility, { verdict: 'present' });
  assert.equal(judge.requests.length, 1);
});

test('distinct matching anonymous hosts or native observations cannot share title identity', async () => {
  for (const duplicate of ['host', 'native', 'named-native']) {
    const f = fixture();
    if (duplicate === 'host') {
      f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
      f.typography.nodes.push({ ...structuredClone(f.typography.nodes[1]), hostIndex: 4 });
    } else {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[3]),
        index: 5,
        ref: '@e5',
        ...(duplicate === 'named-native' ? { identifier: 'other-title' } : {}),
        presence: { ...f.native.nodes[3].presence, nodeIndex: 5 },
      });
      f.native.snapshotVerdict.nodeCount++;
    }
    const screen = await f.capture();
    assert.equal(screen.elements[3].semantic?.heading, undefined);
  }
});

test('typographic title cannot satisfy an explicit accessibility role or unlock other visual requirements', async () => {
  const screen = await fixture().capture();
  const judge = scriptedJudge(() =>
    assert.fail('unsupported requirement must not reach the judge'),
  );
  assert.deepEqual(
    (await decideScreen(screen, judge, undefined, wait('the welcome accessibility heading')))
      .visibility,
    { verdict: 'pending' },
  );
  for (const phrase of ['the red welcome heading', 'the welcome heading at the top']) {
    const decision = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: phrase, line: 2 },
      wait(phrase),
    );
    assert.ok(typeof decision.check === 'object' && 'refuse' in decision.check);
    assert.equal(decision.check.refuse, 'VISIBILITY_UNSUPPORTED');
    assert.equal(decision.visibility, undefined);
    assert.equal(decision.target, undefined);
    assert.equal(judge.requests.length, 0);
    const standalone = await decideScreen(screen, judge, undefined, wait(phrase));
    assert.deepEqual(standalone.visibility, decision.check);
    assert.equal(judge.requests.length, 0);
  }
});

test('unrelated Account heading and plain Settings text stay unestablished even after a low Noul answer', async () => {
  const f = fixture();
  f.typography.nodes[1].text.content = 'Account';
  f.native.nodes[3].label = 'Account';
  f.typography.nodes[3].text.content = 'Settings';
  f.typography.nodes[3].text.runs[0].end = 8;
  f.native.nodes[4].label = 'Settings';
  const screen = await f.capture();
  const judge = scriptedJudge((questions, _, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.match(questions.visibility_1.instructions, /Heading claims require `qualifiedHeadings`/);
    assert.equal(
      state.assertionEvidence.observed.some((text) => text.includes('Settings')),
      true,
    );
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 1, kind: 'typographic-title' },
    ]);
    assert.match(state.assertionEvidence.observed[1], /Account/);
    assert.equal(state.assertionEvidence.observed[1].includes('Settings'), false);
    return { visibility_1: { type: 'noul', noul: 0.01 } };
  });
  assert.deepEqual(
    (await decideScreen(screen, judge, undefined, wait('the Settings heading'))).visibility,
    { verdict: 'pending' },
  );
  for (const [plan, captures] of [
    ['Wait for the Settings heading', PHRASE_WAIT_BUDGET_MS / WAIT_POLL_MS],
    ['Scroll down until the Settings heading', 2],
  ] as const) {
    const start = judge.requests.length;
    const w = walker([screen, screen], judge);
    const result = await runPlan(parsePlan(`1. ${plan}`).blocks!, w.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.match(result.failure!.seen, /VISIBILITY_UNSURE/);
    assert.equal(judge.requests.length - start, captures);
    assert.equal(w.captures(), plan.startsWith('Scroll') ? 3 * captures : captures);
    assert.deepEqual(w.actions, []);
  }
});

test('heading qualification never bypasses the whole-claim contribution bound or hides unknown containers', async () => {
  for (const [count, unknownAnchor] of [
    [30, false],
    [31, false],
    [30, true],
    [31, true],
  ] as const) {
    const f = fixture();
    if (unknownAnchor) {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    }
    const screen = await f.capture();
    for (let i = 3; i < count; i++)
      screen.elements.push(element(`extra${i}`, 'Other content', { kind: 'text' }));
    const judge = scriptedJudge((questions, __, state) => {
      assert.equal(count, 30, 'over-bound headings must not reach the judge');
      assert.deepEqual(Object.keys(questions), ['check_2', 'visibility_1']);
      assert.equal(state.assertionEvidence.observed.length, count - Number(unknownAnchor));
      assert.deepEqual(
        state.assertionEvidence.unknown,
        unknownAnchor
          ? [{ description: 'Button "Open panel" [testID panel]', reason: 'visibility' }]
          : [],
      );
      assert.equal(state.assertionEvidence.unassociatedReact, 0);
      assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
        { contribution: unknownAnchor ? 0 : 1, kind: 'typographic-title' },
      ]);
      return { check_2: { type: 'noul', noul: 0.99 }, visibility_1: { type: 'noul', noul: 0.99 } };
    });
    const result = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: 'the welcome heading', line: 2 },
      wait(),
    );
    if (count === 30) {
      assert.deepEqual(result.visibility, { verdict: 'present' });
      assert.equal(result.check, 'pass');
    } else {
      assert.deepEqual(result.check, {
        refuse: 'CANDIDATE_LIMIT',
        reason:
          'more than 30 assertion contributions; the whole expectation cannot be judged within the evidence bound',
      });
      assert.equal(result.visibility, undefined);
      assert.equal(result.target, undefined);
      assert.equal(judge.requests.length, 0);
      const standalone = await decideScreen(screen, judge, undefined, wait());
      assert.deepEqual(standalone.visibility, result.check);
    }
    assert.equal(judge.requests.length, count === 30 ? 1 : 0);
  }
  const f = fixture();
  f.native.nodes[2].type = 'Other';
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
  const judge = scriptedJudge((questions, _, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.equal(state.assertionEvidence.observed.length, 2);
    assert.deepEqual(state.assertionEvidence.unknown, [
      { description: 'Other "Open panel" [testID panel]', reason: 'content' },
    ]);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 0, kind: 'typographic-title' },
    ]);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  assert.deepEqual((await decideScreen(screen, judge, undefined, wait())).visibility, {
    verdict: 'present',
  });
});

test('legacy synthetic heading stays unestablished and quoted compatibility remains unchanged', async () => {
  const screen = syntheticScreen([element('title', 'Welcome', { kind: 'text' })]);
  const judge = scriptedJudge(() => assert.fail('no new evidence was provided'));
  assert.deepEqual((await decideScreen(screen, judge, undefined, wait())).visibility, {
    verdict: 'pending',
  });
  const w = walker([screen], judge);
  assert.equal((await runPlan(parsePlan('1. Wait for "Welcome"').blocks!, w.deps)).verdict, 'PASS');
});

test('typography admission rejects malformed, partial-run, cross-root and over-budget claims', () => {
  const valid = fixture().hostEvidence;
  assert.deepEqual(validateReactHostEvidence(valid), valid);
  assert.notEqual(validateReactHostEvidence(valid)!.typography, valid.typography);
  const changes = [
    (t) => {
      t.durationMs = 1000;
    },
    (t) => {
      t.durationMs = NaN;
    },
    (t) => {
      t.coordinateSpace = 'screen';
    },
    (t) => {
      t.nodes.pop();
    },
    (t) => {
      t.nodes[1].hostIndex = 0;
    },
    (t) => {
      t.nodes[0].parentHostIndex = 1;
    },
    (t) => {
      t.nodes[1].rootIndex = 2;
    },
    (t) => {
      t.nodes[2].text.ownerHostIndex = 3;
    },
    (t) => {
      t.nodes[1].rect.width = -1;
    },
    (t) => {
      t.nodes[1].rect.x = Infinity;
    },
    (t) => {
      t.nodes[1].text.runs[0].start = 1;
    },
    (t) => {
      t.nodes[1].text.runs[1].end = 6;
    },
    (t) => {
      t.nodes[1].text.runs[0].fontSize = 0;
    },
    (t) => {
      t.nodes[1].text.scaling.maxFontSizeMultiplier = 0.5;
    },
    (t) => {
      t.nodes[1].text.content = 'x'.repeat(4097);
    },
  ];
  for (const change of changes) {
    const evidence = structuredClone(valid);
    change(evidence.typography);
    assert.equal(validateHostTypography(evidence.typography, evidence.hosts.length), undefined);
    assert.equal(validateReactHostEvidence(evidence), undefined);
  }
});

test('zero-area host facts cannot admit anchors, title text or body text without positive native bounds', async () => {
  for (const [hostIndex, nativeIndex] of [
    [0, 2],
    [1, 3],
    [3, 4],
  ]) {
    for (const [width, height] of [
      [0, 0],
      [0, 40],
      [250, 0],
    ]) {
      for (const nativeGeometry of ['positive', 'observed-zero', 'unknown-zero']) {
        const f = fixture();
        Object.assign(f.typography.nodes[hostIndex].rect!, { width, height });
        assert.ok(validateHostTypography(f.typography, 4));
        if (nativeGeometry !== 'positive')
          Object.assign(f.native.nodes[nativeIndex].rect, { width, height });
        if (nativeGeometry === 'unknown-zero') {
          f.native.nodes[nativeIndex].presence.status = 'unknown';
          delete f.native.nodes[nativeIndex].presence.observedUptimeMs;
        }
        const screen = await f.capture();
        assert.equal(screen.elements[3].semantic?.heading, undefined);
        assert.equal(screen.elements.length, 5);
      }
    }
  }
});

test('rectangle validation rejects negative dimensions, missing components and every nonfinite coordinate', () => {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    for (const value of [
      undefined,
      NaN,
      Infinity,
      -Infinity,
      ...(key === 'width' || key === 'height' ? [-1] : []),
    ]) {
      const f = fixture();
      if (value === undefined) delete f.typography.nodes[1].rect![key];
      else f.typography.nodes[1].rect![key] = value;
      assert.equal(validateHostTypography(f.typography, 4), undefined, `${key}: ${value}`);
    }
  }
});

test('complete empty text, unsupported owners and multiple host roots in one renderer remain valid facts', () => {
  const f = fixture();
  f.typography.nodes[1].text = {
    kind: 'block',
    content: '',
    runs: [],
    scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
  };
  assert.ok(validateReactHostEvidence(f.hostEvidence));
  f.typography.nodes[1].text = { kind: 'unsupported' };
  assert.ok(validateReactHostEvidence(f.hostEvidence));
  f.typography.nodes[3].parentHostIndex = null;
  assert.ok(validateReactHostEvidence(f.hostEvidence));
});

test('unmeasured competing text owners cannot be dismissed to create a unique association', async () => {
  const f = fixture();
  f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
  const duplicate = { ...structuredClone(f.typography.nodes[1]), hostIndex: 4 };
  delete duplicate.rect;
  f.typography.nodes.push(duplicate);
  assert.equal((await f.capture()).elements[3].semantic?.heading, undefined);
});

test('capture accounts for competing anonymous text in another renderer root', async () => {
  for (const variant of [
    'same-frame',
    'unmeasured',
    'different-text',
    'different-frame',
    'identified-elsewhere',
  ]) {
    const f = fixture();
    const other = {
      ...structuredClone(f.typography.nodes[1]),
      hostIndex: 4,
      parentHostIndex: null,
      rootIndex: 1,
    };
    f.typography.nodes.push(other);
    f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    if (variant === 'unmeasured') delete other.rect;
    if (variant === 'different-text') {
      other.text.content = 'Elsewhere';
      other.text.runs[1].end = 9;
    }
    if (variant === 'different-frame') other.rect!.x++;
    if (variant === 'identified-elsewhere') {
      f.hostEvidence.hosts[4].testID = 'other-title';
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[3]),
        ref: '@e5',
        index: 5,
        parentIndex: 1,
        depth: 2,
        identifier: 'other-title',
        presence: { ...f.native.nodes[3].presence, nodeIndex: 5 },
      });
      f.native.snapshotVerdict.nodeCount++;
    }
    const screen = await f.capture();
    assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' }, variant);
    assert.equal(screen.reactHostEvidence!.hosts.length, 5);
    assert.equal(screen.reactHostEvidence!.typography!.nodes[4].rootIndex, 1);
    const ambiguous = variant === 'same-frame' || variant === 'unmeasured';
    assert.equal(!!screen.elements[3].semantic?.heading, !ambiguous, variant);
    if (ambiguous) {
      const judge = scriptedJudge(() =>
        assert.fail('unresolved cross-root ownership cannot reach Jev'),
      );
      assert.deepEqual((await decideScreen(screen, judge, undefined, wait())).visibility, {
        verdict: 'pending',
      });
    }
  }
});

test('removing accessibility facts cannot turn a different-content nonvirtual host into a unique title owner', async () => {
  for (const kind of ['block', 'inline'] as const) {
    const f = fixture();
    const other: HostTypography['nodes'][number] = {
      ...structuredClone(f.typography.nodes[1]),
      hostIndex: 4,
      parentHostIndex: kind === 'inline' ? 1 : null,
      rootIndex: kind === 'inline' ? 0 : 1,
      accessibility: { accessible: 'absent', authoredLabel: 'present' },
    };
    other.text =
      kind === 'inline'
        ? { kind: 'inline', ownerHostIndex: 1 }
        : {
            kind: 'block',
            content: 'Elsewhere',
            runs: [{ start: 0, end: 9, fontSize: 14 }],
            scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
          };
    f.typography.nodes.push(other);
    f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    assert.equal((await f.capture()).elements[3].semantic?.heading, undefined, kind);
    delete other.accessibility;
    const weakened = await f.capture();
    assert.deepEqual(weakened.coverage, { native: 'complete', react: 'complete' });
    assert.equal(weakened.elements[3].semantic?.heading, undefined, kind);
    assert.equal(weakened.elements.length, 5);
    assert.equal(weakened.reactHostEvidence!.hosts.length, 5);
    other.accessibility = { accessible: 'absent', authoredLabel: 'absent' };
    assert.equal(
      (await f.capture()).elements[3].semantic?.heading?.kind,
      kind === 'block' ? 'typographic-title' : undefined,
      'nonvirtual inline hosts remain possible owners even with absent accessibility props',
    );
  }
});

test('losing cross-root text classification never manufactures anonymous title uniqueness', async () => {
  for (const measured of [true, false]) {
    for (const classification of ['unsupported', 'text-none', 'null-none', 'custom-none']) {
      const f = fixture();
      const other = {
        ...structuredClone(f.typography.nodes[1]),
        hostIndex: 4,
        parentHostIndex: null,
        rootIndex: 1,
      };
      if (!measured) delete other.rect;
      f.typography.nodes.push(other);
      f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
      assert.equal((await f.capture()).elements[3].semantic?.heading, undefined);
      other.text = { kind: classification === 'unsupported' ? 'unsupported' : 'none' };
      if (classification === 'null-none') other.hostType = null;
      if (classification === 'custom-none') other.hostType = 'CustomNativeText';
      const screen = await f.capture();
      assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
      assert.equal(screen.reactHostEvidence!.typography!.nodes[4].text.kind, other.text.kind);
      assert.equal(
        screen.elements[3].semantic?.heading,
        undefined,
        `${classification}, measured=${measured}`,
      );
    }
  }
});

test('only incompatible geometry excludes an anonymous owner; a View type alone cannot', async () => {
  for (const variant of ['nontext', 'other-frame']) {
    const f = fixture();
    f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    const other: HostTypography['nodes'][number] = {
      hostIndex: 4,
      parentHostIndex: null,
      rootIndex: 1,
      hostType: variant === 'nontext' ? 'RCTView' : 'RCTText',
      text: { kind: variant === 'nontext' ? 'none' : 'unsupported' },
      ...(variant === 'other-frame' ? { rect: { x: 300, y: 600, width: 20, height: 20 } } : {}),
    };
    f.typography.nodes.push(other);
    assert.equal(
      (await f.capture()).elements[3].semantic?.heading?.kind,
      variant === 'other-frame' ? 'typographic-title' : undefined,
    );
  }
});

test('accessible View competitors require proven independent identity even when their frames match', async () => {
  for (const variant of [
    'proven',
    'missing-ID',
    'duplicate-ID',
    'missing-ref',
    'duplicate-ref',
    'unmeasured',
  ]) {
    const f = fixture();
    const other: HostTypography['nodes'][number] = {
      ...structuredClone(f.typography.nodes[1]),
      hostIndex: 4,
      parentHostIndex: null,
      rootIndex: 1,
      hostType: 'RCTView',
      text: { kind: 'none' },
      accessibility: { accessible: 'true', authoredLabel: 'present' },
    };
    f.typography.nodes.push(other);
    f.hostEvidence.hosts.push({
      testID: 'other',
      role: 'text',
      roleSource: 'role',
      capabilities: {},
    });
    f.native.nodes.push({
      ...structuredClone(f.native.nodes[3]),
      type: 'Other',
      ref: variant === 'missing-ref' ? '' : variant === 'duplicate-ref' ? '@e3' : '@e5',
      identifier: variant === 'missing-ID' ? undefined : 'other',
      index: 5,
      parentIndex: 1,
      depth: 2,
      presence: { ...f.native.nodes[3].presence, nodeIndex: 5 },
    });
    f.native.snapshotVerdict.nodeCount++;
    if (variant === 'duplicate-ID') f.hostEvidence.hosts[2].testID = 'other';
    if (variant === 'unmeasured') delete other.rect;
    const screen = await f.capture();
    assert.equal(screen.elements.length, 6);
    assert.equal(
      screen.elements[3].semantic?.heading?.kind,
      variant === 'proven' ? 'typographic-title' : undefined,
      variant,
    );
    assert.equal(screen.elements[5].semantic?.press, 'unsupported');
  }
});

test('accessibility fact validation accepts bounded flags, rejects raw values and never reads getters', () => {
  for (const accessible of ['true', 'false', 'absent', 'unknown'] as const) {
    for (const authoredLabel of ['present', 'absent', 'unknown'] as const) {
      const f = fixture();
      f.typography.nodes[0].accessibility = { accessible, authoredLabel };
      assert.ok(validateHostTypography(f.typography, 4));
    }
  }
  let reads = 0;
  for (const facts of [
    {},
    { accessible: true, authoredLabel: 'present' },
    { accessible: 'true', authoredLabel: 'Welcome' },
    { accessible: 'true', authoredLabel: 'present', label: 'private' },
    {
      get accessible() {
        reads++;
        return 'true';
      },
      authoredLabel: 'present',
    },
  ]) {
    const f = fixture();
    Object.assign(f.typography.nodes[0], { accessibility: facts });
    assert.equal(validateHostTypography(f.typography, 4), undefined);
  }
  const f = fixture();
  Object.defineProperty(f.typography.nodes[0], 'accessibility', {
    get() {
      reads++;
    },
  });
  assert.equal(validateHostTypography(f.typography, 4), undefined);
  assert.equal(reads, 0);
});

test('unsupported competitors are excluded only by a proven independent native identity', async () => {
  for (const variant of [
    'proven',
    'unknown-presence',
    'unmeasured',
    'duplicate-ID',
    'wrong-type',
  ]) {
    const f = fixture();
    const other = {
      ...structuredClone(f.typography.nodes[1]),
      hostIndex: 4,
      parentHostIndex: null,
      rootIndex: 1,
      text: { kind: 'unsupported' as const },
    };
    f.typography.nodes.push(other);
    f.hostEvidence.hosts.push({
      testID: 'other-title',
      role: null,
      roleSource: 'none',
      capabilities: {},
    });
    const nativeOther = {
      ...structuredClone(f.native.nodes[3]),
      ref: '@e5',
      index: 5,
      parentIndex: 1,
      depth: 2,
      identifier: 'other-title',
      presence: { ...f.native.nodes[3].presence, nodeIndex: 5 },
    };
    f.native.nodes.push(nativeOther);
    f.native.snapshotVerdict.nodeCount++;
    if (variant === 'unknown-presence') {
      nativeOther.presence.status = 'unknown';
      delete nativeOther.presence.observedUptimeMs;
    }
    if (variant === 'unmeasured') delete other.rect;
    if (variant === 'duplicate-ID') f.hostEvidence.hosts[2].testID = 'other-title';
    if (variant === 'wrong-type') nativeOther.type = 'Button';
    const screen = await f.capture();
    assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
    assert.equal(!!screen.elements[3].semantic?.heading, variant === 'proven', variant);
  }
});

test('real producer unsupported text in another root cannot create a heading association', async () => {
  for (const unsupported of [false, true]) {
    for (const measuredCompetitor of [true, false]) {
      const f = fixture();
      const measured = (rect: { x: number; y: number; width: number; height: number }) => ({
        measureInWindow(callback: (...values: number[]) => void) {
          callback(rect.x, rect.y, rect.width, rect.height);
        },
      });
      const main = buildFiber({
        hostType: 'RCTView',
        props: { testID: 'panel' },
        stateNode: measured(f.typography.nodes[0].rect!),
        children: [
          {
            hostType: 'RCTText',
            props: { style: { fontSize: 24 } },
            stateNode: measured(f.typography.nodes[1].rect!),
            children: [
              { text: 'Wel' },
              {
                hostType: 'RCTVirtualText',
                props: { style: { fontSize: 22 } },
                children: [{ text: 'come' }],
              },
            ],
          },
          {
            hostType: 'RCTText',
            props: {},
            stateNode: measured(f.typography.nodes[3].rect!),
            children: [{ text: 'Your workspace' }],
          },
        ],
      });
      const competitor = buildFiber({
        hostType: 'RCTText',
        props: { style: { fontSize: 24 }, ...(unsupported ? { adjustsFontSizeToFit: true } : {}) },
        stateNode: measuredCompetitor ? measured(f.typography.nodes[1].rect!) : {},
        children: [{ text: 'Welcome' }],
      });
      const queue = [main, competitor];
      while (queue.length) {
        const fiber = queue.shift()!;
        fiber.tag =
          typeof fiber.memoizedProps === 'string' ? 6 : typeof fiber.type === 'string' ? 5 : 0;
        for (let child = fiber.child; child; child = child.sibling) queue.push(child);
      }
      const sandbox = createSandbox();
      const roots = [{ current: main }, { current: competitor }];
      Object.assign(sandbox, {
        __REACT_DEVTOOLS_GLOBAL_HOOK__: {
          renderers: new Map([[1, {}]]),
          getFiberRoots: (id: number) => new Set(id === 1 ? roots : []),
        },
      });
      const produced = JSON.parse(
        await vm.runInContext(
          '__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true, typographyEvidence: true })',
          sandbox,
        ),
      );
      assert.equal(produced.hostEvidence.typography.complete, measuredCompetitor);
      const competing = produced.hostEvidence.typography.nodes.find((node) => node.rootIndex === 1);
      assert.ok(competing);
      assert.equal(competing.text.kind, unsupported ? 'unsupported' : 'block');
      assert.equal(!!competing.rect, measuredCompetitor);
      if (unsupported) assert.equal(Object.hasOwn(competing.text, 'content'), false);
      const screen = await captureScreen({
        appId: 'com.test',
        native: async () => f.native,
        react: async () => produced,
      });
      assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
      assert.equal(screen.elements[3].semantic?.heading, undefined);
      const judge = scriptedJudge(() => assert.fail('unsupported ownership cannot reach Jev'));
      const w = walker([screen], judge);
      const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, w.deps);
      assert.equal(result.verdict, 'FAIL');
      assert.match(result.failure!.seen, /VISIBILITY_UNSURE/);
      assert.deepEqual(w.actions, []);
    }
  }
});

test('identified inline spans retain graph identity without independent measurements or heading roles', async () => {
  const f = fixture();
  f.hostEvidence.hosts[2] = {
    testID: 'title-span',
    role: 'heading',
    roleSource: 'role',
    capabilities: {},
  };
  f.hostEvidence.hosts.push({
    testID: 'body-span',
    role: 'header',
    roleSource: 'accessibilityRole',
    capabilities: {},
  });
  f.typography.nodes.push({
    hostIndex: 4,
    parentHostIndex: 3,
    rootIndex: 0,
    hostType: 'RCTVirtualText',
    text: { kind: 'inline', ownerHostIndex: 3 },
  });
  const screen = await f.capture();
  assert.equal(screen.reactHostEvidence!.hosts[2].testID, 'title-span');
  assert.equal(screen.reactHostEvidence!.hosts[4].testID, 'body-span');
  assert.equal(screen.reactHostEvidence!.typography!.nodes[2].rect, undefined);
  assert.equal(screen.reactHostEvidence!.typography!.nodes[4].rect, undefined);
  assert.deepEqual(
    screen.elements.flatMap((e) => (e.semantic?.heading ? [e.semantic.heading.kind] : [])),
    ['typographic-title'],
  );
  assert.equal(screen.reactHostEvidence!.hosts[1].role, null);
  f.typography.nodes[1].text.runs.forEach((run) => {
    run.fontSize = 14;
  });
  assert.equal(
    (await f.capture()).elements.some((e) => e.semantic?.heading),
    false,
  );
});

test('heading CHECK pass stays inclusive while no lower answer becomes absence', async () => {
  const screen = await fixture().capture();
  for (const noul of [0, 0.01, 0.3, 0.5, 0.699, 0.7, 1]) {
    const judge = scriptedJudge(() => ({ visibility_1: { type: 'noul', noul } }));
    assert.deepEqual((await decideScreen(screen, judge, undefined, wait())).visibility, {
      verdict: noul >= 0.7 ? 'present' : noul <= 0.3 ? 'pending' : 'unsure',
    });
  }
});

test('both prominence ratios include 1.25 exactly and refuse immediately below it', async () => {
  for (const [fontSize, height, supported] of [
    [17.5, 25, true],
    [17.49, 25, false],
    [17.5, 24.99, false],
  ] as const) {
    const f = fixture();
    f.typography.nodes[1].text.runs.forEach((run) => {
      run.fontSize = fontSize;
    });
    f.typography.nodes[1].rect!.height = height;
    f.native.nodes[3].rect.height = height;
    assert.equal(!!(await f.capture()).elements[3].semantic?.heading, supported);
  }
});

test('heading evidence retains masking and the existing uncertain fresh-screen re-ask', async () => {
  const screen = await fixture().capture();
  const maskedJudge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).toLowerCase().includes('welcome'), false);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 1, kind: 'typographic-title' },
    ]);
    assert.match(state.assertionEvidence.observed[1], /QAREN_VALUE/);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  assert.deepEqual(
    (await decideScreen(screen, maskedJudge, undefined, wait('the Welcome heading'), ['Welcome']))
      .visibility,
    { verdict: 'present' },
  );
  assert.equal(maskedJudge.requests.length, 1);
  const judge = scriptedJudge((_, i) => ({
    visibility_1: { type: 'noul', noul: i === 0 ? 0.5 : 0.99 },
  }));
  const w = walker([screen, screen], judge);
  const result = await runPlan(parsePlan('1. Wait for the welcome heading').blocks!, w.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.equal(judge.requests.length, 2);
  assert.deepEqual(w.actions, []);
});

function scrollWithStats() {
  const f = fixture();
  f.native.nodes[2].type = 'ScrollView';
  f.typography.nodes[0].hostType = 'RCTScrollView';
  f.hostEvidence.hosts.push(
    { role: null, roleSource: 'none', capabilities: {} },
    { role: null, roleSource: 'none', capabilities: {} },
  );
  f.typography.nodes.push(
    {
      hostIndex: 4,
      parentHostIndex: 0,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: { x: 20, y: 150, width: 250, height: 120 },
      text: { kind: 'none' },
    },
    {
      hostIndex: 5,
      parentHostIndex: 4,
      rootIndex: 0,
      hostType: 'RCTText',
      rect: { x: 30, y: 160, width: 100, height: 20 },
      text: { kind: 'unsupported' },
    },
  );
  for (const [index, type, parentIndex, depth, label, rect] of [
    [5, 'Other', 2, 3, '', { x: 40, y: 190, width: 250, height: 120 }],
    [6, 'StaticText', 5, 4, '42 visits', { x: 50, y: 200, width: 100, height: 20 }],
  ] as const) {
    f.native.nodes.push({
      ...f.native.nodes[4],
      index,
      ref: `@e${index}`,
      type,
      parentIndex,
      depth,
      label,
      rect: { ...rect },
      presence: { ...f.native.nodes[4].presence, nodeIndex: index },
    });
  }
  f.native.snapshotVerdict.nodeCount = f.native.nodes.length;
  return f;
}

test('separately measured nested unsupported stats do not veto ScrollView title association', async () => {
  const f = scrollWithStats();
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.heading?.kind, 'typographic-title');
  assert.deepEqual(
    screen.elements.map((e) => e.ref),
    ['@e0', '@e1', '@e2', '@e3', '@e4', '@e5', '@e6'],
  );
  assert.equal(screen.elements[6].label, '42 visits');
  assert.equal(screen.elements[5].semantic?.press, 'unsupported');
  const judge = scriptedJudge((questions, _, state) => {
    assert.deepEqual(Object.keys(questions), ['visibility_1']);
    assert.equal(state.assertionEvidence.observed.length, 3);
    assert.deepEqual(state.assertionEvidence.unknown, [
      { description: 'Other "Open panel" [testID panel]', reason: 'content' },
    ]);
    assert.equal(state.assertionEvidence.unassociatedReact, 0);
    assert.deepEqual(state.assertionEvidence.qualifiedHeadings, [
      { contribution: 0, kind: 'typographic-title' },
    ]);
    assert.match(state.assertionEvidence.observed[2], /42 visits/);
    return { visibility_1: { type: 'noul', noul: 0.99 } };
  });
  assert.deepEqual((await decideScreen(screen, judge, undefined, wait())).visibility, {
    verdict: 'present',
  });
});

test('weakening nested stats geometry or moving unsupported content into the title container withholds a title', async () => {
  for (const variant of [
    'same-title-frame',
    'same-body-frame',
    'missing-frame',
    'unsupported-sibling',
    'opaque-ancestor',
    'unsupported-ancestor',
  ]) {
    const f = scrollWithStats();
    if (variant === 'same-title-frame')
      f.typography.nodes[5].rect = { ...f.typography.nodes[1].rect! };
    if (variant === 'same-body-frame')
      f.typography.nodes[5].rect = { ...f.typography.nodes[3].rect! };
    if (variant === 'missing-frame') delete f.typography.nodes[5].rect;
    if (variant === 'unsupported-sibling') f.typography.nodes[5].parentHostIndex = 0;
    if (variant === 'opaque-ancestor') f.typography.nodes[0].hostType = null;
    if (variant === 'unsupported-ancestor') f.typography.nodes[0].text = { kind: 'unsupported' };
    const screen = await f.capture();
    assert.equal(screen.elements[3].semantic?.heading, undefined, variant);
    assert.equal(screen.elements.length, 7);
    assert.equal(screen.elements[6].label, '42 visits');
  }
});

test('an unnamed opaque ancestor cannot be discharged by its different measured rectangle', async () => {
  const f = scrollWithStats();
  f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
  f.typography.nodes.push({
    hostIndex: 6,
    parentHostIndex: 0,
    rootIndex: 0,
    hostType: null,
    rect: { x: 15, y: 20, width: 300, height: 110 },
    text: { kind: 'none' },
  });
  f.typography.nodes[1].parentHostIndex = 6;
  f.typography.nodes[3].parentHostIndex = 6;
  assert.equal((await f.capture()).elements[3].semantic?.heading, undefined);
});

test('real entering-text producer in a separate measured stats container preserves the Welcome title only with exclusion proof', async () => {
  for (const geometry of ['distinct', 'same', 'missing']) {
    const f = scrollWithStats();
    const measured = (rect) => ({
      measureInWindow(cb) {
        cb(rect.x, rect.y, rect.width, rect.height);
      },
    });
    const root = buildFiber({
      hostType: 'RCTScrollView',
      props: { testID: 'panel' },
      stateNode: measured(f.typography.nodes[0].rect),
      children: [
        {
          hostType: 'RCTText',
          props: { style: { fontSize: 24 } },
          stateNode: measured(f.typography.nodes[1].rect),
          children: [{ text: 'Welcome' }],
        },
        {
          hostType: 'RCTText',
          stateNode: measured(f.typography.nodes[3].rect),
          children: [{ text: 'Your workspace' }],
        },
        {
          hostType: 'RCTView',
          stateNode: measured(f.typography.nodes[4].rect),
          children: [
            {
              name: 'AnimatedStats',
              props: { entering: { initialValues: { opacity: 0 } } },
              children: [
                {
                  hostType: 'RCTText',
                  stateNode:
                    geometry === 'missing'
                      ? {}
                      : measured(f.typography.nodes[geometry === 'same' ? 1 : 5].rect),
                  children: [{ text: '42 visits' }],
                },
              ],
            },
          ],
        },
      ],
    });
    const queue = [root];
    while (queue.length) {
      const fiber = queue.shift()!;
      fiber.tag =
        typeof fiber.memoizedProps === 'string' ? 6 : typeof fiber.type === 'string' ? 5 : 0;
      for (let child = fiber.child; child; child = child.sibling) queue.push(child);
    }
    const sandbox = createSandbox({ fiberRoot: root });
    const produced = JSON.parse(
      await vm.runInContext(
        '__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true, typographyEvidence: true })',
        sandbox,
      ),
    );
    assert.equal(produced.hostEvidence.typography.nodes.at(-1).text.kind, 'unsupported');
    assert.equal(produced.hostEvidence.typography.complete, geometry !== 'missing');
    const screen = await captureScreen({
      appId: 'com.test',
      native: async () => f.native,
      react: async () => produced,
    });
    assert.equal(
      screen.elements[3].semantic?.heading?.kind,
      geometry === 'distinct' ? 'typographic-title' : undefined,
      geometry,
    );
    assert.equal(screen.elements.length, 7);
    assert.equal(screen.elements[5].kind, 'other');
    assert.equal(screen.elements[5].semantic?.press, 'unsupported');
    assert.equal(screen.elements[6].label, '42 visits');
  }
});

test('heading comparison never combines associated title and body from different windows', async () => {
  const f = fixture();
  delete f.hostEvidence.hosts[0].testID;
  f.hostEvidence.hosts[1].testID = 'title';
  f.hostEvidence.hosts[3].testID = 'body';
  f.native.nodes[3].identifier = 'title';
  const body = structuredClone(f.native.nodes[4]);
  f.native.nodes[4] = {
    ...structuredClone(f.native.nodes[1]),
    ref: '@e4',
    index: 4,
    presence: { ...f.native.nodes[1].presence, nodeIndex: 4 },
  };
  f.native.nodes.push({
    ...body,
    ref: '@e5',
    index: 5,
    identifier: 'body',
    parentIndex: 4,
    depth: 2,
    presence: { ...body.presence, nodeIndex: 5 },
  });
  f.native.snapshotVerdict.nodeCount = 6;
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.visibility, 'visible');
  assert.equal(screen.elements[5].semantic?.visibility, 'visible');
  assert.equal(screen.elements[3].semantic?.heading, undefined);
});
