import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../../dist/injected-helpers.js';
import { associateHeadings } from '../../../dist/qa/host-typography.js';
import { validateReactHostEvidence } from '../../../dist/qa/screen.js';
import { createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';
import { devFreeze } from './rn-dev-freeze.ts';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';

const { maxHosts } = PRIVATE_INPUT_LIMITS;

type Measure = (callback: (...rect: number[]) => void) => void;
interface Fiber {
  tag: number;
  type: unknown;
  memoizedProps: unknown;
  memoizedState?: unknown;
  stateNode: any;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate?: Fiber;
}

function fiber(tag: number, type: unknown, props: unknown, children: Fiber[] = []): Fiber {
  const node: Fiber = {
    tag,
    type,
    memoizedProps: props,
    stateNode: null,
    return: null,
    child: children[0] ?? null,
    sibling: null,
  };
  children.forEach((child, index) => {
    child.return = node;
    child.sibling = children[index + 1] ?? null;
  });
  return node;
}
const raw = (text: string) => fiber(6, null, text);
const composite = (children: Fiber[], name = 'Heading') =>
  fiber(0, { displayName: name }, {}, children);
const measured: Measure = (callback) => callback(10, 20, 200, 40);
function host(
  type: string,
  props = {},
  children: Fiber[] = [],
  measure: Measure | null = measured,
) {
  const node = fiber(5, type, props, children);
  node.stateNode = measure ? { measureInWindow: measure } : {};
  return node;
}
const text = (content = 'Title', props = {}, measure: Measure | null = measured) =>
  host('RCTText', props, [raw(content)], measure);

function fixture(...fibers: Fiber[]) {
  const roots = fibers.map((current) => ({ current }));
  const sandbox = createSandbox();
  Object.assign(sandbox, {
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map([[1, {}]]),
      getFiberRoots: (id: number) => new Set(id === 1 ? roots : []),
    },
  });
  return { sandbox, roots };
}
const options = { interactiveOnly: true, semanticEvidence: true, typographyEvidence: true };
function invoke(sandbox: vm.Context, opts: object = options) {
  return vm.runInContext(`__QAREN.getTree(${JSON.stringify(opts)})`, sandbox);
}
async function digest(sandbox: vm.Context) {
  const result = invoke(sandbox);
  assert.equal(typeof result.then, 'function');
  return JSON.parse(await result);
}
async function typography(...fibers: Fiber[]) {
  return (await digest(fixture(...fibers).sandbox)).hostEvidence.typography;
}

test('stable bailout children may retain alternate parent returns, but those exact returns must not change', async () => {
  for (const mutate of [false, true]) {
    let complete: (...values: number[]) => void = () => assert.fail('measurement not started');
    const title = text('Title', {}, (cb) => {
      complete = cb;
    });
    const sibling = host('RCTView');
    const parent = composite([title, sibling]);
    const alternate = composite([]);
    parent.alternate = alternate;
    alternate.alternate = parent;
    alternate.child = parent.child;
    title.return = alternate;
    sibling.return = alternate;
    const pending = digest(fixture(parent).sandbox);
    await Promise.resolve();
    if (mutate) title.return = parent;
    complete(0, 0, 200, 40);
    const evidence = (await pending).hostEvidence.typography;
    assert.equal(evidence.complete, !mutate);
    assert.equal(evidence.nodes[0].text.kind, mutate ? 'unsupported' : 'block');
    assert.equal(Boolean(evidence.nodes[0].rect), !mutate);
  }
});

test('RN dev-frozen text styles keep block typography while lookalike accessors stay unsupported', async () => {
  const frozen = await typography(text('Welcome', { style: devFreeze({ fontSize: 28 }) }));
  assert.equal(frozen.nodes[0].text.kind, 'block');
  assert.equal(frozen.nodes[0].text.runs[0].fontSize, 28);
  let calls = 0;
  const style = Object.defineProperty({}, 'fontSize', {
    enumerable: true,
    get() {
      calls++;
      return 28;
    },
  });
  const lookalike = await typography(text('Welcome', { style: Object.freeze(style) }));
  assert.equal(lookalike.nodes[0].text.kind, 'unsupported');
  assert.equal(calls, 0);
});

test('named virtual spans preserve identity and ancestry without measuring or degrading the capture', async () => {
  const span = host('RCTVirtualText', { testID: 'span' }, [raw('world')], () =>
    assert.fail('virtual spans are not independently measurable'),
  );
  const result = await digest(fixture(host('RCTText', {}, [raw('Hello '), span])).sandbox);
  const evidence = result.hostEvidence.typography;
  assert.equal(evidence.complete, true);
  assert.equal(result.hostEvidence.hosts[1].testID, 'span');
  assert.deepEqual(evidence.nodes[1], {
    hostIndex: 1,
    parentHostIndex: 0,
    rootIndex: 0,
    hostType: 'RCTVirtualText',
    text: { kind: 'inline', ownerHostIndex: 0 },
  });
  assert.equal(evidence.nodes[0].text.content, 'Hello world');
  assert.ok(evidence.nodes[0].rect);
});

