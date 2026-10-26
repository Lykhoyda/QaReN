import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  join,
  semanticActionView,
  validateReactHostEvidence,
  visibilityView,
} from '../../../dist/qa/screen.js';
import type { NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';
import {
  associateHosts,
  type HostAssociationDiagnostic,
} from '../../../dist/qa/host-association.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { runPlan } from '../../../dist/qa/walker.js';
import type { WalkerTimingDiagnostic } from '../../../dist/qa/walker.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';
import { nativeCapture } from './platform-presence-fixtures.ts';

const frame = { x: 10, y: 20, width: 100, height: 40 };
function fixture() {
  const nodes: NativeNode[] = [
    { ref: 'PRIVATE-app', type: 'Application' },
    {
      ref: 'PRIVATE-window',
      type: 'Window',
      parentIndex: 0,
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    { ref: 'PRIVATE-blocker', type: 'Other', parentIndex: 1, rect: frame },
    {
      ref: 'PRIVATE-associated',
      type: 'Other',
      identifier: 'PRIVATE-associated-id',
      parentIndex: 1,
      rect: frame,
    },
  ];
  const presence: NativePresence = {
    source: 'xcui-live',
    nodes: nodes.map((_, i) => ({ status: i === 3 ? 'observed' : 'unknown', labelSource: 'none' })),
  };
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      {
        testID: 'PRIVATE-input-0',
        nativeID: 'PRIVATE-native-id',
        role: null,
        roleSource: 'none',
        capabilities: { press: true, fill: true },
      },
      {
        testID: 'PRIVATE-input-1',
        role: 'textinput',
        roleSource: 'role',
        capabilities: { press: true, fill: true },
      },
      {
        testID: 'PRIVATE-hidden',
        hidden: true,
        role: null,
        roleSource: 'none',
        capabilities: { press: true, fill: true },
      },
      {
        testID: 'PRIVATE-associated-id',
        role: null,
        roleSource: 'none',
        capabilities: { press: true },
      },
      { role: null, roleSource: 'none', capabilities: {} },
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: Array.from({ length: 5 }, (_, hostIndex) => ({
        hostIndex,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: hostIndex < 2 ? 'RCTSinglelineTextInputView' : 'RCTView',
        rect: frame,
        text: { kind: 'none' },
      })),
    },
  };
  const screen = () =>
    join(nodes, [], 'app', { native: 'complete', react: 'complete' }, evidence, presence);
  return { nodes, evidence, presence, screen };
}

