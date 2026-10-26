import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { join, semanticActionView, visibilityView } from '../../../dist/qa/screen.js';
import type { NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import { inputValues, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import { associateHosts } from '../../../dist/qa/host-association.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { scriptedJudge } from './judgment-fixtures.ts';

function fixture() {
  const window = { x: 20, y: 40, width: 400, height: 800 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', depth: 0, rect: window },
    { ref: '@window', type: 'Window', depth: 1, parentIndex: 0, rect: window },
    { ref: '@container', type: 'Other', depth: 2, parentIndex: 1, rect: window },
    {
      ref: '@heading',
      type: 'StaticText',
      label: 'Tasks',
      depth: 3,
      parentIndex: 2,
      rect: { x: 30, y: 60, width: 160, height: 24 },
    },
    ...[0, 1].map((i) => ({
      ref: `@input-${i}`,
      type: 'TextField',
      identifier: `input-${i}`,
      label: `Field ${i}`,
      hittable: true,
      depth: 3,
      parentIndex: 2,
      rect: { x: 30, y: 100 + i * 60, width: 160, height: 40 },
    })),
  ];
  const presence: NativePresence = {
    source: 'xcui-live',
    nodes: nodes.map((_, i) => ({
      status: i >= 3 ? 'observed' : 'unknown',
      labelSource: i >= 3 ? 'direct' : 'none',
    })),
  };
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [0, 1].map((i) => ({
      testID: `input-${i}`,
      role: null,
      roleSource: 'none',
      capabilities: { press: true, fill: true },
    })),
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [0, 1].map((i) => ({
        hostIndex: i,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: 'RCTSinglelineTextInputView',
        rect: { x: 10, y: 60 + i * 60, width: 160, height: 40 },
        text: { kind: 'none' },
      })),
    },
  };
  const screen = () =>
    join(nodes, [], 'app', { native: 'complete', react: 'complete' }, evidence, presence);
  const native = () => {
    const capture = nativeCapture();
    return {
      ...capture,
      nodes: nodes.map((node, index) => ({
        ...node,
        index,
        enabled: node.enabled !== false,
        presence: {
          ...capture.nodes[0].presence,
          ...presence.nodes[index],
          nodeIndex: index,
          ...(presence.nodes[index]?.status === 'observed' ? { observedUptimeMs: 150 } : {}),
        },
      })),
      snapshotVerdict: { ...capture.snapshotVerdict, nodeCount: nodes.length },
    };
  };
  return { nodes, evidence, presence, screen, native };
}

test('two fully proven input hosts close both gaps and let an inert container leave the visibility projection', () => {
  const f = fixture();
  const screen = f.screen();
  assert.equal(screen.pressEvidenceGap, undefined, JSON.stringify(visibilityView(screen, true)));
  assert.equal(screen.elements[2].semantic?.visibility, 'unknown');
  assert.equal(screen.elements[2].semantic?.press, 'unsupported');
  assert.equal(screen.elements[2].semantic?.fill, 'unsupported');
  assert.deepEqual(visibilityView(screen), {
    elements: screen.elements.slice(3),
    unknown: [],
    unassociatedReact: 0,
  });
});

test('known input hosts retain their supported native kinds for equal frames', () => {
  for (const [hostType, nativeTypes] of [
    ['TextInput', ['TextField', 'SecureTextField', 'TextView']],
    ['RCTTextInput', ['TextField', 'SecureTextField', 'TextView']],
    ['RCTSinglelineTextInputView', ['TextField', 'SecureTextField']],
    ['RCTMultilineTextInputView', ['TextView']],
    ['AndroidTextInput', ['TextField', 'SecureTextField', 'TextView']],
  ] as const) {
    for (const nativeType of nativeTypes) {
      const f = fixture();
      f.evidence.typography!.nodes.forEach((node) => {
        node.hostType = hostType;
      });
      f.nodes.slice(4).forEach((node) => {
        node.type = nativeType;
      });
      const screen = f.screen();
      assert.equal(screen.pressEvidenceGap, undefined, `${hostType} / ${nativeType}`);
      assert.deepEqual(visibilityView(screen), {
        elements: screen.elements.slice(3),
        unknown: [],
        unassociatedReact: 0,
      });
      for (const operation of ['press', 'fill'] as const)
        assert.deepEqual(semanticActionView(screen, operation), {
          elements: screen.elements.slice(4),
        });
    }
  }
});

