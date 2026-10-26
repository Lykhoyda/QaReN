import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import type { ReactObservation } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { outsideViewport } from '../../../dist/qa/native-presence.js';
import { concealsScreen, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import type { NativeNode } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge, walker } from './judgment-fixtures.ts';
import { attested, nativeCapture } from './platform-presence-fixtures.ts';

type Extra = Partial<NativeNode> & { ref: string; type: string };

function native(extra: Extra[], presence = false) {
  const base = nativeCapture();
  const nodes = [
    ...base.nodes,
    ...extra.map((node, i) => ({
      ...base.nodes[1],
      identifier: undefined,
      label: undefined,
      ...node,
      index: base.nodes.length + i,
      presence: { ...base.nodes[1].presence, nodeIndex: base.nodes.length + i },
    })),
  ];
  return {
    ...base,
    presenceCapture: presence ? base.presenceCapture : undefined,
    nodes,
    snapshotVerdict: { ...base.snapshotVerdict, nodeCount: nodes.length },
  };
}

const digest = (extra: ReactObservation['interactive'] = []): ReactObservation => ({
  interactive: [
    { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
    ...(extra ?? []),
  ],
  verdict: { state: 'ok', path: 'interactive', complete: true },
  hostEvidence: {
    complete: true,
    hosts: [{ testID: 'save', role: 'button', roleSource: 'role', capabilities: { press: true } }],
  },
});

function deps(
  screens: Array<{ nodes: Extra[]; react?: ReactObservation; presence?: boolean }>,
  answer = 0.01,
) {
  let captures = 0;
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer }])),
  );
  const f = walker([], judge);
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots += 1;
    return name;
  };
  f.deps.captureScreen = (options) => {
    const next = screens[Math.min(captures++, screens.length - 1)];
    return captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      timing: options?.timing,
      native: async () => native(next.nodes, next.presence),
      react: async () => next.react ?? digest(),
    });
  };
  return { f, judge, shots: () => shots };
}

const outputs = (value: unknown, judge: { requests: unknown[] }, rows: unknown[]) =>
  JSON.stringify({ value, rows, prompts: judge.requests });

