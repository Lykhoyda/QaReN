import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCdpReplayCommands } from '../../dist/handlers/cdp-replay-dispatch.js';

test('React tap aborts after interactability proof without dispatching a late press', async () => {
  const controller = new AbortController();
  let mutations = 0;
  const result = await runCdpReplayCommands(
    [{ tapOn: { id: 'submit' } }],
    {},
    {
      pressByTestId: async () => {
        mutations += 1;
      },
      typeByTestId: async () => {},
      treeFor: async () => {
        controller.abort(new Error('deadline'));
        return { tree: { testID: 'submit', children: [] } };
      },
      frontmostFor: async () => ({ visible: true, matchCount: 1 }),
      launchApp: async () => {},
      settle: async () => {},
    },
    { signal: controller.signal },
  );

  assert.equal(result.passed, false);
  assert.equal(result.failureCode, 'RUNNER_TIMEOUT');
  assert.equal(mutations, 0);
});