function insetInputs(f: ReturnType<typeof fixture>, inset = 1) {
  for (const node of f.nodes.slice(4)) {
    node.rect!.x += inset;
    node.rect!.y += inset;
    node.rect!.width -= inset * 2;
    node.rect!.height -= inset * 2;
  }
}

test('known iOS backing inputs close the gaps with equal or contained frames', () => {
  for (const [hostType, nativeType] of [
    ['RCTSinglelineTextInputView', 'TextField'],
    ['RCTSinglelineTextInputView', 'SecureTextField'],
    ['RCTMultilineTextInputView', 'TextView'],
  ]) {
    for (const inset of [0, 0.25, 1, 3]) {
      const f = fixture();
      f.evidence.typography!.nodes.forEach((host) => {
        host.hostType = hostType;
      });
      f.nodes.slice(4).forEach((node) => {
        node.type = nativeType;
      });
      insetInputs(f, inset);
      const diagnostics = new Map();
      assert.equal(associateHosts(f.nodes, f.evidence, f.presence, diagnostics).size, 2);
      assert.equal(diagnostics.get(0).sameFrameCount, Number(inset === 0));
      assert.equal(diagnostics.get(0).inputContainmentCount, 1);
      const screen = f.screen();
      assert.equal(screen.pressEvidenceGap, undefined);
      assert.deepEqual(visibilityView(screen), {
        elements: screen.elements.slice(3),
        unknown: [],
        unassociatedReact: 0,
      });
    }
  }
});

test('input containment is not available to generic aliases, non-input hosts or wrong native types', () => {
  for (const [hostType, nativeType] of [
    ['TextInput', 'TextField'],
    ['RCTTextInput', 'TextField'],
    ['AndroidTextInput', 'TextField'],
    ['RCTView', 'Other'],
    ['RCTSinglelineTextInputView', 'TextView'],
    ['RCTMultilineTextInputView', 'TextField'],
    ['RCTMultilineTextInputView', 'SecureTextField'],
  ]) {
    for (const inset of [0, 1]) {
      if (inset === 0 && !hostType.endsWith('TextInputView')) continue;
      const f = fixture();
      f.evidence.typography!.nodes.forEach((host) => {
        host.hostType = hostType;
      });
      f.nodes.slice(4).forEach((node) => {
        node.type = nativeType;
      });
      insetInputs(f, inset);
      assert.equal(
        associateHosts(f.nodes, f.evidence, f.presence).size,
        0,
        `${hostType}/${nativeType}`,
      );
    }
  }
});

