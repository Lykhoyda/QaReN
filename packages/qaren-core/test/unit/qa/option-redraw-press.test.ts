// An option that exposes no accessibility state proves its press only by redrawing its own subtree.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { join, renderedFingerprintOf, screenSignature } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, Screen } from '../../../dist/qa/screen.js';
import { walkBlock } from '../../../dist/qa/walker.js';
import type { ActResult, WalkerDeps } from '../../../dist/qa/walker.js';

function optionTree(
  path: string,
  props: Record<string, unknown> = {},
  wrapper?: { hostType?: string; name?: string; props: Record<string, unknown> },
) {
  const checkmark = { hostType: 'RNSVGPath', props: { d: path, ...props } };
  const pressable = buildFiber({
    name: 'Pressable',
    props: { testID: 'option_alone', onPress() {} },
    children: [
      {
        hostType: 'RCTView',
        props: { testID: 'option_alone', style: { borderColor: '#ccc' } },
        children: [
          wrapper ? { ...wrapper, children: [checkmark] } : checkmark,
          { hostType: 'RCTText', props: {}, children: [{ text: 'Alone' }] },
        ],
      },
    ],
  });
  pressable.tag = 0;
  const host = pressable.child!;
  host.tag = 5;
  host.child!.tag = 5;
  if (wrapper) {
    host.child!.tag = wrapper.hostType ? 5 : 0;
    host.child!.child!.tag = 5;
  }
  host.child!.sibling!.tag = 5;
  host.child!.sibling!.child!.tag = 6;
  const root = { current: pressable };
  const sandbox = createSandbox({ fiberRoot: pressable });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return sandbox.__QAREN;
}

async function digest(api: ReturnType<typeof optionTree>) {
  const begin = api.beginQaCapture(false);
  await Promise.resolve();
  await Promise.resolve();
  const result = begin.state === 'pending' ? api.readQaCapture(begin.id) : begin;
  assert.equal(result.state, 'ready');
  return JSON.parse(result.tree).interactive as DigestEntry[];
}

test('the producer hashes each control subtree and leaves an unreadable one without a hash', async () => {
  const [unchecked] = await digest(optionTree('M0 0h24'));
  const [again] = await digest(optionTree('M0 0h24'));
  const [checked] = await digest(optionTree('M0 0l12 12'));
  assert.match(unchecked.rendered!, /^[0-9a-f]{8}$/);
  assert.equal(again.rendered, unchecked.rendered);
  assert.notEqual(checked.rendered, unchecked.rendered);
  const unreadable = {};
  Object.defineProperty(unreadable, 'payload', { enumerable: true, get: () => 0 });
  const [opaque] = await digest(optionTree('M0 0h24', { fill: unreadable }));
  assert.equal(opaque.testID, 'option_alone');
  assert.equal(opaque.rendered, undefined);
});

function options(rendered: string | undefined, labels = ['Alone', 'Together']): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', index: 0, type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
    {
      ref: '@win',
      index: 1,
      parentIndex: 0,
      type: 'Window',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    ...labels.map((label, i) => ({
      ref: `@option${i}`,
      index: 2 + i,
      parentIndex: 1,
      type: 'Button',
      label,
      hittable: true,
      rect: { x: 20, y: 300 + i * 60, width: 360, height: 44 },
    })),
  ];
  const entries: DigestEntry[] = labels.map((label, i) => ({
    role: 'button',
    text: label,
    capabilities: { press: true, fill: false },
    ...(i === 0 && rendered !== undefined ? { rendered } : {}),
  }));
  return { ...join(nodes, entries), coverage: { native: 'complete', react: 'complete' } };
}

