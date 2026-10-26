import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';
import { devFreeze } from './rn-dev-freeze.ts';

interface FiberSpec {
  name?: string;
  hostType?: string;
  props?: Record<string, unknown>;
  text?: string;
  children?: FiberSpec[];
}

const onPress = () => undefined;
const button = (testID: string): FiberSpec => ({ name: 'Pressable', props: { testID, onPress } });

function digest(children: FiberSpec[], qaCapture = false) {
  const fiberRoot = buildFiber({ name: 'App', children });
  const queue = [fiberRoot];
  while (queue.length) {
    const fiber = queue.pop()!;
    if (typeof fiber.memoizedProps === 'string') fiber.tag = 6;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  const sandbox = createSandbox({ fiberRoot });
  return JSON.parse(
    vm.runInContext(
      `__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true${qaCapture ? ', qa: true' : ''} })`,
      sandbox,
    ),
  );
}

const ids = (out: { interactive: Array<{ testID?: string }> }) =>
  out.interactive.map((entry) => entry.testID);

test('an inactive react-native-screens screen is not walked', () => {
  const out = digest([
    { name: 'Screen', props: { activityState: 0 }, children: [button('behind')] },
    { name: 'Screen', props: { activityState: 2 }, children: [button('front')] },
  ]);
  assert.deepEqual(ids(out), ['front']);
});

test('an invisible navigator scene and a display-none host view are not walked', () => {
  const out = digest([
    { name: 'MaybeScreen', props: { visible: false }, children: [button('scene')] },
    {
      hostType: 'RCTView',
      props: { style: [{ flex: 1 }, [{ display: 'none' }]] },
      children: [button('collapsed')],
    },
    { hostType: 'RCTView', props: { style: { display: 'flex' } }, children: [button('shown')] },
  ]);
  assert.deepEqual(ids(out), ['shown']);
});

test('a style that cannot be read safely never skips its subtree', () => {
  let reads = 0;
  const style = {};
  Object.defineProperty(style, 'display', {
    get: () => {
      reads++;
      return 'none';
    },
    enumerable: true,
  });
  Object.freeze(style);
  const out = digest([{ hostType: 'RCTView', props: { style }, children: [button('kept')] }]);
  assert.deepEqual(ids(out), ['kept']);
  assert.equal(reads, 0);
});

test('validated frozen route props and nested style arrays prune inactive subtrees', () => {
  for (const qa of [false, true]) {
    const out = digest(
      [
        { name: 'Screen', props: devFreeze({ activityState: 0 }), children: [button('behind')] },
        { name: 'MaybeScreen', props: devFreeze({ visible: false }), children: [button('scene')] },
        {
          hostType: 'RCTView',
          props: devFreeze({
            style: devFreeze([devFreeze({ flex: 1 }), devFreeze([devFreeze({ display: 'none' })])]),
          }),
          children: [button('collapsed')],
        },
        {
          hostType: 'RCTView',
          props: {
            style: devFreeze([devFreeze({ display: 'none' }), devFreeze({ display: 'flex' })]),
          },
          children: [button('shown')],
        },
      ],
      qa,
    );
    assert.deepEqual(ids(out), ['shown']);
    assert.equal(out.verdict.complete, true);
  }
});

test('an earlier display none prunes only when every later style override was examined', () => {
  let reads = 0;
  const unreadable = Object.freeze(
    Object.defineProperty({}, 'display', {
      enumerable: true,
      get: () => {
        reads++;
        return 'flex';
      },
    }),
  );
  let deep: unknown = { display: 'flex' };
  for (let i = 0; i < 17; i++) deep = [deep];
  const cases: Array<[string, unknown, boolean]> = [
    ['none then flex', [{ display: 'none' }, { display: 'flex' }], true],
    ['none then undefined', [{ display: 'none' }, { display: undefined }], true],
    ['none then null', [{ display: 'none' }, { display: null }], true],
    ['none then missing', [{ display: 'none' }, {}], false],
    ['none alone', { display: 'none' }, false],
    ['flex then none', [{ display: 'flex' }, { display: 'none' }], false],
    ['unreadable alone', unreadable, true],
    [
      'none, 63 empty, then flex past the scan cap',
      [{ display: 'none' }, ...Array.from({ length: 63 }, () => ({})), { display: 'flex' }],
      true,
    ],
    ['none then an unreadable override', [{ display: 'none' }, unreadable], true],
    ['none then flex past the depth cap', [{ display: 'none' }, deep], true],
  ];
  for (const qa of [false, true])
    for (const [name, style, shown] of cases) {
      const out = digest(
        [{ hostType: 'RCTView', props: { style }, children: [button('save')] }],
        qa,
      );
      assert.equal(ids(out).includes('save'), shown, `${name} (qa=${qa})`);
    }
  assert.equal(reads, 0);
});

test('a large tree whose bulk is on inactive routes still yields a complete active digest', () => {
  const filler = (n: number): FiberSpec[] =>
    Array.from({ length: n }, (_, i) => ({ hostType: 'RCTView', props: { testID: `f${i}` } }));
  const inactive = Array.from({ length: 20 }, () => ({
    name: 'Screen',
    props: { activityState: 0 },
    children: filler(1000),
  }));
  const out = digest([
    ...inactive,
    { name: 'Screen', props: { activityState: 2 }, children: [button('active')] },
  ]);
  assert.deepEqual(ids(out), ['active']);
  assert.equal(out.truncated, undefined);
  assert.equal(out.verdict.complete, true);
});

test('inactive fibers with their own control identity cannot block a visible action', async () => {
  for (const frozen of [false, true]) {
    const freeze = <T extends object>(value: T): T => (frozen ? devFreeze(value) : value);
    for (const qa of [false, true]) {
      const out = digest(
        [
          {
            hostType: 'RCTView',
            props: freeze({ testID: 'hidden-action', onPress, style: freeze({ display: 'none' }) }),
            children: [{ text: 'Hidden action text' }],
          },
          {
            name: 'Screen',
            props: freeze({ activityState: 0, testID: 'inactive-action', onPress }),
            children: [{ text: 'Inactive route text' }],
          },
          {
            hostType: 'RCTView',
            props: { testID: 'save', onPress, accessibilityRole: 'button' },
            children: [
              { text: 'Save' },
              {
                hostType: 'RCTView',
                props: freeze({ style: freeze({ display: 'none' }) }),
                children: [{ text: 'Hidden descendant text' }],
              },
              {
                name: 'Screen',
                props: freeze({ activityState: 0 }),
                children: [{ text: 'Inactive descendant text' }],
              },
            ],
          },
        ],
        qa,
      );
      assert.deepEqual(ids(out), ['save']);
      assert.deepEqual(
        out.hostEvidence.hosts.map((host) => host.testID),
        ['save'],
      );
      assert.equal(out.interactive[0].text, 'Save');
      const f = walker(
        [],
        scriptedJudge((questions) => ({
          target_1: choice(questions.target_1),
        })),
      );
      f.deps.captureScreen = () =>
        captureScreen({
          appId: 'com.test',
          requirePrivateInputs: true,
          native: async () => nativeCapture(),
          react: async () => out,
        });
      const result = await runPlan(parsePlan('1. Tap the save button').blocks!, f.deps);
      assert.equal(result.verdict, 'PASS', JSON.stringify(result));
      assert.deepEqual(f.actions, ['press @e1']);
    }
  }
});

test('display resets retain visible host controls and descendant text', () => {
  for (const reset of [undefined, null]) {
    for (const frozen of [false, true]) {
      const freeze = <T extends object>(value: T): T => (frozen ? devFreeze(value) : value);
      const style = freeze([freeze({ display: 'none' }), freeze([freeze({ display: reset })])]);
      for (const qa of [false, true]) {
        const out = digest(
          [
            {
              hostType: 'RCTView',
              props: { testID: 'save', onPress, style },
              children: [
                { hostType: 'RCTView', props: { style }, children: [{ text: 'Save changes' }] },
              ],
            },
          ],
          qa,
        );
        assert.deepEqual(ids(out), ['save']);
        assert.equal(out.interactive[0].text, 'Save changes');
        assert.deepEqual(
          out.hostEvidence.hosts.map((host) => host.testID),
          ['save', undefined],
        );
        assert.equal(out.verdict.complete, true);
      }
    }
  }
});