test('input containment rejects every escaped edge, invalid size and overflowing coordinate', () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.nodes[4].rect!.x = 29;
    },
    (f) => {
      f.nodes[4].rect!.y = 99;
    },
    (f) => {
      f.nodes[4].rect!.width = 160;
    },
    (f) => {
      f.nodes[4].rect!.height = 40;
    },
    ...[0, -1, NaN, Infinity].flatMap((value) => [
      (f: ReturnType<typeof fixture>) => {
        f.nodes[4].rect!.width = value;
      },
      (f: ReturnType<typeof fixture>) => {
        f.nodes[4].rect!.height = value;
      },
      (f: ReturnType<typeof fixture>) => {
        f.evidence.typography!.nodes[0].rect!.width = value;
      },
      (f: ReturnType<typeof fixture>) => {
        f.evidence.typography!.nodes[0].rect!.height = value;
      },
    ]),
    (f) => {
      f.evidence.typography!.nodes[0].rect!.x = Number.MAX_VALUE;
      f.evidence.typography!.nodes[0].rect!.width = Number.MAX_VALUE;
      f.nodes[4].rect!.x = Number.MAX_VALUE;
      f.nodes[4].rect!.width = Number.MAX_VALUE;
    },
    (f) => {
      f.nodes[1].rect!.x = Number.MAX_VALUE;
      f.evidence.typography!.nodes[0].rect!.x = Number.MAX_VALUE;
    },
    (f) => {
      f.nodes[4].rect = { x: 30, y: 100, width: 0, height: 40 };
      f.evidence.typography!.nodes[0].rect = { x: 10, y: 60, width: 0, height: 40 };
    },
    (f) => {
      f.evidence.hosts[0].hidden = true;
    },
  ];
  for (const change of cases) {
    const f = fixture();
    insetInputs(f);
    change(f);
    assert.equal(associateHosts(f.nodes, f.evidence, f.presence).has(0), false);
  }
});

test('input identity counts the full native inventory before duplicate suppression', () => {
  const f = fixture();
  insetInputs(f);
  const duplicate = { ...f.nodes[4], type: 'StaticText' };
  f.nodes.push(
    { ...duplicate, ref: '@duplicate-parent' },
    { ...duplicate, ref: '@duplicate-child', parentIndex: 6, depth: 4 },
  );
  f.presence.nodes.push({ ...f.presence.nodes[4] }, { ...f.presence.nodes[4] });
  const diagnostics = new Map();
  assert.equal(associateHosts(f.nodes, f.evidence, f.presence, diagnostics).has(0), false);
  assert.equal(diagnostics.get(0).nativeIdentityCandidateCount, 3);
});

