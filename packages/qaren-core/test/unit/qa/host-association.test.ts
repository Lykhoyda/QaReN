import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { decideScreen, prepareTarget } from '../../../dist/qa/resolve.js';
import { inputValues, isPossibleInput, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  join,
  semanticActionView,
  validateReactHostEvidence,
  visibilityView,
} from '../../../dist/qa/screen.js';
import { validateNativePresence } from '../../../dist/qa/native-presence.js';
import { associateHosts } from '../../../dist/qa/host-association.js';
import { dismissCandidate } from '../../../dist/qa/recover.js';
import type { DigestEntry, ReactHostEvidence } from '../../../dist/qa/screen.js';
import {
  ANDROID_SCALE,
  androidPresenceCapture,
  nativeCapture,
} from './platform-presence-fixtures.ts';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { choice, scriptedJudge, walker } from './judgment-fixtures.ts';

function fixture() {
  const native = nativeCapture();
  native.nodes = [
    native.nodes[0],
    {
      ...native.nodes[1],
      type: 'Window',
      identifier: undefined,
      label: '',
      rect: { x: 20, y: 40, width: 400, height: 800 },
    },
    {
      ...native.nodes[1],
      ref: '@e2',
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      rect: { x: 30, y: 60, width: 100, height: 40 },
      presence: { ...native.nodes[1].presence, nodeIndex: 2 },
    },
  ];
  native.snapshotVerdict.nodeCount = 3;
  const hostEvidence: ReactHostEvidence = {
    complete: true,
    hosts: [{ testID: 'save', role: null, roleSource: 'none', capabilities: { press: true } }],
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: { x: 10, y: 20, width: 100, height: 40 },
          text: { kind: 'none' },
        },
      ],
    },
  };
  const interactive: DigestEntry[] = [];
  const capture = () =>
    captureScreen({
      appId: 'com.test',
      native: async () => native,
      react: async () => ({
        interactive,
        hostEvidence,
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    });
  return { native, hostEvidence, interactive, capture };
}

function twoWindowFixture() {
  const f = fixture();
  f.native.nodes[2].label = 'Skip';
  f.native.nodes.push({
    ...structuredClone(f.native.nodes[1]),
    index: 3,
    ref: '@e3',
    presence: { ...f.native.nodes[1].presence, nodeIndex: 3 },
  });
  f.native.snapshotVerdict.nodeCount = f.native.nodes.length;
  return f;
}

test('a role-less decline in its proven window survives a second window and recovers once', async () => {
  const f = twoWindowFixture();
  const screen = await f.capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.reactHostEvidence!.hosts[0].role, null);
  assert.deepEqual(dismissCandidate(screen, [{ quoted: 'Destination', phrase: 'Destination' }]), {
    label: 'Skip',
  });
  const w = walker(
    [],
    scriptedJudge(() => assert.fail('literal recovery is model-free')),
  );
  w.deps.captureScreen = f.capture;
  let taps = 0;
  w.deps.press = async (ref, context) => {
    assert.equal(ref, '@e2');
    context.authorize();
    taps++;
    f.native.nodes[2].label = 'Destination';
    return { ok: true, executed: true, proven: true };
  };
  w.deps.hideDevMenu = async () => assert.fail('no developer overlay');
  const result = await runPlan(parsePlan('✓ "Destination"').blocks!, w.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.recoveries, 1);
  assert.equal(taps, 1);
});

test('measured exact host identity admits positive press without inventing a native role', async () => {
  const screen = await fixture().capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(
    screen.elements[2].semantic?.fill,
    'unsupported',
    'a press handler offers no text entry',
  );
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.reactHostEvidence!.hosts[0].role, null);
  assert.deepEqual(semanticActionView(screen, 'press'), { elements: [screen.elements[2]] });
  assert.deepEqual(visibilityView(screen), {
    elements: [screen.elements[2]],
    unknown: [],
    unassociatedReact: 0,
  });
});

test('an exact structural match below the window associates without presence; an unobserved one on screen does not', async () => {
  const offscreen = fixture();
  const host = offscreen.hostEvidence.typography!.nodes[0];
  host.rect = { ...host.rect!, y: 900 };
  offscreen.native.nodes[2].rect = { ...offscreen.native.nodes[2].rect, y: 940 };
  const unknown = { ...offscreen.native.nodes[2].presence, status: 'unknown' };
  delete (unknown as { observedUptimeMs?: number }).observedUptimeMs;
  offscreen.native.nodes[2].presence = unknown;
  const below = await offscreen.capture();
  assert.equal(below.elements[2].semantic?.visibility, 'offscreen');
  assert.equal(below.elements[2].semantic?.press, 'supported');
  assert.equal(below.pressEvidenceGap, undefined);
  assert.equal(below.pressGapCount, 0);
  assert.equal(below.fillGapCount, 0);
  assert.deepEqual(semanticActionView(below, 'press'), { elements: [below.elements[2]] });
  assert.deepEqual(visibilityView(below), { elements: [], unknown: [], unassociatedReact: 0 });

  const onScreen = fixture();
  onScreen.native.nodes[2].presence = unknown;
  onScreen.hostEvidence.hosts[0].capabilities.fill = true;
  const shown = await onScreen.capture();
  assert.equal(shown.elements[2].semantic?.visibility, 'unknown');
  assert.equal(shown.pressEvidenceGap, '1 interactive React host unassociated');
  assert.equal(shown.pressGapCount, 1);
  assert.equal(shown.fillGapCount, 1);
});