test('a hidden but attached field and its same-screen echo are masked in the prompt and every output', async () => {
  const secret = 'secret-a@example.test';
  const { f, judge } = deps([
    {
      nodes: [
        {
          ref: '@hidden',
          type: 'TextField',
          identifier: 'hidden-email',
          label: 'Email',
          value: secret,
          rect: { x: 10, y: -2000, width: 200, height: 40 },
        },
        { ref: '@echo', type: 'StaticText', label: `Signed in as ${secret}` },
      ],
      presence: true,
    },
  ]);
  const result = await runPlan(
    parsePlan(`✓ The greeting names the signed-in account\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  assert.equal(result.verdict, 'FAIL');
  assert.ok(
    judge.requests.length > 0,
    `the phrase check reached the model: ${JSON.stringify(result)}`,
  );
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('strings from a React-only digest entry never reach any output', async () => {
  const reactOnly = 'react-only-secret-label';
  const { f, judge } = deps([
    {
      nodes: [{ ref: '@echo', type: 'StaticText', label: 'Welcome' }],
      react: digest([{ role: 'text', testID: 'ghost', text: reactOnly, label: reactOnly }]),
      presence: true,
    },
  ]);
  const result = await runPlan(
    parsePlan(`✓ The welcome text is shown\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(reactOnly), false, all);
  const screen = await f.deps.captureScreen();
  assert.ok(screen.elements.some((element) => element.testID === 'ghost'));
  assert.equal(JSON.stringify(screen.elements).includes(reactOnly), false);
});

test('a field value seen earlier stays masked when echoed after navigation', async () => {
  const secret = 'history-b@example.test';
  const { f, judge, shots } = deps([
    {
      nodes: [
        { ref: '@email', type: 'TextField', identifier: 'email', label: 'Email', value: secret },
      ],
    },
    { nodes: [{ ref: '@welcome', type: 'StaticText', label: `Welcome ${secret}` }] },
  ]);
  const result = await runPlan(parsePlan(`1. Tap "save"\n✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(f.actions, ['press @e1']);
  assert.equal(f.rows[0].outcome, 'pass');
  assert.match(result.failure!.seen, /Welcome •••/);
  assert.equal(shots(), 0);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('generic native values stay private when React fails or reclassifies them', async () => {
  const secret = 'wrapped-input-private';
  for (const type of ['Other', 'UnrecognizedView', 'android.view.ViewGroup']) {
    for (const reactState of ['failed', 'empty', 'text-role']) {
      for (const history of [false, true]) {
        const judge = scriptedJudge((questions) =>
          Object.fromEntries(
            Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.01 }]),
          ),
        );
        const f = walker([], judge);
        let captures = 0;
        let shots = 0;
        f.deps.screenshot = async (name) => {
          shots++;
          return name;
        };
        f.deps.captureScreen = () => {
          const afterNavigation = history && captures++ > 0;
          return captureScreen({
            appId: 'com.test',
            requirePrivateInputs: true,
            native: async () =>
              native(
                [
                  ...(!afterNavigation
                    ? [
                        {
                          ref: '@wrapped',
                          type,
                          identifier: 'wrapped',
                          label: 'Email',
                          value: secret,
                        },
                      ]
                    : []),
                  { ref: '@echo', type: 'StaticText', label: `Echo: ${secret}` },
                ],
                afterNavigation,
              ),
            react: async () => {
              if (afterNavigation) return digest();
              if (reactState === 'failed') throw new Error('React transport failed');
              return digest(
                reactState === 'text-role' ? [{ role: 'text', testID: 'wrapped' }] : [],
              );
            },
          });
        };
        const plan = history
          ? '1. Tap "save"\n✓ The greeting shows an account\n✓ "Nothing like this"'
          : '✓ "Nothing like this"';
        const result = await runPlan(parsePlan(plan).blocks!, f.deps);
        assert.equal(result.verdict, 'FAIL');
        assert.match(result.failure!.seen, /Echo: •••/);
        assert.equal(shots, 0);
        if (history) {
          assert.deepEqual(f.actions, ['press @e1']);
          assert.ok(judge.requests.length > 0, 'the post-navigation check must reach the model');
        }
        const all = outputs(result, judge, f.rows);
        assert.equal(all.includes(secret), false, `${type}/${reactState}/${history}: ${all}`);
      }
    }
  }
});

test('filling an empty field then navigating to a native echo masks output and withholds screenshots', async () => {
  const typed = 'typed-c@example.test';
  const { f, judge, shots } = deps([
    { nodes: [{ ref: '@email', type: 'TextField', identifier: 'Email', label: 'Email' }] },
    { nodes: [{ ref: '@note', type: 'StaticText', label: `Sent to ${typed}` }] },
  ]);
  const result = await runPlan(
    parsePlan(`1. Fill "Email" with "${typed}"\n✓ "Nothing like this"`).blocks!,
    f.deps,
  );
  assert.deepEqual(f.actions, [`fill @email ${typed}`]);
  assert.equal(f.rows[0].outcome, 'pass');
  assert.match(result.failure!.seen, /Sent to •••/);
  assert.equal(shots(), 0);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(typed), false, all);
});

test('a secure field is never written and withholds screenshots', async () => {
  const { f, judge, shots } = deps([
    {
      nodes: [
        {
          ref: '@password',
          type: 'SecureTextField',
          identifier: 'password',
          label: 'Password',
          value: '•••••••',
          secure: true,
        },
      ],
    },
  ]);
  const result = await runPlan(parsePlan(`✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(shots(), 0);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes('•••••••'), false, all);
});

test('a readable secure value and its echo are masked in every output', async () => {
  const secret = 'readable-secure-d';
  const { f, judge, shots } = deps([
    {
      nodes: [
        {
          ref: '@password',
          type: 'android.widget.EditText',
          identifier: 'password',
          label: secret,
          secure: true,
        },
        { ref: '@echo', type: 'android.widget.TextView', label: `Your password is ${secret}` },
      ],
    },
  ]);
  const result = await runPlan(parsePlan(`✓ "Nothing like this"`).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(shots(), 0);
  assert.ok(result.failure!.seen.endsWith('[screen text withheld: a secure field is on screen]'));
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes(secret), false, all);
});

test('a literal check refuses when the native tree is not proven complete', async () => {
  for (const [broken, cause] of [
    [{ snapshotVerdict: undefined }, 'unattested'],
    [{ truncated: true }, 'truncated'],
  ] as const) {
    const judge = scriptedJudge(() => assert.fail('a refused capture must not call Jev'));
    const f = walker([], judge);
    f.deps.captureScreen = () =>
      captureScreen({
        appId: 'com.test',
        requirePrivateInputs: true,
        native: async () => ({
          ...native([{ ref: '@welcome', type: 'StaticText', label: 'Welcome' }]),
          ...broken,
        }),
        react: async () => digest(),
      });
    const result = await runPlan(parsePlan('✓ "Welcome"').blocks!, f.deps);
    assert.equal(result.verdict, 'REFUSED', cause);
    assert.equal('code' in result && result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
    assert.match(result.failure!.seen, new RegExp(`causes=${cause}\\)`));
  }
});

test('open and secure field values equal to their placeholders are masked', async () => {
  const fields = digest([
    { role: 'textbox', testID: 'search', placeholder: 'Search', capabilities: { fill: true } },
    { role: 'textbox', testID: 'code', placeholder: 'Code', capabilities: { fill: true } },
  ]);
  const { f, judge, shots } = deps([
    {
      nodes: [
        { ref: '@search', type: 'TextField', identifier: 'search', value: 'Search' },
        { ref: '@results', type: 'StaticText', label: 'Search results' },
        { ref: '@code', type: 'SecureTextField', identifier: 'code', value: 'Code', secure: true },
        { ref: '@sent', type: 'StaticText', label: 'Code sent' },
      ],
      react: fields,
    },
  ]);
  const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
  assert.ok(result.failure!.seen.endsWith('[screen text withheld: a secure field is on screen]'));
  assert.equal(shots(), 0);
  const all = outputs(result, judge, f.rows);
  assert.equal(all.includes('Search'), false, all);
  assert.equal(all.includes('Code'), false, all);
});

test('bullet-only open values and Android placeholder-equal labels are private', async () => {
  for (const [type, secret] of [
    ['TextField', '***'],
    ['android.widget.EditText', 'Search'],
  ]) {
    const { f, judge, shots } = deps([
      {
        nodes: [
          {
            ref: '@input',
            type,
            identifier: 'entry',
            ...(type === 'TextField' ? { value: secret } : { label: secret }),
          },
          { ref: '@echo', type: 'StaticText', label: `Echo ${secret}` },
        ],
        react: digest([{ role: 'textbox', testID: 'entry', placeholder: secret }]),
      },
    ]);
    const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
    assert.match(result.failure!.seen, /Echo •••/);
    assert.equal(shots(), 0);
    const all = outputs(result, judge, f.rows);
    assert.equal(all.includes(secret), false, all);
  }
});

test('native pixel echoes withhold screenshots without changing short-token text disclosure', async () => {
  for (const echo of [
    { ref: '@text', type: 'StaticText', label: 'Echo x' },
    { ref: '@image', type: 'Image', label: 'Echo x' },
    { ref: '@container', type: 'Other', value: 'Echo x' },
  ]) {
    const privacy = new ObservedPrivacy(['x']);
    const screen = await captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => native([echo]),
      react: async () => digest(),
    });
    privacy.observe(screen);
    assert.equal(privacy.canScreenshot(), false);
    assert.equal(privacy.redact('Echo x'), echo.value ? '•••' : 'Echo x');
  }
  const privacy = new ObservedPrivacy(['absent-secret']);
  const screen = await captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    native: async () => native([{ ref: '@text', type: 'StaticText', label: 'Welcome' }]),
    react: async () => digest(),
  });
  privacy.observe(screen);
  assert.equal(privacy.canScreenshot(), true);
});