async function witness(f: ReturnType<typeof fixture>) {
  const associations = associateHosts(f.nodes, f.evidence, f.presence);
  const traces = new Map<number, HostAssociationDiagnostic>();
  assert.deepEqual(associateHosts(f.nodes, f.evidence, f.presence, traces), associations);
  const screen = f.screen();
  const publicBefore = JSON.stringify(screen);
  assert.doesNotMatch(
    publicBefore,
    /gapHosts|nativeIdentityCandidateCount|ancestorPath|frameMismatch/,
  );
  const projection = visibilityView(screen, true);
  assert.ok('elements' in projection);
  assert.equal(
    projection.unknown.some(({ element }) => element === screen.elements[2]),
    false,
    'a content-free plain container is not a contribution even under the screen-wide gap',
  );
  assert.ok((projection.capabilityGapContainers ?? 0) >= 1);
  assert.equal(projection.unassociatedReact, 0);
  assert.equal(
    projection.elements.length +
      projection.unknown.length +
      (projection.capabilityGapContainers ?? 0),
    screen.elements.slice(2).filter((element) => element.semantic?.visibility !== 'offscreen')
      .length,
  );
  assert.ok(
    projection.elements.includes(screen.elements[3]),
    'the proven associated control remains established',
  );
  for (const operation of ['press', 'fill'] as const) {
    const action = semanticActionView(screen, operation);
    assert.ok('refuse' in action);
    assert.equal(action.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  }
  const judge = () =>
    scriptedJudge((questions, _, state) => {
      assert.deepEqual(Object.keys(questions), ['visibility_1']);
      assert.deepEqual(Object.keys(state), ['front', 'assertionEvidence']);
      assert.equal(state.assertionEvidence.observed.length, projection.elements.length);
      assert.deepEqual(
        state.assertionEvidence.unknown.map(({ reason }) => reason),
        projection.unknown.map(({ reason }) => reason),
      );
      assert.equal(
        state.assertionEvidence.unknown.some(
          ({ description }: { description: string }) => description === 'Other',
        ),
        false,
      );
      assert.equal(state.assertionEvidence.unassociatedReact, 0);
      assert.deepEqual(state.assertionEvidence.qualifiedHeadings, []);
      assert.doesNotMatch(
        JSON.stringify({ questions, state }),
        /PRIVATE-(?:native-id|hidden|component|role|value|label|bounds|hash|coordinate)|gapHosts|ancestorPath|nativeIdentityCandidateCount|frameMismatch|111000|222000|12345|23456|34567|45678/,
      );
      return { visibility_1: { type: 'noul', noul: 0.99 } };
    });
  const baselineJudge = judge();
  const observedJudge = judge();
  const baseline = walker([screen], baselineJudge);
  const expected = await runPlan(
    parsePlan('1. Wait for an available control').blocks!,
    baseline.deps,
  );
  const w = walker([{ ...screen }], observedJudge);
  const events: WalkerTimingDiagnostic[] = [];
  w.deps.diagnostic = (event) => events.push(event);
  const result = await runPlan(parsePlan('1. Wait for an available control').blocks!, w.deps);
  assert.deepEqual(result, expected);
  assert.equal(result.verdict, 'PASS');
  assert.equal(baselineJudge.requests.length, 1);
  assert.equal(observedJudge.requests.length, 1);
  assert.deepEqual(w.actions, []);
  assert.equal(w.captures(), 1);
  assert.equal(JSON.stringify(screen), publicBefore);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|RCT|TextInput|hash|nativeID"|testID"/);
  assert.doesNotMatch(JSON.stringify(result), /gapHosts|identityCandidateCount|frameMismatch/);
  const blockers = events.filter((event) => event.visibilityBlocker);
  assert.equal(blockers.length, 0);
  assert.ok(projection.diagnostic);
  assert.doesNotMatch(
    JSON.stringify(projection.diagnostic),
    /PRIVATE-|RCT|TextInput|hash|nativeID"|testID"/,
  );
  return projection.diagnostic;
}

test('visibility diagnostics name only the two actual press/fill gap hosts while assertions can use established evidence', async () => {
  const f = fixture();
  assert.deepEqual([...associateHosts(f.nodes, f.evidence, f.presence).keys()], [3]);
  const diagnostic = await witness(f);
  assert.equal(diagnostic.ordinal, 2);
  assert.equal(diagnostic.pressGapCount, 2);
  assert.equal(diagnostic.fillGapCount, 2);
  const association = {
    identity: 'native-id-count',
    nativeIdentityCandidateCount: 0,
    compatibleCount: null,
    sameFrameCount: null,
    presenceProofCount: null,
    ancestorPath: 'self-anchor-missing',
    collisions: null,
  };
  assert.deepEqual(diagnostic.gapHosts, {
    total: 2,
    truncated: false,
    rows: [0, 1].map((hostOrdinal) => ({
      hostOrdinal,
      hostKind: 'input',
      capabilities: { press: true, fill: true },
      roleCategory: hostOrdinal === 0 ? 'none' : 'input',
      testIDPresent: true,
      nativeIDPresent: hostOrdinal === 0,
      hidden: false,
      rectStatus: 'positive',
      pressGap: true,
      fillGap: true,
      association,
    })),
  });
});

function addNative(
  f: ReturnType<typeof fixture>,
  hostOrdinal: number,
  patch: Partial<NativeNode> = {},
  observed = true,
) {
  f.nodes.push({
    ref: `PRIVATE-native-${f.nodes.length}`,
    type: 'Other',
    parentIndex: 1,
    identifier: f.evidence.hosts[hostOrdinal].testID,
    rect: f.evidence.typography!.nodes[hostOrdinal].rect ?? frame,
    ...patch,
  });
  f.presence.nodes.push({ status: observed ? 'observed' : 'unknown', labelSource: 'none' });
}

function frameMismatchFixture(nativeKind = 'TextField') {
  const f = fixture();
  f.nodes[1].rect = { x: 111000, y: 222000, width: 400000, height: 800000 };
  for (const node of f.nodes.slice(2))
    node.rect = { ...node.rect!, x: node.rect!.x + 111000, y: node.rect!.y + 222000 };
  for (const i of [0, 1]) {
    if (nativeKind === 'TextView')
      f.evidence.typography!.nodes[i].hostType = 'RCTMultilineTextInputView';
    f.evidence.typography!.nodes[i].rect = { x: 12345, y: 23456, width: 34567, height: 45678 };
    addNative(f, i, {
      type: nativeKind,
      rect: { x: 12345 + 111000 + 2, y: 23456 + 222000 - 3, width: 34567 - 4, height: 45678 + 5 },
    });
  }
  return f;
}