test('an iOS row overlapping its list with its centre outside anchors as a scroll hint without a press gap', async () => {
  const f = fixture();
  const row = f.native.nodes[2];
  row.index = 3;
  row.ref = '@e3';
  row.parentIndex = 2;
  row.depth = 3;
  row.rect.y = 481;
  row.hittable = false;
  row.presence = { ...f.native.nodes[0].presence, nodeIndex: 3 };
  f.native.nodes.splice(2, 0, {
    ...f.native.nodes[1],
    ref: '@e2',
    index: 2,
    parentIndex: 1,
    depth: 2,
    type: 'ScrollView',
    rect: { x: 20, y: 100, width: 400, height: 400 },
    presence: { ...f.native.nodes[1].presence, nodeIndex: 2 },
  });
  f.native.snapshotVerdict.nodeCount = 4;
  f.hostEvidence.typography!.nodes[0].rect!.y = 441;
  const screen = await f.capture();
  const element = screen.elements[3];
  assert.equal(element.semantic?.visibility, 'offscreen');
  assert.equal(element.semantic?.press, 'supported');
  assert.equal(element.hittable, false);
  assert.equal(screen.pressEvidenceGap, undefined);
  assert.equal(screen.pressGapCount, 0);
  assert.deepEqual(semanticActionView(screen, 'press'), { elements: [element] });
  assert.deepEqual(visibilityView(screen), { elements: [], unknown: [], unassociatedReact: 0 });
  assert.deepEqual(prepareTarget({ kind: 'press', target: { phrase: 'save' } }, screen), {
    scroll: 'down',
    element,
    origin: 'named-offscreen',
  });

  row.rect.y = 479;
  f.hostEvidence.typography!.nodes[0].rect!.y = 439;
  const centreInside = await f.capture();
  assert.equal(centreInside.elements[3].semantic?.visibility, 'unknown');
  assert.equal(centreInside.pressGapCount, 1);
  assert.equal(semanticActionView(centreInside, 'press').refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('associated disabled and read-only facts block both operations without erasing positive capabilities', async () => {
  for (const state of ['disabled', 'readOnly'] as const) {
    const f = fixture();
    f.hostEvidence.hosts[0][state] = true;
    f.hostEvidence.hosts[0].capabilities.fill = true;
    const screen = await f.capture();
    assert.equal(screen.elements[2].semantic?.press, 'supported');
    assert.equal(screen.elements[2].semantic?.fill, 'supported');
    assert.deepEqual(semanticActionView(screen, 'press'), { elements: [] }, state);
    assert.deepEqual(semanticActionView(screen, 'fill'), { elements: [] }, state);
    assert.deepEqual(visibilityView(screen), {
      elements: [screen.elements[2]],
      unknown: [],
      unassociatedReact: 0,
    });
  }
});

test('presence mode never borrows a legacy digest role or capability, including invalid presence', async () => {
  const f = fixture();
  f.interactive.push({ testID: 'save', role: 'button', capabilities: { press: true, fill: true } });
  f.hostEvidence.hosts[0].capabilities = {};
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  assert.ok('refuse' in semanticActionView(screen, 'press'));
  for (const presence of [undefined, 'unknown'] as const) {
    const invalid = join(
      f.native.nodes,
      f.interactive,
      'app',
      { native: 'complete', react: 'complete' },
      f.hostEvidence,
      presence,
    );
    assert.equal(invalid.elements[2].kind, 'other');
    assert.equal(invalid.elements[2].semantic?.press, 'unknown');
    assert.ok('refuse' in semanticActionView(invalid, 'press'));
  }
  const legacyNodes = f.native.nodes.map(({ presence: _, ...node }) => node);
  const legacy = join(legacyNodes, f.interactive);
  assert.equal(legacy.elements[2].kind, 'button');
  assert.equal(legacy.elements[2].semantic?.press, 'supported');
});

test('host facts do not depend on which legacy label entry matched first', async () => {
  const f = fixture();
  f.interactive.push(
    { role: 'text', label: 'Save', disabled: true },
    { role: 'button', testID: 'save', capabilities: { press: false, fill: false } },
  );
  const screen = await f.capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(screen.elements[2].semantic?.disabled, false);
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(
    screen.semanticUnassociatedReact,
    1,
    'only the anonymous digest observation remains unassociated',
  );
  assert.equal(
    screen.elements.length,
    3,
    'a proven exact native identity is not duplicated as an offscreen digest ghost',
  );
  assert.ok('refuse' in semanticActionView(screen, 'press'), 'unknown competitors remain');
});

const unproven: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'missing host capture',
    (f) => {
      f.hostEvidence.complete = false;
    },
  ],
  [
    'missing measurements',
    (f) => {
      delete f.hostEvidence.typography;
    },
  ],
  [
    'incomplete measurements',
    (f) => {
      f.hostEvidence.typography!.complete = false;
    },
  ],
  [
    'missing frame',
    (f) => {
      delete f.hostEvidence.typography!.nodes[0].rect;
    },
  ],
  [
    'different frame',
    (f) => {
      f.hostEvidence.typography!.nodes[0].rect!.x++;
    },
  ],
  [
    'nativeID only',
    (f) => {
      f.hostEvidence.hosts[0].nativeID = 'save';
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'no host ID',
    (f) => {
      delete f.hostEvidence.hosts[0].testID;
    },
  ],
  [
    'nonexact ID',
    (f) => {
      f.hostEvidence.hosts[0].testID = ' save ';
    },
  ],
  [
    'no native ID',
    (f) => {
      delete f.native.nodes[2].identifier;
    },
  ],
  [
    'incompatible host type',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = 'RCTText';
    },
  ],
  [
    'input host with a generic native view',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = 'RCTSinglelineTextInputView';
    },
  ],
  [
    'unknown host type',
    (f) => {
      f.hostEvidence.typography!.nodes[0].hostType = null;
    },
  ],
  [
    'no window',
    (f) => {
      f.native.nodes[1].type = 'Other';
    },
  ],
  [
    'outside window',
    (f) => {
      f.native.nodes[2].parentIndex = 0;
      f.native.nodes[2].depth = 1;
    },
  ],
  [
    'unknown presence',
    (f) => {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    },
  ],
  [
    'invalid presence generation',
    (f) => {
      f.native.nodes[2].presence.generation++;
    },
  ],
  [
    'different app',
    (f) => {
      f.native.presenceCapture.appId = 'com.other';
    },
  ],
  [
    'duplicate host ID',
    (f) => {
      f.hostEvidence.hosts.push(structuredClone(f.hostEvidence.hosts[0]));
      f.hostEvidence.typography!.nodes.push({
        ...structuredClone(f.hostEvidence.typography!.nodes[0]),
        hostIndex: 1,
      });
    },
  ],
  [
    'duplicate native ID',
    (f) => {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[2]),
        index: 3,
        ref: '@e3',
        presence: { ...f.native.nodes[2].presence, nodeIndex: 3 },
      });
      f.native.snapshotVerdict.nodeCount++;
    },
  ],
  [
    'nested window ownership',
    (f) => {
      const control = f.native.nodes[2];
      f.native.nodes[2] = {
        ...structuredClone(f.native.nodes[1]),
        index: 2,
        ref: '@e2',
        parentIndex: 1,
        depth: 2,
        presence: { ...f.native.nodes[1].presence, nodeIndex: 2 },
      };
      f.native.nodes.push({
        ...control,
        index: 3,
        ref: '@e3',
        parentIndex: 2,
        depth: 3,
        presence: { ...control.presence, nodeIndex: 3 },
      });
      f.native.snapshotVerdict.nodeCount++;
    },
  ],
];

