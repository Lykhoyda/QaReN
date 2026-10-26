import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AppProcessGoneError,
  NativeCaptureError,
  captureScreen,
} from '../../../dist/qa/capture.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import type { NativeObservation, ReactObservation } from '../../../dist/qa/capture.js';
import { assertionView, visibilityView } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import type { TimingEvent } from '../../../dist/qa/timing.js';

const nodes: NativeNode[] = [
  {
    ref: '@save',
    index: 7,
    parentIndex: 2,
    depth: 3,
    type: 'Button',
    identifier: 'save',
    label: 'Save',
    hittable: true,
  },
];
const interactive: DigestEntry[] = [
  { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
  { role: 'button', testID: 'later', text: 'Later' },
];
const snapshotVerdict = {
  state: 'ok',
  source: 'rn-fast-runner',
  nodeCount: 1,
  refMapUpdated: true,
  reasons: [],
};
const verdict = { state: 'ok', path: 'interactive', complete: true };
const hostEvidence: ReactHostEvidence = {
  hosts: [{ testID: 'save', role: 'button', roleSource: 'role', capabilities: { press: true } }],
  complete: true,
};

test('a dropped native observation cannot turn 31 raw controls into an admissible set of 30', async () => {
  const retained = Array.from({ length: 30 }, (_, index) => ({
    ref: `@${index}`,
    type: 'Button',
    label: `Control ${index}`,
    hittable: true,
  }));
  const screen = await captureScreen({
    native: async () => ({
      nodes: retained,
      truncated: false,
      normalizationDroppedNodes: 1,
      snapshotVerdict: { ...snapshotVerdict, nodeCount: 30 },
    }),
    react: async () => ({ interactive: [], verdict }),
  });
  assert.equal(screen.captureCoverage?.native, 'incomplete');
  assert.equal(screen.coverage?.native, 'incomplete');
  const decision = await decideScreen(
    screen,
    {
      calls: [],
      ask: async () => assert.fail('a normalization loss must refuse before Jev'),
    },
    undefined,
    { kind: 'press', target: { phrase: 'the first control' }, line: 1 },
  );
  assert.ok(decision.target && 'refuse' in decision.target);
  assert.equal(decision.target.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('an incomplete native capture names its causes as content-free codes', async () => {
  const screen = await captureScreen({
    native: async () => ({
      nodes,
      truncated: true,
      normalizationDroppedNodes: 2,
      snapshotVerdict: {
        ...snapshotVerdict,
        state: 'degraded',
        nodeCount: 3,
        refMapUpdated: false,
        reasons: ['snapshot-ref-freshness-unknown', 'Welcome back, Anton', 'anton'],
      },
      presenceCapture: { complete: false, startedUptimeMs: 1_000, endedUptimeMs: 6_012.4 },
    }),
    react: async () => ({ interactive, verdict }),
  });
  assert.deepEqual(screen.nativeCaptureCauses, [
    'truncated',
    'dropped=2',
    'verdict=degraded',
    'ref-map-not-updated',
    'reason=snapshot-ref-freshness-unknown',
    'reason=unrecognized',
    'reason=unrecognized',
    'keyboard-state-unknown',
    'snapshot-generation-unknown',
    'node-count-mismatch',
    'presence-incomplete',
    'presence-ms=5012',
    'nodes=1',
    'reported-observed=0',
  ]);
  const view = visibilityView(screen);
  assert.ok('refuse' in view);
  assert.match(view.reason, /native capture: truncated, dropped=2, verdict=degraded/);
  assert.doesNotMatch(view.reason, /anton/i);

  const complete = await captureScreen({
    native: async () => ({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict,
    }),
    react: async () => ({ interactive, verdict }),
  });
  assert.equal(complete.nativeCaptureCauses, undefined);
});

test('discarded presence evidence on a complete native capture names why', async () => {
  const cases: Array<[string, Record<string, unknown>, number, string[]]> = [
    [
      'runner could not finish',
      { complete: false, startedUptimeMs: 0, endedUptimeMs: 5_001 },
      100,
      ['presence-incomplete', 'presence-ms=5001', 'nodes=1', 'reported-observed=0'],
    ],
    [
      'evidence fails validation',
      { complete: true, startedUptimeMs: 0, endedUptimeMs: 1_200 },
      1_300,
      [
        'presence-rejected',
        'presence-ms=1200',
        'nodes=1',
        'reported-observed=0',
        'capture-ms=1300',
      ],
    ],
    [
      'capture outlived the budget',
      { complete: true, startedUptimeMs: 0, endedUptimeMs: 3_100 },
      22_400,
      [
        'capture-over-budget',
        'presence-ms=3100',
        'nodes=1',
        'reported-observed=0',
        'capture-ms=22400',
      ],
    ],
  ];
  for (const [name, presenceCapture, elapsed, causes] of cases) {
    const times = [0, elapsed];
    const screen = await captureScreen({
      now: () => times.shift() ?? elapsed,
      appId: 'com.example',
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
        snapshotGeneration: 1,
        presenceCapture,
      }),
      react: async () => ({ interactive, verdict, hostEvidence }),
    });
    assert.equal(screen.captureCoverage?.native, 'complete', name);
    assert.equal(screen.coverage?.native, 'incomplete', name);
    assert.deepEqual(screen.nativeCaptureCauses, causes, name);
    const view = visibilityView(screen);
    assert.ok('refuse' in view, name);
    assert.ok(view.reason.includes(`native capture: ${causes.join(', ')}`), name);
  }
});

test('native deadline diagnostics survive coverage refusal without becoming evidence', async () => {
  const observation = nativeCapture();
  const diagnostics = {
    phaseMs: {
      'initial-eligibility': 10,
      enumeration: 20,
      observation: 4791.2,
      'final-eligibility': 0,
    },
    failure: { phase: 'observation', reason: 'deadline' },
    deadline: { phase: 'observation', read: 'first-match', edge: 'after' },
  };
  const screen = await captureScreen({
    appId: 'com.test',
    native: async () => ({
      ...observation,
      snapshotVerdict: {
        ...observation.snapshotVerdict,
        state: 'degraded',
        refMapUpdated: false,
        reasons: ['snapshot-ref-freshness-unknown'],
      },
      presenceCapture: {
        ...observation.presenceCapture,
        complete: false,
        endedUptimeMs: 4921.2,
        diagnostics,
      },
    }),
    react: async () => ({ interactive: [], verdict, hostEvidence: { hosts: [], complete: true } }),
  });
  assert.equal(screen.coverage?.native, 'incomplete');
  const view = visibilityView(screen);
  assert.ok('refuse' in view);
  assert.equal(view.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  for (const cause of [
    'presence-ms=4821',
    'presence-failure=observation:deadline',
    'presence-deadline=observation:first-match:after',
    'presence-initial-eligibility-ms=10',
    'presence-enumeration-ms=20',
    'presence-observation-ms=4791',
    'presence-final-eligibility-ms=0',
  ]) {
    assert.ok(screen.nativeCaptureCauses?.includes(cause), cause);
    assert.ok(view.reason.includes(cause), cause);
  }
  assert.doesNotMatch(view.reason, /presence-revalidation-ms/);
  const decision = await decideScreen(
    screen,
    { calls: [], ask: async () => assert.fail('diagnostics cannot authorize a judgment') },
    undefined,
    { kind: 'wait', target: { phrase: 'the tasks heading' }, line: 14 },
  );
  assert.ok(decision.visibility && 'refuse' in decision.visibility);
  assert.equal(decision.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('native diagnostic strings and timings are bounded and allowlisted', async () => {
  const baseline = ['presence-incomplete', 'nodes=1', 'reported-observed=0'];
  for (const diagnostics of [
    undefined,
    null,
    'private-content',
    [],
    {
      phaseMs: {
        'initial-eligibility': -1,
        enumeration: NaN,
        observation: Infinity,
        'final-eligibility': 'private-content',
        revalidation: Number.MAX_VALUE,
        'private-content': 1,
      },
      failure: { phase: 'private-content', reason: 'deadline' },
      deadline: { phase: 'observation', read: 'private-content', edge: 'after' },
    },
    {
      phaseMs: [],
      failure: { phase: 'observation', reason: 'private-content' },
      deadline: { phase: 'observation', read: 'first-match', edge: 'private-content' },
    },
    {
      failure: { phase: 'observation' },
      deadline: { phase: 'private-content', read: 'first-match', edge: 'after' },
    },
  ]) {
    const screen = await captureScreen({
      native: async () => ({ nodes, presenceCapture: { complete: false, diagnostics } }),
      react: async () => ({ interactive: [], verdict }),
    });
    assert.deepEqual(screen.nativeCaptureCauses, baseline);
  }
});

test('first-mismatch diagnostics accept only bounded structural fields and never change admission', async () => {
  const secret = 'PRIVATE-mismatch-canary';
  const mismatch = { kind: 'node', index: 1, fieldMask: 16, beforeType: 9, afterType: 48 };
  const capture = async (detail: unknown, reason = 'enumeration-changed', throwSink = false) => {
    const logs: string[] = [];
    const source = nativeCapture();
    const screen = await captureScreen({
      appId: 'com.test',
      now: () => 0,
      native: async () => ({
        ...source,
        presenceCapture: {
          ...source.presenceCapture,
          complete: false,
          diagnostics: { failure: { phase: 'revalidation', reason, mismatch: detail } },
        },
      }),
      react: async () => ({
        interactive: [],
        verdict,
        hostEvidence: { hosts: [], complete: true },
      }),
      warn: (line) => {
        logs.push(line);
        if (throwSink && line.startsWith('presence-mismatch=')) throw new Error(secret);
      },
    });
    assert.equal(screen.coverage?.native, 'incomplete');
    assert.ok('refuse' in visibilityView(screen));
    assert.ok(!JSON.stringify({ screen, logs }).includes(secret));
    return { screen, logs };
  };
  const safe = await capture({
    ...mismatch,
    label: secret,
    value: secret,
    identifier: secret,
    hash: secret,
  });
  assert.deepEqual(safe.logs, [
    'presence-failure=revalidation:enumeration-changed',
    'presence-mismatch=kind=node,index=1,fieldMask=16,beforeType=9,afterType=48',
  ]);
  assert.ok(safe.screen.nativeCaptureCauses?.includes(safe.logs[1]));
  assert.deepEqual(await capture(mismatch, 'enumeration-changed', true), safe);
  for (const detail of [
    undefined,
    null,
    [],
    secret,
    { ...mismatch, kind: secret },
    ...['index', 'fieldMask', 'beforeType', 'afterType'].flatMap((key) =>
      [secret, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, {}].map((value) => ({
        ...mismatch,
        [key]: value,
      })),
    ),
    { ...mismatch, index: 600 },
    { ...mismatch, index: undefined },
    { ...mismatch, fieldMask: 512 },
    { ...mismatch, fieldMask: 0 },
    { ...mismatch, beforeType: 65536 },
    { ...mismatch, afterType: 65536 },
  ]) {
    const { logs } = await capture(detail);
    assert.deepEqual(logs, ['presence-failure=revalidation:enumeration-changed']);
  }
  for (const kind of ['descriptor-count', 'added-node', 'missing-node']) {
    const detail = { kind, fieldMask: 0, ...(kind === 'descriptor-count' ? {} : { index: 1 }) };
    const { logs } = await capture(detail);
    assert.equal(
      logs[1],
      `presence-mismatch=kind=${kind}${kind === 'descriptor-count' ? '' : ',index=1'},fieldMask=0`,
    );
  }
  const { logs } = await capture({ kind: 'node', index: 599, fieldMask: 511, afterType: 65535 });
  assert.equal(logs[1], 'presence-mismatch=kind=node,index=599,fieldMask=511,afterType=65535');
  assert.deepEqual((await capture(mismatch, 'read-unavailable')).logs, [
    'presence-failure=revalidation:read-unavailable',
  ]);
  const geometry = {
    changedMask: 15,
    beforeFiniteMask: 15,
    afterFiniteMask: 15,
    deltaFiniteMask: 15,
    dx: 0.125,
    dy: -0.25,
    dWidth: 0.5,
    dHeight: -1,
    beforeNull: false,
    afterNull: false,
    beforeInfinite: false,
    afterInfinite: false,
    beforeInvalidSize: false,
    afterInvalidSize: false,
  };
  const detailed = {
    ...mismatch,
    geometry,
    ancestorTypes: [1],
    ancestorsTruncated: false,
  };
  const enriched = await capture({
    ...detailed,
    geometry: {
      ...geometry,
      x: secret,
      y: secret,
      width: secret,
      height: secret,
      before: { frame: secret },
      label: secret,
      identifier: secret,
      value: secret,
      hash: secret,
    },
    ancestorLabels: [secret],
  });
  assert.deepEqual(enriched.logs, [
    safe.logs[0],
    `${safe.logs[1]},geometry=${JSON.stringify(geometry)},ancestorTypes=[1],ancestorsTruncated=false`,
  ]);
  assert.deepEqual(await capture(detailed, 'enumeration-changed', true), enriched);
  assert.ok(enriched.screen.nativeCaptureCauses?.includes(enriched.logs[1]));
  const decision = await decideScreen(
    enriched.screen,
    { calls: [], ask: async () => assert.fail('geometry diagnostics must not authorize Jev') },
    undefined,
    { kind: 'wait', target: { phrase: 'the heading' }, line: 10 },
  );
  assert.ok(decision.visibility && 'refuse' in decision.visibility);
  assert.equal(decision.visibility.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
  for (const detail of [
    ...[null, [], secret].map((geometry) => ({ ...detailed, geometry })),
    ...['changedMask', 'beforeFiniteMask', 'afterFiniteMask', 'deltaFiniteMask'].flatMap((key) =>
      [-1, 16, 1.5, NaN, Infinity, secret, null, undefined].map((value) => ({
        ...detailed,
        geometry: { ...geometry, [key]: value },
      })),
    ),
    ...['dx', 'dy', 'dWidth', 'dHeight'].flatMap((key) =>
      [NaN, Infinity, -Infinity, secret, null, undefined, {}].map((value) => ({
        ...detailed,
        geometry: { ...geometry, [key]: value },
      })),
    ),
    ...[
      'beforeNull',
      'afterNull',
      'beforeInfinite',
      'afterInfinite',
      'beforeInvalidSize',
      'afterInvalidSize',
    ].flatMap((key) =>
      [0, 1, secret, null, undefined, {}].map((value) => ({
        ...detailed,
        geometry: { ...geometry, [key]: value },
      })),
    ),
    { ...detailed, geometry: { ...geometry, afterFiniteMask: 14 } },
    { ...detailed, geometry: { ...geometry, deltaFiniteMask: 14 } },
    { ...detailed, geometry: { ...geometry, changedMask: 14 } },
    { ...detailed, geometry: { ...geometry, dx: 0 } },
    { ...detailed, beforeType: undefined },
    ...[
      undefined,
      null,
      {},
      secret,
      Array(17).fill(1),
      Array(1),
      [-1],
      [65536],
      [1.5],
      [NaN],
      [Infinity],
      [secret],
      [null],
    ].map((ancestorTypes) => ({ ...detailed, ancestorTypes })),
    ...[undefined, null, 0, 1, secret, {}].map((ancestorsTruncated) => ({
      ...detailed,
      ancestorsTruncated,
    })),
    { kind: 'descriptor-count', fieldMask: 0, geometry },
    { kind: 'missing-node', index: 1, fieldMask: 0, ancestorTypes: [1], ancestorsTruncated: false },
  ]) {
    assert.deepEqual((await capture(detail)).logs, [safe.logs[0]], JSON.stringify(detail));
  }
  const partial = { ...geometry, afterFiniteMask: 14, deltaFiniteMask: 14, dx: undefined };
  assert.ok(
    (await capture({ ...detailed, geometry: partial })).logs[1].includes(
      `geometry=${JSON.stringify(partial)}`,
    ),
  );
  for (const dx of [
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    1.7763568394002505e-15,
  ]) {
    const detail = { ...detailed, geometry: { ...geometry, dx } };
    assert.ok((await capture(detail)).logs[1].includes(`"dx":${dx}`));
  }
  const longest = await capture({
    ...detailed,
    index: 599,
    ancestorTypes: Array(16).fill(65535),
    ancestorsTruncated: true,
  });
  assert.ok(
    longest.logs[1].endsWith(
      `ancestorTypes=${JSON.stringify(Array(16).fill(65535))},ancestorsTruncated=true`,
    ),
  );
  assert.ok(longest.logs[1].length < 800);
});

test('preparation diagnostics expose only scalar quiet-window facts on success and refusal', async () => {
  const secret = 'PRIVATE-preparation-canary';
  for (const complete of [true, false]) {
    const source = nativeCapture();
    const logs: string[] = [];
    const events: TimingEvent[] = [];
    let now = 0;
    const screen = await captureScreen({
      appId: 'com.test',
      now: () => now,
      native: async () => {
        now += 900;
        return {
          ...source,
          presenceCapture: {
            ...source.presenceCapture,
            complete,
            endedUptimeMs: 1_000,
            diagnostics: {
              preparationSamples: 8,
              preparationResets: 1,
              preparationQuietWindowMs: 500,
              preparationQuietElapsedMs: 500.25,
              phaseMs: { preparation: 700.25, [secret]: 1 },
              ...(complete
                ? {}
                : {
                    failure: { phase: 'preparation', reason: 'deadline' },
                    deadline: { phase: 'preparation', read: 'preparation-poll', edge: 'after' },
                  }),
              label: secret,
              descriptor: secret,
              treeHash: secret,
            },
          },
        };
      },
      react: async () => ({
        interactive: [],
        verdict,
        hostEvidence: { hosts: [], complete: true },
      }),
      warn: (line) => logs.push(line),
      timing: (event) => events.push(event),
    });
    assert.equal(screen.coverage?.native, complete ? 'complete' : 'incomplete');
    assert.ok(logs.includes('presence-preparation-samples=8'));
    assert.ok(logs.includes('presence-preparation-ms=700'));
    assert.ok(logs.includes('presence-preparation-quiet-window-ms=500'));
    assert.ok(logs.includes('presence-preparation-resets=1'));
    assert.ok(logs.includes('presence-preparation-quiet-elapsed-ms=500.25'));
    assert.deepEqual(
      events.find((event) => event.stage === 'native-preparation'),
      {
        stage: 'native-preparation',
        edge: 'point',
        outcome: complete ? 'ok' : 'failed',
        at: 900,
        ms: 700.25,
        count: 8,
      },
    );
    assert.equal(events.find((event) => event.stage === 'native-production')?.ms, 900);
    assert.equal(
      events.find((event) => event.stage === 'native-total' && event.edge === 'end')?.ms,
      900,
    );
    if (!complete) {
      assert.ok(logs.includes('presence-failure=preparation:deadline'));
      assert.ok(logs.includes('presence-deadline=preparation:preparation-poll:after'));
      assert.ok(screen.nativeCaptureCauses?.includes('presence-preparation-samples=8'));
      assert.ok(
        screen.nativeCaptureCauses?.includes('presence-preparation-quiet-elapsed-ms=500.25'),
      );
    }
    assert.ok(!JSON.stringify({ screen, events, logs }).includes(secret));
  }
  for (const value of [
    undefined,
    null,
    secret,
    {},
    [],
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const logs: string[] = [];
    const events: TimingEvent[] = [];
    await captureScreen({
      native: async () => ({
        presenceCapture: {
          diagnostics: { preparationSamples: value, phaseMs: { preparation: secret } },
        },
      }),
      react: async () => ({}),
      warn: (line) => logs.push(line),
      timing: (event) => events.push(event),
    });
    assert.ok(!logs.some((line) => line.includes('preparation')));
    assert.ok(!events.some((event) => event.stage === 'native-preparation'));
    assert.ok(!JSON.stringify({ logs, events }).includes(secret));
  }
});

test('quiet-window diagnostics reject malformed scalars and cannot change admission through a sink', async () => {
  const secret = 'PRIVATE-quiet-canary';
  const valid = {
    preparationSamples: 6,
    preparationResets: 0,
    preparationQuietWindowMs: 500,
    preparationQuietElapsedMs: 500,
    phaseMs: { preparation: 500 },
    descriptor: secret,
    treeHash: secret,
  };
  const malformed: object[] = [];
  for (const field of [
    'preparationSamples',
    'preparationResets',
    'preparationQuietWindowMs',
    'preparationQuietElapsedMs',
  ]) {
    for (const value of [
      undefined,
      null,
      secret,
      {},
      [],
      -1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ])
      malformed.push({ ...valid, [field]: value });
  }
  malformed.push(
    { ...valid, preparationSamples: 1 },
    { ...valid, preparationSamples: 1.5 },
    { ...valid, preparationResets: 6 },
    { ...valid, preparationResets: 0.5 },
    { ...valid, preparationQuietWindowMs: 501 },
    { ...valid, preparationQuietElapsedMs: 501 },
    { ...valid, preparationQuietElapsedMs: 20_000, phaseMs: { preparation: 20_000 } },
    ...[undefined, null, secret, NaN, Infinity, -1, 499].map((value) => ({
      ...valid,
      phaseMs: { preparation: value },
    })),
  );
  const source = nativeCapture();
  for (const diagnostics of malformed) {
    const logs: string[] = [];
    const screen = await captureScreen({
      appId: 'com.test',
      native: async () => ({
        ...source,
        presenceCapture: { ...source.presenceCapture, complete: false, diagnostics },
      }),
      react: async () => ({}),
      warn: (line) => logs.push(line),
    });
    assert.equal(screen.coverage?.native, 'incomplete');
    assert.ok(!logs.some((line) => /preparation-(quiet|resets)/.test(line)));
    assert.ok(!JSON.stringify({ screen, logs }).includes(secret));
  }
  for (const complete of [true, false]) {
    const capture = (warn?: (line: string) => void) =>
      captureScreen({
        appId: 'com.test',
        now: () => 0,
        native: async () => ({
          ...source,
          presenceCapture: { ...source.presenceCapture, complete, diagnostics: valid },
        }),
        react: async () => ({
          interactive: [],
          verdict,
          hostEvidence: { hosts: [], complete: true },
        }),
        warn,
      });
    const baseline = await capture();
    assert.equal(baseline.coverage?.native, complete ? 'complete' : 'incomplete');
    assert.deepEqual(
      await capture(() => {
        throw new Error(secret);
      }),
      baseline,
    );
  }
});

test('optional native diagnostics never change coverage or a successful projection', async () => {
  const observation = nativeCapture();
  const capture = (diagnostics?: unknown) =>
    captureScreen({
      appId: 'com.test',
      now: () => 0,
      native: async () => ({
        ...observation,
        presenceCapture: { ...observation.presenceCapture, diagnostics },
      }),
      react: async () => ({
        interactive: [],
        verdict,
        hostEvidence: { hosts: [], complete: true },
      }),
    });
  const baseline = await capture();
  assert.equal(baseline.coverage?.native, 'complete');
  assert.ok(!('refuse' in visibilityView(baseline)));
  for (const diagnostics of [
    null,
    'private-content',
    { preparationSamples: 3, phaseMs: { preparation: 200 } },
    {
      preparationSamples: 6,
      preparationResets: 0,
      preparationQuietWindowMs: 500,
      preparationQuietElapsedMs: 500,
      phaseMs: { preparation: 500 },
    },
    {
      failure: {
        phase: 'revalidation',
        reason: 'enumeration-changed',
        mismatch: { kind: 'node', index: 1, fieldMask: 16, beforeType: 9, afterType: 9 },
      },
    },
    { phaseMs: { observation: -1 }, failure: { phase: 'observation', reason: 'deadline' } },
    {
      phaseMs: { observation: 4821 },
      failure: { phase: 'observation', reason: 'deadline' },
      deadline: { phase: 'observation', read: 'first-match', edge: 'after' },
    },
  ]) {
    assert.deepEqual(await capture(diagnostics), baseline);
  }
});

test('complete acquisition preserves legacy joins without claiming semantic enumeration', async () => {
  const screen = await captureScreen({
    native: async () => ({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict,
    }),
    react: async () => ({ interactive, verdict }),
  });

  assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'complete' });
  assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
  assert.equal(screen.reactHostEvidence, undefined);
  assert.deepEqual(
    screen.elements.map((element) => [element.ref, element.testID, element.label]),
    [
      ['@save', 'save', 'Save'],
      ['react:later', 'later', undefined],
    ],
  );
  assert.deepEqual(assertionView(screen), ['Save']);
  assert.ok(screen.elements.every((element) => element.semantic?.visibility === 'unknown'));
  assert.ok('refuse' in visibilityView(screen));
});

test('native acquisition coverage needs capture-time readiness as well as untruncated nodes', async () => {
  const cases: Array<[string, NativeObservation, 'unknown' | 'incomplete']> = [
    ['missing normalization coverage', { nodes, truncated: false, snapshotVerdict }, 'unknown'],
    [
      'malformed normalization coverage',
      { nodes, truncated: false, normalizationDroppedNodes: '0', snapshotVerdict },
      'unknown',
    ],
    [
      'negative normalization coverage',
      { nodes, truncated: false, normalizationDroppedNodes: -1, snapshotVerdict },
      'unknown',
    ],
    ['missing metadata', { nodes }, 'unknown'],
    ['missing verdict', { nodes, truncated: false }, 'unknown'],
    ['missing truncation', { nodes, snapshotVerdict }, 'unknown'],
    ['untyped truncation', { nodes, truncated: 'false', snapshotVerdict }, 'unknown'],
    ['false with missing nodes', { truncated: false, snapshotVerdict }, 'unknown'],
    ['false with empty nodes and no verdict', { nodes: [], truncated: false }, 'unknown'],
    ['truncated', { nodes, truncated: true, snapshotVerdict }, 'incomplete'],
    [
      'degraded nonempty capture',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, state: 'degraded' } },
      'incomplete',
    ],
    [
      'degraded empty capture',
      {
        nodes: [],
        truncated: false,
        snapshotVerdict: {
          ...snapshotVerdict,
          state: 'degraded',
          nodeCount: 0,
          refMapUpdated: false,
          reasons: ['empty-capture'],
        },
      },
      'incomplete',
    ],
    [
      'empty cannot claim readiness',
      { nodes: [], truncated: false, snapshotVerdict: { ...snapshotVerdict, nodeCount: 0 } },
      'incomplete',
    ],
    [
      'refs not updated',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, refMapUpdated: false } },
      'incomplete',
    ],
    [
      'verdict describes a different capture',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, nodeCount: 2 } },
      'incomplete',
    ],
    [
      'quality reasons cannot be ignored',
      {
        nodes,
        truncated: false,
        snapshotVerdict: { ...snapshotVerdict, reasons: ['empty-capture'] },
      },
      'incomplete',
    ],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => observation,
      react: async () => ({ interactive, verdict }),
    });
    assert.equal(screen.captureCoverage?.native, expected, name);
    assert.equal(screen.captureCoverage?.react, 'complete', name);
    assert.equal(screen.coverage?.native, expected, name);
    assert.equal(screen.coverage?.react, 'unknown', name);
    assert.deepEqual(assertionView(screen), observation.nodes?.length ? ['Save'] : [], name);
    assert.ok('refuse' in visibilityView(screen), name);
  }
});