const cssLayoutModes = [
  'css-keyframes',
  'css-transition',
  'css-duration',
  'css-shorthand',
  'css-unrelated-property',
  'class-css-keyframes',
  'class-css-transition',
  'entering',
  'exiting',
  'layout',
  'layout-builder',
  'entering-object',
];

function animatedOwner(
  child: Fiber,
  mode: string,
  dynamicRead = () => assert.fail('must not evaluate animation values'),
) {
  const owner = composite([child], 'OrdinaryWrapper');
  const handle = {
    viewDescriptors: { shareableViewDescriptors: {} },
    initial: {
      value: { fontSize: 28 },
      updater: () => {
        dynamicRead();
        return { fontSize: 28 };
      },
    },
  };
  const shared = {
    _isReanimatedSharedValue: true,
    get value() {
      dynamicRead();
      return 28;
    },
  };
  class NativeAnimatedNode {
    __isNative = true;
    __getValue() {
      dynamicRead();
      return 28;
    }
    __getAnimatedValue() {
      dynamicRead();
      return 28;
    }
  }
  if (mode === 'style') owner.memoizedProps = { style: [null, [handle]] };
  else if (mode === 'animatedProps') owner.memoizedProps = { animatedProps: [handle] };
  else if (mode === 'shared') owner.memoizedProps = { style: { fontSize: shared } };
  else if (mode === 'native-animated')
    owner.memoizedProps = { style: { fontSize: new NativeAnimatedNode() } };
  else if (mode === 'class-style' || mode === 'class-props') {
    owner.tag = 1;
    owner.stateNode = {
      _animatedStyles: mode === 'class-style' ? [handle] : [],
      _animatedProps: mode === 'class-props' ? [handle] : [],
    };
  } else if (mode === 'inline-manager') {
    owner.tag = 1;
    owner.stateNode = { _InlinePropManager: { _inlineProps: { fontSize: shared } } };
  } else if (mode.startsWith('css-') || mode.startsWith('class-css-')) {
    const styles: Record<string, object> = {
      'css-keyframes': {
        animationName: { from: { fontSize: 28 }, to: { fontSize: 14 } },
        animationDuration: 1000,
      },
      'css-transition': { transitionProperty: 'fontSize', transitionDuration: 1000 },
      'css-duration': { transitionDuration: 1000 },
      'css-shorthand': { transition: 'font-size 1s' },
      'css-unrelated-property': { transitionProperty: 'opacity', transitionDuration: 0 },
    };
    const style = styles[mode.replace('class-', '')];
    assert.ok(style, mode);
    if (mode.startsWith('class-')) {
      owner.tag = 1;
      owner.stateNode = { _cssStyle: style };
    } else owner.memoizedProps = { style: [{ fontSize: 28 }, style] };
  } else if (['entering', 'exiting', 'layout'].includes(mode)) {
    owner.memoizedProps = {
      [mode]: () => {
        dynamicRead();
        return { initialValues: { fontSize: 28 }, animations: { fontSize: 14 } };
      },
    };
  } else if (mode === 'layout-builder') {
    owner.memoizedProps = {
      layout: {
        build() {
          dynamicRead();
          return () => ({});
        },
      },
    };
  } else if (mode === 'entering-object') {
    owner.memoizedProps = {
      entering: { initialValues: { fontSize: 28 }, animations: { fontSize: 14 } },
    };
  }
  return owner;
}

test('captured animation ownership invalidates plain initial host font sizes without evaluating animation values', async () => {
  for (const mode of [
    'style',
    'animatedProps',
    'class-style',
    'class-props',
    'inline-manager',
    'shared',
    'native-animated',
    ...cssLayoutModes,
  ]) {
    let dynamicReads = 0;
    const child = text('Title', { style: [{ fontSize: 28, lineHeight: 40, width: 200 }] });
    const result = await typography(
      animatedOwner(child, mode, () => {
        dynamicReads++;
      }),
    );
    assert.equal(result.complete, true, mode);
    assert.equal(result.nodes[0].text.kind, 'unsupported', mode);
    assert.ok(result.nodes[0].rect, mode);
    assert.equal(dynamicReads, 0, mode);
  }
});

