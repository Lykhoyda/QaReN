import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { createComponentTreeHandler } from '../../../dist/handlers/component-tree.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { PRIVATE_INPUT_LIMITS } from '../../../dist/qa/private-input-limits.js';
import { validateReactHostEvidence } from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createMockClient } from '../../helpers/mock-cdp-client.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

function producer(children: Parameters<typeof buildFiber>[0]['children']) {
  const sandbox = createSandbox({ fiberRoot: buildFiber({ name: 'Screen', children }) });
  const client = createMockClient({
    evaluate: async (expression: string) => ({ value: vm.runInContext(expression, sandbox) }),
  });
  return createComponentTreeHandler(() => client);
}

test('real host producer survives the handler and capture without becoming visual proof', async () => {
  const tree = producer([
    {
      hostType: 'RCTText',
      props: { testID: 'welcome', role: 'heading', accessibilityLabel: 'Private description' },
    },
    { hostType: 'RCTView', props: { testID: 'save', onClick() {} } },
    { hostType: 'RCTText', props: { testID: 'save' } },
  ]);
  const read = async () => {
    const envelope = parseEnvelope(
      await tree({ depth: 12, interactiveOnly: true, semanticEvidence: true }),
    );
    assert.equal(envelope.ok, true);
    return { ...envelope.data, verdict: envelope.meta.treeVerdict };
  };
  const screen = await captureScreen({
    native: async () => ({
      nodes: [
        {
          ref: '@welcome',
          type: 'StaticText',
          identifier: 'welcome',
          label: 'Welcome',
          hittable: true,
        },
        { ref: '@save', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
      ],
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict: { state: 'ok', nodeCount: 2, refMapUpdated: true, reasons: [] },
    }),
    react: read,
  });
  assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'complete' });
  assert.deepEqual(screen.coverage, { native: 'unknown', react: 'complete' });
  assert.deepEqual(screen.reactHostEvidence, {
    hosts: [
      { testID: 'welcome', role: 'heading', roleSource: 'role', capabilities: {}, order: 0 },
      { testID: 'save', role: null, roleSource: 'none', capabilities: { press: true }, order: 1 },
      { testID: 'save', role: null, roleSource: 'none', capabilities: {}, order: 2 },
    ],
    complete: true,
  });
  assert.ok(!JSON.stringify(screen.reactHostEvidence).includes('Private description'));
  assert.ok(screen.elements.every((element) => element.semantic?.visibility === 'unknown'));
  for (const plan of [
    '1. Wait for the welcome heading',
    '1. Tap the save control',
    '1. Scroll down until the welcome heading',
  ]) {
    const judge = scriptedJudge(() => assert.fail('host roles and hit hints cannot authorize Jev'));
    const f = walker([screen], judge);
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.equal(result.verdict, 'FAIL', plan);
    assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
    assert.deepEqual(f.actions, []);
    assert.equal(judge.requests.length, 0);
  }
  const judge = scriptedJudge(() => assert.fail('literal compatibility must stay local'));
  const f = walker([screen], judge);
  const literal = await runPlan(parsePlan('1. Wait for "Welcome"').blocks!, f.deps);
  assert.equal(literal.verdict, 'PASS', literal.failure?.seen);
  assert.deepEqual(f.actions, []);
});

test('the component tree handler forwards host capture only with the interactive opt-in', async () => {
  const tree = producer([{ hostType: 'RCTText', props: { role: 'heading' } }]);
  for (const args of [
    { depth: 4 },
    { depth: 4, interactiveOnly: true },
    { depth: 4, semanticEvidence: true },
  ]) {
    const envelope = parseEnvelope(await tree(args));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.data.hostEvidence, undefined);
  }
  const envelope = parseEnvelope(
    await tree({ depth: 4, interactiveOnly: true, semanticEvidence: true }),
  );
  assert.deepEqual(envelope.data.hostEvidence.hosts, [
    { role: 'heading', roleSource: 'role', capabilities: {}, order: 0 },
  ]);
  assert.equal(envelope.meta.treeVerdict.complete, true);
});