test('React acquisition coverage never turns unavailable digests into complete emptiness', async () => {
  const cases: Array<[string, ReactObservation, 'unknown' | 'incomplete' | 'complete']> = [
    ['unavailable', {}, 'unknown'],
    ['missing metadata', { interactive }, 'unknown'],
    ['false without metadata', { interactive, truncated: false }, 'unknown'],
    ['missing entries', { truncated: false, verdict }, 'unknown'],
    [
      'missing completeness',
      { interactive, verdict: { state: 'ok', path: 'interactive' } },
      'unknown',
    ],
    ['missing state', { interactive, verdict: { path: 'interactive', complete: true } }, 'unknown'],
    ['missing path', { interactive, verdict: { state: 'ok', complete: true } }, 'unknown'],
    ['untyped truncation', { interactive, verdict, truncated: 'false' }, 'unknown'],
    ['truncated', { interactive, verdict, truncated: true }, 'incomplete'],
    ['failed', { interactive, verdict: { ...verdict, state: 'failed' } }, 'incomplete'],
    ['degraded', { interactive, verdict: { ...verdict, state: 'degraded' } }, 'incomplete'],
    ['incomplete walk', { interactive, verdict: { ...verdict, complete: false } }, 'incomplete'],
    ['wrong path', { interactive, verdict: { ...verdict, path: 'tree' } }, 'incomplete'],
    [
      'no renderer',
      { verdict: { state: 'failed', path: 'none', complete: false, reasons: ['no-renderer'] } },
      'incomplete',
    ],
    [
      'truncation in verdict',
      { interactive, verdict: { ...verdict, reasons: ['output-truncated'] } },
      'incomplete',
    ],
    ['complete empty digest', { interactive: [], verdict }, 'complete'],
    ['explicitly untruncated', { interactive, verdict, truncated: false }, 'complete'],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
      }),
      react: async () => observation,
    });
    assert.equal(screen.captureCoverage?.native, 'complete', name);
    assert.equal(screen.captureCoverage?.react, expected, name);
    assert.equal(screen.coverage?.native, 'unknown', name);
    assert.equal(
      screen.coverage?.react,
      expected === 'incomplete' ? 'incomplete' : 'unknown',
      name,
    );
    assert.deepEqual(assertionView(screen), ['Save'], name);
    assert.equal(
      screen.elements.some((element) => element.ref === 'react:later'),
      observation.interactive === interactive,
      name,
    );
    assert.ok('refuse' in visibilityView(screen), name);
  }
});