for (const [name, weaken] of unproven) {
  test(`unproven host capabilities and safety facts are not transferred: ${name}`, async () => {
    const f = fixture();
    f.hostEvidence.hosts[0].capabilities.fill = true;
    f.hostEvidence.hosts[0].disabled = true;
    f.hostEvidence.hosts[0].readOnly = true;
    f.interactive.push({
      testID: 'save',
      role: 'button',
      disabled: true,
      capabilities: { press: true, fill: true },
    });
    weaken(f);
    const screen = await f.capture();
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.disabled, false);
    const judge = scriptedJudge(() =>
      assert.fail('unproven capabilities cannot authorize a choice'),
    );
    const w = walker([screen], judge);
    assert.equal(
      (await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps)).verdict,
      'FAIL',
    );
    assert.deepEqual(w.actions, []);
  });
}

test('named host ancestors need their own structural match, not native nesting; only the host needs presence', async () => {
  for (const variant of ['proven', 'frame', 'unknown-presence', 'missing-ID', 'disconnected']) {
    const f = fixture();
    const control = f.native.nodes[2];
    f.native.nodes[2] = {
      ...control,
      identifier: 'panel',
      label: '',
      rect: { x: 20, y: 40, width: 300, height: 300 },
    };
    f.native.nodes.push({
      ...control,
      ref: '@e3',
      index: 3,
      parentIndex: 2,
      depth: 3,
      presence: { ...control.presence, nodeIndex: 3 },
    });
    f.native.snapshotVerdict.nodeCount++;
    f.hostEvidence.hosts.push({
      testID: 'panel',
      role: null,
      roleSource: 'none',
      capabilities: {},
    });
    f.hostEvidence.typography!.nodes[0].parentHostIndex = 1;
    f.hostEvidence.typography!.nodes.push({
      hostIndex: 1,
      parentHostIndex: null,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: { x: 0, y: 0, width: 300, height: 300 },
      text: { kind: 'none' },
    });
    if (variant === 'frame') f.hostEvidence.typography!.nodes[1].rect!.x++;
    if (variant === 'unknown-presence') {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    }
    if (variant === 'missing-ID') f.hostEvidence.hosts[1].testID = 'missing-panel';
    if (variant === 'disconnected') {
      f.native.nodes[3].parentIndex = 1;
      f.native.nodes[3].depth = 2;
    }
    const screen = await f.capture();
    assert.equal(
      screen.elements[3].semantic?.press,
      ['proven', 'unknown-presence', 'disconnected'].includes(variant) ? 'supported' : 'unknown',
      variant,
    );
    assert.equal(screen.elements.length, 4);
    if (['proven', 'unknown-presence', 'disconnected'].includes(variant))
      assert.deepEqual(
        semanticActionView(screen, 'press'),
        { elements: [screen.elements[3]] },
        'with every interactive host accounted for, the handler-less panel is not pressable',
      );
    else
      assert.ok(
        'refuse' in semanticActionView(screen, 'press'),
        `${variant}: an unassociated handler keeps the generic ancestor an unknown competitor`,
      );
  }
});

test('real measured producer press reaches the walker without a role; an accounted host without a handler is not pressable', async () => {
  for (const mode of ['press', 'none', 'disabled', 'readonly']) {
    const f = fixture();
    const fiber = buildFiber({
      hostType: 'RCTView',
      props: {
        testID: 'save',
        ...(mode === 'none' ? {} : { onPress() {} }),
        ...(mode === 'disabled' ? { disabled: true } : {}),
        ...(mode === 'readonly' ? { readOnly: true } : {}),
      },
      stateNode: {
        measureInWindow(cb) {
          cb(10, 20, 100, 40);
        },
      },
    });
    fiber.tag = 5;
    const sandbox = createSandbox({ fiberRoot: fiber });
    const produced = JSON.parse(
      await vm.runInContext(
        '__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true, typographyEvidence: true })',
        sandbox,
      ),
    );
    const screen = await captureScreen({
      appId: 'com.test',
      native: async () => f.native,
      react: async () => produced,
    });
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unsupported');
    assert.equal(screen.elements[2].semantic?.press, mode === 'none' ? 'unsupported' : 'supported');
    const judge = scriptedJudge((questions) => {
      assert.equal(mode, 'press', 'blocked controls never reach a model');
      return Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [id, choice(question)]),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps);
    assert.equal(result.verdict, mode === 'press' ? 'PASS' : 'FAIL', result.failure?.seen);
    assert.deepEqual(w.actions, mode === 'press' ? ['press @e2'] : []);
  }
});

test('generic and text views leave the choice only while every interactive host is accounted for', async () => {
  for (const type of ['Other', 'StaticText']) {
    for (const stray of [false, true]) {
      const f = fixture();
      f.native.nodes.push({
        ...f.native.nodes[2],
        ref: '@e3',
        index: 3,
        identifier: undefined,
        type,
        label: 'Other contribution',
        presence: { ...f.native.nodes[2].presence, nodeIndex: 3 },
      });
      f.native.snapshotVerdict.nodeCount++;
      if (stray) {
        f.hostEvidence.hosts.push({
          role: null,
          roleSource: 'none',
          capabilities: { press: true },
        });
        f.hostEvidence.typography!.nodes.push({
          hostIndex: f.hostEvidence.hosts.length - 1,
          parentHostIndex: null,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: { x: 0, y: 500, width: 40, height: 40 },
          text: { kind: 'none' },
        });
      }
      const screen = await f.capture();
      assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' }, type);
      assert.equal(screen.elements.length, 4);
      assert.equal(screen.elements[3].semantic?.press, stray ? 'unknown' : 'unsupported', type);
      if (stray) {
        const refused = semanticActionView(screen, 'press');
        assert.ok(
          'refuse' in refused,
          `${type}: an unassociated handler could be this view, so it is never removed`,
        );
        assert.match(refused.reason, /; 1 interactive React host unassociated\)$/);
      } else
        assert.deepEqual(semanticActionView(screen, 'press'), { elements: [screen.elements[2]] });
    }
  }
});

test('an admitted positive fill fact supports fill without inferring an input kind', async () => {
  const f = fixture();
  f.hostEvidence.hosts[0].capabilities = { fill: true };
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(
    screen.elements[2].semantic?.press,
    'unsupported',
    'fill evidence alone opens no press',
  );
  assert.deepEqual(semanticActionView(screen, 'fill'), { elements: [screen.elements[2]] });
});