function assertGaps(f: ReturnType<typeof fixture>, count = 2) {
  const screen = f.screen();
  const projection = visibilityView(screen, true);
  assert.ok('elements' in projection);
  const unknown = f.nodes.slice(2).flatMap((node, offset) => {
    const index = offset + 2;
    if (f.presence.nodes[index].status === 'unknown') return [[node.ref, 'visibility']];
    return [
      'TextField',
      'SecureTextField',
      'TextView',
      'Button',
      'StaticText',
      'SearchField',
      'android.widget.EditText',
    ].includes(node.type!)
      ? []
      : [[node.ref, 'content']];
  });
  // Plain containers whose own evidence rules out press and fill leave the projection; the gap is counted once.
  const plain = (ref: string) => {
    const node = f.nodes.find((n) => n.ref === ref)!;
    return node.type === 'Other' && !node.label && node.value === undefined;
  };
  assert.deepEqual(
    projection.unknown.map(({ element, reason }) => [element.ref, reason]),
    unknown.filter(([ref]) => !plain(ref)),
  );
  assert.equal(
    projection.capabilityGapContainers ?? 0,
    unknown.filter(([ref]) => plain(ref)).length,
  );
  assert.deepEqual(
    projection.elements.map((element) => element.ref),
    f.nodes
      .slice(2)
      .filter((node) => !unknown.some(([ref]) => ref === node.ref))
      .map((node) => node.ref),
  );
  assert.equal(projection.unassociatedReact, 0);
  for (const operation of ['press', 'fill'] as const) {
    const action = semanticActionView(screen, operation);
    assert.ok('refuse' in action);
    assert.equal(action.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  }
  assert.equal(projection.diagnostic?.ordinal, 2);
  assert.equal(projection.diagnostic?.pressGapCount, count);
  assert.equal(projection.diagnostic?.fillGapCount, count);
  assert.equal(projection.diagnostic?.gapHosts?.total, count);
  return projection.diagnostic!;
}

test('input compatibility never falls back to generic, similar-named or other native control kinds', () => {
  for (const nativeType of [
    'Other',
    'Button',
    'StaticText',
    'SearchField',
    'android.widget.EditText',
    'CustomTextField',
    'TextFieldSuffix',
    'textfield',
    undefined,
  ]) {
    const f = fixture();
    f.nodes.slice(4).forEach((node) => {
      node.type = nativeType;
    });
    const diagnostic = assertGaps(f);
    assert.ok(
      diagnostic.gapHosts!.rows.every((row) => row.association?.identity === 'incompatible-type'),
    );
  }
  for (const hostType of [
    null,
    'CustomTextInput',
    'RCTSinglelineTextInputViewSuffix',
    'RCTMultilineTextInput',
    'TextField',
    ' RCTTextInput',
    'RCTTextInput ',
    '__proto__',
  ]) {
    const f = fixture();
    f.evidence.typography!.nodes.forEach((node) => {
      node.hostType = hostType;
    });
    assertGaps(f);
  }
});

const unproven: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    'incomplete hosts',
    (f) => {
      f.evidence.complete = false;
    },
  ],
  [
    'missing measurements',
    (f) => {
      delete f.evidence.typography;
    },
  ],
  [
    'incomplete measurements',
    (f) => {
      f.evidence.typography!.complete = false;
    },
  ],
  [
    'missing frame',
    (f) => {
      f.evidence.typography!.nodes.forEach((node) => {
        delete node.rect;
      });
    },
  ],
  ...(['x', 'y', 'width', 'height'] as const).map(
    (axis): [string, (f: ReturnType<typeof fixture>) => void] => [
      `native escapes ${axis}`,
      (f) => {
        f.nodes.slice(4).forEach((node) => {
          node.rect![axis] += 4;
        });
      },
    ],
  ),
  [
    'unobserved on-screen inputs',
    (f) => {
      f.presence.nodes.slice(4).forEach((node) => {
        node.status = 'unknown';
      });
    },
  ],
  [
    'missing host IDs',
    (f) => {
      f.evidence.hosts.forEach((host) => {
        host.nativeID = host.testID;
        delete host.testID;
      });
    },
  ],
  [
    'missing native IDs',
    (f) => {
      f.nodes.slice(4).forEach((node) => {
        delete node.identifier;
      });
    },
  ],
  [
    'nonexact identity',
    (f) => {
      f.evidence.hosts.forEach((host) => {
        host.testID = ` ${host.testID} `;
      });
    },
  ],
  [
    'duplicate host identity',
    (f) => {
      f.evidence.hosts[1].testID = f.evidence.hosts[0].testID;
    },
  ],
  [
    'duplicate native identity',
    (f) => {
      f.nodes[5].identifier = f.nodes[4].identifier;
    },
  ],
  [
    'outside the window',
    (f) => {
      f.nodes.slice(4).forEach((node) => {
        node.parentIndex = 0;
      });
    },
  ],
  [
    'missing identified ancestor',
    (f) => {
      f.evidence.hosts.push({
        testID: 'missing-panel',
        role: null,
        roleSource: 'none',
        capabilities: {},
      });
      f.evidence.typography!.nodes.forEach((node) => {
        node.parentHostIndex = 2;
      });
      f.evidence.typography!.nodes.push({
        hostIndex: 2,
        parentHostIndex: null,
        rootIndex: 0,
        hostType: 'RCTView',
        rect: { x: 0, y: 0, width: 400, height: 800 },
        text: { kind: 'none' },
      });
    },
  ],
];

for (const [name, weaken] of unproven) {
  test(`input compatibility retains both gaps without complete proof: ${name}`, () => {
    const f = fixture();
    weaken(f);
    assertGaps(f);
    const inset = fixture();
    insetInputs(inset);
    weaken(inset);
    assert.equal(associateHosts(inset.nodes, inset.evidence, inset.presence).size, 0);
  });
}