test('static defaults and explicit inactive CSS forms retain supported text evidence', async () => {
  for (const style of [
    {},
    { animationName: undefined },
    { animationName: null },
    { animationName: 'none', animationDuration: 1000 },
    { animationName: [] },
    { animationName: ['none', 'none'] },
    { animationDuration: 1000 },
    { transition: 'none' },
    { transition: ['none'] },
    { transitionProperty: 'none', transitionDuration: 1000 },
    { transitionProperty: ['none', 'none'], transitionDelay: 10 },
    { transitionProperty: [] },
    { transitionDuration: undefined },
  ]) {
    for (const classField of [false, true]) {
      const owner = composite([text()]);
      owner.memoizedProps = {
        style: classField ? {} : style,
        entering: undefined,
        exiting: null,
        layout: false,
      };
      if (classField) {
        owner.tag = 1;
        owner.stateNode = { _cssStyle: style };
      }
      const result = await typography(owner);
      assert.equal(result.complete, true);
      assert.equal(result.nodes[0].text.kind, 'block', JSON.stringify(style));
      assert.equal(result.nodes[0].text.runs[0].fontSize, 14);
    }
  }
});

test('CSS and layout ownership probes never execute getters and reject oversized selectors', async () => {
  for (const mode of [
    'animationName',
    'transitionProperty',
    'entering',
    '_cssStyle',
    'layout-build',
  ]) {
    let reads = 0;
    const owner = composite([text()]);
    const getter = {
      get() {
        reads++;
        return 'none';
      },
      enumerable: true,
    };
    if (mode === '_cssStyle') {
      owner.tag = 1;
      owner.stateNode = Object.defineProperty({}, mode, getter);
    } else if (mode === 'entering') owner.memoizedProps = Object.defineProperty({}, mode, getter);
    else if (mode === 'layout-build')
      owner.memoizedProps = { layout: Object.defineProperty({}, 'build', getter) };
    else owner.memoizedProps = { style: Object.defineProperty({}, mode, getter) };
    const result = await typography(owner);
    assert.equal(result.nodes[0].text.kind, 'unsupported', mode);
    assert.equal(reads, 0, mode);
  }
  const owner = composite([text()]);
  owner.memoizedProps = { style: { animationName: Array(129).fill('none') } };
  assert.equal((await typography(owner)).nodes[0].text.kind, 'unsupported');
});

test('animation ownership inspection is bounded and never invokes original-prop getters', async () => {
  let reads = 0;
  const accessor = composite([text()]);
  accessor.memoizedProps = {
    get style() {
      reads++;
      return { fontSize: 28 };
    },
  };
  assert.equal((await typography(accessor)).nodes[0].text.kind, 'unsupported');
  assert.equal(reads, 0);
  const wide = composite([text()]);
  wide.memoizedProps = { style: Array.from({ length: 129 }, () => ({ fontSize: 28 })) };
  assert.equal((await typography(wide)).nodes[0].text.kind, 'unsupported');
  const owners = Array.from({ length: 130 }, () => {
    const owner = composite([text()]);
    owner.memoizedProps = { style: Array.from({ length: 126 }, () => ({ fontSize: 14 })) };
    return owner;
  });
  const result = await typography(composite(owners));
  assert.equal(result.nodes[0].text.kind, 'block');
  assert.equal(result.nodes.at(-1).text.kind, 'unsupported');
});

test('animated inline owners invalidate their block, not only the virtual span', async () => {
  const span = host('RCTVirtualText', { style: { fontSize: 28 } }, [raw('title')]);
  const result = await typography(host('RCTText', {}, [raw('A '), animatedOwner(span, 'style')]));
  assert.equal(result.nodes[0].text.kind, 'unsupported');
});

test('animation names and unrelated component state do not invalidate static text or siblings', async () => {
  const owner = composite([text()], 'AnimatedText');
  owner.tag = 1;
  owner.stateNode = { state: { animation: true }, _animatedStyles: [], _animatedProps: [] };
  owner.memoizedState = { memoizedState: { viewDescriptors: {}, initial: {} }, next: null };
  const result = await typography(composite([owner, animatedOwner(text('other'), 'style')]));
  assert.equal(result.nodes[0].text.kind, 'block');
  assert.equal(result.nodes[1].text.kind, 'unsupported');
});