test('React semantic coverage requires validated opt-in host evidence, not digest quality', async () => {
  const cases: Array<[string, unknown, 'unknown' | 'incomplete' | 'complete']> = [
    ['absent evidence', undefined, 'unknown'],
    ['null evidence', null, 'incomplete'],
    ['non-object evidence', false, 'incomplete'],
    ['array evidence', [], 'incomplete'],
    ['missing hosts', { complete: true }, 'incomplete'],
    ['non-array hosts', { hosts: {}, complete: true }, 'incomplete'],
    ['missing completeness', { hosts: [] }, 'incomplete'],
    ['untyped completeness', { hosts: [], complete: 'true' }, 'incomplete'],
    ['malformed host', { hosts: [null], complete: true }, 'incomplete'],
    [
      'missing host metadata',
      { hosts: [{ testID: 'save', role: 'button' }], complete: true },
      'incomplete',
    ],
    [
      'invalid role source',
      { hosts: [{ ...hostEvidence.hosts[0], roleSource: 'inferred' }], complete: true },
      'incomplete',
    ],
    [
      'invalid capability',
      { hosts: [{ ...hostEvidence.hosts[0], capabilities: { press: false } }], complete: true },
      'incomplete',
    ],
    ['explicitly incomplete hosts', { ...hostEvidence, complete: false }, 'incomplete'],
    ['explicitly incomplete empty hosts', { hosts: [], complete: false }, 'incomplete'],
    ['complete empty hosts', { hosts: [], complete: true }, 'complete'],
    ['complete hosts', hostEvidence, 'complete'],
  ];
  for (const [name, evidence, expected] of cases) {
    const native: NativeObservation = {
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict,
    };
    const react: ReactObservation = {
      interactive,
      verdict,
      ...(evidence === undefined ? {} : { hostEvidence: evidence }),
    };
    const before = structuredClone({ native, react });
    const screen = await captureScreen({
      native: async () => native,
      react: async () => react,
      warn: () => assert.fail('host evidence must not be logged'),
    });
    assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'complete' }, name);
    assert.deepEqual(screen.coverage, { native: 'unknown', react: expected }, name);
    assert.deepEqual(assertionView(screen), ['Save'], name);
    const validEvidence =
      expected === 'complete' || name.startsWith('explicitly incomplete') ? evidence : undefined;
    assert.deepEqual(screen.reactHostEvidence, validEvidence, name);

    const decision = await decideScreen(
      screen,
      { calls: [], ask: async () => assert.fail(`${name}: native enumeration is still unknown`) },
      undefined,
      { kind: 'press', target: { phrase: 'the save control' }, line: 1 },
    );
    assert.ok(decision.target && 'refuse' in decision.target, name);
    assert.equal(decision.target.refuse, 'SCREEN_EVIDENCE_INCOMPLETE', name);
    assert.deepEqual({ native, react }, before, `${name}: observations must not be mutated`);
  }
});

