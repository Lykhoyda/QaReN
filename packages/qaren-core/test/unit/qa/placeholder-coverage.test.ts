import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  join,
  type DigestEntry,
  type NativeNode,
  type ReactHostEvidence,
} from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { prepareTarget } from '../../../dist/qa/resolve.js';
import { placeholderPairingGap, targetMissDiagnostic } from '../../../dist/qa/target-miss.js';
import { ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

const frame = { x: 0, y: 0, width: 400, height: 800 };
const target = { quoted: 'Search items', phrase: 'Search items' };
const fill = { kind: 'fill' as const, target, text: 'query' };

function fixture() {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: frame },
    { ref: '@window', type: 'Window', parentIndex: 0, rect: frame },
    {
      ref: '@input',
      type: 'TextField',
      parentIndex: 1,
      enabled: true,
      hittable: true,
      rect: { x: 20, y: 100, width: 300, height: 44 },
    },
    {
      ref: '@lower',
      type: 'TextField',
      parentIndex: 1,
      identifier: 'lower-search',
      enabled: true,
      rect: { x: 20, y: 1000, width: 300, height: 44 },
    },
  ];
  const digest: DigestEntry[] = [
    {
      role: 'textinput',
      placeholder: 'Search items',
      capabilities: { press: false, fill: true },
      inputHostIndices: [0],
    },
    {
      role: 'textinput',
      placeholder: 'Lower search',
      testID: 'lower-search',
      capabilities: { press: false, fill: true },
      inputHostIndices: [1],
    },
  ];
  const hosts: ReactHostEvidence = {
    complete: true,
    hosts: [
      { role: 'textinput', roleSource: 'none', capabilities: { fill: true } },
      {
        role: 'textinput',
        roleSource: 'none',
        capabilities: { fill: true },
        testID: 'lower-search',
      },
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [2, 3].map((node, hostIndex) => ({
        hostIndex,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: 'RCTSinglelineTextInputView',
        rect: nodes[node].rect,
        text: { kind: 'none' as const },
      })),
    },
  };
  const presence: NativePresence = {
    source: 'xcui-live',
    nodes: nodes.map((_, i) => ({
      status: i === 3 ? 'unknown' : 'observed',
      labelSource: 'none',
    })),
  };
  const capture = () =>
    join(nodes, digest, 'app', { native: 'complete', react: 'complete' }, hosts, presence);
  return { nodes, digest, hosts, presence, capture };
}

for (const competitor of ['on-screen', 'offscreen', 'accessibility-hidden'] as const) {
  test(`a second ${competitor} native input withholds the placeholder and refuses Fill`, async () => {
    const f = fixture();
    if (competitor !== 'offscreen') {
      f.nodes[3].rect = { ...f.nodes[3].rect!, y: 200 };
      f.hosts.typography!.nodes[1].rect = f.nodes[3].rect;
    }
    if (competitor === 'on-screen') f.presence.nodes[3].status = 'observed';
    if (competitor === 'accessibility-hidden') {
      f.hosts.hosts[1].hidden = true;
      f.digest[1].hidden = true;
    }
    const screen = f.capture();
    assert.equal(screen.elements.find((e) => e.ref === '@input')?.placeholder, undefined);
    assert.ok('refuse' in prepareTarget(fill, screen));
    const w = walker(
      [screen],
      scriptedJudge(() => assert.fail('quoted Fill needs no model')),
    );
    const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, w.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.deepEqual(w.actions, []);
  });
}

test('on-screen, keyboard-covered, React-only and stale or conflicting associations stay competitors', () => {
  const changes: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.nodes[3].rect = { ...f.nodes[3].rect!, y: 200 };
      f.hosts.typography!.nodes[1].rect = f.nodes[3].rect;
      f.presence.nodes[3].status = 'observed';
    },
    (f) => {
      f.presence.nodes[3].unknownReason = 'keyboard-covered';
    },
    (f) => {
      f.nodes.push({
        ref: '@keyboard',
        type: 'Keyboard',
        rect: { x: 0, y: 900, width: 400, height: 300 },
      });
      f.presence.nodes.push({ status: 'observed', labelSource: 'none' });
    },
    (f) => {
      f.nodes.pop();
      f.presence.nodes.pop();
    },
    (f) => {
      f.nodes.pop();
      f.presence.nodes.pop();
      delete f.digest[1].testID;
      delete f.hosts.hosts[1].testID;
    },
    (f) => {
      f.hosts.typography!.nodes[1].rect = { ...f.nodes[3].rect!, y: 1001 };
    },
    (f) => {
      f.digest[1].inputHostIndices = [];
    },
    (f) => {
      f.digest[1].inputHostIndices = [0, 1];
    },
    (f) => {
      f.digest[1].testID = 'stale';
    },
    (f) => {
      f.nodes.push({ ...f.nodes[3], ref: '@duplicate' });
      f.presence.nodes.push({ status: 'unknown', labelSource: 'none' });
    },
    (f) => {
      f.hosts.complete = false;
    },
    (f) => {
      f.hosts.typography!.complete = false;
    },
    (f) => {
      f.digest.push({ ...f.digest[0], placeholder: 'Conflicting forwarded name' });
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    const screen = f.capture();
    assert.equal(screen.elements.find((e) => e.ref === '@input')?.placeholder, undefined);
    assert.ok('refuse' in prepareTarget(fill, screen));
  }
});

