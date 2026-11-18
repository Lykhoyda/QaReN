import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION, INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { devFreeze } from './qa/rn-dev-freeze.ts';

// D and L: the base revision's program and the current one run side by side
// over one fiber corpus, built separately for each side.
const baseline: { version: number; program: string } = JSON.parse(
  readFileSync(new URL('../fixtures/helpers/baseline.txt', import.meta.url), 'utf8'),
);

type Props = Record<string, unknown>;
type Fiber = {
  tag: number;
  type: unknown;
  key: string | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  stateNode: unknown;
  return: Fiber | null;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
};
type Spec = {
  host?: string;
  name?: string;
  text?: string;
  tag?: number;
  props?: Props;
  stateNode?: unknown;
  children?: Spec[];
};
type Corpus = { roots: Fiber[]; fibers: Fiber[]; calls: string[] };
type Api = Record<string, (...args: unknown[]) => unknown>;
type Side = {
  api: Api;
  sandbox: Record<string, unknown>;
  corpus: Corpus;
  clock: { now: number };
  timers: Map<number, { at: number; run: () => void }>;
  advance: (ms: number) => void;
};

function measured(x: number, y: number, width: number, height: number) {
  const box = (done: (...values: number[]) => void) => done(x, y, width, height);
  return { canonical: { publicInstance: { measureInWindow: box, measure: box } } };
}

function build(spec: Spec, parent: Fiber | null, fibers: Fiber[]): Fiber {
  const fiber: Fiber = {
    tag: spec.tag ?? (spec.text !== undefined ? 6 : spec.host !== undefined ? 5 : 0),
    type:
      spec.text !== undefined
        ? null
        : spec.host !== undefined
          ? spec.host
          : { displayName: spec.name ?? 'Anonymous' },
    key: null,
    memoizedProps: spec.text !== undefined ? spec.text : (spec.props ?? {}),
    memoizedState: null,
    stateNode:
      spec.stateNode !== undefined
        ? spec.stateNode
        : spec.host !== undefined
          ? measured(0, fibers.length * 10, 100, 10)
          : null,
    return: parent,
    child: null,
    sibling: null,
    alternate: null,
  };
  fibers.push(fiber);
  let previous: Fiber | null = null;
  for (const childSpec of spec.children ?? []) {
    const child = build(childSpec, fiber, fibers);
    if (previous) previous.sibling = child;
    else fiber.child = child;
    previous = child;
  }
  return fiber;
}

function handler(calls: string[], label: string) {
  return function (this: unknown, ...args: unknown[]) {
    calls.push(`${label}:${typeof this}:${args.length}`);
  };
}

function nested(depth: number, leaf: Props): unknown {
  let style: unknown = leaf;
  for (let level = 0; level < depth; level++) style = [style];
  return style;
}

function expoImageState(attributes: Props) {
  return {
    canonical: {
      viewConfig: { uiViewClassName: 'ViewManagerAdapter_ExpoImage', validAttributes: attributes },
      publicInstance: measured(0, 300, 40, 40).canonical.publicInstance,
    },
  };
}