test('host capture carries checked and selected flags but no other accessibility state', async () => {
  const tree = producer([
    {
      hostType: 'RCTView',
      props: {
        accessibilityRole: 'checkbox',
        accessibilityState: { checked: true, selected: false, expanded: true },
      },
    },
    { hostType: 'RCTView', props: { accessibilityState: { checked: 'mixed' } } },
    { hostType: 'RCTView', props: { accessibilityState: { checked: 'yes', selected: 1 } } },
  ]);
  const envelope = parseEnvelope(
    await tree({ depth: 4, interactiveOnly: true, semanticEvidence: true }),
  );
  assert.deepEqual(envelope.data.hostEvidence.hosts, [
    {
      role: 'checkbox',
      roleSource: 'accessibilityRole',
      capabilities: {},
      checked: true,
      selected: false,
      order: 0,
    },
    { role: null, roleSource: 'none', capabilities: {}, checked: 'mixed', order: 1 },
    { role: null, roleSource: 'none', capabilities: {}, order: 2 },
  ]);
  assert.ok(validateReactHostEvidence(envelope.data.hostEvidence));
});

test('host admission rejects malformed facts and retains independent identities without coercion', () => {
  const host = {
    testID: 'same',
    nativeID: 'other',
    role: 'heading',
    roleSource: 'role',
    capabilities: {},
  };
  for (const invalid of [
    null,
    [],
    {},
    { hosts: [], complete: 'true' },
    { hosts: [{ ...host, capabilities: { press: false } }], complete: true },
    { hosts: [{ ...host, role: null }], complete: true },
    { hosts: [{ ...host, roleSource: 'none' }], complete: true },
    { hosts: [{ ...host, nativeID: 1 }], complete: true },
    { hosts: [{ ...host, disabled: false }], complete: true },
    { hosts: [{ ...host, pointerEvents: 'unknown' }], complete: true },
    { hosts: [{ ...host, pointerEvents: null }], complete: true },
    { hosts: [{ ...host, zIndex: '1' }], complete: true },
    { hosts: [{ ...host, zIndex: Number.POSITIVE_INFINITY }], complete: true },
    { hosts: [{ ...host, order: -1 }], complete: true },
    { hosts: [{ ...host, order: 1.5 }], complete: true },
    { hosts: [{ ...host, checked: 'yes' }], complete: true },
    { hosts: [{ ...host, selected: 'mixed' }], complete: true },
    {
      hosts: [{ ...host, roleSource: { toString: () => assert.fail('no coercion') } }],
      complete: true,
    },
    { hosts: Array.from({ length: PRIVATE_INPUT_LIMITS.maxHosts }, () => host), complete: true },
    {
      hosts: Array.from({ length: PRIVATE_INPUT_LIMITS.maxHosts + 1 }, () => host),
      complete: false,
    },
  ])
    assert.equal(validateReactHostEvidence(invalid), undefined);
  const touch = {
    ...host,
    pointerEvents: 'box-none',
    zIndex: -2,
    order: 3,
    checked: 'mixed',
    selected: false,
  };
  assert.deepEqual(validateReactHostEvidence({ hosts: [touch], complete: true }), {
    hosts: [touch],
    complete: true,
  });
  const input = { hosts: [host, host], complete: true };
  const valid = validateReactHostEvidence(input)!;
  assert.deepEqual(valid, input);
  assert.notEqual(valid.hosts[0], valid.hosts[1]);
  assert.notEqual(valid.hosts[0].capabilities, host.capabilities);
  assert.deepEqual(
    validateReactHostEvidence({ hosts: [{ ...host, role: null }], complete: false }),
    {
      hosts: [{ ...host, role: null }],
      complete: false,
    },
  );
});