test('plain animated initial sizes cannot qualify a title even when fixed layout retains matching rectangles', async () => {
  const frame =
    (x: number, y: number, width: number, height: number): Measure =>
    (cb) =>
      cb(x, y, width, height);
  const nodes = [
    {
      ref: '@window',
      index: 0,
      type: 'Window',
      label: '',
      rect: { x: 0, y: 0, width: 300, height: 300 },
    },
    {
      ref: '@panel',
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: '',
      identifier: 'panel',
      rect: { x: 0, y: 0, width: 300, height: 300 },
    },
    {
      ref: '@title',
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Title',
      rect: { x: 10, y: 10, width: 200, height: 40 },
    },
    {
      ref: '@body',
      index: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Body',
      rect: { x: 10, y: 70, width: 200, height: 20 },
    },
  ];
  for (const mode of ['static', 'style', ...cssLayoutModes]) {
    const title = text(
      'Title',
      { style: [{ fontSize: 28, lineHeight: 40, width: 200 }] },
      frame(10, 10, 200, 40),
    );
    const body = text('Body', {}, frame(10, 70, 200, 20));
    const root = host(
      'RCTView',
      { testID: 'panel' },
      [mode === 'static' ? composite([title]) : animatedOwner(title, mode), body],
      frame(0, 0, 300, 300),
    );
    const result = await digest(fixture(root).sandbox);
    const evidence = validateReactHostEvidence(result.hostEvidence);
    assert.ok(evidence?.typography?.complete);
    const headings = associateHeadings(nodes, evidence, {
      source: 'xcui-live',
      nodes: nodes.map(() => ({ status: 'observed', labelSource: 'direct' })),
    });
    assert.equal(headings.get(2)?.kind, mode === 'static' ? 'typographic-title' : undefined, mode);
  }
});

test('only the triple opt-in is asynchronous; all other digest shapes stay exact', async () => {
  let measurements = 0;
  const { sandbox } = fixture(
    text('Title', { style: { fontSize: 40 } }, (cb) => {
      measurements++;
      measured(cb);
    }),
  );
  const legacy = invoke(sandbox, { interactiveOnly: true });
  const semantic = invoke(sandbox, { interactiveOnly: true, semanticEvidence: true });
  assert.equal(typeof semantic, 'string');
  assert.equal(typeof legacy, 'string');
  for (const opts of [
    { interactiveOnly: true, typographyEvidence: true },
    { typographyEvidence: true },
    { semanticEvidence: true, typographyEvidence: true },
    { ...options, typographyEvidence: false },
  ]) {
    const without = { ...opts, typographyEvidence: false };
    assert.equal(invoke(sandbox, opts), invoke(sandbox, without));
  }
  assert.equal(measurements, 0);
  const captured = await digest(sandbox);
  delete captured.hostEvidence.typography;
  assert.deepEqual(captured, JSON.parse(semantic));
  delete captured.hostEvidence;
  assert.deepEqual(captured, JSON.parse(legacy));
  assert.equal(measurements, 1);
});

