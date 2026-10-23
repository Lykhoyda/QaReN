import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { captureScreen, nativeDevOverlayUncleared } from '../../../dist/qa/capture.js';
import { keyboardCoversElement } from '../../../dist/qa/screen.js';
import { NativeSnapshotIncomplete } from '../../../dist/qa/private-input.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../../dist/runners/rn-android-runner-client.js';
import {
  REQUIRED_ANDROID_COMMANDS,
  REQUIRED_ANDROID_FEATURES,
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
} from '../../../dist/runners/protocol.js';
import { clearRefMap } from '../../../dist/fast-runner-ref-map.js';
import { SETTLE_DEFAULT_BUDGET_MS } from '../../../dist/lifecycle/settle.js';
import { QA_READ_ONLY_CAPABILITY } from '../../../dist/runners/qa-native-policy.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

beforeEach(() => {
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'test-emulator',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  clearRefMap();
});

// QA reads carry the live-traversal hierarchy; these flat fixtures are depth-0 roots.
const node = {
  index: 0,
  depth: 0,
  type: 'android.widget.Button',
  label: 'Save',
  identifier: 'save',
  packageName: 'com.test',
  enabled: true,
  hittable: true,
  rect: { x: 0, y: 0, width: 100, height: 50 },
};
const complete = () => ({
  nodes: [
    node,
    { ...node, index: 1, type: 'android.widget.EditText', label: 'Email', identifier: 'email' },
  ],
  truncated: false,
  normalizationDroppedNodes: 0,
});

async function capture(data: unknown) {
  _setFetchForTest(async (url, init) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY],
      });
    assert.equal(JSON.parse(String(init?.body)).command, 'snapshot');
    return Response.json({ ok: true, data });
  });
  // Each read spends one settle budget, so an empty-capture retry ends without a wall-clock race.
  let now = 0;
  return captureScreen({
    appId: 'com.test',
    requirePrivateInputs: true,
    now: () => now,
    native: async () => {
      const result = parseEnvelope(
        await runAndroid({
          command: 'snapshot',
          deviceId: 'test-emulator',
          bundleId: 'com.test',
          qaReadOnly: true,
        }),
      );
      now += SETTLE_DEFAULT_BUDGET_MS;
      assert.equal(result.ok, true);
      return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
    },
    react: async () => ({
      interactive: [],
      verdict: { state: 'ok', path: 'interactive', complete: true },
      hostEvidence: { hosts: [], complete: true },
    }),
  });
}

test('Android production adapter → capture → walker admits complete literal actions and checks', async () => {
  for (const [plan, actions] of [
    ['1. Back', ['back']],
    ['1. Tap "Save"', ['press @e0']],
    ['1. Wait for "Save"', []],
    ['1. Fill "Email" with "Ada"', ['fill @e1 Ada']],
    ['1. Scroll down', ['scroll down']],
    ['1. Scroll until you see "Save"', []],
    ['✓ "Save"', []],
  ] as const) {
    const judge = scriptedJudge(() => assert.fail('literal plans must not call Jev'));
    const f = walker([], judge);
    f.deps.captureScreen = () => capture(complete());
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.equal(result.verdict, 'PASS', `${plan}: ${result.failure?.seen}`);
    assert.deepEqual(f.actions, actions);
  }
  const screen = await capture(complete());
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.coverage?.native, 'unknown', 'raw completeness is not semantic presence');
});

