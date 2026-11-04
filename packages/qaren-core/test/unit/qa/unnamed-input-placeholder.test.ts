import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { inputCheckSubject, redactEvidence } from '../../../dist/qa/privacy.js';
import { resolveTarget } from '../../../dist/qa/resolve.js';
import { describe, join } from '../../../dist/qa/screen.js';
import type {
  DigestEntry,
  NativeNode,
  ReactHostEvidence,
  Screen,
} from '../../../dist/qa/screen.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const input: NativeNode = {
  ref: '@input',
  type: 'TextField',
  hittable: true,
  enabled: true,
  rect: { x: 20, y: 100, width: 300, height: 44 },
};
const candidate: DigestEntry = {
  role: 'textinput',
  inputHostIndices: [0],
  placeholder: 'Search items',
  capabilities: { press: false, fill: true },
};
const inputHosts: ReactHostEvidence = {
  complete: true,
  hosts: [{ role: 'textinput', roleSource: 'role', capabilities: { fill: true } }],
};
const noJudge = () => scriptedJudge(() => assert.fail('quoted targets do not need Jev'));
const joinScreen: typeof join = (
  nodes,
  digest,
  front,
  coverage = { native: 'complete', react: 'complete' },
  hosts = {
    complete: true,
    hosts: [{ role: 'textinput', roleSource: 'none', capabilities: { fill: true } }],
  },
  presence,
) => join(nodes, digest, front, coverage, hosts, presence);

async function resolve(observed: Screen, target = 'Search items') {
  const step = parseStep(`Fill "${target}" with "query"`);
  assert.ok(step && !('refuse' in step));
  return resolveTarget(step, observed, noJudge());
}

test('one unnamed empty input receives only the unique React placeholder and can be filled', async () => {
  for (const entry of [candidate, { ...candidate, role: 'other' }]) {
    const observed = joinScreen([input], [entry]);
    const baseline = joinScreen([input], [{ ...entry, placeholder: undefined }]);
    assert.deepEqual(observed.elements[0], {
      ...baseline.elements[0],
      placeholder: 'Search items',
    });
    assert.deepEqual(observed.visibleText, baseline.visibleText);
    assert.equal(observed.semanticUnassociatedReact, baseline.semanticUnassociatedReact);
    assert.equal(observed.semanticUnassociatedReact, 1);
    const result = await resolve(observed);
    assert.ok('ref' in result);
    assert.equal(result.ref, '@input');
    const f = walker([observed], noJudge());
    const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, f.deps);
    assert.equal(ledger.verdict, 'PASS');
    assert.deepEqual(f.actions, ['fill @input query']);
  }
});

