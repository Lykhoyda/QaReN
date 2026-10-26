import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createSandbox } from './helpers/inject-harness.js';

interface Fiber {
  type: { name: string };
  memoizedProps: Record<string, unknown>;
  child: Fiber | null;
  sibling: Fiber | null;
}

interface FiberRoot {
  current: Fiber;
}

interface RendererHook {
  renderers: Map<number, object>;
  getFiberRoots: (id: number) => Set<FiberRoot>;
}

interface InjectedAgent {
  getStoreState: (path?: string, requestedType?: string) => string;
  dispatchAction: (options: { action: string; payload?: unknown }) => string;
}

interface Sandbox extends Record<string, unknown> {
  __QAREN: InjectedAgent;
  __REACT_DEVTOOLS_GLOBAL_HOOK__?: RendererHook;
  __REDUX_STORE__?: { getState: () => unknown };
}

function createSingleChildFiberChain(depth: number, leaf: Fiber): Fiber {
  let fiber = leaf;
  for (let index = 0; index < depth; index++) {
    fiber = {
      type: { name: 'ContextProvider' },
      memoizedProps: {},
      child: fiber,
      sibling: null,
    };
  }
  return fiber;
}

test('getStoreState explains the Redux global fallback when no Provider is found', () => {
  const result = JSON.parse((createSandbox() as Sandbox).__QAREN.getStoreState());

  assert.equal(
    result.hint2,
    'For Redux, the Provider is auto-detected from the fiber tree. If it still is not found, expose it: if (__DEV__) global.__REDUX_STORE__ = store',
  );
});

test('getStoreState reads Redux state from a Provider at depth 60 explicitly and by default', () => {
  const fiberRoot = createSingleChildFiberChain(60, {
    type: { name: 'Provider' },
    memoizedProps: {
      store: {
        getState: () => ({ cmsApi: { queries: { featured: { status: 'fulfilled' } } } }),
      },
    },
    child: null,
    sibling: null,
  });
  const sandbox = createSandbox({ fiberRoot }) as Sandbox;

  const explicitResult = JSON.parse(sandbox.__QAREN.getStoreState('cmsApi.queries', 'redux'));

  assert.deepEqual(explicitResult, {
    type: 'redux',
    state: { featured: { status: 'fulfilled' } },
  });
  assert.deepEqual(JSON.parse(sandbox.__QAREN.getStoreState('cmsApi.queries')), explicitResult);
});

test('dispatchAction dispatches through a Redux Provider at depth 60', () => {
  const actions: unknown[] = [];
  const fiberRoot = createSingleChildFiberChain(60, {
    type: { name: 'Provider' },
    memoizedProps: { store: { dispatch: (action: unknown) => actions.push(action) } },
    child: null,
    sibling: null,
  });
  const sandbox = createSandbox({ fiberRoot }) as Sandbox;

  const result = JSON.parse(
    sandbox.__QAREN.dispatchAction({ action: 'cms/refetch', payload: { id: 'featured' } }),
  );

  assert.deepEqual(result, { dispatched: true });
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), [
    { type: 'cms/refetch', payload: { id: 'featured' } },
  ]);
});

test('getStoreState preserves Redux Provider detection at depth 20', () => {
  const fiberRoot = createSingleChildFiberChain(20, {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ session: { ready: true } }) } },
    child: null,
    sibling: null,
  });

  const result = JSON.parse(
    (createSandbox({ fiberRoot }) as Sandbox).__QAREN.getStoreState('session.ready', 'redux'),
  );

  assert.deepEqual(result, { type: 'redux', state: true });
});

test('getStoreState finds a Redux Provider after a non-matching sibling', () => {
  const provider: Fiber = {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ siblingStore: true }) } },
    child: null,
    sibling: null,
  };
  const fiberRoot: Fiber = {
    type: { name: 'App' },
    memoizedProps: {},
    child: {
      type: { name: 'FirstBranch' },
      memoizedProps: {},
      child: null,
      sibling: provider,
    },
    sibling: null,
  };

  const result = JSON.parse(
    (createSandbox({ fiberRoot }) as Sandbox).__QAREN.getStoreState(undefined, 'redux'),
  );

  assert.deepEqual(result, { type: 'redux', state: { siblingStore: true } });
});