test('all measured host controls count toward the unchanged 30-choice limit', async () => {
  for (const count of [30, 31]) {
    const f = fixture();
    for (let i = 1; i < count; i++) {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[2]),
        ref: `@e${i + 2}`,
        index: i + 2,
        identifier: `save-${i}`,
        presence: { ...f.native.nodes[2].presence, nodeIndex: i + 2 },
      });
      f.hostEvidence.hosts.push({
        ...structuredClone(f.hostEvidence.hosts[0]),
        testID: `save-${i}`,
      });
      f.hostEvidence.typography!.nodes.push({
        ...structuredClone(f.hostEvidence.typography!.nodes[0]),
        hostIndex: i,
      });
    }
    f.native.snapshotVerdict.nodeCount = f.native.nodes.length;
    const screen = await f.capture();
    assert.equal(screen.elements.length, count + 2);
    const judge = scriptedJudge((questions) => {
      assert.equal(count, 30);
      return Object.fromEntries(
        Object.entries(questions).map(([id, question]) => {
          assert.equal(Object.keys(question.criteria!).length, 31);
          return [id, choice(question)];
        }),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('1. Tap the save control').blocks!, w.deps);
    assert.equal(result.verdict, count === 30 ? 'PASS' : 'FAIL', result.failure?.seen);
    if (count === 31) assert.match(result.failure!.seen, /CANDIDATE_LIMIT/);
    assert.deepEqual(w.actions, count === 30 ? ['press @e2'] : []);
  }
});

function possibleInputFixture(anonymousLabelFirst = false, onChangeOnly = false) {
  const f = fixture();
  const secret = 'prefilled-private-credential';
  const input = f.native.nodes[2];
  input.identifier = 'email';
  input.label = 'Email';
  input.value = secret;
  f.native.nodes.push({
    ...input,
    ref: '@e3',
    index: 3,
    identifier: undefined,
    type: 'StaticText',
    label: `Echo: ${secret}`,
    value: undefined,
    presence: { ...input.presence, nodeIndex: 3 },
  });
  f.native.snapshotVerdict.nodeCount++;
  const sandbox = createSandbox({
    fiberRoot: buildFiber({
      name: 'Form',
      children: [
        ...(anonymousLabelFirst
          ? [{ hostType: 'RCTView', props: { accessibilityLabel: 'Email', onPress() {} } }]
          : []),
        {
          hostType: 'RCTSinglelineTextInputView',
          props: {
            testID: 'email',
            accessibilityLabel: 'Email',
            ...(onChangeOnly ? { onChange() {} } : { onChangeText() {} }),
          },
        },
      ],
    }),
  });
  const produced = JSON.parse(
    vm.runInContext('__QAREN.getTree({ interactiveOnly: true, semanticEvidence: true })', sandbox),
  );
  assert.equal(produced.interactive.at(-1).role, onChangeOnly ? 'button' : 'textinput');
  const capture = () =>
    captureScreen({
      appId: 'com.test',
      native: async () => f.native,
      react: async () => produced,
    });
  return { native: f.native, produced, secret, capture };
}

test('real inferred textinput digest masks a generic native control value and its echo in CHECK', async () => {
  const f = possibleInputFixture();
  const screen = await f.capture();
  assert.equal(screen.elements[2].kind, 'other');
  assert.equal(screen.elements[2].value, f.secret, 'local observations remain intact');
  assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  assert.equal(screen.elements[2].semantic?.press, 'unknown');
  const judge = scriptedJudge((questions, _, state) => {
    assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false);
    assert.match(questions.check_1.instructions, /QAREN_VALUE/);
    assert.match(state.assertionEvidence.observed.join(' '), /Echo: \[QAREN_VALUE_/);
    return { check_1: { type: 'noul', noul: 0.99 } };
  });
  await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text: `The control value and its echo show ${f.secret}`,
    line: 1,
  });
  assert.equal(judge.requests.length, 1);
});

test('possible-input privacy survives invalid presence and a greedy anonymous label match before the exact ID', async () => {
  for (const variant of [
    'valid',
    'incomplete-native',
    'invalid-presence',
    'incomplete-react',
    'missing-hosts',
  ]) {
    const f = possibleInputFixture(true);
    if (variant === 'incomplete-native') f.native.truncated = true;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    if (variant === 'incomplete-react') f.produced.hostEvidence.complete = false;
    if (variant === 'missing-hosts') delete f.produced.hostEvidence;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].value, f.secret);
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    assert.ok('refuse' in semanticActionView(screen, 'fill'));
    const judge = scriptedJudge((questions, _, state) => {
      assert.equal(variant, 'valid', 'incomplete captures cannot be judged');
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
      assert.match(state.assertionEvidence.observed.join(' '), /Echo: \[QAREN_VALUE_/);
      return { check_1: { type: 'noul', noul: 0.1 } };
    });
    const decision = await decideScreen(screen, judge, {
      kind: 'check',
      literal: false,
      text: 'The echo is correct',
      line: 1,
    });
    assert.equal(judge.requests.length, variant === 'valid' ? 1 : 0);
    if (variant !== 'valid') {
      assert.ok(decision.check && typeof decision.check === 'object');
      assert.equal(decision.check.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
      assert.match(decision.check.reason, /requires complete native and React coverage/);
    }
    assert.ok(inputValues(screen).includes(f.secret), variant);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(
      privacy.maskForModel(inputValues(screen), []).apply(f.secret).includes(f.secret),
      false,
      variant,
    );
  }
});

test('secure possible-input values stay out of model requests and durable failures without changing ordinary evidence policy', async () => {
  for (const secure of [false, true]) {
    for (const variant of ['valid', 'incomplete-native', 'invalid-presence', 'missing-digest']) {
      const f = possibleInputFixture(true);
      f.native.nodes[2].secure = secure;
      if (variant === 'incomplete-native') f.native.truncated = true;
      if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
      if (variant === 'missing-digest') f.produced.interactive = [];
      const screen = await f.capture();
      assert.equal(screen.elements[2].kind, 'other');
      assert.equal(screen.elements[2].value, secure ? undefined : f.secret);
      assert.equal(screen.elements[2].label, 'Email');
      assert.equal(screen.elements[2].testID, 'email');
      assert.equal(
        screen.elements[3].label,
        `Echo: ${f.secret}`,
        'local echo identity is not rewritten',
      );
      const before = JSON.stringify(screen);
      const judge = scriptedJudge((questions, _, state) => {
        assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
        assert.match(state.assertionEvidence.observed.join(' '), /Echo: \[QAREN_VALUE_/);
        return Object.fromEntries(
          Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }]),
        );
      });
      const w = walker([screen], judge);
      const result = await runPlan(parsePlan('✓ The echo is correct').blocks!, w.deps);
      assert.equal(result.verdict, 'FAIL');
      const admitted = variant === 'valid' || variant === 'missing-digest';
      assert.equal(judge.requests.length, admitted ? 2 : 0);
      if (!admitted) assert.match(result.failure!.seen, /SCREEN_EVIDENCE_INCOMPLETE/);
      // Native-first privacy masks every possible input's value, secure or not.
      assert.equal(JSON.stringify({ result, rows: w.rows }).includes(f.secret), false, variant);
      if (secure)
        assert.ok(
          result.failure!.seen.endsWith('[screen text withheld: a secure field is on screen]'),
        );
      else assert.match(result.failure!.seen, /Echo: •••/);
      assert.equal(JSON.stringify(screen), before);
      assert.deepEqual(w.actions, []);
    }
  }
});