test('ordered raw text, inline ownership, style inheritance and measured anchors share host indexes', async () => {
  const inline = host('RCTVirtualText', { style: [{ fontSize: 18 }, [false, { fontSize: 22 }]] }, [
    raw('world'),
  ]);
  const title = host('RCTText', { style: { fontSize: 32 } }, [
    raw('Hello'),
    composite([inline]),
    raw('!'),
  ]);
  const root = host('RCTView', { testID: 'anchor' }, [composite([title])]);
  const result = await digest(fixture(root, text('Other root')).sandbox);
  const evidence = result.hostEvidence.typography;
  assert.equal(evidence.version, 1);
  assert.equal(evidence.coordinateSpace, 'window-points');
  assert.equal(evidence.complete, true);
  assert.ok(evidence.durationMs >= 0 && evidence.durationMs < 1000);
  assert.deepEqual(evidence.nodes, [
    {
      hostIndex: 0,
      parentHostIndex: null,
      rootIndex: 0,
      hostType: 'RCTView',
      text: { kind: 'none' },
      accessibility: { accessible: 'absent', authoredLabel: 'absent' },
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
    {
      hostIndex: 1,
      parentHostIndex: null,
      rootIndex: 1,
      hostType: 'RCTText',
      accessibility: { accessible: 'absent', authoredLabel: 'absent' },
      text: {
        kind: 'block',
        content: 'Other root',
        runs: [{ start: 0, end: 10, fontSize: 14 }],
        scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
      },
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
    {
      hostIndex: 2,
      parentHostIndex: 0,
      rootIndex: 0,
      hostType: 'RCTText',
      accessibility: { accessible: 'absent', authoredLabel: 'absent' },
      text: {
        kind: 'block',
        content: 'Helloworld!',
        runs: [
          { start: 0, end: 5, fontSize: 32 },
          { start: 5, end: 10, fontSize: 22 },
          { start: 10, end: 11, fontSize: 32 },
        ],
        scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
      },
      rect: { x: 10, y: 20, width: 200, height: 40 },
    },
    {
      hostIndex: 3,
      parentHostIndex: 2,
      rootIndex: 0,
      hostType: 'RCTVirtualText',
      text: { kind: 'inline', ownerHostIndex: 2 },
    },
  ]);
  assert.equal(result.hostEvidence.hosts.length, evidence.nodes.length);
  assert.ok(result.hostEvidence.hosts.every((entry: any) => entry.role === null));
  assert.deepEqual(result.interactive, []);
});

test('14-point default and present undefined/null style overwrites inherit rather than retaining an earlier size', async () => {
  for (const reset of [undefined, null]) {
    const evidence = await typography(
      host('RCTText', { style: [{ fontSize: 50 }, [{ fontSize: reset }]] }, [
        raw('a'),
        host('RCTVirtualText', { style: [{ fontSize: 40 }, { fontSize: reset }] }, [raw('b')]),
        raw('c'),
      ]),
    );
    assert.deepEqual(evidence.nodes[0].text, {
      kind: 'block',
      content: 'abc',
      runs: [{ start: 0, end: 3, fontSize: 14 }],
      scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
    });
  }
  const scaled = await typography(
    text('a', { style: { fontSize: 20 }, allowFontScaling: false, maxFontSizeMultiplier: 2 }),
  );
  assert.deepEqual(scaled.nodes[0].text.scaling, {
    allowFontScaling: false,
    maxFontSizeMultiplier: 2,
  });
  assert.equal(scaled.nodes[0].text.runs[0].fontSize, 20);
});

test('unsupported styles and scaling never produce numeric text evidence', async () => {
  const cycle: unknown[] = [];
  cycle.push(cycle);
  const styles = [
    12,
    0,
    'font-size:40',
    [{ fontSize: 30 }, 9],
    { fontSize: '24' },
    { fontSize: NaN },
    { fontSize: Infinity },
    { fontSize: -1 },
    { fontSize: {} },
    { fontSize: 0 },
    new Date(),
    { __getValue: () => ({ fontSize: 40 }) },
    { viewDescriptors: {}, initial: { value: { fontSize: 40 } } },
    cycle,
    { transform: [{ scale: 2 }] },
    { textTransform: 'uppercase' },
  ];
  for (const style of styles) {
    assert.equal((await typography(text('a', { style }))).nodes[0].text.kind, 'unsupported');
  }
  for (const props of [
    { adjustsFontSizeToFit: true },
    { dynamicTypeRamp: 'title1' },
    { minimumFontScale: 0.5 },
    { fontSizeMultiplier: 2 },
    { allowFontScaling: 'true' },
    { maxFontSizeMultiplier: 0.5 },
  ])
    assert.equal((await typography(text('a', props))).nodes[0].text.kind, 'unsupported');
  for (const props of [{ allowFontScaling: false }, { maxFontSizeMultiplier: 2 }]) {
    assert.equal(
      (await typography(host('RCTText', {}, [host('RCTVirtualText', props, [raw('a')])]))).nodes[0]
        .text.kind,
      'unsupported',
    );
  }
});

test('host tag and canonical Fabric viewConfig identify text; names and declared roles cannot', async () => {
  const fabric = host('IgnoredName', {}, [raw('Fabric')]);
  fabric.type = { displayName: 'Unrelated' };
  fabric.stateNode = {
    canonical: {
      viewConfig: { uiViewClassName: 'RCTText' },
      publicInstance: { measureInWindow: measured },
    },
  };
  let compositeMeasurements = 0;
  const fake = composite([], 'RCTText');
  fake.memoizedProps = { testID: 'fake', role: 'heading', style: { fontSize: 100 } };
  fake.stateNode = {
    measureInWindow() {
      compositeMeasurements++;
    },
  };
  const evidence = await typography(
    composite([
      fake,
      fabric,
      host('Title', { role: 'heading', style: { fontSize: 80 } }),
      host('RCTVirtualText', {}, [raw('orphan')]),
    ]),
  );
  assert.deepEqual(
    evidence.nodes.map((node: any) => [node.hostType, node.text.kind]),
    [
      ['RCTText', 'block'],
      ['Title', 'none'],
      ['RCTVirtualText', 'unsupported'],
    ],
  );
  assert.equal(evidence.nodes[0].text.content, 'Fabric');
  assert.equal(compositeMeasurements, 0);
});

test('only an initialized canonical renderer export may create a lazy public instance', async () => {
  for (const mode of [
    'initialized',
    'cold',
    'wrong-module',
    'missing-export',
    'ambiguous',
    'over-budget',
  ]) {
    const node = text();
    node.stateNode = {
      canonical: { viewConfig: { uiViewClassName: 'RCTText' }, publicInstance: null },
    };
    const { sandbox } = fixture(node);
    let resolutions = 0;
    const module = {
      isInitialized: mode !== 'cold',
      verboseName:
        mode === 'wrong-module'
          ? '/app/ReactFabric-dev.js'
          : '/app/node_modules/react-native/Libraries/Renderer/implementations/ReactFabric-dev.js',
      publicModule: {
        exports:
          mode === 'missing-export'
            ? {}
            : {
                getPublicInstanceFromInternalInstanceHandle(handle: Fiber) {
                  resolutions++;
                  assert.equal(handle, node);
                  return (handle.stateNode.canonical.publicInstance = {
                    measureInWindow: measured,
                  });
                },
              },
      },
    };
    const modules = new Map<number, object>([[0, module]]);
    if (mode === 'ambiguous') modules.set(1, module);
    if (mode === 'over-budget') for (let i = 1; i <= 20000; i++) modules.set(i, {});
    const metro = Object.assign(() => assert.fail('must never require a renderer'), {
      getModules: () => modules,
    });
    Object.assign(sandbox, {
      __r: metro,
      require: () => assert.fail('package require is forbidden'),
    });
    const evidence = (await digest(sandbox)).hostEvidence.typography;
    assert.equal(resolutions, mode === 'initialized' ? 1 : 0, mode);
    assert.equal(Boolean(evidence.nodes[0].rect), mode === 'initialized', mode);
  }
});

test('finite zero-area facts are retained but required text and named-host measurements still need positive area', async () => {
  for (const [width, height] of [
    [0, 0],
    [0, 40],
    [200, 0],
  ]) {
    for (const kind of ['anonymous', 'named', 'text']) {
      const measure: Measure = (cb) => cb(-10, -20, width, height);
      const node =
        kind === 'text'
          ? text('Title', {}, measure)
          : host('RCTView', kind === 'named' ? { testID: 'panel' } : {}, [], measure);
      const result = await digest(fixture(node).sandbox);
      const evidence = result.hostEvidence.typography;
      assert.equal(evidence.complete, kind === 'anonymous', kind);
      assert.deepEqual(evidence.nodes[0].rect, { x: -10, y: -20, width, height });
      assert.ok(validateReactHostEvidence(result.hostEvidence), kind);
    }
  }
});

test('missing methods, throws and invalid rectangles omit geometry without invented identities', async () => {
  for (const measure of [
    null,
    () => {
      throw new Error('unmounted');
    },
    (cb: (...values: number[]) => void) => cb(0, 0, 1),
    (cb: (...values: number[]) => void) => cb(0, 0, -1, 1),
    (cb: (...values: number[]) => void) => cb(0, 0, 1, -1),
    (cb: (...values: number[]) => void) => cb(0, 0, 1, Infinity),
    (cb: (...values: number[]) => void) => cb(0, 0, NaN, 1),
  ]) {
    const evidence = await typography(text('known', {}, measure));
    assert.equal(evidence.complete, false);
    assert.equal(evidence.nodes[0].rect, undefined);
    assert.equal(evidence.nodes[0].text.kind, 'block');
    assert.equal(JSON.stringify(evidence).includes('windowId'), false);
  }
});

test('text and anonymous possible View owners share one 1000ms timer with eight measurements in flight', async () => {
  const callbacks: Array<(...values: number[]) => void> = [];
  const { sandbox } = fixture(
    composite(
      Array.from({ length: 20 }, (_, i) =>
        i % 2
          ? host('RCTView', { accessible: true, accessibilityLabel: 'Private' }, [], (cb) =>
              callbacks.push(cb),
            )
          : text(String(i), {}, (cb) => callbacks.push(cb)),
      ),
    ),
  );
  let now = 0;
  let expire = () => {};
  const waits: number[] = [];
  Object.assign(sandbox, {
    Date: { now: () => now },
    setTimeout: (callback: () => void, delay: number) => {
      expire = callback;
      waits.push(delay);
      return 1;
    },
    clearTimeout() {},
  });
  const pending = digest(sandbox);
  assert.equal(callbacks.length, 8);
  now = 900;
  callbacks[0](0, 0, 20, 20);
  await Promise.resolve();
  assert.equal(callbacks.length, 9);
  assert.deepEqual(waits, [1000]);
  now = 1000;
  expire();
  const evidence = (await pending).hostEvidence.typography;
  assert.equal(evidence.complete, false);
  assert.equal(evidence.durationMs, 1000);
  assert.equal(evidence.nodes.filter((node: any) => node.rect).length, 1);
  callbacks[1](0, 0, 10, 10);
  assert.equal(callbacks.length, 9);
});

test('anonymous owner measurement is opt-in and retains the exact ordinary digest output', async () => {
  let measurements = 0;
  const owner = host(
    'RCTView',
    { accessible: true, accessibilityLabel: 'Private', accessibilityRole: 'text' },
    [text()],
    (cb) => {
      measurements++;
      measured(cb);
    },
  );
  const { sandbox } = fixture(owner);
  const ordinary = invoke(sandbox, { interactiveOnly: true });
  const semantic = invoke(sandbox, { interactiveOnly: true, semanticEvidence: true });
  assert.equal(measurements, 0);
  const captured = await digest(sandbox);
  assert.equal(measurements, 1);
  assert.equal(captured.hostEvidence.typography.nodes.length, 2);
  assert.equal(JSON.stringify(captured.hostEvidence.typography).includes('Private'), false);
  delete captured.hostEvidence.typography;
  assert.deepEqual(captured, JSON.parse(semantic));
  delete captured.hostEvidence;
  assert.deepEqual(captured, JSON.parse(ordinary));
  assert.equal(invoke(sandbox, { interactiveOnly: true }), ordinary);
});

test('anonymous potential owners retain the shared host bound without exposing authored labels', async () => {
  let measurements = 0;
  const evidence = await typography(
    composite(
      Array.from({ length: maxHosts + 1 }, () =>
        host('RCTView', { accessible: true, accessibilityLabel: 'Private' }, [], (cb) => {
          measurements++;
          measured(cb);
        }),
      ),
    ),
  );
  assert.equal(evidence.complete, false);
  assert.equal(evidence.nodes.length, maxHosts);
  assert.equal(measurements, maxHosts);
  assert.equal(JSON.stringify(evidence).includes('Private'), false);
});

test('optional owner measurement getters remain unread and keep missing geometry', async () => {
  let reads = 0;
  const owner = host('RCTView', { accessible: true });
  owner.stateNode = {
    get measureInWindow() {
      reads++;
      return measured;
    },
  };
  const evidence = await typography(owner);
  assert.equal(reads, 0);
  assert.equal(evidence.complete, true);
  assert.equal(evidence.nodes[0].rect, undefined);
  assert.equal(evidence.nodes[0].accessibility.accessible, 'true');
});

test('changing accessibility facts while measurements await invalidates their capture', async () => {
  const props = { accessible: false };
  const owner = host('RCTView', props, [], (cb) => {
    props.accessible = true;
    measured(cb);
  });
  assert.equal((await typography(owner)).complete, false);
});

test('the extraction phase consumes the same deadline before measurements start', async () => {
  let measureCalls = 0;
  const { sandbox } = fixture(
    text('slow', { style: { fontSize: 30 } }, () => {
      measureCalls++;
    }),
  );
  let reads = 0;
  Object.assign(sandbox, { Date: { now: () => reads++ * 100 } });
  const result = await digest(sandbox);
  assert.equal(result.hostEvidence.typography.complete, false);
  assert.equal(measureCalls, 0);
});

test('a missing native callback settles on the real shared deadline', async () => {
  let calls = 0;
  const start = Date.now();
  const evidence = await typography(
    composite(
      Array.from({ length: 12 }, () =>
        text('pending', {}, () => {
          calls++;
        }),
      ),
    ),
  );
  assert.equal(calls, 8);
  assert.equal(evidence.complete, false);
  assert.ok(evidence.durationMs >= 990);
  assert.ok(Date.now() - start < 2500, 'must not wait separately for each host');
  assert.ok(evidence.nodes.every((node: any) => node.rect === undefined));
});

test('post-await revalidation rejects even an equivalent alternate root', async () => {
  let complete: (...values: number[]) => void = () => assert.fail('measurement did not start');
  const title = text('pending', {}, (cb) => {
    complete = cb;
  });
  const { sandbox, roots } = fixture(title);
  const pending = digest(sandbox);
  await Promise.resolve();
  const alternate = text('pending');
  alternate.alternate = title;
  title.alternate = alternate;
  roots[0].current = alternate;
  complete(0, 0, 200, 40);
  const evidence = (await pending).hostEvidence.typography;
  assert.equal(evidence.complete, false);
  assert.equal(evidence.nodes[0].text.kind, 'unsupported');
  assert.equal(evidence.nodes[0].rect, undefined);
});

test('style work is bounded across blocks, not just within each flattened array', async () => {
  const style = Array.from({ length: 126 }, () => ({ fontSize: 18 }));
  const evidence = await typography(
    composite(Array.from({ length: 100 }, () => text('a', { style }))),
  );
  const supported = evidence.nodes.filter((node: any) => node.text.kind === 'block');
  assert.ok(supported.length > 0 && supported.length <= 64);
  assert.ok(evidence.nodes.some((node: any) => node.text.kind === 'unsupported'));
});

test('root-current switches, props and ancestry changes invalidate every text and rectangle', async () => {
  for (const mutation of [
    'root',
    'props',
    'ancestor-props',
    'parent',
    'child',
    'sibling',
    'canonical',
    'unmount',
  ]) {
    let mutate = () => {};
    const title = text('a', {}, (cb) => {
      mutate();
      measured(cb);
    });
    const wrapper = composite([title]);
    const { sandbox, roots } = fixture(wrapper);
    mutate = () => {
      if (mutation === 'root') {
        const alternate = composite([]);
        alternate.alternate = wrapper;
        wrapper.alternate = alternate;
        roots[0].current = alternate;
      } else if (mutation === 'props') title.memoizedProps = {};
      else if (mutation === 'ancestor-props') wrapper.memoizedProps = {};
      else if (mutation === 'parent') title.return = composite([]);
      else if (mutation === 'child') title.child = raw('b');
      else if (mutation === 'sibling') title.sibling = raw('b');
      else if (mutation === 'canonical') title.stateNode.canonical = {};
      else roots.splice(0);
    };
    const evidence = (await digest(sandbox)).hostEvidence.typography;
    assert.equal(evidence.complete, false, mutation);
    assert.equal(evidence.nodes[0].text.kind, 'unsupported', mutation);
    assert.equal(evidence.nodes[0].rect, undefined, mutation);
  }
});

test('block, total-character, run, visit, host and graph bounds fail closed', async () => {
  assert.equal((await typography(text('x'.repeat(4096)))).nodes[0].text.content.length, 4096);
  assert.equal((await typography(text('x'.repeat(4097)))).nodes[0].text.kind, 'unsupported');
  const totals = await typography(
    composite(Array.from({ length: 5 }, () => text('x'.repeat(4096)))),
  );
  assert.deepEqual(
    totals.nodes.map((node: any) => node.text.kind),
    ['block', 'block', 'block', 'block', 'unsupported'],
  );
  const alternating = (count: number) =>
    host(
      'RCTText',
      {},
      Array.from({ length: count }, (_, i) =>
        i % 2 ? host('RCTVirtualText', { style: { fontSize: 20 } }, [raw('x')]) : raw('x'),
      ),
    );
  assert.equal((await typography(alternating(128))).nodes[0].text.runs.length, 128);
  assert.equal((await typography(alternating(129))).nodes[0].text.kind, 'unsupported');
  assert.equal(
    (
      await typography(
        host(
          'RCTText',
          {},
          Array.from({ length: 256 }, () => raw('x')),
        ),
      )
    ).nodes[0].text.kind,
    'block',
  );
  assert.equal(
    (
      await typography(
        host(
          'RCTText',
          {},
          Array.from({ length: 257 }, () => raw('x')),
        ),
      )
    ).nodes[0].text.kind,
    'unsupported',
  );
  const hosts = await typography(
    composite(Array.from({ length: maxHosts + 50 }, () => host('RCTView'))),
  );
  assert.equal(hosts.complete, false);
  assert.equal(hosts.nodes.length, maxHosts);
  const graph = await digest(
    fixture(composite([...Array.from({ length: 2000 }, () => composite([])), text('past scan')]))
      .sandbox,
  );
  assert.equal(graph.hostEvidence.typography.complete, false);
  assert.equal(graph.totalNodes, 2000);
  assert.deepEqual(graph.hostEvidence.typography.nodes, []);
});

test('unsupported embedded hosts, portals and cyclic text graphs never become blocks', async () => {
  for (const child of [host('RCTImage'), text('nested'), fiber(4, null, {}, [raw('portal')])]) {
    assert.equal(
      (await typography(host('RCTText', {}, [child]))).nodes[0].text.kind,
      'unsupported',
    );
  }
  const child = raw('cycle');
  const root = host('RCTText', {}, [child]);
  child.sibling = child;
  const evidence = await typography(root);
  assert.equal(evidence.complete, false);
  assert.equal(evidence.nodes[0].text.kind, 'unsupported');
});

test('early refusal is still a Promise carrying incomplete typography', async () => {
  for (const sandbox of [createSandbox(), fixture(composite([], 'LogBox')).sandbox]) {
    const evidence = (await digest(sandbox)).hostEvidence.typography;
    assert.equal(evidence.complete, false);
    assert.deepEqual(evidence.nodes, []);
  }
});

test('current helper replaces a warm 89 producer and reinjection remains idempotent', async () => {
  const { sandbox } = fixture(text());
  Object.assign(sandbox, {
    __QAREN: {
      __v: 89,
      getTree() {
        throw new Error('stale');
      },
    },
  });
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(sandbox.__QAREN.__v, HELPERS_VERSION);
  const producer = sandbox.__QAREN.getTree;
  assert.equal((await digest(sandbox)).hostEvidence.typography.version, 1);
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(sandbox.__QAREN.getTree, producer);
});