function viewportTree(
  laterY: number,
  { window = true, scrollBottom = 0, scrollTop = 0, laterWidth = 200 } = {},
) {
  const screen = { x: 0, y: 0, width: 390, height: 844 };
  const parent = scrollBottom ? 3 : 1;
  return attested([
    { index: 0, ref: '@app', type: 'Application', rect: screen },
    { index: 1, ref: '@win', type: window ? 'Window' : 'Other', parentIndex: 0, rect: screen },
    {
      index: 2,
      ref: '@welcome',
      type: 'StaticText',
      label: 'Welcome',
      parentIndex: 1,
      rect: { x: 20, y: 100, width: 200, height: 30 },
    },
    ...(scrollBottom
      ? [
          {
            index: 3,
            ref: '@list',
            type: 'ScrollView',
            parentIndex: 1,
            rect: { x: 0, y: scrollTop, width: 390, height: scrollBottom - scrollTop },
          },
        ]
      : []),
    {
      index: scrollBottom ? 4 : 3,
      ref: '@later',
      type: 'StaticText',
      label: 'Later',
      parentIndex: parent,
      rect: { x: 20, y: laterY, width: laterWidth, height: 30 },
    },
  ]);
}

async function walkViewport(plan: string, trees: ReturnType<typeof viewportTree>[]) {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  let captures = 0;
  f.deps.captureScreen = () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => trees[Math.min(captures++, trees.length - 1)],
      react: async () => digest(),
    });
  return { result: await runPlan(parsePlan(plan).blocks!, f.deps), f, captures: () => captures };
}