test('frame rejection emits only signed native-minus-translated-host deltas through join → resolve → walker', async () => {
  for (const nativeKind of ['TextField', 'SecureTextField', 'TextView']) {
    const diagnostic = await witness(frameMismatchFixture(nativeKind));
    assert.equal(diagnostic.pressGapCount, 2);
    assert.equal(diagnostic.fillGapCount, 2);
    for (const row of diagnostic.gapHosts!.rows) {
      assert.equal(row.association!.identity, 'frame-mismatch');
      assert.equal(row.association!.compatibleCount, 1);
      assert.equal(row.association!.sameFrameCount, 0);
      assert.deepEqual(row.association!.frameMismatch, {
        nativeKind,
        hostFinite: true,
        nativeFinite: true,
        windowOriginFinite: true,
        delta: { x: 2, y: -3, width: -4, height: 5 },
      });
    }
    assert.doesNotMatch(
      JSON.stringify(diagnostic),
      /111000|222000|12345|23456|34567|45678|PRIVATE-/,
    );
  }
});

test('frame diagnostics preserve fractional differences and use a closed non-input native category', async () => {
  const f = frameMismatchFixture('Other');
  for (const i of [0, 1]) {
    f.evidence.typography!.nodes[i].hostType = 'RCTView';
    f.nodes[4 + i].rect = {
      x: 12345 + 111000 + 1 / 1024,
      y: 23456 + 222000,
      width: 34567,
      height: 45678,
    };
  }
  const diagnostic = await witness(f);
  assert.deepEqual(diagnostic.gapHosts!.rows[0].association!.frameMismatch, {
    nativeKind: 'other',
    hostFinite: true,
    nativeFinite: true,
    windowOriginFinite: true,
    delta: { x: 1 / 1024, y: 0, width: 0, height: 0 },
  });
  const unknown = frameMismatchFixture('PRIVATE-native-kind');
  const refused = await witness(unknown);
  assert.ok(refused.gapHosts!.rows.every((row) => row.association!.frameMismatch === undefined));
});

test('missing, nonfinite and malformed frame components yield null deltas without serializing or coercing them', async () => {
  for (const side of ['host', 'native'] as const) {
    for (const axis of ['x', 'y', 'width', 'height'] as const) {
      for (const invalid of [NaN, Infinity, -Infinity, undefined, '123', 'PRIVATE-coordinate']) {
        const f = frameMismatchFixture();
        const rect = side === 'host' ? f.evidence.typography!.nodes[0].rect! : f.nodes[4].rect!;
        Object.assign(rect, { [axis]: invalid, extra: 'PRIVATE-bounds', hash: 'PRIVATE-hash' });
        const diagnostic = await witness(f);
        const mismatch = diagnostic.gapHosts!.rows[0].association!.frameMismatch!;
        assert.equal(mismatch.hostFinite, side !== 'host');
        assert.equal(mismatch.nativeFinite, side !== 'native');
        assert.equal(mismatch.windowOriginFinite, true);
        assert.deepEqual(mismatch.delta, { x: 2, y: -3, width: -4, height: 5, [axis]: null });
        assert.doesNotMatch(
          JSON.stringify(diagnostic),
          /NaN|Infinity|PRIVATE-|111000|222000|12345|23456|34567|45678/,
        );
      }
    }
    const f = frameMismatchFixture();
    if (side === 'host') delete f.evidence.typography!.nodes[0].rect;
    else delete f.nodes[4].rect;
    const mismatch = (await witness(f)).gapHosts!.rows[0].association!.frameMismatch!;
    assert.equal(mismatch.hostFinite, side !== 'host');
    assert.equal(mismatch.nativeFinite, side !== 'native');
    assert.deepEqual(mismatch.delta, { x: null, y: null, width: null, height: null });
  }
  const f = frameMismatchFixture();
  f.evidence.typography!.nodes[0].rect!.x = Number.MAX_VALUE;
  f.nodes[4].rect!.x = -Number.MAX_VALUE;
  const mismatch = (await witness(f)).gapHosts!.rows[0].association!.frameMismatch!;
  assert.equal(mismatch.hostFinite, true);
  assert.equal(mismatch.nativeFinite, true);
  assert.equal(
    mismatch.delta.x,
    null,
    'finite operands do not make an overflowed difference finite',
  );
});