test('complete host evidence cannot repair missing or incomplete interactive acquisition', async () => {
  const cases: Array<[string, ReactObservation, 'unknown' | 'incomplete' | 'complete']> = [
    ['missing digest', { verdict }, 'unknown'],
    ['missing verdict', { interactive }, 'unknown'],
    ['failed digest', { interactive, verdict: { ...verdict, state: 'failed' } }, 'incomplete'],
    ['truncated digest', { interactive, verdict, truncated: true }, 'incomplete'],
    ['wrong path', { interactive, verdict: { ...verdict, path: 'tree' } }, 'incomplete'],
    ['successful digest', { interactive, verdict }, 'complete'],
    ['successful empty digest', { interactive: [], verdict }, 'complete'],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => ({ nodes }),
      react: async () => ({ ...observation, hostEvidence }),
    });
    assert.equal(screen.captureCoverage?.react, expected, name);
    assert.equal(screen.coverage?.react, expected, name);
    assert.deepEqual(screen.reactHostEvidence, hostEvidence, name);
    assert.deepEqual(assertionView(screen), ['Save'], name);
  }
});

test('invalid or explicitly incomplete host evidence dominates unknown acquisition', async () => {
  for (const evidence of [null, { hosts: [], complete: false }]) {
    const screen = await captureScreen({
      native: async () => ({ nodes }),
      react: async () => ({ hostEvidence: evidence }),
    });
    assert.equal(screen.captureCoverage?.react, 'unknown');
    assert.equal(screen.coverage?.react, 'incomplete');
    assert.deepEqual(assertionView(screen), ['Save']);
  }
});