test('one proven input cannot close the other input gap', () => {
  const f = fixture();
  f.presence.nodes[5].status = 'unknown';
  const diagnostic = assertGaps(f, 1);
  assert.equal(diagnostic.gapHosts!.rows[0].hostOrdinal, 1);
  assert.deepEqual(diagnostic.gapHosts!.rows[0].association, {
    identity: 'matched',
    nativeIdentityCandidateCount: 1,
    compatibleCount: 1,
    sameFrameCount: 1,
    inputContainmentCount: 1,
    presenceProofCount: 0,
    ancestorPath: 'self-anchor-missing',
    collisions: null,
  });
});

test('associated visible inputs still need native hit hints before either operation', () => {
  const f = fixture();
  f.nodes[4].hittable = false;
  const screen = f.screen();
  assert.equal(screen.pressEvidenceGap, undefined);
  assert.deepEqual(visibilityView(screen), {
    elements: screen.elements.slice(3),
    unknown: [],
    unassociatedReact: 0,
  });
  for (const operation of ['press', 'fill'] as const)
    assert.deepEqual(semanticActionView(screen, operation), {
      refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
      reason: 'a supported control has neither a hit hint nor offscreen evidence',
    });
});

test('equal input geometry cannot replace the named ancestor path with an unrelated native branch', () => {
  const f = fixture();
  f.evidence.typography!.nodes.forEach((node) => {
    node.parentHostIndex = 2;
  });
  f.evidence.hosts.push({ testID: 'panel', role: null, roleSource: 'none', capabilities: {} });
  f.evidence.typography!.nodes.push({
    hostIndex: 2,
    parentHostIndex: null,
    rootIndex: 0,
    hostType: 'RCTView',
    rect: { x: 0, y: 0, width: 400, height: 800 },
    text: { kind: 'none' },
  });
  f.nodes.push(
    { ref: '@branch', type: 'Other', parentIndex: 1, depth: 2, rect: f.nodes[1].rect },
    {
      ref: '@panel',
      type: 'Other',
      identifier: 'panel',
      parentIndex: 6,
      depth: 3,
      rect: f.nodes[1].rect,
    },
  );
  f.presence.nodes.push(
    { status: 'unknown', labelSource: 'none' },
    { status: 'unknown', labelSource: 'none' },
  );
  const diagnostic = assertGaps(f);
  assert.ok(
    diagnostic.gapHosts!.rows.every(
      (row) => row.association?.ancestorPath === 'ancestor-path-mismatch',
    ),
  );
  insetInputs(f);
  assert.equal(associateHosts(f.nodes, f.evidence, f.presence).size, 0);
});

test('capture validation still rejects incomplete native presence and mismatched generations', async () => {
  for (const mode of ['incomplete', 'generation', 'missing-node-proof']) {
    const f = fixture();
    const native = f.native();
    if (mode === 'incomplete') native.presenceCapture.complete = false;
    if (mode === 'generation') native.presenceCapture.generation++;
    if (mode === 'missing-node-proof') Reflect.deleteProperty(native.nodes[4], 'presence');
    const screen = await captureScreen({
      appId: 'com.test',
      native: async () => native,
      react: async () => ({
        interactive: [],
        hostEvidence: f.evidence,
        verdict: { state: 'ok', path: 'interactive', complete: true },
      }),
    });
    assert.equal(screen.pressEvidenceGap, '2 interactive React hosts unassociated');
    assert.equal(screen.coverage?.native, 'incomplete');
    assert.ok('refuse' in visibilityView(screen));
  }
});