test('value-derived or unproven native labels on possible inputs are masked without replacing their local identities', async () => {
  for (const variant of ['value-label', 'invalid-presence']) {
    const f = possibleInputFixture();
    f.native.nodes[2].label = f.secret;
    delete f.native.nodes[2].value;
    f.native.nodes[2].presence.labelSource = 'value';
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].label, f.secret);
    const judge = scriptedJudge((questions, _, state) => {
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false);
      return Object.fromEntries(
        Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.1 }]),
      );
    });
    const w = walker([screen], judge);
    const result = await runPlan(parsePlan('✓ The echo is correct').blocks!, w.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(JSON.stringify(result).includes(f.secret), false);
    assert.match(result.failure!.seen, /Echo: •••/);
  }
});

test('secure possible-input checks stay unsure while a legitimate batched phrase target is still judged', async () => {
  for (const type of ['Other', 'TextField']) {
    const f = possibleInputFixture();
    f.native.nodes[2].type = type;
    f.native.nodes[2].secure = true;
    f.native.nodes[2].enabled = false;
    f.native.nodes[3].type = 'Button';
    f.native.nodes[3].label = 'Continue';
    const screen = await f.capture();
    const judge = scriptedJudge((questions) => {
      assert.deepEqual(Object.keys(questions), ['target_2'], type);
      return { target_2: choice(questions.target_2) };
    });
    const decision = await decideScreen(
      screen,
      judge,
      { kind: 'check', literal: false, text: 'Email is valid', line: 1 },
      { kind: 'press', target: { phrase: 'the Continue control' }, line: 2 },
    );
    assert.equal(decision.check, 'unsure');
    assert.equal(decision.target.ref, '@e3');
    assert.equal(judge.requests.length, 1);
    assert.equal(screen.elements[2].kind, type === 'Other' ? 'other' : 'input');
    if (type === 'Other') assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  }
});

