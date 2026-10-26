import test from 'node:test';
import assert from 'node:assert/strict';
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

test('GH-588 Slice E: oversize state hint names only real narrowing/read tools', () => {
  assert.match(
    INJECTED_HELPERS,
    /State exceeds the payload budget; target a smaller component via testID/,
  );
  assert.match(INJECTED_HELPERS, /cdp_store_state \/ cdp_evaluate/);
  assert.doesNotMatch(INJECTED_HELPERS, /Use a filter or narrower path to reduce output size/);
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