test('ambiguous or unavailable native presence keeps hidden and offscreen inputs competing', () => {
  for (const reason of [
    'ambiguous-descriptor',
    'match-count-mismatch',
    'post-hit-mismatch',
    'read-unavailable',
  ] as const) {
    for (const hidden of [false, true]) {
      const f = fixture();
      if (hidden) {
        f.nodes[3].rect = { ...f.nodes[3].rect!, y: 200 };
        f.hosts.typography!.nodes[1].rect = f.nodes[3].rect;
        f.hosts.hosts[1].hidden = true;
        f.digest[1].hidden = true;
      }
      f.presence.nodes[3].unknownReason = reason;
      assert.equal(f.capture().elements[2].placeholder, undefined);
      assert.ok('refuse' in prepareTarget(fill, f.capture()));
    }
  }
});

test('an inactive donor cannot name the on-screen input', () => {
  const f = fixture();
  delete f.digest[0].placeholder;
  f.digest[1].placeholder = 'Search items';
  assert.equal(f.capture().elements[2].placeholder, undefined);
  const result = prepareTarget(fill, f.capture());
  if ('ref' in result) assert.equal(result.ref, '@lower');
});

for (const react of ['unknown', 'incomplete'] as const) {
  test(`a missed placeholder Fill explains ${react} React coverage without dispatch`, async () => {
    const f = fixture();
    f.nodes.pop();
    f.presence.nodes.pop();
    const screen = join(f.nodes, [], 'app', { native: 'complete', react }, undefined, f.presence);
    const diagnostic = targetMissDiagnostic(
      target,
      screen,
      1,
      false,
      new ObservedPrivacy(),
      'fill',
    );
    assert.equal(diagnostic.reason, 'evidence-incomplete');
    const w = walker(
      [screen],
      scriptedJudge(() => assert.fail('quoted Fill needs no model')),
    );
    const ledger = await runPlan(parsePlan('1. Fill "Search items" with "query"').blocks!, w.deps);
    assert.equal(ledger.verdict, 'FAIL');
    assert.deepEqual(w.actions, []);
    assert.equal(ledger.failure?.subreason, 'evidence-incomplete');
    assert.match(
      ledger.failure?.suggestion ?? '',
      new RegExp(`React coverage on this screen is ${react}; target the field by test id`),
    );
    assert.match(
      JSON.stringify(ledger.steps),
      new RegExp(`React coverage on this screen is ${react}`),
    );
    screen.captureCoverage = { native: 'complete', react };
    screen.coverage = { native: 'complete', react: 'complete' };
    assert.equal(
      targetMissDiagnostic(target, screen, 1, false, new ObservedPrivacy(), 'fill').reason,
      'evidence-incomplete',
    );
    assert.equal(
      targetMissDiagnostic(target, screen, 1, false, new ObservedPrivacy(), 'press').reason,
      'absent',
    );
    assert.equal(
      targetMissDiagnostic(
        { ...target, exact: 'id' },
        screen,
        1,
        false,
        new ObservedPrivacy(),
        'fill',
      ).reason,
      'absent',
    );
    screen.elements[2].testID = 'Search items';
    assert.equal(
      targetMissDiagnostic(target, screen, 1, false, new ObservedPrivacy(), 'fill').reason,
      'present-but-unavailable',
    );
  });
}

test('a joined host-evidence downgrade is reported even when acquisition was complete', () => {
  const f = fixture();
  f.nodes.pop();
  f.presence.nodes.pop();
  const screen = join(
    f.nodes,
    [],
    'app',
    { native: 'complete', react: 'incomplete' },
    undefined,
    f.presence,
  );
  screen.captureCoverage = { native: 'complete', react: 'complete' };
  assert.equal(
    targetMissDiagnostic(target, screen, 1, false, new ObservedPrivacy(), 'fill').reason,
    'evidence-incomplete',
  );
  const phrase = { phrase: 'the insurer search field' };
  assert.equal(placeholderPairingGap(phrase, screen, 'fill'), undefined);
  assert.equal(
    targetMissDiagnostic(phrase, screen, 1, false, new ObservedPrivacy(), 'fill').reason,
    'evidence-incomplete',
  );
});