test('Android producer or host normalization losses never become usable literal acquisitions', async () => {
  for (const data of [
    { nodes: [node] },
    { ...complete(), truncated: true },
    { ...complete(), truncated: undefined },
    { ...complete(), truncated: 'false' },
    { ...complete(), normalizationDroppedNodes: 1 },
    { ...complete(), normalizationDroppedNodes: undefined },
    { ...complete(), normalizationDroppedNodes: -1 },
    { ...complete(), normalizationDroppedNodes: 0.5 },
    { ...complete(), normalizationDroppedNodes: '0' },
    { ...complete(), normalizationDroppedNodes: Number.MAX_SAFE_INTEGER + 1 },
    { ...complete(), nodes: [node, { index: 1, type: 'android.widget.TextView' }] },
    ...[
      null,
      { ...node, index: 2, rect: {} },
      { ...node, index: 2, rect: { ...node.rect, width: -1 } },
    ].map((invalid) => ({ ...complete(), nodes: [node, invalid] })),
  ]) {
    let screen;
    try {
      screen = await capture(data);
    } catch (error) {
      // A provably incomplete tree refuses at capture, which is never usable either.
      assert.ok(error instanceof NativeSnapshotIncomplete, JSON.stringify(data));
      continue;
    }
    assert.notEqual(screen.captureCoverage?.native, 'complete', JSON.stringify(data));
    for (const plan of ['1. Back', '1. Tap "Save"', '1. Wait for "Save"']) {
      const judge = scriptedJudge(() => assert.fail('unusable acquisition must not call Jev'));
      const f = walker([screen], judge);
      const result = await runPlan(parsePlan(plan).blocks!, f.deps);
      assert.equal(result.verdict, 'FAIL', plan);
      assert.match(result.failure!.seen, /NATIVE_ACQUISITION_UNUSABLE/);
      assert.deepEqual(f.actions, []);
    }
  }
  // An empty tree is reread within the settle budget, then refused.
  await assert.rejects(capture({ ...complete(), nodes: [] }), NativeSnapshotIncomplete);
});

test('Android acquisition reports producer and host losses together', async () => {
  await assert.rejects(
    capture({
      ...complete(),
      normalizationDroppedNodes: 2,
      nodes: [node, { index: 1, type: 'android.widget.TextView' }],
    }),
    (error) => error instanceof NativeSnapshotIncomplete && error.causes.includes('dropped=3'),
  );
});

test('Android incomplete producer reply never permits a mutation', async () => {
  for (const data of [
    { ...complete(), normalizationDroppedNodes: 2 },
    { ...complete(), truncated: true },
  ]) {
    const judge = scriptedJudge(() => assert.fail('incomplete capture must not ask Jev'));
    const f = walker([], judge);
    f.deps.captureScreen = () => capture(data);
    const result = await runPlan(parsePlan('1. Tap "Save"').blocks!, f.deps);
    assert.equal(result.verdict, 'REFUSED');
    assert.equal((result as { code?: string }).code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
    assert.deepEqual(f.actions, []);
    assert.equal(judge.calls.length, 0);
  }
});

test('Android input text reported as a label stays masked with its echo', async () => {
  const secret = 'prefilled-c@example.test';
  const data = {
    ...complete(),
    nodes: [
      node,
      { ...node, index: 1, type: 'android.widget.EditText', label: secret, identifier: 'email' },
      { ...node, index: 2, type: 'android.widget.TextView', label: `Sent to ${secret}` },
    ],
  };
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = () => capture(data);
  const result = await runPlan(parsePlan('✓ "Nothing like this"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /Sent to •••/);
  assert.equal(JSON.stringify({ result, rows: f.rows }).includes(secret), false);
});

// The QA snapshot shape the runner builds from one live traversal of the windows.
const display = { x: 0, y: 0, width: 1080, height: 2400 };
const qaNode = (index: number, parentIndex: number | undefined, depth: number, rest: object) => ({
  index,
  depth,
  ...(parentIndex === undefined ? {} : { parentIndex }),
  label: '',
  identifier: '',
  packageName: 'com.test',
  enabled: true,
  hittable: false,
  checked: false,
  selected: false,
  visibleToUser: true,
  ...rest,
});
const qaSnapshot = (nodes: object[], extra: object = {}) => ({
  nodes,
  truncated: false,
  normalizationDroppedNodes: 0,
  snapshotGeneration: 7,
  keyboardVisible: false,
  ...extra,
});
const appRoots = () => [
  qaNode(0, undefined, 0, { type: 'Application', rect: display }),
  qaNode(1, 0, 1, { type: 'Window', rect: display }),
  qaNode(2, 1, 2, { type: 'android.widget.FrameLayout', rect: display }),
];
const control = (index: number, rest: object) =>
  qaNode(index, 2, 3, { type: 'android.widget.Button', hittable: true, ...rest });

test('Android QA roots, ancestry and selection survive the client into a complete capture', async () => {
  const data = qaSnapshot([
    ...appRoots(),
    control(3, {
      label: 'Home',
      identifier: 'tab-home',
      selected: true,
      rect: { x: 0, y: 2200, width: 540, height: 200 },
    }),
  ]);
  let mapped: Record<string, unknown>[] = [];
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY],
      });
    return Response.json({ ok: true, data });
  });
  const envelope = parseEnvelope(
    await runAndroid({
      command: 'snapshot',
      deviceId: 'test-emulator',
      bundleId: 'com.test',
      qaReadOnly: true,
    }),
  );
  mapped = envelope.data.nodes;
  assert.deepEqual(
    mapped.map((n) => [n.type, n.index, n.depth, n.parentIndex]),
    [
      ['Application', 0, 0, undefined],
      ['Window', 1, 1, 0],
      ['android.widget.FrameLayout', 2, 2, 1],
      ['android.widget.Button', 3, 3, 2],
    ],
  );
  assert.equal(envelope.data.snapshotGeneration, 7);
  assert.equal(envelope.data.keyboardVisible, false);

  const screen = await capture(data);
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.front, 'app');
  assert.equal(screen.keyboardVisible, false);
  assert.equal(screen.elements.find((e) => e.testID === 'tab-home')?.selected, true);
});