test('getStoreState prefers an outer Redux Provider', () => {
  const fiberRoot: Fiber = {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ selected: 'outer' }) } },
    child: {
      type: { name: 'Provider' },
      memoizedProps: { store: { getState: () => ({ selected: 'inner' }) } },
      child: null,
      sibling: null,
    },
    sibling: null,
  };

  const result = JSON.parse(
    (createSandbox({ fiberRoot }) as Sandbox).__QAREN.getStoreState(undefined, 'redux'),
  );

  assert.deepEqual(result, { type: 'redux', state: { selected: 'outer' } });
});

test('getStoreState preserves renderer order when the earlier Provider is deeper', () => {
  const earlierRoot = createSingleChildFiberChain(60, {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ selected: 'earlier' }) } },
    child: null,
    sibling: null,
  });
  const laterRoot = createSingleChildFiberChain(1, {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ selected: 'later' }) } },
    child: null,
    sibling: null,
  });
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (id) =>
      new Set(id === 1 ? [{ current: earlierRoot }] : id === 2 ? [{ current: laterRoot }] : []),
  };

  const sandbox = createSandbox() as Sandbox;
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const result = JSON.parse(sandbox.__QAREN.getStoreState(undefined, 'redux'));

  assert.deepEqual(result, { type: 'redux', state: { selected: 'earlier' } });
});

test('getStoreState reads React Query state from a Provider at depth 60', () => {
  const fiberRoot = createSingleChildFiberChain(60, {
    type: { name: 'QueryClientProvider' },
    memoizedProps: {
      client: {
        getQueryCache: () => ({
          getAll: () => [
            {
              queryKey: ['featured'],
              state: { data: { id: 7 }, status: 'success', dataUpdatedAt: 123 },
            },
          ],
        }),
      },
    },
    child: null,
    sibling: null,
  });

  const result = JSON.parse((createSandbox({ fiberRoot }) as Sandbox).__QAREN.getStoreState());

  assert.deepEqual(result, {
    type: 'react-query',
    state: {
      '["featured"]': { data: { id: 7 }, status: 'success', dataUpdatedAt: 123 },
    },
  });
});

test('getStoreState enforces the per-root visit budget and preserves the global fallback', () => {
  const beyondBudgetRoot = createSingleChildFiberChain(50_000, {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ selected: 'beyond-budget' }) } },
    child: null,
    sibling: null,
  });
  const nextRendererRoot: Fiber = {
    type: { name: 'Provider' },
    memoizedProps: { store: { getState: () => ({ selected: 'next-renderer' }) } },
    child: null,
    sibling: null,
  };
  const hook: RendererHook = {
    renderers: new Map([
      [1, {}],
      [2, {}],
    ]),
    getFiberRoots: (id) =>
      new Set(
        id === 1
          ? [{ current: beyondBudgetRoot }]
          : id === 2
            ? [{ current: nextRendererRoot }]
            : [],
      ),
  };

  const rendererSandbox = createSandbox() as Sandbox;
  rendererSandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  const nextRendererResult = JSON.parse(rendererSandbox.__QAREN.getStoreState(undefined, 'redux'));
  const fallbackSandbox = createSandbox({ fiberRoot: beyondBudgetRoot }) as Sandbox;
  fallbackSandbox.__REDUX_STORE__ = {
    getState: () => ({ selected: 'global-fallback' }),
  };
  const fallbackResult = JSON.parse(fallbackSandbox.__QAREN.getStoreState(undefined, 'redux'));

  assert.deepEqual(nextRendererResult, { type: 'redux', state: { selected: 'next-renderer' } });
  assert.deepEqual(fallbackResult, { type: 'redux', state: { selected: 'global-fallback' } });
});