test('digest errors preserve native literals and warn without logging private payloads', async () => {
  const warnings: string[] = [];
  const error = new Error('digest contained password=sensitive-value and token=private-token');
  error.toString = () => assert.fail('capture must not stringify the digest error');
  for (const warn of [undefined, (message: string) => warnings.push(message)]) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
      }),
      react: async () => {
        throw error;
      },
      warn,
    });
    assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'unknown' });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(assertionView(screen), ['Save']);
    assert.deepEqual(
      screen.elements.map((element) => element.ref),
      ['@save'],
    );
  }
  assert.deepEqual(warnings, [
    'interactive digest unavailable; React coverage is unknown; observation=null mode=ordinary',
  ]);
});

test('non-array adapter data stays unknown rather than masquerading as a complete empty capture', async () => {
  for (const raw of ['null', 'false', '{}', '"unavailable"']) {
    const screen = await captureScreen({
      native: async () => ({ nodes: JSON.parse(raw), truncated: false, snapshotVerdict }),
      react: async () => ({ interactive: JSON.parse(raw), truncated: false, verdict }),
    });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' }, raw);
    assert.deepEqual(screen.captureCoverage, { native: 'unknown', react: 'unknown' }, raw);
    assert.deepEqual(screen.elements, [], raw);
    assert.ok('refuse' in visibilityView(screen), raw);
  }
});

