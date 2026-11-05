import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { INJECTED_HELPERS } from '../../dist/injected-helpers.js';
import { createComponentTreeHandler } from '../../dist/handlers/component-tree.js';
// @ts-expect-error legacy JS helper has no declaration file
import { createMockClient } from '../helpers/mock-cdp-client.js';

function body(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text) as {
    ok: boolean;
    data?: Record<string, unknown>;
    meta?: Record<string, unknown>;
  };
}

test('GH-588 Slice E: oversize navigation state emits a narrowing hint', () => {
  const context = vm.createContext({
    __expo_router_state__: { payload: 'x'.repeat(50_000) },
  });
  vm.runInContext(INJECTED_HELPERS, context);
  const result = JSON.parse(context.__QAREN.getNavState());
  assert.equal(result.__agent_truncated, true);
  assert.ok(result.originalLength > 50_000);
  assert.match(
    result.hint,
    /State exceeds the payload budget; target a smaller component via testID/,
  );
  assert.equal(result.payload, undefined);
});

test('GH-588 Slice E: scan budget exhaustion is self-explaining in the top-level message', async () => {
  const client = createMockClient({
    evaluate: async () => ({
      value: JSON.stringify({
        tree: null,
        verdict: { state: 'failed', reasons: ['scan-budget-exhausted'] },
      }),
    }),
  });
  const result = body(await createComponentTreeHandler(() => client as never)({ depth: 12 }));
  assert.equal(result.ok, true);
  assert.match(String(result.data?.message), /scan budget was exhausted/);
  const verdict = result.meta?.treeVerdict as { reasons?: string[] } | undefined;
  assert.deepEqual(verdict?.reasons, ['scan-budget-exhausted']);
});
