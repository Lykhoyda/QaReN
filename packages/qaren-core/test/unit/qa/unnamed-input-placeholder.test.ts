import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, parseStep } from '../../../dist/qa/plan.js';
import { inputCheckSubject, redactEvidence } from '../../../dist/qa/privacy.js';
import { resolveTarget } from '../../../dist/qa/resolve.js';
import { describe, join } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, Screen } from '../../../dist/qa/screen.js';
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
  placeholder: 'Search items',
  capabilities: { press: false, fill: true },
};
const noJudge = () => scriptedJudge(() => assert.fail('quoted targets do not need Jev'));
const joinScreen: typeof join = (
  nodes,
  digest,
  front,
  coverage = { native: 'complete', react: 'complete' },
  hosts,
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

test('competing React inputs block the name, including React-only and composite wrappers', async () => {
  for (const extra of [
    { ...candidate, placeholder: 'Other search' },
    { ...candidate, testID: 'react-only' },
    { ...candidate, compositeWrapper: true as const },
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
