import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../../dist/injected-helpers.js';
import { buildFiber, createSandbox, INJECTED_HELPERS } from '../helpers/inject-harness.js';

type Fiber = Record<string, unknown>;

function link<T extends object>(parent: T, children: object[]): T {
  let previous: Fiber | null = null;
  for (const child of children as Fiber[]) {
    child.return = parent;
    if (previous) previous.sibling = child;
    else Reflect.set(parent, 'child', child);
    previous = child;
  }
  return parent;
}

function composite(name: string, props: Record<string, unknown> = {}) {
  const fiber = buildFiber({ name, props });
  fiber.tag = 0;
  return fiber;
}

function host(props: Record<string, unknown> = {}, hostType = 'RCTView') {
  const fiber = buildFiber({ hostType, props });
  fiber.tag = 5;
  return fiber;
}

const leak = 'inactive-tab-label';

// Three retained, natively detached tabs whose fibers together exceed the
// 5,000-visit overlay cap, beside one small focused tab.
// `root` places the overlay beside the tabs; `wrapped` places it inside a root
// wrapper ahead of them, which the depth-first walk reaches after their contents.
function retainedTabs(overlay?: { name: string; at: 'root' | 'wrapped' }) {
  const shell = host();
  const tabs = Array.from({ length: 3 }, () =>
    link(
      composite('Screen', { activityState: 0 }),
      Array.from({ length: 1700 }, () => host({ onPress() {}, accessibilityLabel: leak })),
    ),
  );
  const focused = link(composite('Screen', { activityState: 2 }), [
    host({ testID: 'focused', accessibilityRole: 'button', onPress() {} }),
  ]);
  const children: object[] = [...tabs, focused];
  if (overlay?.at === 'root') children.push(buildFiber({ name: overlay.name }));
  if (overlay?.at === 'wrapped') {
    children.unshift(link(composite('AppContainer'), [buildFiber({ name: overlay.name })]));
  }
  link(shell, children);
  const sandbox = createSandbox({ fiberRoot: shell });
  const root = { current: shell };
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return sandbox;
}

async function settled(api: {
  beginQaCapture: (typography?: boolean) => Record<string, unknown>;
  readQaCapture: (id: unknown) => Record<string, unknown>;
}) {
  const begin = api.beginQaCapture();
  await Promise.resolve();
  await Promise.resolve();
  return begin.state === 'pending' ? api.readQaCapture(begin.id) : begin;
}

test('the overlay pre-scan skips inactive retained tabs so the focused screen is captured', async () => {
  const result = await settled(retainedTabs().__QAREN);
  assert.equal(
    result.state,
    'ready',
    `refused with ${JSON.stringify((result as { diagnostic?: unknown }).diagnostic)}`,
  );
  assert.doesNotMatch(JSON.stringify(result), new RegExp(leak));
  const tree = JSON.parse(result.tree as string);
  assert.deepEqual(
    tree.interactive.map((entry: { testID?: string }) => entry.testID),
    ['focused'],
  );
  assert.equal(tree.hostEvidence.complete, true);
  assert.ok(tree.verdict.scannedNodes < 100, `scanned ${tree.verdict.scannedNodes}`);
});

test('a visible root error overlay beside inactive retained tabs still refuses as a render error', async () => {
  for (const name of ['LogBox', 'RedBox']) {
    for (const at of ['root', 'wrapped'] as const) {
      const result = await settled(retainedTabs({ name, at }).__QAREN);
      assert.equal(result.state, 'refused', `${name} ${at}`);
      assert.equal(result.reason, 'render-error', `${name} ${at}`);
      assert.equal(result.tree, undefined, `${name} ${at}`);
    }
  }
});

test('the overlay-scan helper replaces a warm helper96', () => {
  const sandbox = retainedTabs();
  sandbox.__QAREN = { __v: 96 };
  vm.runInContext(INJECTED_HELPERS, sandbox);
  assert.equal(sandbox.__QAREN.__v, HELPERS_VERSION);
  assert.notEqual(HELPERS_VERSION, 96);
  assert.equal(typeof sandbox.__QAREN.beginQaCapture, 'function');
});