test('malformed verdicts do not establish coverage from false truncation flags', async () => {
  for (const metadata of [undefined, null, false, 'ok', [], {}, { complete: true }]) {
    const screen = await captureScreen({
      native: async () => ({ nodes, truncated: false, snapshotVerdict: metadata }),
      react: async () => ({ interactive, truncated: false, verdict: metadata }),
    });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(screen.captureCoverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(assertionView(screen), ['Save']);
  }
});

test('capture awaits one native read before one React read and leaves native hierarchy intact', async () => {
  const calls: string[] = [];
  const read = Promise.withResolvers<NativeObservation>();
  const nativeNodes: NativeNode[] = [
    { ref: '@dialog', type: 'Alert', index: 0, parentIndex: -1, depth: 0 },
    { ref: '@confirm', type: 'Button', label: 'Confirm', index: 4, parentIndex: 0, depth: 1 },
  ];
  nativeNodes.forEach(Object.freeze);
  Object.freeze(nativeNodes);
  const pending = captureScreen({
    native: () => {
      calls.push('native');
      return read.promise;
    },
    react: async () => {
      calls.push('react');
      return { interactive: [], verdict };
    },
    warn: () => assert.fail('successful reads must not log their contents'),
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['native']);
  read.resolve({ nodes: nativeNodes });
  const screen = await pending;
  assert.deepEqual(calls, ['native', 'react']);
  assert.equal(screen.front, 'dialog');
  assert.deepEqual(assertionView(screen), ['Confirm']);
  assert.deepEqual(nativeNodes, [
    { ref: '@dialog', type: 'Alert', index: 0, parentIndex: -1, depth: 0 },
    { ref: '@confirm', type: 'Button', label: 'Confirm', index: 4, parentIndex: 0, depth: 1 },
  ]);
});

test('surface observations retain the existing dev-menu and picker classification', async () => {
  for (const [surface, front] of [
    ['expo_dev_menu', 'dev-menu'],
    ['react_native_dev_menu', 'dev-menu'],
    ['dev_client_picker', 'picker'],
    ['first_run_tutorial', 'picker'],
    ['unknown', 'app'],
  ]) {
    const screen = await captureScreen({
      native: async () => ({ nodes, surface }),
      react: async () => ({}),
    });
    assert.equal(screen.front, front, surface);
  }
});

test('native errors propagate unchanged without reading React or logging payloads', async () => {
  const failure = new Error('native capture failed');
  let reads = 0;
  await assert.rejects(
    captureScreen({
      native: async () => {
        reads += 1;
        throw failure;
      },
      react: () => assert.fail('React cannot be read after native failure'),
      warn: () => assert.fail('native errors must not be swallowed or logged'),
    }),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});

test('the runner-reported app process identifier reaches the screen only when it is a positive integer', async () => {
  for (const [reported, expected] of [
    [4242, 4242],
    [0, undefined],
    [-7, undefined],
    [1.5, undefined],
    ['4242', undefined],
    [undefined, undefined],
  ] as const) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
        ...(reported === undefined ? {} : { appProcessIdentifier: reported }),
      }),
      react: async () => ({ interactive, verdict, hostEvidence }),
    });
    assert.equal(screen.appProcessIdentifier, expected, String(reported));
  }
});