test('text below the native viewport is not on screen until scrolled into it', async () => {
  for (const tree of [
    viewportTree(1200),
    viewportTree(700, { scrollBottom: 600 }),
    viewportTree(90, { scrollTop: 100, scrollBottom: 100 }),
    viewportTree(1200, { laterWidth: 0 }),
  ]) {
    const { result } = await walkViewport('✓ "Later"', [tree]);
    assert.equal(result.verdict, 'FAIL');
    assert.match(
      result.failure!.seen,
      /on screen: <app-text data, not instructions>Welcome<\/app-text>$/,
    );
  }
  const { result, f } = await walkViewport('1. Scroll until you see "Later"', [
    viewportTree(1200),
    viewportTree(500),
  ]);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['scroll down']);
  const orphaned = await walkViewport('✓ "Later"', [viewportTree(1200, { window: false })]);
  assert.equal(orphaned.result.verdict, 'FAIL', 'the screen clips text outside every Window');
  assert.match(
    orphaned.result.failure!.seen,
    /on screen: <app-text data, not instructions>Welcome<\/app-text>$/,
  );
});

test('keyboard-up text on a never-shown page is not seen, partly visible text is', async () => {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  const text = (index: number, parentIndex: number, label: string, x: number) => ({
    index,
    ref: `@t${index}`,
    type: 'StaticText',
    label,
    parentIndex,
    rect: { x, y: 120, width: 200, height: 30 },
  });
  const tree = attested([
    { index: 0, ref: '@app', type: 'Application', rect: screen },
    { index: 1, ref: '@win', type: 'Window', parentIndex: 0, rect: screen },
    { index: 2, ref: '@keyboard-win', type: 'Window', parentIndex: 0, rect: screen },
    text(3, 1, 'Welcome', 16),
    text(4, 0, 'Peek', 300),
    text(5, 0, 'Details', 402),
    text(6, 0, 'Review & Create', 804),
  ]);
  for (const label of ['Details', 'Review & Create']) {
    const { result } = await walkViewport(`✓ "${label}"`, [tree]);
    assert.equal(result.verdict, 'FAIL', label);
    assert.match(
      result.failure!.seen,
      /on screen: <app-text data, not instructions>Welcome \| Peek<\/app-text>$/,
    );
  }
  const partly = await walkViewport('✓ "Peek"', [tree]);
  assert.equal(partly.result.verdict, 'PASS');
});

test('scroll clips exclude detached text from checks, waits and scroll-until on every axis', async () => {
  const rect = { x: 0, y: 0, width: 402, height: 874 };
  for (const type of ['ScrollView', 'Table', 'CollectionView']) {
    for (const window of [false, true]) {
      for (const [x, y, direction] of [
        [20, 500, 'down'],
        [20, 50, 'up'],
        [350, 120, 'down'],
        [0, 120, 'down'],
      ] as const) {
        const nodes: NativeNode[] = [
          { ref: '@app', type: 'Application', rect },
          { ref: '@window', type: window ? 'Window' : 'Other', parentIndex: 0, rect },
          {
            ref: '@list',
            type,
            parentIndex: 1,
            rect: { x: 50, y: 100, width: 250, height: 300 },
          },
          {
            ref: '@later',
            type: 'StaticText',
            label: 'Later',
            parentIndex: 2,
            rect: { x, y, width: x === 0 ? 30 : 200, height: 30 },
          },
          {
            ref: '@partial',
            type: 'StaticText',
            label: 'Partial',
            parentIndex: 2,
            rect: { x: 40, y: 384, width: 100, height: 30 },
          },
        ];
        if (x === 20 && y === 500) nodes[2].rect = { x: 0, y: 100, width: 402, height: 300 };
        assert.deepEqual([...outsideViewport(nodes)], [3]);
        const initial = attested(nodes);
        const observed = await captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          native: async () => initial,
          react: async () => digest(),
        });
        assert.equal(observed.elements.find((e) => e.ref === '@later')!.offscreen, true);
        assert.deepEqual(observed.visibleText, ['Partial']);
        const failed = await walkViewport('✓ "Later"', [initial]);
        assert.equal(failed.result.verdict, 'FAIL');
        const partial = await walkViewport('✓ "Partial"', [initial]);
        assert.equal(partial.result.verdict, 'PASS');
        const revealed = attested(
          nodes.map((node) =>
            node.ref === '@later'
              ? { ...node, rect: { x: 60, y: 200, width: 200, height: 30 } }
              : node,
          ),
        );
        const waited = await walkViewport('1. Wait for "Later"', [initial, revealed]);
        assert.equal(waited.result.verdict, 'PASS');
        assert.ok(waited.captures() > 1);
        const scrolled = await walkViewport('1. Scroll until you see "Later"', [initial, revealed]);
        assert.equal(scrolled.result.verdict, 'PASS');
        assert.deepEqual(scrolled.f.actions, [`scroll ${direction}`]);
      }
    }
  }
});

