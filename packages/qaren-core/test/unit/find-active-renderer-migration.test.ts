import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';

type Root = { current: object };
type Visit = (fiber: object, rendererId: number) => unknown;

function inject(getFiberRoots: (id: number) => Set<Root>, ids = [1, 21]) {
  const context = vm.createContext({
    __REACT_DEVTOOLS_GLOBAL_HOOK__: {
      renderers: new Map(ids.map((id) => [id, {}])),
      getFiberRoots,
    },
  });
  vm.runInContext(INJECTED_HELPERS, context);
  return context.__QAREN as {
    __forEachRootFiber: (visit: Visit) => unknown;
    __findAllRootFibers: () => Array<{ fiber: object; rendererId: number }>;
  };
}

test('root collection reaches every fixture root across registered renderers', () => {
  const first = {};
  const second = {};
  const third = {};
  const helpers = inject(
    (id) =>
      new Set(
        (id === 1 ? [first, second] : id === 21 ? [third] : []).map((current) => ({ current })),
      ),
  );
  const roots = helpers.__findAllRootFibers();
  assert.equal(roots.length, 3);
  assert.equal(roots[0]!.fiber, first);
  assert.equal(roots[1]!.fiber, second);
  assert.equal(roots[2]!.fiber, third);
  assert.deepEqual(
    Array.from(roots, (root) => root.rendererId),
    [1, 1, 21],
  );
});

test('root callbacks continue on falsy results and stop on the first truthy result', () => {
  const fibers = [{}, {}, {}, {}, {}];
  const helpers = inject((id) => new Set(id === 1 ? fibers.map((current) => ({ current })) : []));
  const visited: object[] = [];
  const found = {};
  const results = [0, false, '', found];
  assert.equal(
    helpers.__forEachRootFiber((fiber) => {
      visited.push(fiber);
      return results[visited.length - 1];
    }),
    found,
  );
  assert.deepEqual(visited, fibers.slice(0, 4));
});

test('root iteration isolates renderer lookup and callback failures', () => {
  const broken = {};
  const live = {};
  const helpers = inject(
    (id) => {
      if (id === 1) throw new Error('renderer teardown');
      return new Set(id === 2 ? [{ current: broken }] : id === 21 ? [{ current: live }] : []);
    },
    [1, 2, 21],
  );
  const visited: object[] = [];
  assert.equal(
    helpers.__forEachRootFiber((fiber) => {
      visited.push(fiber);
      if (fiber === broken) throw new Error('walk failed');
      return 'found';
    }),
    'found',
  );
  assert.deepEqual(visited, [broken, live]);
  assert.deepEqual(
    Array.from(helpers.__findAllRootFibers(), (root) => root.fiber),
    [broken, live],
  );
});

test('root iteration returns null when no callback finds a match', () => {
  const helpers = inject((id) => new Set(id === 1 ? [{ current: {} }] : []));
  let visits = 0;
  assert.equal(
    helpers.__forEachRootFiber(() => {
      visits++;
      return false;
    }),
    null,
  );
  assert.equal(visits, 1);
});