test('frame diagnostics do not bypass existing host or native capture validation', () => {
  for (const axis of ['x', 'y', 'width', 'height'] as const) {
    for (const invalid of [NaN, Infinity, -Infinity, undefined, '123', 'PRIVATE-coordinate']) {
      const f = frameMismatchFixture();
      assert.ok(validateReactHostEvidence(f.evidence));
      Object.assign(f.evidence.typography!.nodes[0].rect!, { [axis]: invalid });
      const rejected = validateReactHostEvidence(f.evidence);
      assert.equal(rejected, undefined);
      const traces = new Map<number, HostAssociationDiagnostic>();
      assert.equal(associateHosts(f.nodes, rejected, f.presence, traces).size, 0);
      assert.equal(traces.size, 0);

      const capture = nativeCapture();
      const validate = () =>
        validateNativePresence(
          capture.presenceCapture,
          capture.nodes,
          capture.snapshotGeneration,
          'com.test',
          20_000,
        );
      assert.ok(validate());
      Object.assign(capture.nodes[1].rect, { [axis]: invalid });
      assert.equal(validate(), undefined);
    }
  }
});

test('frame diagnostic construction failure does not change the rejection or retain exception content', () => {
  const f = frameMismatchFixture();
  Object.defineProperty(f.evidence.typography!.nodes[0].rect!, 'height', {
    get() {
      throw new Error('PRIVATE-frame-diagnostic-error');
    },
  });
  const baseline = associateHosts(f.nodes, f.evidence, f.presence);
  const traces = new Map<number, HostAssociationDiagnostic>();
  assert.deepEqual(associateHosts(f.nodes, f.evidence, f.presence, traces), baseline);
  assert.equal(traces.get(0)!.identity, 'frame-mismatch');
  assert.equal(traces.get(0)!.sameFrameCount, 0);
  assert.equal(traces.get(0)!.frameMismatch, undefined);
  assert.doesNotMatch(JSON.stringify([...traces]), /PRIVATE-/);
});

test('gap rows report the actual short-circuit identity, compatibility, frame and presence decisions', async () => {
  const cases = [
    ['missing', 'native-id-count', [0, null, null, null]],
    ['ambiguous', 'native-id-count', [2, null, null, null]],
    ['host-duplicate', 'host-id-ambiguous', [null, null, null, null]],
    ['native-id-only', 'no-test-id', [null, null, null, null]],
    ['outside-window', 'outside-window', [1, null, null, null]],
    ['incompatible', 'incompatible-type', [1, 0, null, null]],
    ['frame', 'frame-mismatch', [1, 1, 0, null]],
    ['unknown-presence', 'matched', [1, 1, 1, 0]],
  ] as const;
  for (const [mode, identity, counts] of cases) {
    const f = fixture();
    if (mode !== 'incompatible') f.evidence.typography!.nodes[0].hostType = 'RCTView';
    if (mode === 'native-id-only') delete f.evidence.hosts[0].testID;
    else if (mode === 'host-duplicate') f.evidence.hosts[4].testID = f.evidence.hosts[0].testID;
    else if (mode !== 'missing') {
      addNative(
        f,
        0,
        mode === 'frame'
          ? { rect: { ...frame, x: frame.x + 1 } }
          : mode === 'outside-window'
            ? { parentIndex: 0 }
            : {},
        mode !== 'unknown-presence',
      );
      if (mode === 'ambiguous') addNative(f, 0);
    }
    const row = (await witness(f)).gapHosts!.rows[0];
    assert.equal(row.hostOrdinal, 0);
    assert.equal(row.association!.identity, identity, mode);
    const a = row.association!;
    assert.deepEqual(
      [a.nativeIdentityCandidateCount, a.compatibleCount, a.sameFrameCount, a.presenceProofCount],
      counts,
      mode,
    );
    assert.equal(a.ancestorPath, mode === 'native-id-only' ? 'valid' : 'self-anchor-missing', mode);
    assert.equal(a.collisions, null);
    assert.equal(a.frameMismatch !== undefined, mode === 'frame');
  }
});