// Each scenario returns a fresh tree; the two sides never share an object.
const SCENARIOS: Record<string, (calls: string[], frozen: boolean) => Spec> = {
  mixed: (calls, frozen) => {
    const freeze = <T extends object>(value: T): T => (frozen ? devFreeze(value) : value);
    return {
      name: 'App',
      children: [
        {
          host: 'RCTView',
          props: { testID: 'screen', style: freeze({ flex: 1 }) },
          children: [
            {
              host: 'RCTText',
              props: { testID: 'title', accessibilityRole: 'header' },
              children: [{ text: 'Welcome back' }],
            },
            {
              name: 'MyButton',
              props: { onPress: handler(calls, 'continue'), testID: 'continue-wrapper' },
              children: [
                {
                  host: 'RCTView',
                  props: {
                    testID: 'continue',
                    accessible: true,
                    accessibilityRole: 'button',
                    accessibilityLabel: 'Continue',
                    accessibilityState: freeze({ disabled: false }),
                    onPress: handler(calls, 'continue-host'),
                    style: freeze([freeze({ zIndex: 2 }), [freeze({ pointerEvents: 'box-none' })]]),
                  },
                  children: [{ host: 'RCTText', props: {}, children: [{ text: 'Continue' }] }],
                },
              ],
            },
            {
              host: 'RCTSinglelineTextInputView',
              props: {
                testID: 'email',
                placeholder: 'Email address',
                value: 'person@example.test',
                editable: true,
                onChangeText: handler(calls, 'email-change'),
                pointerEvents: 'auto',
              },
            },
            {
              host: 'RCTImageView',
              props: { testID: 'avatar', accessibilityLabel: 'Avatar' },
            },
            {
              host: 'RCTSwitch',
              props: {
                testID: 'remember',
                value: true,
                onChange: handler(calls, 'switch'),
              },
            },
            {
              host: 'RCTScrollView',
              props: { testID: 'list', style: freeze({ zIndex: 'high' }) },
              children: [
                {
                  host: 'RCTView',
                  props: {
                    testID: 'row-1',
                    onPress: handler(calls, 'row-1'),
                    style: nested(40, { pointerEvents: 'none' }),
                  },
                  children: [{ host: 'RCTText', props: {}, children: [{ text: 'First row' }] }],
                },
                {
                  host: 'RCTView',
                  props: {
                    testID: 'row-2',
                    onPress: handler(calls, 'row-2'),
                    pointerEvents: 'sideways',
                    style: [null, false, { zIndex: Infinity }],
                  },
                },
              ],
            },
            { host: 'constructor', props: { testID: 'proto-constructor' } },
            { host: 'toString', props: { testID: 'proto-to-string' } },
            { name: 'Text', props: { testID: 'composite-text' } },
            {
              host: 'RCTModalHostView',
              props: { testID: 'sheet', visible: true },
              children: [
                {
                  host: 'RCTView',
                  props: { testID: 'sheet-close', onPress: handler(calls, 'close') },
                  children: [{ host: 'Text', props: {}, children: [{ text: 'Close' }] }],
                },
              ],
            },
          ],
        },
      ],
    };
  },
  expoImage: (calls) => ({
    name: 'Gallery',
    children: [
      {
        host: 'ViewManagerAdapter_ExpoImage',
        props: {
          testID: 'picture',
          placeholder: [{ uri: 'image-source' }],
          onPress: handler(calls, 'picture'),
        },
        stateNode: expoImageState({ source: true, placeholder: { process: () => 'x' } }),
      },
    ],
  }),
  expoImageInput: () => ({
    name: 'Search',
    children: [
      {
        host: 'ViewManagerAdapter_ExpoImage',
        props: { testID: 'search-picture', role: 'searchbox', placeholder: [{ uri: 'image' }] },
        stateNode: expoImageState({ source: true, placeholder: true }),
      },
    ],
  }),
  frozenPropsBag: (calls) => ({
    name: 'Frozen',
    children: [
      {
        host: 'RCTView',
        props: devFreeze({ testID: 'frozen', onPress: handler(calls, 'frozen') }),
      },
    ],
  }),
  refusedAccessor: () => {
    const props: Props = { testID: 'trap' };
    Object.defineProperty(props, 'accessibilityLabel', { enumerable: true, get: () => 'Trap' });
    return { name: 'Trap', children: [{ host: 'RCTView', props }] };
  },
  privateInput: (calls) => ({
    name: 'Form',
    children: [
      {
        host: 'TextInput',
        props: {
          testID: 'password',
          value: 'hunter2',
          secureTextEntry: true,
          onChangeText: handler(calls, 'pw'),
        },
      },
      {
        host: 'AndroidTextInput',
        props: {
          testID: 'name',
          value: '',
          placeholder: 'Name',
          onChangeText: handler(calls, 'name'),
        },
      },
    ],
  }),
};

function corpusFor(scenario: string, frozen: boolean): Corpus {
  const calls: string[] = [];
  const fibers: Fiber[] = [];
  const root = build(SCENARIOS[scenario]!(calls, frozen), null, fibers);
  return { roots: [root], fibers, calls };
}