test('screen and nested container clips remain cumulative across missing and invalid anchors', () => {
  const rect = { x: 0, y: 0, width: 402, height: 874 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect },
    { ref: '@window', type: 'Window', parentIndex: 0, rect },
    {
      ref: '@outer',
      type: 'Table',
      parentIndex: 1,
      rect: { x: 0, y: 100, width: 402, height: 300 },
    },
    { ref: '@inner', type: 'CollectionView', parentIndex: 2, rect },
    {
      ref: '@later',
      type: 'StaticText',
      parentIndex: 3,
      rect: { x: 20, y: 500, width: 200, height: 30 },
    },
  ];
  for (const invalid of [undefined, { ...rect, x: NaN }, { ...rect, width: -1 }]) {
    for (const index of [0, 1, 3]) {
      const patched = nodes.map((node, i) => (i === index ? { ...node, rect: invalid } : node));
      assert.ok(outsideViewport(patched).has(4));
    }
  }
  const overlapping = nodes.map((node, i) => {
    if (i === 2) return { ...node, rect: { x: 0, y: 800, width: 402, height: 200 } };
    if (i === 4) return { ...node, rect: { x: 20, y: 858, width: 200, height: 30 } };
    return node;
  });
  assert.equal(outsideViewport(overlapping).has(4), false);
  overlapping[4].rect!.y = 874;
  assert.equal(outsideViewport(overlapping).has(4), true);
  overlapping[3].rect = { x: 0, y: 0, width: 402, height: 800 };
  overlapping[4].rect!.y = 790;
  assert.equal(outsideViewport(overlapping).has(4), true);
});

test('each node uses its own sized Window ancestor when multiple windows exist', async () => {
  const rect = { x: 0, y: 0, width: 390, height: 844 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect },
    { ref: '@main', type: 'Window', parentIndex: 0, rect },
    { ref: '@welcome', type: 'StaticText', parentIndex: 1, label: 'Welcome', rect },
    {
      ref: '@aux',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 180, y: 100, width: 200, height: 200 },
    },
    {
      ref: '@later',
      type: 'StaticText',
      parentIndex: 1,
      label: 'Later',
      rect: { x: 10, y: 1200, width: 100, height: 30 },
    },
    {
      ref: '@aux-visible',
      type: 'StaticText',
      parentIndex: 3,
      label: 'Auxiliary',
      rect: { x: 190, y: 120, width: 100, height: 30 },
    },
    {
      ref: '@aux-outside',
      type: 'StaticText',
      parentIndex: 3,
      label: 'Outside auxiliary',
      rect: { x: 10, y: 120, width: 100, height: 30 },
    },
    {
      ref: '@unowned',
      type: 'StaticText',
      parentIndex: 0,
      label: 'Unowned',
      rect: { x: 10, y: 1200, width: 100, height: 30 },
    },
    { ref: '@unsized', type: 'Window', parentIndex: 0 },
    {
      ref: '@unsized-child',
      type: 'StaticText',
      parentIndex: 8,
      rect: { x: 10, y: 1200, width: 100, height: 30 },
    },
  ];
  assert.deepEqual([...outsideViewport(nodes)], [4, 6, 7, 9]);
  const initial = attested(nodes);
  const revealed = attested(
    nodes.map((node) =>
      node.ref === '@later' ? { ...node, rect: { ...node.rect!, y: 500 } } : node,
    ),
  );
  const failed = await walkViewport('✓ "Later"', [initial]);
  assert.equal(failed.result.verdict, 'FAIL');
  assert.equal(failed.result.failure!.seen.includes('Outside auxiliary'), false);
  const visible = await walkViewport('✓ "Auxiliary"', [initial]);
  assert.equal(visible.result.verdict, 'PASS');
  const scrolled = await walkViewport('1. Scroll until you see "Later"', [initial, revealed]);
  assert.equal(scrolled.result.verdict, 'PASS');
  assert.deepEqual(scrolled.f.actions, ['scroll down']);
  const waited = await walkViewport('1. Wait for "Later"', [initial, revealed]);
  assert.equal(waited.result.verdict, 'PASS');
});