test('ancestor diagnostics reuse the real structural and observed-or-offscreen anchor path', async () => {
  for (const mode of ['missing-ancestor', 'offscreen', 'disconnected']) {
    const f = fixture();
    const hosts = f.evidence.typography!.nodes;
    hosts[0].hostType = hosts[1].hostType = 'RCTView';
    hosts[1].parentHostIndex = 0;
    if (mode === 'disconnected') {
      hosts[0].rect = { x: 0, y: 200, width: 100, height: 40 };
      addNative(f, 0);
    }
    if (mode === 'offscreen') hosts[1].rect = { ...frame, y: 900 };
    addNative(f, 1, {}, mode !== 'offscreen');
    const row = (await witness(f)).gapHosts!.rows.find((row) => row.hostOrdinal === 1)!;
    assert.deepEqual(
      row.association,
      {
        identity: 'matched',
        nativeIdentityCandidateCount: 1,
        compatibleCount: 1,
        sameFrameCount: 1,
        presenceProofCount: 1,
        ancestorPath:
          mode === 'disconnected' ? 'ancestor-path-mismatch' : 'ancestor-structure-missing',
        collisions: null,
      },
      mode,
    );
  }
});

test('rect and host/role categories are closed facts, including zero, unknown and unfamiliar host names', async () => {
  for (const mode of ['zero', 'missing', 'nonfinite', 'unknown-host']) {
    const f = fixture();
    const host = f.evidence.typography!.nodes[0];
    host.hostType = mode === 'unknown-host' ? 'PRIVATE-component-name' : 'RCTView';
    if (mode === 'zero') host.rect = { ...frame, height: 0 };
    if (mode === 'missing') delete host.rect;
    if (mode === 'nonfinite') host.rect = { ...frame, x: NaN };
    f.evidence.hosts[0].role = 'PRIVATE-role';
    Object.assign(host, { hash: 'PRIVATE-hash', value: 'PRIVATE-value', label: 'PRIVATE-label' });
    const row = (await witness(f)).gapHosts!.rows[0];
    assert.equal(
      row.rectStatus,
      mode === 'zero' ? 'zero' : mode === 'unknown-host' ? 'positive' : 'unknown',
    );
    assert.equal(row.hostKind, mode === 'unknown-host' ? 'unknown' : 'view');
    assert.equal(row.roleCategory, 'noninteractive');
    assert.equal(row.capabilities.press, true);
    assert.equal(row.pressGap, true);
  }
});

test('gap dependencies deduplicate both-operation hosts and cap at eight without changing complete gap counts', async () => {
  const f = fixture();
  f.evidence.hosts[0].capabilities = { press: true };
  f.evidence.hosts[1].capabilities = { fill: true };
  f.evidence.hosts[1].role = null;
  for (let i = 0; i < 9; i++) {
    const hostIndex = f.evidence.hosts.length;
    f.evidence.hosts.push({
      testID: `PRIVATE-extra-${i}`,
      role: null,
      roleSource: 'none',
      capabilities: { press: true, fill: true },
    });
    f.evidence.typography!.nodes.push({
      hostIndex,
      parentHostIndex: null,
      rootIndex: 0,
      hostType: 'PRIVATE-component',
      rect: frame,
      text: { kind: 'none' },
    });
  }
  const diagnostic = await witness(f);
  assert.equal(diagnostic.pressGapCount, 10);
  assert.equal(diagnostic.fillGapCount, 10);
  const dependencies = diagnostic.gapHosts!;
  assert.equal(dependencies.total, 11);
  assert.equal(dependencies.truncated, true);
  assert.deepEqual(
    dependencies.rows.map((row) => row.hostOrdinal),
    [0, 1, 5, 6, 7, 8, 9, 10],
  );
  assert.deepEqual(
    dependencies.rows.map((row) => [row.pressGap, row.fillGap]),
    [[true, false], [false, true], ...Array.from({ length: 6 }, () => [true, true])],
  );
});

test('association diagnostics preserve default maps and isolate a throwing recorder, including collision checks', () => {
  const f = fixture();
  const expected = associateHosts(f.nodes, f.evidence, f.presence);
  const diagnostics = new Map<number, HostAssociationDiagnostic>();
  assert.deepEqual(associateHosts(f.nodes, f.evidence, f.presence, diagnostics), expected);
  assert.equal(diagnostics.get(3)!.collisions, 0);
  assert.equal(diagnostics.get(3)!.ancestorPath, 'valid');
  assert.equal(diagnostics.get(3)!.frameMismatch, undefined);
  assert.equal(diagnostics.get(0)!.collisions, null);
  let writes = 0;
  diagnostics.set = () => {
    writes++;
    throw new Error('PRIVATE-recorder-error');
  };
  assert.deepEqual(associateHosts(f.nodes, f.evidence, f.presence, diagnostics), expected);
  assert.ok(writes > 0);
});