test('competing native inputs block the name even when offscreen, labelled or populated', async () => {
  for (const extra of [
    {},
    { rect: { x: 20, y: -500, width: 300, height: 44 } },
    { label: 'Other field', identifier: 'other', value: 'existing text' },
  ]) {
    const observed = joinScreen(
      [
        { ref: '@app', type: 'Application', rect: { x: 0, y: 0, width: 400, height: 800 } },
        input,
        { ...input, ref: '@other', ...extra },
      ],
      [candidate],
    );
    if ('rect' in extra)
      assert.equal(observed.elements.find((e) => e.ref === '@other')?.offscreen, true);
    assert.ok(observed.elements.every((e) => e.placeholder === undefined));
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('partial, unknown and unattested captures cannot prove a unique placeholder pairing', async () => {
  for (const coverage of [
    { native: 'complete', react: 'incomplete' },
    { native: 'incomplete', react: 'complete' },
    { native: 'complete', react: 'unknown' },
    { native: 'unknown', react: 'complete' },
    undefined,
  ] as const) {
    const observed = join([input], [candidate], 'app', coverage);
    assert.equal(observed.elements[0].placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('competing React inputs block the name, including React-only inputs', async () => {
  for (const extra of [
    { ...candidate, placeholder: 'Other search' },
    { ...candidate, testID: 'react-only' },
    { ...candidate, hidden: true },
    { role: 'other', capabilities: { press: false, fill: true } },
  ]) {
    const observed = joinScreen([input], [candidate, extra]);
    if ('testID' in extra)
      assert.ok(observed.elements.some((e) => e.ref === 'react:react-only' && e.offscreen));
    assert.equal(observed.elements[0].placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('shared input-host grouping refuses conflicting names, identities and incomplete ancestry', async () => {
  const first = { ...candidate, inputHostIndices: [0] };
  const host = {
    role: 'textinput',
    roleSource: 'none' as const,
    capabilities: { fill: true as const },
  };
  for (const [extra, evidence] of [
    [
      { ...first, placeholder: 'Other search' },
      { complete: true, hosts: [host] },
    ],
    [
      { ...first, hidden: true },
      { complete: true, hosts: [host] },
    ],
    [
      { ...first, testID: 'other' },
      { complete: true, hosts: [host] },
    ],
    [
      { ...first, inputHostIndices: undefined },
      { complete: true, hosts: [host] },
    ],
    [
      { ...first, inputHostIndices: [1] },
      { complete: true, hosts: [host, host] },
    ],
    [
      { ...first, inputHostIndices: [0, 1] },
      { complete: true, hosts: [host, host] },
    ],
    [first, { complete: false, hosts: [host] }],
  ] as const) {
    const observed = joinScreen([input], [first, extra], 'app', undefined, {
      ...evidence,
      hosts: [...evidence.hosts],
    });
    assert.equal(observed.elements[0].placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('same-host layers pair in either order without erasing coverage gaps', async () => {
  const layers = [
    { ...candidate, compositeWrapper: true as const },
    { ...candidate, placeholder: undefined },
    candidate,
  ];
  for (const digest of [layers, [...layers].reverse()]) {
    const observed = joinScreen([input], digest);
    const result = await resolve(observed);
    assert.ok('ref' in result);
    assert.equal(result.ref, '@input');
    assert.equal(observed.semanticUnassociatedReact, 2);
    for (const native of ['unknown', 'incomplete'] as const) {
      for (const acquired of ['complete', 'unknown', 'incomplete'] as const) {
        const ordinary = join(
          [input],
          digest,
          'app',
          { native, react: 'complete' },
          inputHosts,
          undefined,
          acquired,
        );
        const result = await resolve(ordinary);
        if (acquired === 'complete') {
          assert.equal(ordinary.elements[0].placeholder, 'Search items');
          assert.ok('ref' in result);
          assert.equal(result.ref, '@input');
        } else {
          assert.equal(ordinary.elements[0].placeholder, undefined);
          assert.ok('refuse' in result);
          assert.equal(result.refuse, 'TARGET_NOT_FOUND');
        }
      }
    }
    for (const react of ['unknown', 'incomplete'] as const) {
      const partial = joinScreen([input], digest, 'app', { native: 'complete', react });
      assert.equal(partial.elements[0].placeholder, undefined);
      assert.ok('refuse' in (await resolve(partial)));
    }
  }
});

test('unknown native coverage without acquisition evidence cannot pair attested hosts', async () => {
  const observed = join(
    [input],
    [candidate],
    'app',
    { native: 'unknown', react: 'complete' },
    inputHosts,
  );
  assert.equal(observed.elements[0].placeholder, undefined);
  const result = await resolve(observed);
  assert.ok('refuse' in result);
  assert.equal(result.refuse, 'TARGET_NOT_FOUND');
});

test('ordinary capture carries acquisition proof through placeholder resolution and Fill dispatch', async () => {
  const f = walker([], noJudge());
  let captures = 0;
  f.deps.captureScreen = async (options) => {
    assert.notEqual(options?.platformPresence, true);
    captures += 1;
    const observed = await captureScreen({
      requirePrivateInputs: true,
      native: async () => ({
        nodes: [input],
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict: { state: 'ok', nodeCount: 1, refMapUpdated: true, reasons: [] },
      }),
      react: async () => ({
        interactive: [{ ...candidate, compositeWrapper: true }, candidate],
        verdict: { state: 'ok', path: 'interactive', complete: true },
        hostEvidence: inputHosts,
      }),
    });
    assert.deepEqual(observed.captureCoverage, { native: 'complete', react: 'complete' });
    assert.deepEqual(observed.coverage, { native: 'unknown', react: 'complete' });
    assert.equal(observed.elements[0].placeholder, 'Search items');
    return observed;
  };
  const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'PASS');
  assert.ok(captures > 0);
  assert.deepEqual(f.actions, ['fill @input query']);
});

test('ordinary acquisition keeps distinct, hidden, offscreen and conflicting inputs competing', async () => {
  for (const [nodes, digest, hosts] of [
    [[input, { ...input, ref: '@other' }], [candidate], inputHosts],
    [
      [input, { ...input, ref: '@other', rect: { x: 20, y: -500, width: 300, height: 44 } }],
      [candidate, { ...candidate, inputHostIndices: [1] }],
      { complete: true, hosts: [...inputHosts.hosts, inputHosts.hosts[0]] },
    ],
    [
      [input, { ...input, ref: '@other' }],
      [candidate, { ...candidate, hidden: true, inputHostIndices: [1] }],
      { complete: true, hosts: [...inputHosts.hosts, { ...inputHosts.hosts[0], hidden: true }] },
    ],
    [
      [input],
      [candidate, { ...candidate, inputHostIndices: [1] }],
      { complete: true, hosts: [...inputHosts.hosts, inputHosts.hosts[0]] },
    ],
    [[input], [candidate, { ...candidate, placeholder: 'Other search' }], inputHosts],
    [[input], [candidate, { ...candidate, inputHostIndices: [1] }], inputHosts],
  ] as const) {
    for (const native of ['unknown', 'incomplete'] as const) {
      const observed = join(
        [...nodes],
        [...digest],
        'app',
        { native, react: 'complete' },
        { ...hosts, hosts: [...hosts.hosts] },
        undefined,
        'complete',
      );
      assert.ok(observed.elements.every((element) => element.placeholder === undefined));
      const result = await resolve(observed);
      assert.ok('refuse' in result);
      assert.equal(result.refuse, 'TARGET_NOT_FOUND');
      const f = walker(
        [{ ...observed, captureCoverage: { native: 'complete', react: 'complete' } }],
        noJudge(),
      );
      const ledger = await runPlan(
        parsePlan('1. Fill "Search items" with "query"').blocks!,
        f.deps,
      );
      assert.equal(ledger.verdict, 'FAIL');
      assert.deepEqual(f.actions, []);
    }
  }
});

test('two attested input hosts cannot donate a placeholder to one native input', async () => {
  const observed = joinScreen(
    [input],
    [candidate, { ...candidate, inputHostIndices: [1] }],
    'app',
    undefined,
    {
      complete: true,
      hosts: [
        { role: 'textinput', roleSource: 'none', capabilities: { fill: true } },
        { role: 'textinput', roleSource: 'none', capabilities: { fill: true } },
      ],
    },
  );
  const f = walker([observed], noJudge());
  const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, f.deps);
  assert.equal(ledger.verdict, 'FAIL');
  assert.deepEqual(f.actions, []);
});

test('hidden, composite, identified, blank and non-input entries cannot name an input', async () => {
  for (const entry of [
    { ...candidate, hidden: true },
    { ...candidate, compositeWrapper: true as const },
    { ...candidate, testID: 'unmatched' },
    { ...candidate, placeholder: '  ' },
    { role: 'text', placeholder: 'Search items' },
  ]) {
    const observed = joinScreen([input], [entry]);
    assert.equal(observed.elements[0].placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('a candidate consumed by another node cannot name the empty input in either tree order', async () => {
  const label: NativeNode = { ...input, ref: '@label', type: 'StaticText', label: 'Search label' };
  for (const nodes of [
    [input, label],
    [label, input],
  ]) {
    const observed = joinScreen(nodes, [{ ...candidate, label: 'Search label' }]);
    assert.equal(observed.elements.find((e) => e.ref === '@input')?.placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('existing label matching keeps text precedence and whitespace and case normalization', () => {
  const typed = { ...input, label: 'Typed text', value: 'Typed text' };
  const matched = joinScreen(
    [typed],
    [{ ...candidate, text: '  TYPED\ntext  ', label: 'Other label' }],
  );
  assert.equal(matched.elements[0].placeholder, 'Search items');
  assert.equal(matched.elements[0].value, 'Typed text');
  const unmatched = joinScreen(
    [typed],
    [{ ...candidate, text: 'Other text', label: 'Typed text' }],
  );
  assert.equal(unmatched.elements[0].placeholder, undefined);
});

test('a native value, including placeholder-equal text and whitespace, is never treated as empty', async () => {
  for (const value of ['Search items', 'already typed', '  ']) {
    const observed = joinScreen([{ ...input, value }], [candidate]);
    assert.equal(observed.elements[0].placeholder, undefined);
    const result = await resolve(observed);
    assert.ok('refuse' in result);
    assert.equal(result.refuse, 'TARGET_NOT_FOUND');
  }
});

test('the Test App input with a test ID retains its existing digest join', async () => {
  const observed = joinScreen(
    [{ ...input, identifier: 'fixture_input' }],
    [{ ...candidate, testID: 'fixture_input', placeholder: 'type here' }],
  );
  assert.equal(observed.elements[0].placeholder, 'type here');
  assert.equal(observed.semanticUnassociatedReact, 0);
  const result = await resolve(observed, 'type here');
  assert.ok('ref' in result);
  assert.equal(result.ref, '@input');
});

test('placeholder naming does not import disabled state, value or capabilities from the digest', () => {
  const hostEvidence = {
    complete: true,
    hosts: [
      { role: 'textinput', roleSource: 'role' as const, capabilities: { fill: true as const } },
    ],
  };
  const entry = { ...candidate, disabled: true, value: 'digest-only text' };
  const baseline = joinScreen(
    [input],
    [{ ...entry, placeholder: undefined }],
    'app',
    undefined,
    hostEvidence,
  );
  const observed = joinScreen([input], [entry], 'app', undefined, hostEvidence);
  assert.deepEqual(observed.elements[0], { ...baseline.elements[0], placeholder: 'Search items' });
  assert.equal(observed.elements[0].disabled, false);
  assert.equal(observed.elements[0].value, undefined);
  assert.equal(observed.fillGapCount, baseline.fillGapCount);
  assert.equal(observed.fillGapCount, 1);
  assert.equal(observed.semanticUnassociatedReact, baseline.semanticUnassociatedReact);
});

test('disabled and presence-gated inputs keep the same eligibility', async () => {
  for (const presence of [undefined, 'unknown'] as const) {
    for (const enabled of [false, true]) {
      const node = { ...input, enabled };
      const observed = joinScreen([node], [candidate], 'app', undefined, undefined, presence);
      const baseline = joinScreen(
        [node],
        [{ ...candidate, placeholder: undefined }],
        'app',
        undefined,
        undefined,
        presence,
      );
      assert.equal(observed.elements[0].placeholder, 'Search items');
      assert.deepEqual(observed.elements[0].semantic, baseline.elements[0].semantic);
      assert.equal(observed.elements[0].disabled, !enabled);
      if (!enabled) {
        const result = await resolve(observed);
        assert.ok('refuse' in result);
      }
    }
  }
});

test('a secure input gains a name but no new value or typing proof', async () => {
  const observed = joinScreen([{ ...input, type: 'SecureTextField' }], [candidate]);
  assert.equal(observed.elements[0].placeholder, 'Search items');
  assert.equal(observed.elements[0].value, undefined);
  assert.equal(inputCheckSubject(observed.elements[0]), 'unknown');
  const f = walker([observed], noJudge(), {
    ok: true,
    proven: false,
    evidence: 'unavailable',
  });
  const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, f.deps);
  assert.match(JSON.stringify(ledger), /UNVERIFIED_FILL/);
  assert.deepEqual(f.actions, ['fill @input query']);
});

test('placeholder names and echoed cross-field values remain masked in outward evidence', async () => {
  const secret = 'synthetic-cross-field-value';
  const observed = joinScreen(
    [input, { ...input, ref: '@other', type: 'Other', label: 'Wrapped field', value: secret }],
    [{ ...candidate, placeholder: `Search ${secret}` }],
  );
  assert.equal(observed.elements[0].placeholder, `Search ${secret}`);
  const outward = redactEvidence(observed, describe(observed.elements[0]));
  assert.equal(outward.includes(secret), false);
  const f = walker([observed], noJudge());
  const ledger = await runPlan(
    parsePlan(`1. Fill "Search ${secret}" with "query"`).blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'PASS');
  assert.equal(JSON.stringify({ ledger, rows: f.rows }).includes(secret), false);
  const judge = scriptedJudge((questions) =>
    Object.fromEntries(Object.keys(questions).map((key) => [key, { type: 'noul', noul: 0.99 }])),
  );
  const check = walker([observed], judge);
  const checked = await runPlan(parsePlan('✓ The search field is shown').blocks!, check.deps);
  assert.equal(judge.requests.length, 0);
  assert.match(checked.failure?.seen ?? '', /SCREEN_EVIDENCE_INCOMPLETE/);
  assert.equal(JSON.stringify({ checked, prompts: judge.requests }).includes(secret), false);
});
