import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createComponentTreeHandler } from '../../dist/handlers/component-tree.js';
import { HELPERS_VERSION } from '../../dist/injected-helpers.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { buildFiber, createSandbox } from './helpers/inject-harness.js';

test('component-tree forwards typography and awaits CDP only for the triple opt-in', async () => {
  for (const interactiveOnly of [false, true]) {
    for (const semanticEvidence of [false, true]) {
      for (const typographyEvidence of [false, true]) {
        const raw = buildFiber({ text: 'Title' });
        raw.tag = 6;
        const root = buildFiber({ hostType: 'RCTText', props: { style: { fontSize: 32 } } });
        root.tag = 5;
        root.child = raw;
        raw.return = root;
        root.stateNode = {
          measureInWindow: (cb: (...values: number[]) => void) =>
            queueMicrotask(() => cb(0, 0, 200, 40)),
        };
        const sandbox = createSandbox({ fiberRoot: root });
        const enabled = interactiveOnly && semanticEvidence && typographyEvidence;
        let calls = 0;
        const client = createMockClient({
          probeHelperFreshness: async () => ({
            fresh: true,
            version: HELPERS_VERSION,
            probed: true,
          }),
          evaluate: async (expression: string, awaitPromise: boolean) => {
            calls++;
            assert.equal(awaitPromise, enabled);
            assert.equal(expression.includes('"typographyEvidence":true'), enabled);
            const value = vm.runInContext(expression, sandbox);
            assert.equal(typeof value === 'string', !enabled);
            return { value: awaitPromise ? await value : value };
          },
        });
        const result = parseEnvelope(
          await createComponentTreeHandler(() => client)({
            interactiveOnly,
            semanticEvidence,
            typographyEvidence,
            depth: 12,
          }),
        );
        assert.equal(result.ok, true);
        assert.equal(calls, 1);
        assert.equal(Boolean(result.data.hostEvidence?.typography), enabled);
        if (enabled) {
          assert.equal(result.data.hostEvidence.typography.nodes[0].text.content, 'Title');
          assert.equal(result.data.hostEvidence.typography.nodes[0].rect.height, 40);
        }
      }
    }
  }
});