test('the runner-reported keyboard state reaches the screen only when it is a boolean', async () => {
  for (const [reported, expected] of [
    [true, true],
    [false, false],
    ['true', undefined],
    [1, undefined],
    [undefined, undefined],
  ] as const) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
        ...(reported === undefined ? {} : { keyboardVisible: reported }),
      }),
      react: async () => ({ interactive, verdict, hostEvidence }),
    });
    assert.equal(screen.keyboardVisible, expected, String(reported));
  }
});

test('a gone app process passes through private capture; other native failures stay content-free', async () => {
  const fail = (error: Error) =>
    captureScreen({
      requirePrivateInputs: true,
      native: async () => {
        throw error;
      },
      react: async () => ({ interactive, verdict, hostEvidence }),
    });
  await assert.rejects(fail(new AppProcessGoneError()), AppProcessGoneError);
  await assert.rejects(fail(new Error('secret runner detail')), NativeCaptureError);
});

test('unrecognised system-modal diagnostics survive privacy refusal with no app content', async () => {
  const logs: string[] = [];
  const systemModal = {
    appState: 'runningForeground',
    alertCount: 1,
    sheetCount: 0,
    modals: [
      {
        exists: true,
        frameEmpty: false,
        centerInViewport: true,
        springboardFrameEmpty: false,
        descendantTypes: [{ type: 9, count: 2 }],
        hittableDescendantCount: 0,
        label: 'private modal',
      },
    ],
    identifier: 'private-id',
  };
  await assert.rejects(
    captureScreen({
      requirePrivateInputs: true,
      native: async () => ({ nodes: [], systemModal }),
      react: async () => ({ interactive: [] }),
      warn: (line) => logs.push(line),
    }),
    /native snapshot was incomplete/,
  );
  assert.deepEqual(logs, [
    'presence-system-modal=' +
      JSON.stringify({
        appState: 'runningForeground',
        alertCount: 1,
        sheetCount: 0,
        modals: [
          {
            exists: true,
            frameEmpty: false,
            centerInViewport: true,
            springboardFrameEmpty: false,
            descendantTypes: [{ type: 9, count: 2 }],
            hittableDescendantCount: 0,
          },
        ],
      }),
  ]);
  assert.doesNotMatch(logs.join(''), /private/);
});