test('nested ScrollView clips intersect Table and CollectionView clips on both axes', async () => {
  const rect = { x: 0, y: 0, width: 390, height: 844 };
  for (const type of ['Table', 'CollectionView']) {
    const nodes: NativeNode[] = [
      { ref: '@app', type: 'Application', rect },
      { ref: '@window', type: 'Window', parentIndex: 0, rect },
      {
        ref: '@outer',
        type,
        parentIndex: 1,
        rect: { x: 50, y: 100, width: 200, height: 300 },
      },
      { ref: '@inner', type: 'ScrollView', parentIndex: 2, rect },
      {
        ref: '@later',
        type: 'StaticText',
        label: 'Later',
        parentIndex: 3,
        rect: { x: 60, y: 500, width: 100, height: 30 },
      },
      {
        ref: '@left',
        type: 'StaticText',
        parentIndex: 3,
        rect: { x: 0, y: 120, width: 30, height: 30 },
      },
      {
        ref: '@right',
        type: 'StaticText',
        parentIndex: 3,
        rect: { x: 260, y: 120, width: 30, height: 30 },
      },
      {
        ref: '@above',
        type: 'StaticText',
        parentIndex: 3,
        rect: { x: 60, y: 50, width: 100, height: 30 },
      },
      {
        ref: '@partial',
        type: 'StaticText',
        label: 'Partial',
        parentIndex: 3,
        rect: { x: 40, y: 90, width: 100, height: 30 },
      },
      {
        ref: '@zero',
        type: 'StaticText',
        parentIndex: 3,
        rect: { x: 60, y: 120, width: 0, height: 0 },
      },
    ];
    assert.deepEqual([...outsideViewport(nodes)], [3, 4, 5, 6, 7], type);
    const initial = attested(nodes);
    const revealed = attested(
      nodes.map((node) =>
        node.ref === '@later' ? { ...node, rect: { ...node.rect!, y: 200 } } : node,
      ),
    );
    const failed = await walkViewport('✓ "Later"', [initial]);
    assert.equal(failed.result.verdict, 'FAIL', type);
    const visible = await walkViewport('✓ "Partial"', [initial]);
    assert.equal(visible.result.verdict, 'PASS', type);
    const scrolled = await walkViewport('1. Scroll until you see "Later"', [initial, revealed]);
    assert.equal(scrolled.result.verdict, 'PASS', type);
    assert.deepEqual(scrolled.f.actions, ['scroll down']);
    const waited = await walkViewport('1. Wait for "Later"', [initial, revealed]);
    assert.equal(waited.result.verdict, 'PASS', type);
    const empty = nodes.map((node) =>
      node.ref === '@inner' ? { ...node, rect: { x: 260, y: 100, width: 100, height: 300 } } : node,
    );
    assert.ok(outsideViewport(empty).has(9), `${type}: an empty clip hides zero-size frames`);
  }
});