function fake(screens: Screen[]) {
  const calls: string[] = [];
  const queue = [...screens];
  let clock = 0;
  const deps: WalkerDeps = {
    async captureScreen() {
      return queue.length > 1 ? queue.shift()! : queue[0];
    },
    async press(ref) {
      calls.push(`press ${ref}`);
      return { ok: true, proven: false } satisfies ActResult;
    },
    async fill() {
      return { ok: true, proven: true };
    },
    async scroll() {
      return { ok: true, proven: false };
    },
    async back() {
      return { ok: true, proven: false };
    },
    async dialog() {
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
  };
  return { deps, calls };
}

const tapAlone = parsePlan('1. Tap "Alone"\n').blocks![0];
const seen = (outcome: Awaited<ReturnType<typeof walkBlock>>) =>
  renderReason(outcome.failure?.seen ?? '', (text) => text);

test('a redrawn target never changes the whole-screen signature', () => {
  assert.equal(screenSignature(options('0000000a')), screenSignature(options('0000000b')));
});

test('a press that only redraws the option it tapped passes on its first attempt', async () => {
  const f = fake([options('0000000a'), options('0000000b')]);
  const outcome = await walkBlock(tapAlone, f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.length, 1);
});

test('a press that leaves the option drawn the same still fails after two attempts', async () => {
  const f = fake([options('0000000a')]);
  const outcome = await walkBlock(tapAlone, f.deps);
  assert.equal(outcome.block.outcome, 'fail');
  assert.equal(f.calls.length, 2);
  assert.match(seen(outcome), /the screen did not change after two attempts/);
});

test('hidden checkmark changes cannot prove a tap through producer, join and walker', async () => {
  for (const wrapper of [
    { hostType: 'RCTView', props: { style: { display: 'none' } } },
    { hostType: 'RCTView', props: { style: [{ display: 'flex' }, { display: 'none' }] } },
    ...['Screen', 'InnerScreen', 'RNSScreen'].map((name) => ({
      name,
      props: { activityState: 0 },
    })),
    ...['MaybeScreen', 'ScreenContainer'].map((name) => ({ name, props: { visible: false } })),
  ]) {
    const before = await digest(optionTree('M0 0h24', {}, wrapper));
    const after = await digest(optionTree('M0 0l12 12', {}, wrapper));
    assert.match(before[0].rendered!, /^[0-9a-f]{8}$/);
    assert.equal(after[0].rendered, before[0].rendered);
    const native = (entries: DigestEntry[]): Screen => ({
      ...join(
        [
          {
            ref: '@option',
            index: 0,
            type: 'Button',
            identifier: 'option_alone',
            label: 'Alone',
            hittable: true,
            rect: { x: 20, y: 300, width: 360, height: 44 },
          },
        ],
        entries,
      ),
      coverage: { native: 'complete', react: 'complete' },
    });
    const f = fake([native(before), native(after)]);
    const outcome = await walkBlock(tapAlone, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
    assert.equal(f.calls.length, 2);
    assert.match(seen(outcome), /the screen did not change after two attempts/);
  }
});

test('unreadable visibility withholds redraw proof', async () => {
  const unreadable = {};
  Object.defineProperty(unreadable, 'display', {
    get() {
      throw new Error('unreadable');
    },
  });
  const unknownRoute = {};
  Object.defineProperty(unknownRoute, 'activityState', {
    get() {
      throw new Error('unreadable');
    },
  });
  for (const props of [
    { style: unreadable },
    { style: [unreadable, { display: 'flex' }] },
    unknownRoute,
  ]) {
    const [entry] = await digest(optionTree('M0 0h24', {}, { hostType: 'RCTView', props }));
    assert.equal(entry.testID, 'option_alone');
    assert.equal(entry.rendered, undefined);
  }
});

test('a hash on only one side of the press is no evidence', async () => {
  for (const screens of [
    [options('0000000a'), options(undefined)],
    [options(undefined), options('0000000b')],
  ]) {
    const f = fake([...screens, screens[1]]);
    const outcome = await walkBlock(tapAlone, f.deps);
    assert.equal(outcome.block.outcome, 'fail');
  }
});

test('an option whose label another node shares carries no hash to compare', async () => {
  const shared = ['Alone', 'Alone'];
  const f = fake([options('0000000a', shared), options('0000000b', shared)]);
  const outcome = await walkBlock(tapAlone, f.deps);
  assert.notEqual(outcome.block.outcome, 'pass');
});

test('label joins withhold hashes for normalized duplicates, even with unique native IDs', async () => {
  for (const identified of [false, true]) {
    for (const labels of [
      ['Alone', 'Alone'],
      ['Alone', ' ALONE '],
      [' alone ', 'Alone'],
    ]) {
      const nodes: NativeNode[] = labels.map((label, i) => ({
        ref: `@option${i}`,
        index: i,
        type: 'Button',
        identifier: identified ? `option-${i}` : undefined,
        label,
        hittable: true,
        rect: { x: 20, y: 300 + i * 60, width: 360, height: 44 },
      }));
      const screen = (rendered: string): Screen => ({
        ...join(nodes, [
          { role: 'button', text: 'Alone', capabilities: { press: true, fill: false }, rendered },
        ]),
        coverage: { native: 'complete', react: 'complete' },
      });
      const before = screen('0000000a');
      const after = screen('0000000b');
      for (const element of [...before.elements, ...after.elements]) {
        assert.equal(renderedFingerprintOf(element), undefined);
      }
      if (identified) {
        const f = fake([before, after]);
        const outcome = await walkBlock(parsePlan('1. Tap "option-0"\n').blocks![0], f.deps);
        assert.equal(outcome.block.outcome, 'fail');
        assert.equal(f.calls.length, 2);
        assert.match(seen(outcome), /the screen did not change after two attempts/);
      }
    }
  }
});

test('exact ID joins retain redraw proof when native labels are shared', async () => {
  const nodes: NativeNode[] = [0, 1].map((i) => ({
    ref: `@option${i}`,
    index: i,
    type: 'Button',
    identifier: `option-${i}`,
    label: 'Alone',
    hittable: true,
    rect: { x: 20, y: 300 + i * 60, width: 360, height: 44 },
  }));
  const screen = (rendered: string): Screen => ({
    ...join(nodes, [
      { role: 'button', testID: 'option-0', capabilities: { press: true, fill: false }, rendered },
    ]),
    coverage: { native: 'complete', react: 'complete' },
  });
  const before = screen('0000000a');
  const after = screen('0000000b');
  assert.equal(renderedFingerprintOf(before.elements[0]), '0000000a');
  assert.equal(renderedFingerprintOf(after.elements[0]), '0000000b');
  assert.equal(renderedFingerprintOf(after.elements[1]), undefined);
  const f = fake([before, after]);
  const outcome = await walkBlock(parsePlan('1. Tap "option-0"\n').blocks![0], f.deps);
  assert.equal(outcome.block.outcome, 'pass', outcome.failure?.seen);
  assert.equal(f.calls.length, 1);
});