function sideFor(program: string, corpus: Corpus): Side {
  const clock = { now: 1_700_000_000_000 };
  const timers = new Map<number, { at: number; run: () => void }>();
  let timerId = 0;
  class ClockDate extends Date {
    constructor(...args: [number?]) {
      super(args.length > 0 ? args[0]! : clock.now);
    }
    static override now() {
      return clock.now;
    }
  }
  const sandbox: Record<string, unknown> = {
    Array,
    Object,
    JSON,
    Map,
    Set,
    WeakSet,
    WeakMap,
    Error,
    Date: ClockDate,
    parseInt,
    parseFloat,
    String,
    Number,
    Boolean,
    RegExp,
    Symbol,
    Promise,
    setTimeout: (run: () => void, ms: number) => {
      timers.set(++timerId, { at: clock.now + (ms || 0), run });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    console: { log() {}, error() {}, warn() {}, info() {}, debug() {} },
    __expo_router_state__: { routeName: 'Differential' },
  };
  sandbox.globalThis = sandbox;
  const fiberRoots = new Set(corpus.roots.map((current) => ({ current })));
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map([[1, {}]]),
    getFiberRoots: (id: number) => (id === 1 ? fiberRoots : new Set()),
  };
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox);
  const advance = (ms: number) => {
    clock.now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > clock.now || !timers.has(id)) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return { api: sandbox.__QAREN as Api, sandbox, corpus, clock, timers, advance };
}

function snapshot(value: unknown): unknown {
  if (typeof value === 'function') return `[function ${value.name}]`;
  if (value === undefined) return '[undefined]';
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(snapshot);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, snapshot(v)]));
  }
  return value;
}

async function settle() {
  for (let turn = 0; turn < 4; turn++) await Promise.resolve();
}

// One adapter per API: the return kind is recorded before anything is awaited.
async function call(side: Side, name: string, args: unknown[]): Promise<unknown> {
  let result: unknown;
  try {
    result = side.api[name]!(...args);
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) };
  }
  const kind =
    result && typeof (result as Promise<unknown>).then === 'function' ? 'promise' : 'sync';
  if (kind === 'promise') {
    try {
      result = await result;
    } catch (error) {
      return { kind, rejected: error instanceof Error ? error.message : String(error) };
    }
  }
  return { kind, result: snapshot(result), calls: [...side.corpus.calls] };
}

const ODD_FIBERS: unknown[] = [
  undefined,
  null,
  {},
  { type: null },
  { type: 'constructor' },
  { type: '__proto__' },
  { type: 'hasOwnProperty' },
  { tag: 6, type: 'RCTText' },
  { tag: 5, type: 'RCTTextInput' },
  { type: { displayName: 5 } },
  { type: { name: 'Image' } },
  { type: { displayName: '', name: 'Switch' } },
  { type: 7 },
  { type: true },
];

async function trace(program: string, scenario: string, frozen: boolean) {
  const side = sideFor(program, corpusFor(scenario, frozen));
  const steps: Array<[string, unknown]> = [];
  const record = async (label: string, name: string, ...args: unknown[]) => {
    steps.push([label, await call(side, name, args)]);
  };
  const { fibers } = side.corpus;
  for (const [index, fiber] of [...fibers, ...ODD_FIBERS].entries()) {
    await record(`hostKind ${index}`, '__hostKind', fiber);
  }
  for (const [index, fiber] of fibers.entries()) {
    await record(`role ${index}`, '__role', fiber);
    await record(`name ${index}`, '__accessibleName', fiber, fibers[0]);
    await record(`hidden ${index}`, '__hidden', fiber);
    await record(`anchors ${index}`, '__collectAnchors', fiber);
  }
  await record('match', '__match', 'Continue', 'Continue');
  for (const opts of [
    undefined,
    {},
    { interactiveOnly: true },
    { filter: 'Continue' },
    { testID: 'email' },
    { semanticEvidence: true },
  ]) {
    await record(`tree ${JSON.stringify(opts)}`, 'getTree', opts);
  }
  for (const typography of [false, true]) {
    const begin = await call(side, 'beginQaCapture', [typography]);
    steps.push([`capture ${typography}`, begin]);
    await settle();
    const id = (begin as { result?: { id?: string } }).result?.id;
    await record(`read ${typography}`, 'readQaCapture', id);
  }
  for (const testID of ['continue', 'email', 'row-1', 'proto-constructor', 'missing']) {
    await record(`frontmost ${testID}`, 'isTestIdFrontmost', testID);
    await record(`ladder testID ${testID}`, 'resolveLadder', JSON.stringify({ testID }));
  }
  for (const spec of [
    { role: 'button', name: 'Continue' },
    { text: 'First row' },
    { placeholder: 'Email address' },
  ]) {
    await record(`ladder ${JSON.stringify(spec)}`, 'resolveLadder', JSON.stringify(spec));
  }
  await record('read email', 'readInputValue', 'email');
  await record('read password', 'readInputValue', 'password', { private: true });
  for (const opts of [
    { action: 'press', testID: 'continue' },
    { action: 'press', testID: 'row-2' },
    { action: 'press', accessibilityLabel: 'Avatar' },
    { action: 'press', testID: 'email', walkUp: true, allowInputDesignation: true },
    { action: 'typeText', testID: 'email', text: 'a' },
    { action: 'press', testID: 'picture' },
  ]) {
    await record(`interact ${JSON.stringify(opts)}`, 'interact', opts);
  }
  await record('nav', 'getNavState');
  return steps;
}