function privateCapture(mode: string) {
  const f = fixture();
  insetInputs(f);
  if (mode === 'secure') f.nodes[4].type = 'SecureTextField';
  // The native snapshot is the privacy source; iOS reports a secure field's value as bullets.
  f.nodes.slice(4, 6).forEach((node, i) => {
    if (mode !== 'uncontrolled')
      node.value = mode === 'secure' && i === 0 ? '••••••' : `PRIVATE-controlled-${i}`;
  });
  if (mode === 'native-disabled')
    f.nodes.slice(4).forEach((node) => {
      node.enabled = false;
    });
  const root = buildFiber({
    hostType: 'RCTView',
    stateNode: {
      measureInWindow(callback) {
        callback(0, 0, 400, 800);
      },
    },
    children: [0, 1].map((i) => ({
      hostType: 'RCTSinglelineTextInputView',
      props: {
        testID: `input-${i}`,
        value: mode === 'uncontrolled' ? undefined : `PRIVATE-controlled-${i}`,
        secureTextEntry: mode === 'secure',
        readOnly: mode === 'readOnly',
        disabled: mode === 'disabled',
        onPress() {},
        onChange() {},
      },
      stateNode: {
        measureInWindow(callback) {
          callback(10, 60 + i * 60, 160, 40);
        },
      },
    })),
  });
  root.tag = root.child.tag = root.child.sibling.tag = 5;
  const sandbox = createSandbox({ fiberRoot: root });
  const capturedRoot = { current: root };
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([capturedRoot]) : new Set();
  return () =>
    captureScreen({
      appId: 'com.test',
      requirePrivateInputs: true,
      native: async () => f.native(),
      react: async () => {
        const observation = await captureQaReact(
          {
            isConnected: true,
            async withPrivateHelperWorld(run) {
              return run(async (expression) => vm.runInContext(expression, sandbox));
            },
          },
          true,
        );
        assert.doesNotMatch(JSON.stringify(observation), /PRIVATE-controlled/);
        return observation;
      },
    });
}

test('real private capture associates inputs without bypassing secure, read-only or disabled policy', async () => {
  for (const mode of ['editable', 'secure', 'readOnly', 'disabled', 'native-disabled']) {
    const screen = await privateCapture(mode)();
    assert.equal(screen.pressEvidenceGap, undefined, mode);
    assert.deepEqual(screen.coverage, { native: 'complete', react: 'complete' });
    assert.deepEqual(visibilityView(screen), {
      elements: screen.elements.slice(3),
      unknown: [],
      unassociatedReact: 0,
    });
    const blocked = ['readOnly', 'disabled', 'native-disabled'].includes(mode);
    for (const operation of ['press', 'fill'] as const)
      assert.deepEqual(
        semanticActionView(screen, operation),
        { elements: blocked ? [] : screen.elements.slice(4) },
        mode,
      );
    assert.equal(inputValues(screen).includes('PRIVATE-controlled-0'), mode !== 'secure', mode);
    const privacy = new ObservedPrivacy();
    privacy.observe(screen);
    assert.equal(privacy.canScreenshot(), false);
    assert.equal(privacy.redact('PRIVATE-controlled-1'), '•••', mode);
    if (mode !== 'secure') assert.equal(privacy.redact('PRIVATE-controlled-0'), '•••', mode);
    const judge = scriptedJudge((questions, _, state) => {
      assert.doesNotMatch(JSON.stringify({ questions, state }), /PRIVATE-controlled/);
      return { check_1: { type: 'noul', noul: 0.99 } };
    });
    assert.equal(
      (
        await decideScreen(screen, judge, {
          kind: 'check',
          text: 'Tasks is visible',
          literal: false,
          line: 1,
        })
      ).check,
      'pass',
    );
    assert.equal(judge.requests.length, 1);
    const local = scriptedJudge(() =>
      assert.fail('private-only or secure values must not be judged'),
    );
    // A literal check is decided locally from observations and never reaches a model.
    await decideScreen(screen, local, {
      kind: 'check',
      text: 'PRIVATE-controlled-0',
      literal: true,
      line: 1,
    });
    if (mode === 'secure')
      assert.equal(
        (
          await decideScreen(screen, local, {
            kind: 'check',
            text: 'Field 1 is valid',
            literal: false,
            line: 1,
          })
        ).check,
        'unsure',
      );
  }
  // A field reporting no native value is not a refusal; it has nothing to leak.
  const uncontrolled = await privateCapture('uncontrolled')();
  assert.deepEqual(inputValues(uncontrolled), []);
});