function wizardTree(pageX: number) {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  return attested([
    { index: 0, ref: '@app', type: 'Application', rect: screen },
    { index: 1, ref: '@win', type: 'Window', parentIndex: 0, rect: screen },
    {
      index: 2,
      ref: '@pager',
      type: 'Other',
      parentIndex: 1,
      rect: { x: pageX, y: 0, width: 1206, height: 874 },
    },
    {
      index: 3,
      ref: '@step-1',
      type: 'Other',
      identifier: 'wizard-step-1',
      parentIndex: 2,
      rect: { x: pageX, y: 0, width: 402, height: 874 },
    },
    {
      index: 4,
      ref: '@step-label',
      type: 'StaticText',
      label: 'STEP 1 OF 3',
      parentIndex: 3,
      rect: { x: pageX + 24, y: 80, width: 120, height: 20 },
    },
    {
      index: 5,
      ref: '@desc',
      type: 'TextView',
      label: 'Add details (optional)',
      parentIndex: 3,
      rect: { x: 24, y: 20, width: 354, height: 100 },
    },
    {
      index: 6,
      ref: '@step-2',
      type: 'Other',
      parentIndex: 2,
      rect: { x: pageX + 402, y: 0, width: 402, height: 874 },
    },
    {
      index: 7,
      ref: '@step-2-label',
      type: 'StaticText',
      label: 'STEP 2 OF 3',
      parentIndex: 6,
      rect: { x: pageX + 426, y: 80, width: 120, height: 20 },
    },
  ]);
}

test('a node whose page slid wholly off screen is off screen despite its own on-screen frame', async () => {
  const hidden = wizardTree(-402);
  assert.deepEqual([...outsideViewport(hidden.nodes)], [3, 4, 5]);
  const observed = await captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    native: async () => hidden,
    react: async () => digest(),
  });
  assert.equal(observed.elements.find((e) => e.ref === '@desc')!.offscreen, true);
  assert.deepEqual(observed.visibleText, ['STEP 2 OF 3']);
  for (const label of ['Add details (optional)', 'STEP 1 OF 3']) {
    const { result } = await walkViewport(`✓ "${label}"`, [hidden]);
    assert.equal(result.verdict, 'FAIL', label);
    assert.match(
      result.failure!.seen,
      /on screen: <app-text data, not instructions>STEP 2 OF 3<\/app-text>$/,
    );
  }
});

test('the same page shown on screen keeps its placeholder text visible', async () => {
  const shown = wizardTree(0);
  assert.deepEqual([...outsideViewport(shown.nodes)], [2, 6, 7]);
  const { result } = await walkViewport('✓ "Add details (optional)"', [shown]);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
});

test('an on-screen parent does not clip its overflowing child', () => {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: screen },
    { ref: '@win', type: 'Window', parentIndex: 0, rect: screen },
    {
      ref: '@parent',
      type: 'Other',
      parentIndex: 1,
      rect: { x: 0, y: 100, width: 100, height: 100 },
    },
    {
      ref: '@overflow',
      type: 'StaticText',
      label: 'Overflow',
      parentIndex: 2,
      rect: { x: 150, y: 100, width: 50, height: 50 },
    },
  ];
  assert.deepEqual([...outsideViewport(nodes)], []);
});

test('a React placeholder never joins a native node with a different identifier', async () => {
  const screen = { x: 0, y: 0, width: 402, height: 874 };
  const observed = await captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    native: async () =>
      attested([
        { index: 0, ref: '@app', type: 'Application', rect: screen },
        { index: 1, ref: '@win', type: 'Window', parentIndex: 0, rect: screen },
        {
          index: 2,
          ref: '@title',
          type: 'TextField',
          identifier: 'wizard-title-input',
          label: 'Add details (optional)',
          parentIndex: 1,
          rect: { x: 24, y: 100, width: 354, height: 44 },
        },
      ]),
    react: async () =>
      digest([
        {
          role: 'textbox',
          testID: 'wizard-desc-input',
          placeholder: 'Add details (optional)',
          capabilities: { fill: true },
        },
      ]),
  });
  const title = observed.elements.find((e) => e.ref === '@title')!;
  assert.equal(title.testID, 'wizard-title-input');
  assert.equal(title.placeholder, undefined);
});

test('secure captures withhold all screen text, including offscreen and empty fields', () => {
  const privacy = new ObservedPrivacy([]);
  const texts = ['Welcome', 'Saved password: pf-s3cret-91'];
  const plain = screen(texts.map((label, i) => element(`@text${i}`, label, { kind: 'text' })));
  plain.elements.push(element('@email', 'Email', { kind: 'input' }));
  assert.equal(concealsScreen(plain), false);
  assert.deepEqual(privacy.screenText(plain), [...texts, 'Email']);
  for (const offscreen of [false, true]) {
    const captured = screen(
      [
        ...plain.elements,
        element('@password', 'Password', { kind: 'input', secure: true, offscreen }),
      ],
      texts,
    );
    assert.deepEqual(privacy.screenText(captured), [
      '[screen text withheld: a secure field is on screen]',
    ]);
  }
});