test('absent or malformed modal diagnostics emit nothing and cannot repair private capture', async () => {
  for (const systemModal of [
    undefined,
    { appState: 'private', alertCount: 1, sheetCount: 0, modals: [] },
    { appState: 'runningForeground', alertCount: 0, sheetCount: 0, modals: [] },
    {
      appState: 'runningForeground',
      alertCount: 1,
      sheetCount: 0,
      modals: [{ exists: 'private' }],
    },
  ]) {
    const logs: string[] = [];
    await assert.rejects(
      captureScreen({
        requirePrivateInputs: true,
        native: async () => ({ nodes: [], systemModal }),
        react: async () => ({ interactive: [] }),
        warn: (line) => logs.push(line),
      }),
      /native snapshot was incomplete/,
    );
    assert.deepEqual(logs, []);
  }
  const logs: string[] = [];
  const observation = nativeCapture();
  const baseline = await captureScreen({
    now: () => 0,
    native: async () => observation,
    react: async () => ({ interactive: [] }),
  });
  const successful = await captureScreen({
    now: () => 0,
    native: async () => observation,
    react: async () => ({ interactive: [] }),
    warn: (line) => logs.push(line),
  });
  assert.deepEqual(successful, baseline);
  assert.equal(
    logs.some((line) => line.startsWith('presence-system-modal=')),
    false,
  );
});