test('an Android node not visible to the user is offscreen and never a quoted PASS', async () => {
  const data = qaSnapshot([
    ...appRoots(),
    // Scrolled out: clipped to an empty rect whose origin sits inside the viewport.
    control(3, {
      label: 'Archive',
      identifier: 'archive-row',
      hittable: false,
      visibleToUser: false,
      rect: { x: 0, y: 1200, width: 1080, height: 0 },
    }),
    // Laid out on screen but not shown.
    qaNode(4, 2, 3, {
      type: 'android.widget.TextView',
      label: 'Invisible notice',
      visibleToUser: false,
      rect: { x: 0, y: 400, width: 1080, height: 100 },
    }),
  ]);
  const screen = await capture(data);
  assert.equal(screen.captureCoverage?.native, 'complete');
  const archive = screen.elements.find((e) => e.testID === 'archive-row')!;
  assert.equal(archive.offscreen, true);
  assert.equal(archive.visibilityEvidence, 'offscreen');
  for (const plan of ['1. Wait for "archive-row"', '✓ "Invisible notice"']) {
    const f = walker(
      [],
      scriptedJudge(() => assert.fail('literal plans must not call Jev')),
    );
    f.deps.captureScreen = () => capture(data);
    const result = await runPlan(parsePlan(plan).blocks!, f.deps);
    assert.notEqual(result.verdict, 'PASS', plan);
    assert.deepEqual(f.actions, [], plan);
  }
});

test('scrolled-out pager pages past the viewport edge keep the walk-start overlay gate clear', async () => {
  const data = qaSnapshot([
    ...appRoots(),
    qaNode(3, 2, 3, {
      type: 'android.widget.HorizontalScrollView',
      rect: { x: 0, y: 0, width: 1080, height: 2089 },
    }),
    control(4, { identifier: 'onboarding-skip', rect: { x: 55, y: 2209, width: 71, height: 56 } }),
    // The runner keeps an off-screen page as its empty clipped rect at its own origin.
    qaNode(5, 3, 4, {
      type: 'android.view.ViewGroup',
      visibleToUser: false,
      rect: { x: 2160, y: 0, width: 0, height: 2089 },
    }),
    qaNode(6, 5, 5, {
      type: 'android.widget.TextView',
      label: 'Page three',
      visibleToUser: false,
      rect: { x: 2625, y: 1136, width: 0, height: 74 },
    }),
  ]);
  _setFetchForTest(async (url) => {
    if (String(url).endsWith('/health'))
      return Response.json({
        ok: true,
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        runnerVersion: getPluginVersion(),
        commands: REQUIRED_ANDROID_COMMANDS,
        capabilities: [...REQUIRED_ANDROID_FEATURES, QA_READ_ONLY_CAPABILITY],
      });
    return Response.json({ ok: true, data });
  });
  const envelope = parseEnvelope(
    await runAndroid({
      command: 'snapshot',
      deviceId: 'test-emulator',
      bundleId: 'com.test',
      qaReadOnly: true,
    }),
  );
  assert.equal(
    nativeDevOverlayUncleared({
      ...envelope.data,
      snapshotVerdict: envelope.meta.snapshotVerdict,
      surface: 'app',
    }),
    false,
  );

  const screen = await capture(data);
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.elements.find((e) => e.label === 'Page three')?.offscreen, true);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = () => capture(data);
  const result = await runPlan(parsePlan('✓ "Page three"').blocks!, f.deps);
  assert.notEqual(result.verdict, 'PASS');
});

