import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { HELPERS_VERSION } from '../../dist/injected-helpers.js';
import { createComponentTreeHandler } from '../../dist/handlers/component-tree.js';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../helpers/result-helpers.js';
import { buildFiber, createSandbox } from './helpers/inject-harness.js';

const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.SYNTHETIC_INVALID_SIGNATURE';
const person = 'SYNTHETIC_PERSON_SENTINEL';
const address = 'SYNTHETIC_ADDRESS_SENTINEL';

for (const filter of [undefined, 'carousel']) {
  test(`component tree omits queued hooks without inspecting payloads (${filter ?? 'unfiltered'})`, async () => {
    let payloadReads = 0;
    const root = buildFiber({
      name: 'SyntheticCarousel',
      props: { testID: 'synthetic-carousel' },
      children: [
        {
          name: 'Pressable',
          props: { testID: 'synthetic-next', onPress() {}, disabled: true },
        },
      ],
    });
    root.memoizedState = {
      queue: {},
      memoizedState: token,
      next: {
        queue: {},
        memoizedState: { session: { token }, user: { name: person, address } },
        next: {
          queue: {},
          memoizedState: {
            get personalData() {
              payloadReads++;
              return person;
            },
            toJSON() {
              payloadReads++;
              return { personalData: this.personalData };
            },
          },
          next: null,
        },
      },
    };
    const sandbox = createSandbox({ fiberRoot: root });
    const client = createMockClient({
      evaluate: async (expression: string) => ({ value: vm.runInContext(expression, sandbox) }),
      probeHelperFreshness: async () => ({
        fresh: sandbox.__QAREN.__v === HELPERS_VERSION,
        version: sandbox.__QAREN.__v,
        probed: true,
      }),
    });
    const helperText = sandbox.__QAREN.getTree({ filter, maxDepth: 4 });
    const result = await createComponentTreeHandler(() => client)({ filter, depth: 4 });
    const envelope = parseEnvelope(result);

    assert.equal(envelope.ok, true);
    assert.equal(envelope.meta.treeVerdict.state, 'ok');
    assert.equal(envelope.meta.treeVerdict.complete, true);
    assert.equal(envelope.meta.treeVerdict.path, filter ? 'filter' : 'full');
    for (const serialized of [helperText, JSON.stringify(result)]) {
      for (const omitted of ['hookStates', token, person, address]) {
        assert.equal(serialized.includes(omitted), false, `tree must omit ${omitted}`);
      }
    }
    assert.equal(payloadReads, 0, 'tree reads must not call hook payload getters or toJSON');
    assert.deepEqual(envelope.data.tree, {
      component: 'SyntheticCarousel',
      testID: 'synthetic-carousel',
      children: [
        {
          component: 'Pressable',
          testID: 'synthetic-next',
          disabled: true,
          props: { onPress: '[Function]', disabled: true },
        },
      ],
    });

    const state = JSON.parse(sandbox.__QAREN.getComponentState('synthetic-carousel'));
    assert.equal(state.hooks[0], token, 'explicit component state remains available');
    assert.deepEqual(state.hooks[1], {
      session: { token },
      user: { name: person, address },
    });
  });
}