test('real onChange-only host fill evidence conceals native values despite a legacy button role and unproven association', async () => {
  for (const variant of [
    'valid',
    'incomplete-hosts',
    'invalid-presence',
    'anonymous-label-first',
  ]) {
    const f = possibleInputFixture(variant === 'anonymous-label-first', true);
    assert.equal(f.produced.interactive.at(-1).capabilities.fill, false);
    assert.equal(f.produced.hostEvidence.hosts.at(-1).capabilities.fill, true);
    if (variant === 'incomplete-hosts') f.produced.hostEvidence.complete = false;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    const screen = await f.capture();
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    const judge = scriptedJudge((questions, _, state) => {
      assert.ok(['valid', 'anonymous-label-first'].includes(variant));
      assert.equal(JSON.stringify({ questions, state }).includes(f.secret), false, variant);
      assert.match(state.assertionEvidence.observed.join(' '), /Echo: \[QAREN_VALUE_/);
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    const decision = await decideScreen(screen, judge, {
      kind: 'check',
      literal: false,
      text: 'The echo is correct',
      line: 1,
    });
    const admitted = ['valid', 'anonymous-label-first'].includes(variant);
    assert.equal(judge.requests.length, admitted ? 1 : 0);
    if (!admitted) {
      assert.ok(decision.check && typeof decision.check === 'object');
      assert.equal(decision.check.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
      assert.match(decision.check.reason, /requires complete native and React coverage/);
    }
    assert.ok(inputValues(screen).includes(f.secret), variant);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(
      privacy.maskForModel(inputValues(screen), []).apply(f.secret).includes(f.secret),
      false,
      variant,
    );
  }
});

test('possible-input value bounds use local identities before masking and never ask a protected question', async () => {
  for (const variant of ['valid', 'invalid-presence', 'incomplete-hosts']) {
    const f = possibleInputFixture(true);
    f.native.nodes[2].secure = true;
    if (variant === 'invalid-presence') f.native.presenceCapture.generation++;
    if (variant === 'incomplete-hosts') f.produced.hostEvidence.complete = false;
    const screen = await f.capture();
    const judge = scriptedJudge(() =>
      assert.fail('protected value predicates must not reach the judge'),
    );
    for (const predicate of [
      'is valid',
      'is invalid',
      'is filled',
      'starts with abc',
      'has 4 characters',
      `equals ${f.secret}`,
    ]) {
      const result = await decideScreen(screen, judge, {
        kind: 'check',
        literal: false,
        text: `Email input ${predicate}`,
        line: 1,
      });
      if (variant === 'valid') assert.equal(result.check, 'unsure', predicate);
      else {
        assert.ok(result.check && typeof result.check === 'object');
        assert.equal(result.check.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
        assert.match(result.check.reason, /requires complete native and React coverage/);
      }
    }
    assert.equal(screen.elements[2].testID, 'email');
    assert.equal(screen.elements[2].label, 'Email');
    assert.equal(screen.elements[2].kind, 'other');
  }
});

test('privacy gathers all matching positive-fill candidate values and deduplicates them in observation order', () => {
  for (const source of ['digest', 'host']) {
    const f = fixture();
    f.native.nodes[2].value = 'native-private';
    f.hostEvidence.hosts[0].capabilities = source === 'host' ? { fill: true } : {};
    const screen = join(
      f.native.nodes,
      [
        { role: 'button', label: 'Save', value: 'first-private' },
        {
          role: 'button',
          testID: 'save',
          value: 'second-private',
          capabilities: { press: false, fill: source === 'digest' },
        },
        { role: 'button', testID: 'save', value: 'third-private' },
      ],
      'app',
      undefined,
      f.hostEvidence,
      'unknown',
    );
    assert.deepEqual(inputValues(screen), [
      'native-private',
      'first-private',
      'second-private',
      'third-private',
      'Save',
    ]);
    assert.equal(isPossibleInput(screen.elements[2]), true);
    assert.equal(screen.elements[2].kind, 'other');
    assert.equal(screen.elements[2].semantic?.fill, 'unknown');
  }
});

test('unassociated positive-fill observations retain privacy without acquiring native input eligibility', async () => {
  const secret = 'unassociated-private-value';
  const screen = join(
    [{ ref: '@echo', type: 'StaticText', label: `Echo: ${secret}` }],
    [
      {
        role: 'button',
        testID: 'editor',
        value: secret,
        capabilities: { press: false, fill: true },
      },
    ],
    'app',
    undefined,
    undefined,
    'unknown',
  );
  assert.equal(screen.elements[1].kind, 'button');
  assert.equal(screen.elements[1].semantic?.fill, 'unknown');
  const judge = scriptedJudge(() => assert.fail('unknown native coverage cannot be judged'));
  const result = await decideScreen(screen, judge, {
    kind: 'check',
    literal: false,
    text: 'The echo is correct',
    line: 1,
  });
  assert.ok(result.check && typeof result.check === 'object');
  assert.equal(result.check.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.match(result.check.reason, /requires complete native and React coverage/);
  assert.equal(judge.requests.length, 0);
  const privacy = new ObservedPrivacy();
  privacy.observe(screen);
  assert.equal(privacy.maskForModel(inputValues(screen), []).apply(secret).includes(secret), false);
});

test('text under a structurally matched ancestor is searched only inside that ancestor', () => {
  const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
  const node = (
    index: number,
    parentIndex: number | undefined,
    depth: number,
    type: string,
    r: ReturnType<typeof rect>,
    extra = {},
  ) => ({
    ref: `@e${index}`,
    index,
    parentIndex,
    depth,
    type,
    rect: r,
    enabled: true,
    ...extra,
  });
  const nodes = [
    node(0, undefined, 0, 'Application', rect(0, 0, 400, 800)),
    node(1, 0, 1, 'Window', rect(0, 0, 400, 800)),
    node(2, 1, 2, 'Other', rect(0, 0, 400, 800), { identifier: 'root' }),
    node(3, 2, 3, 'Other', rect(0, 0, 200, 400), { identifier: 'panel' }),
    node(4, 2, 3, 'Other', rect(200, 0, 200, 400), { identifier: 'other' }),
    node(5, 4, 4, 'StaticText', rect(10, 10, 100, 20), { label: 'Title' }),
  ];
  const status = ['unknown', 'unknown', 'observed', 'unknown', 'observed', 'observed'] as const;
  const presence = {
    source: 'xcui-live' as const,
    nodes: status.map((s) => ({ status: s, labelSource: 'direct' as const })),
  };
  const view = (hostIndex: number, parentHostIndex: number | null, r: ReturnType<typeof rect>) => ({
    hostIndex,
    parentHostIndex,
    rootIndex: 0,
    hostType: 'RCTView',
    rect: r,
    text: { kind: 'none' as const },
  });
  const evidence = {
    complete: true,
    hosts: [
      { testID: 'root', role: null, roleSource: 'none' as const, capabilities: {} },
      { testID: 'panel', role: null, roleSource: 'none' as const, capabilities: {} },
      { role: null, roleSource: 'none' as const, capabilities: {} },
      { testID: 'other', role: null, roleSource: 'none' as const, capabilities: {} },
    ],
    typography: {
      version: 1 as const,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points' as const,
      nodes: [
        view(0, null, rect(0, 0, 400, 800)),
        view(1, 0, rect(0, 0, 200, 400)),
        {
          ...view(2, 1, rect(10, 10, 100, 20)),
          hostType: 'RCTText',
          text: { kind: 'block' as const, content: 'Title' },
        },
        view(3, 0, rect(200, 0, 200, 400)),
      ],
    },
  };
  const associations = associateHosts(nodes as never, evidence as never, presence as never);
  assert.equal(
    associations.get(1)?.nativeIndex,
    undefined,
    'the panel itself has no measured presence',
  );
  assert.equal(
    associations.get(2),
    undefined,
    'text inside the panel never matches native text in a sibling subtree',
  );
});

test('identified ancestors may be hoisted beside the native path but not sit in an unrelated subtree', () => {
  type Rect = { x: number; y: number; width: number; height: number };
  const rect = (x: number, y: number, width: number, height: number): Rect => ({
    x,
    y,
    width,
    height,
  });
  const other = (
    index: number,
    parentIndex: number,
    depth: number,
    r: Rect,
    identifier?: string,
  ) => ({
    ref: `@e${index}`,
    index,
    parentIndex,
    depth,
    type: 'Other',
    rect: r,
    ...(identifier ? { identifier } : {}),
  });
  const saveRect = rect(10, 10, 100, 40);
  const panel = (index: number, parentIndex: number, depth: number, r: Rect) =>
    other(index, parentIndex, depth, r, 'panel');
  const save = (index: number, parentIndex: number, depth: number) =>
    other(index, parentIndex, depth, saveRect, 'save');
  const base = [
    { ref: '@e0', index: 0, depth: 0, type: 'Application', rect: rect(0, 0, 400, 800) },
    { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: 'Window', rect: rect(0, 0, 400, 800) },
  ];
  const left = other(2, 1, 2, rect(0, 0, 400, 400));
  const associate = (nodes: Array<Record<string, unknown>>, panelRect: Rect, saveIndex: number) => {
    const presence = {
      source: 'xcui-live' as const,
      nodes: nodes.map((_, i) => ({
        status: i === saveIndex ? 'observed' : 'unknown',
        labelSource: 'none' as const,
      })),
    };
    const view = (hostIndex: number, parentHostIndex: number | null, r: Rect) => ({
      hostIndex,
      parentHostIndex,
      rootIndex: 0,
      hostType: 'RCTView',
      rect: r,
      text: { kind: 'none' as const },
    });
    const evidence = {
      complete: true,
      hosts: [
        { testID: 'panel', role: null, roleSource: 'none' as const, capabilities: {} },
        { testID: 'save', role: null, roleSource: 'none' as const, capabilities: { press: true } },
      ],
      typography: {
        version: 1 as const,
        complete: true,
        durationMs: 10,
        coordinateSpace: 'window-points' as const,
        nodes: [view(0, null, panelRect), view(1, 0, saveRect)],
      },
    };
    return associateHosts(nodes as never, evidence as never, presence as never).get(1)?.nativeIndex;
  };
  const cases: Array<[string, Array<Record<string, unknown>>, Rect, number, number | undefined]> = [
    [
      'hoisted beside save and containing it',
      [...base, left, panel(3, 2, 3, rect(0, 0, 400, 400)), save(4, 2, 3)],
      rect(0, 0, 400, 400),
      4,
      4,
    ],
    [
      'a direct native ancestor that save overflows',
      [...base, panel(2, 1, 2, rect(0, 0, 100, 20)), save(3, 2, 3)],
      rect(0, 0, 100, 20),
      3,
      3,
    ],
    [
      'an overlay branch whose panel contains save but is off its native path',
      [
        ...base,
        left,
        other(3, 1, 2, rect(0, 0, 400, 800)),
        panel(4, 3, 3, rect(0, 0, 400, 400)),
        save(5, 2, 3),
      ],
      rect(0, 0, 400, 400),
      5,
      undefined,
    ],
    [
      'panel is save’s native child (reversed ancestry)',
      [...base, left, save(3, 2, 3), panel(4, 3, 4, saveRect)],
      saveRect,
      3,
      undefined,
    ],
    [
      'hoisted beside save without containing it',
      [...base, left, panel(3, 2, 3, rect(200, 200, 100, 100)), save(4, 2, 3)],
      rect(200, 200, 100, 100),
      4,
      undefined,
    ],
  ];
  for (const [name, nodes, panelRect, saveIndex, expected] of cases)
    assert.equal(associate(nodes, panelRect, saveIndex), expected, name);
});

test('a React scroll view identified on its native container view anchors its descendants', () => {
  const frame = { x: 0, y: 0, width: 400, height: 700 };
  const saveRect = { x: 10, y: 100, width: 100, height: 40 };
  const nodes = [
    {
      ref: '@e0',
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@e1',
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Window',
      rect: { x: 0, y: 0, width: 400, height: 800 },
    },
    {
      ref: '@e2',
      index: 2,
      parentIndex: 1,
      depth: 2,
      type: 'Other',
      identifier: 'feed',
      rect: frame,
    },
    { ref: '@e3', index: 3, parentIndex: 2, depth: 3, type: 'ScrollView', rect: frame },
    {
      ref: '@e4',
      index: 4,
      parentIndex: 3,
      depth: 4,
      type: 'Button',
      identifier: 'save',
      rect: saveRect,
    },
  ];
  const presence = {
    source: 'xcui-live' as const,
    nodes: nodes.map((_, i) => ({
      status: i === 4 ? ('observed' as const) : ('unknown' as const),
      labelSource: 'none' as const,
    })),
  };
  const host = (
    hostIndex: number,
    parentHostIndex: number | null,
    hostType: string,
    rect: typeof frame,
  ) => ({
    hostIndex,
    parentHostIndex,
    rootIndex: 0,
    hostType,
    rect,
    text: { kind: 'none' as const },
  });
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      { testID: 'feed', role: null, roleSource: 'none', capabilities: {} },
      { testID: 'save', role: null, roleSource: 'none', capabilities: { press: true } },
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: [host(0, null, 'RCTScrollView', frame), host(1, 0, 'RCTView', saveRect)],
    },
  };
  assert.deepEqual(associateHosts(nodes, evidence, presence).get(1), {
    nativeIndex: 4,
    anchorIndex: 4,
  });
  const flat = nodes.map((n) => (n.type === 'ScrollView' ? { ...n, type: 'Other' } : n));
  assert.equal(
    associateHosts(flat, evidence, presence).get(1),
    undefined,
    'an identified Other stands for a scroll view only when a native ScrollView sits directly under it',
  );
});

function safeAreaAssociation(platform: 'ios' | 'android', rootHostType: string) {
  const frame = { x: 0, y: 0, width: 400, height: 800 };
  const saveRect = { x: 10, y: 100, width: 100, height: 40 };
  const [window, root, save] =
    platform === 'ios'
      ? ['Window', 'Other', 'Button']
      : ['Window', 'android.view.ViewGroup', 'android.widget.Button'];
  const nodes = [
    { ref: '@e0', index: 0, depth: 0, type: 'Application', rect: frame },
    { ref: '@e1', index: 1, parentIndex: 0, depth: 1, type: window, rect: frame },
    { ref: '@e2', index: 2, parentIndex: 1, depth: 2, type: root, identifier: 'base', rect: frame },
    {
      ref: '@e3',
      index: 3,
      parentIndex: 2,
      depth: 3,
      type: save,
      identifier: 'save',
      rect: saveRect,
    },
  ];
  const presence = {
    source: 'xcui-live' as const,
    nodes: nodes.map((_, i) => ({
      status: i >= 2 ? ('observed' as const) : ('unknown' as const),
      labelSource: 'none' as const,
    })),
  };
  const host = (
    hostIndex: number,
    parentHostIndex: number | null,
    hostType: string,
    rect: typeof frame,
  ) => ({
    hostIndex,
    parentHostIndex,
    rootIndex: 0,
    hostType,
    rect,
    text: { kind: 'none' as const },
  });
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      { testID: 'base', role: null, roleSource: 'none', capabilities: {} },
      { testID: 'save', role: null, roleSource: 'none', capabilities: { press: true } },
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 10,
      coordinateSpace: 'window-points',
      nodes: [host(0, null, rootHostType, frame), host(1, 0, 'RCTView', saveRect)],
    },
  };
  return associateHosts(nodes, evidence, presence);
}

test('iOS: a host beneath an identified react-native-safe-area-context root associates', () => {
  for (const root of ['RNCSafeAreaView', 'RNCSafeAreaProvider']) {
    const associations = safeAreaAssociation('ios', root);
    assert.deepEqual(associations.get(0), { nativeIndex: 2, anchorIndex: 2 }, root);
    assert.deepEqual(associations.get(1), { nativeIndex: 3, anchorIndex: 3 }, root);
  }
});

test('Android: an identified react-native-safe-area-context host associates with its ViewGroup', () => {
  for (const root of ['RNCSafeAreaView', 'RNCSafeAreaProvider'])
    assert.deepEqual(
      safeAreaAssociation('android', root).get(0),
      { nativeIndex: 2, anchorIndex: 2 },
      root,
    );
});

for (const mode of [
  'outside-window',
  'duplicate-id',
  'invalid-window-frame',
  'unknown-presence',
  'frame-mismatch',
] as const) {
  test(`two-window role-less decline remains ineligible with ${mode}`, async () => {
    const f = twoWindowFixture();
    if (mode === 'outside-window') {
      f.native.nodes[2].parentIndex = 0;
      f.native.nodes[2].depth = 1;
    } else if (mode === 'duplicate-id') {
      f.native.nodes.push({
        ...structuredClone(f.native.nodes[2]),
        index: 4,
        ref: '@e4',
        parentIndex: 3,
        presence: { ...f.native.nodes[2].presence, nodeIndex: 4 },
      });
      f.native.snapshotVerdict.nodeCount++;
    } else if (mode === 'invalid-window-frame') {
      f.native.nodes[1].rect.width = 0;
      f.native.nodes[1].presence.status = 'unknown';
      delete f.native.nodes[1].presence.observedUptimeMs;
    } else if (mode === 'unknown-presence') {
      f.native.nodes[2].presence.status = 'unknown';
      delete f.native.nodes[2].presence.observedUptimeMs;
    } else f.native.nodes[2].rect.x++;
    const screen = await f.capture();
    assert.equal(screen.elements[2].semantic?.press, 'unknown');
    assert.equal(
      dismissCandidate(screen, [{ quoted: 'Destination', phrase: 'Destination' }]),
      undefined,
    );
    const w = walker(
      [],
      scriptedJudge(() => assert.fail('unknown proof cannot reach Jev')),
    );
    w.deps.captureScreen = f.capture;
    w.deps.press = async () => assert.fail('unproven decline cannot be pressed');
    w.deps.hideDevMenu = async () => assert.fail('no developer overlay');
    const result = await runPlan(parsePlan('✓ "Destination"').blocks!, w.deps);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.recoveries, 0);
  });
}

test('window translation uses the candidate ancestor, even when it is the second window', async () => {
  const f = twoWindowFixture();
  const control = f.native.nodes[2];
  const window = f.native.nodes[3];
  f.native.nodes[2] = {
    ...window,
    ref: '@e2',
    index: 2,
    rect: { x: 80, y: 100, width: 300, height: 600 },
    presence: { ...window.presence, nodeIndex: 2 },
  };
  f.native.nodes[3] = {
    ...control,
    ref: '@e3',
    index: 3,
    parentIndex: 2,
    rect: { x: 90, y: 120, width: 100, height: 40 },
    presence: { ...control.presence, nodeIndex: 3 },
  };
  const screen = await f.capture();
  assert.equal(screen.elements[3].semantic?.press, 'supported');
  assert.deepEqual(dismissCandidate(screen, [{ quoted: 'Destination', phrase: 'Destination' }]), {
    label: 'Skip',
  });
  f.native.nodes[3].rect = { x: 30, y: 60, width: 100, height: 40 };
  assert.equal(
    (await f.capture()).elements[3].semantic?.press,
    'unknown',
    'first-window geometry is not proof for the second window',
  );
});

test('an explicit native Close button keeps its press proof in a two-window capture', async () => {
  const f = twoWindowFixture();
  f.native.nodes[2].type = 'Button';
  f.native.nodes[2].label = 'Close';
  const screen = await f.capture();
  assert.equal(screen.elements[2].semantic?.press, 'supported');
  assert.equal(screen.elements[2].kind, 'button');
  assert.deepEqual(dismissCandidate(screen, [{ quoted: 'Destination', phrase: 'Destination' }]), {
    label: 'Close',
  });
});

// Android: React frames are density-scaled points from an origin the capture calibrates from its testID anchors.
function androidAssociation(mutate?: (fixture: ReturnType<typeof androidPresenceCapture>) => void) {
  const fixture = androidPresenceCapture();
  mutate?.(fixture);
  const nodes = fixture.data.nodes.map((node) => ({ ...node, ref: `@e${node.index}` }));
  const presence = validateNativePresence(
    fixture.data.presenceCapture,
    nodes,
    4,
    'com.test',
    20_000,
  );
  assert.ok(presence);
  const evidence = validateReactHostEvidence(fixture.hostEvidence);
  assert.ok(evidence);
  const diagnostics = new Map();
  const associations = associateHosts(nodes, evidence, presence, diagnostics);
  return {
    native: (host: number) => associations.get(host)?.nativeIndex,
    identity: (host: number) => diagnostics.get(host)?.identity,
  };
}

test("Android hosts associate through the density and the anchors' common origin, within 2 px and not 3", () => {
  const exact = androidAssociation();
  assert.deepEqual(
    [0, 1, 2].map(exact.native),
    [2, 3, 4],
    'a constant +136 px origin is calibrated',
  );
  for (const [residual, text] of [
    [2, 4],
    [-2, 4],
    [3, undefined],
  ] as const) {
    const shifted = androidAssociation((f) => {
      f.data.nodes[4].rect = { ...f.data.nodes[4].rect, x: f.data.nodes[4].rect.x + residual };
    });
    assert.equal(shifted.native(1), 3);
    assert.equal(shifted.native(2), text, `text residual ${residual} px`);
  }
});

test('an Android capture with one anchor has no calibrated origin and associates nothing', () => {
  const single = androidAssociation((f) => {
    delete (f.hostEvidence.hosts[0] as { testID?: string }).testID;
  });
  assert.deepEqual([0, 1, 2].map(single.native), [undefined, undefined, undefined]);
  assert.equal(single.identity(1), 'origin-unknown');
});

test('Android anchors that disagree on the origin by more than the tolerance associate nothing', () => {
  const disagreeing = androidAssociation((f) => {
    const root = f.hostEvidence.typography.nodes[0].rect!;
    f.hostEvidence.typography.nodes[0].rect = { ...root, y: root.y + 3 / ANDROID_SCALE };
  });
  assert.deepEqual([0, 1, 2].map(disagreeing.native), [undefined, undefined, undefined]);
  assert.equal(disagreeing.identity(1), 'origin-unknown');
});

function withModal(children: boolean) {
  return (f: ReturnType<typeof androidPresenceCapture>) => {
    f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    f.hostEvidence.typography.nodes.push({
      hostIndex: 3,
      parentHostIndex: 0,
      rootIndex: 0,
      hostType: 'RCTModalHostView',
      rect: { x: 0, y: 0, width: 1080 / ANDROID_SCALE, height: 2400 / ANDROID_SCALE },
      text: { kind: 'none' },
    } as (typeof f.hostEvidence.typography.nodes)[number]);
    if (!children) return;
    f.hostEvidence.hosts.push({ role: null, roleSource: 'none', capabilities: {} });
    f.hostEvidence.typography.nodes.push({
      hostIndex: 4,
      parentHostIndex: 3,
      rootIndex: 0,
      hostType: 'RCTView',
      text: { kind: 'none' },
    } as (typeof f.hostEvidence.typography.nodes)[number]);
  };
}

test('a mounted React Native Modal with content is a second window Android does not list', () => {
  const modal = androidAssociation(withModal(true));
  assert.deepEqual([0, 1, 2].map(modal.native), [undefined, undefined, undefined]);
  assert.equal(modal.identity(1), 'window-count');
});

test('an empty Modal host does not stop Android association', () => {
  const empty = androidAssociation(withModal(false));
  assert.deepEqual([0, 1, 2].map(empty.native), [2, 3, 4]);
});