test('the Android Keyboard node marks a centre-covered field keyboard-covered', async () => {
  const keyboard = { x: 0, y: 1500, width: 1080, height: 900 };
  const screen = await capture(
    qaSnapshot(
      [
        ...appRoots(),
        control(3, {
          type: 'android.widget.EditText',
          label: 'Email',
          identifier: 'email',
          rect: { x: 40, y: 1700, width: 1000, height: 120 },
        }),
        control(4, {
          label: 'Save',
          identifier: 'save',
          rect: { x: 40, y: 300, width: 1000, height: 120 },
        }),
        qaNode(5, 0, 1, { type: 'Keyboard', packageName: 'com.example.ime', rect: keyboard }),
      ],
      { keyboardVisible: true },
    ),
  );
  assert.equal(screen.captureCoverage?.native, 'complete');
  assert.equal(screen.keyboardVisible, true);
  assert.deepEqual(screen.keyboardFrame, keyboard);
  assert.equal(keyboardCoversElement(screen.elements.find((e) => e.testID === 'email')!), true);
  assert.equal(keyboardCoversElement(screen.elements.find((e) => e.testID === 'save')!), false);
});

// The Android Keyboard node carries no keys, so the keyboard opening is the tap's only visible effect.
test('an Android field tap whose only effect is opening the keyboard passes on its first press', async () => {
  const form = (keyboardVisible: boolean) =>
    qaSnapshot(
      [
        ...appRoots(),
        control(3, {
          type: 'android.widget.EditText',
          label: 'Email',
          identifier: 'rhf-email',
          rect: { x: 40, y: 500, width: 1000, height: 120 },
        }),
        ...(keyboardVisible
          ? [
              qaNode(4, 0, 1, {
                type: 'Keyboard',
                packageName: 'com.example.ime',
                rect: { x: 0, y: 1500, width: 1080, height: 900 },
              }),
            ]
          : []),
      ],
      { keyboardVisible },
    );
  const closed = await capture(form(false));
  const open = await capture(form(true));
  const f = walker(
    [closed, open],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
    {
      ok: false,
      proven: false,
      mutation: 'possible',
      error:
        'INTERACTION_EFFECT_UNVERIFIED: The tap was dispatched but produced no observable UI change.',
    },
  );
  const result = await runPlan(parsePlan('1. Tap "rhf-email"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.equal(f.actions.length, 1);
});

// Android reports a field the keyboard covers as not visible to the user while its rect stays on screen.
const keyboardForm = (field7: { y: number; visibleToUser: boolean }) =>
  qaSnapshot(
    [
      ...appRoots(),
      control(3, {
        type: 'android.widget.EditText',
        identifier: 'qa-kb-input-1',
        rect: { x: 63, y: 600, width: 954, height: 93 },
      }),
      control(4, {
        type: 'android.widget.EditText',
        identifier: 'qa-kb-input-7',
        // The runner derives hittable from enabled and visible-to-user.
        hittable: field7.visibleToUser,
        visibleToUser: field7.visibleToUser,
        rect: { x: 63, y: field7.y, width: 954, height: 93 },
      }),
      control(5, {
        type: 'android.widget.TextView',
        label: 'Field 7',
        hittable: false,
        visibleToUser: field7.visibleToUser,
        rect: { x: 63, y: field7.y - 60, width: 300, height: 50 },
      }),
      qaNode(6, 0, 1, {
        type: 'Keyboard',
        packageName: 'com.example.ime',
        rect: { x: 0, y: 1517, width: 1080, height: 883 },
      }),
    ],
    { keyboardVisible: true },
  );

test('an Android field the keyboard hides is keyboard-covered, not scrolled out', async () => {
  const screen = await capture(keyboardForm({ y: 2049, visibleToUser: false }));
  assert.equal(screen.captureCoverage?.native, 'complete');
  const field = screen.elements.find((e) => e.testID === 'qa-kb-input-7')!;
  assert.equal(field.offscreen, false);
  assert.equal(field.hittable, true);
  assert.equal(keyboardCoversElement(field), true);
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  f.deps.captureScreen = () => capture(keyboardForm({ y: 2049, visibleToUser: false }));
  const result = await runPlan(parsePlan('✓ "Field 7"').blocks!, f.deps);
  assert.notEqual(result.verdict, 'PASS');
});

test('a keyboard-hidden Android field is cleared by one scroll and then filled', async () => {
  const covered = await capture(keyboardForm({ y: 2049, visibleToUser: false }));
  const cleared = await capture(keyboardForm({ y: 1200, visibleToUser: true }));
  const f = walker(
    [covered, cleared],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  const result = await runPlan(parsePlan('1. Type "x" into "qa-kb-input-7"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  assert.deepEqual(f.actions, ['scroll down', 'fill @e4 x']);
});

test('a keyboard-hidden Android field still covered after one scroll refuses as under the keyboard', async () => {
  const covered = await capture(keyboardForm({ y: 2049, visibleToUser: false }));
  const still = await capture(keyboardForm({ y: 1714, visibleToUser: false }));
  const f = walker(
    [covered, still],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  const result = await runPlan(parsePlan('1. Type "x" into "qa-kb-input-7"').blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.match(result.failure!.seen, /stayed off screen after one scroll: .*under the keyboard/);
  assert.deepEqual(f.actions, ['scroll down']);
});

test('the clearance scroll for a keyboard-hidden field carries the distance that clears the keyboard', async () => {
  const covered = await capture(keyboardForm({ y: 2049, visibleToUser: false }));
  const cleared = await capture(keyboardForm({ y: 700, visibleToUser: true }));
  const f = walker(
    [covered, cleared],
    scriptedJudge(() => assert.fail('literal plans must not call Jev')),
  );
  const clearances: (number | undefined)[] = [];
  const scroll = f.deps.scroll;
  f.deps.scroll = (direction, context, clearance) => {
    clearances.push(clearance);
    return scroll(direction, context);
  };
  const result = await runPlan(parsePlan('1. Type "x" into "qa-kb-input-7"').blocks!, f.deps);
  assert.equal(result.verdict, 'PASS', result.failure?.seen);
  // Centre 2049 + 93 / 2 moves to the middle of the band ending 48 px above the keyboard at 1517.
  assert.deepEqual(clearances, [2049 + 93 / 2 - (1517 - 48) / 2]);
});

test('a not-visible Android field away from the keyboard stays off screen', async () => {
  const screen = await capture(keyboardForm({ y: 400, visibleToUser: false }));
  const field = screen.elements.find((e) => e.testID === 'qa-kb-input-7')!;
  assert.equal(field.offscreen, true);
  assert.equal(keyboardCoversElement(field), false);
});

test('an Android Alert-rooted snapshot reads as a front dialog', async () => {
  const pkg = 'com.android.permissioncontroller';
  const screen = await capture(
    qaSnapshot([
      qaNode(0, undefined, 0, {
        type: 'Alert',
        packageName: pkg,
        rect: { x: 80, y: 900, width: 920, height: 600 },
      }),
      qaNode(1, 0, 1, {
        type: 'android.widget.Button',
        label: 'Allow',
        packageName: pkg,
        hittable: true,
        rect: { x: 100, y: 1300, width: 400, height: 120 },
      }),
    ]),
  );
  assert.equal(screen.front, 'dialog');
});

test('Android QA ancestry the client cannot trust is dropped and counted, never silently stripped', async () => {
  for (const broken of [
    { parentIndex: 9 },
    { parentIndex: 3 },
    { parentIndex: -1 },
    { depth: 7 },
    { depth: 'three' },
    { index: 'x' },
  ]) {
    const data = qaSnapshot([
      ...appRoots(),
      control(3, {
        label: 'Save',
        identifier: 'save',
        rect: { x: 0, y: 0, width: 100, height: 50 },
        ...broken,
      }),
    ]);
    await assert.rejects(
      capture(data),
      (error) => error instanceof NativeSnapshotIncomplete && error.causes.includes('dropped=1'),
      JSON.stringify(broken),
    );
  }
});