test('gap-host dependencies remain private when a pending heading wait is batched with a check', async () => {
  for (const f of [fixture(), frameMismatchFixture()]) {
    const screen = f.screen();
    const projection = visibilityView(screen, true);
    assert.ok('elements' in projection);
    assert.equal(projection.diagnostic?.gapHosts?.rows.length, 2);
    const judge = scriptedJudge((questions, _index, state) => {
      assert.deepEqual(Object.keys(questions), ['check_1']);
      assert.deepEqual(state, {
        front: 'app',
        assertionEvidence: {
          observed: [
            'Other [testID PRIVATE-associated-id] (native accessibility name; platform-observed presence)',
            ...(f.nodes.length === 6
              ? [0, 1].map(
                  (i) =>
                    `Input [testID PRIVATE-input-${i}] (native accessibility name; platform-observed presence)`,
                )
              : []),
          ],
          unknown: [],
          unassociatedReact: 0,
          qualifiedHeadings: [],
        },
      });
      assert.doesNotMatch(
        JSON.stringify({ questions, state }),
        /PRIVATE-native-id|gapHosts|ancestorPath|nativeIdentityCandidateCount|frameMismatch|111000|222000|12345|23456|34567|45678/,
      );
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    const result = await decideScreen(
      screen,
      judge,
      { kind: 'check', text: 'The app is ready', literal: false, line: 1 },
      { kind: 'wait', target: { phrase: 'the heading' }, line: 2 },
      [],
      undefined,
      undefined,
      true,
    );
    assert.equal(result.check, 'pass');
    assert.deepEqual(result.visibility, { verdict: 'pending' });
    assert.doesNotMatch(JSON.stringify(result), /gapHosts|diagnostic/);
    assert.equal(judge.requests.length, 1);
  }
});

test('a refused phrase step names its blocking association stage, including the nearest named ancestor', async () => {
  const f = fixture();
  const hosts = f.evidence.typography!.nodes;
  hosts[0].hostType = hosts[1].hostType = 'RCTView';
  hosts[1].parentHostIndex = 0;
  addNative(f, 0, { rect: { ...frame, x: frame.x + 1 } });
  addNative(f, 1);
  const screen = f.screen();
  const action = semanticActionView(screen, 'press');
  assert.ok('refuse' in action);
  assert.equal(action.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  const rows = action.diagnostic?.gapHosts?.rows;
  assert.deepEqual(
    rows?.map((row) => [row.hostOrdinal, row.association?.identity, row.association?.ancestorPath]),
    [
      [0, 'frame-mismatch', 'self-anchor-missing'],
      [1, 'matched', 'ancestor-structure-missing'],
    ],
  );
  assert.equal(rows![0].ancestorAssociation, undefined);
  assert.equal(rows![1].ancestorAssociation?.identity, 'frame-mismatch');
  assert.equal(rows![1].ancestorAssociation?.sameFrameCount, 0);
  assert.deepEqual(rows![1].ancestorAssociation?.frameMismatch?.delta, {
    x: 1,
    y: 0,
    width: 0,
    height: 0,
  });

  const plan = parsePlan('1. Tap the save control').blocks!;
  const judge = () => scriptedJudge(() => assert.fail('a projection refusal reaches no judgment'));
  const baseline = await runPlan(plan, walker([screen], judge()).deps);
  const w = walker([{ ...screen }], judge());
  const events: WalkerTimingDiagnostic[] = [];
  w.deps.diagnostic = (event) => events.push(event);
  const result = await runPlan(plan, w.deps);
  assert.deepEqual(result, baseline);
  assert.equal(result.verdict, 'FAIL');
  assert.deepEqual(w.actions, []);
  const refused = events.filter(
    (event) => event.stage === 'decision' && event.code === 'SCREEN_EVIDENCE_INCOMPLETE',
  );
  assert.equal(refused.length, 1);
  assert.equal(refused[0].line, 1);
  assert.deepEqual(refused[0].visibilityBlocker, action.diagnostic);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE-|RCT|TextInput|hash|nativeID"|testID"/);
  assert.doesNotMatch(JSON.stringify(result), /gapHosts|ancestorAssociation|frameMismatch/);
});