function withoutVersion(program: string, steps: Array<[string, unknown]>) {
  return JSON.parse(
    JSON.stringify(steps)
      .split(`"__v":${program === baseline.program ? baseline.version : HELPERS_VERSION}`)
      .join('"__v":0'),
  );
}

for (const scenario of Object.keys(SCENARIOS)) {
  for (const frozen of scenario === 'mixed' ? [false, true] : [false]) {
    test(`D: ${scenario}${frozen ? ' (dev-frozen props)' : ''} reads the same through every API`, async () => {
      const base = withoutVersion(
        baseline.program,
        await trace(baseline.program, scenario, frozen),
      );
      const current = withoutVersion(
        INJECTED_HELPERS,
        await trace(INJECTED_HELPERS, scenario, frozen),
      );
      assert.deepEqual(current, base);
    });
  }
}

test('D: the corpus reaches the moved reads and host kinds', async () => {
  const steps = await trace(INJECTED_HELPERS, 'mixed', true);
  const text = JSON.stringify(steps);
  for (const kind of ['text', 'textinput', 'image', 'switch', 'scrollview', 'modal']) {
    assert.match(text, new RegExp(`"result":"${kind}"`), kind);
  }
  assert.match(text, /"state":"ready"/);
  // Touch facts, style walks and the frozen-value reads land in the capture's host evidence.
  assert.match(
    text,
    /\\"testID\\":\\"continue\\"[^}]*\\"pointerEvents\\":\\"box-none\\",\\"zIndex\\":2/,
  );
  assert.match(text, /\\"testID\\":\\"email\\"[^}]*\\"pointerEvents\\":\\"auto\\"/);
  const image = JSON.stringify(await trace(INJECTED_HELPERS, 'expoImage', false));
  assert.match(image, /"state":"ready"/);
  assert.match(
    JSON.stringify(await trace(INJECTED_HELPERS, 'expoImageInput', false)),
    /digest-prop-opaque/,
  );
  const refused = JSON.stringify(await trace(INJECTED_HELPERS, 'refusedAccessor', false));
  assert.match(refused, /"state":"refused"/);
});

test('L: replacing the base helpers in one context retires their capture slot and designation', async () => {
  const side = sideFor(baseline.program, corpusFor('mixed', false));
  const old = side.api;
  assert.equal(old.__v, baseline.version);
  const pending = old.beginQaCapture!(true) as { id: string; state: string };
  const designation = JSON.parse(
    old.interact!({
      action: 'press',
      testID: 'email',
      walkUp: true,
      allowInputDesignation: true,
    }) as string,
  );
  assert.equal(typeof designation.designationToken, 'string');
  const oldTimers = side.timers.size;

  vm.runInContext(INJECTED_HELPERS, side.sandbox);
  const current = side.sandbox.__QAREN as Api;
  assert.notEqual(current, old);
  assert.equal(current.__v, HELPERS_VERSION);
  assert.ok(HELPERS_VERSION > baseline.version);
  assert.equal(Object.keys(side.sandbox).filter((key) => key === '__QAREN').length, 1);

  const before = JSON.stringify(snapshot(current));
  assert.ok(oldTimers > 0);
  assert.doesNotThrow(() => side.advance(5_000));
  await settle();
  assert.equal(side.timers.size, 0);
  assert.equal(JSON.stringify(snapshot(current)), before);
  assert.equal(side.sandbox.__QAREN, current);
  assert.equal((current.readQaCapture!(pending.id) as { state: string }).state, 'refused');

  const typed = JSON.parse(
    current.interact!({
      action: 'typeText',
      testID: 'email',
      text: 'a',
      designationToken: designation.designationToken,
      requireLiveInputDesignation: true,
    }) as string,
  );
  assert.equal(typed.code, 'INTERACTION_NOT_ACTUATED');
  assert.deepEqual(
    JSON.parse(current.releaseInputDesignation!(designation.designationToken) as string),
    {
      released: false,
    },
  );
  assert.deepEqual(side.corpus.calls, []);
});
