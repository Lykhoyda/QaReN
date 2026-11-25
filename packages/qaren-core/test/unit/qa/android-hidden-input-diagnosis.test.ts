import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import type { StoredBlock } from '../../../dist/qa/blocks.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import type { Screen } from '../../../dist/qa/screen.js';
import { renderReason } from '../../../dist/qa/untrusted.js';
import { loginBlock, replayBlock, runPlan, walkBlock } from '../../../dist/qa/walker.js';
import {
  _setAndroidRunnerStateForTest,
  _setFetchForTest,
  runAndroid,
} from '../../../dist/runners/qaren-android-runner-client.js';
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
import { RunInputs, withInputs } from '../../../dist/qa/inputs.js';
import { MASK, ObservedPrivacy } from '../../../dist/qa/privacy.js';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

// AI-717 (interim): the hidden-in-place diagnosis on the Test App code page (OtpFixtureScreens.tsx:219-237),
// through the production capture path: a runner-shaped QA snapshot through the Android client and
// captureScreen, with React from the real injected helper, and recovery enabled as in production, whose
// read is a presence capture that the runner answers as PresenceRules.observe does (an invisible node is
// clipped, or keyboard-covered when the keyboard meets it). Geometry from the D0 phone (720x1600; the
// hidden input's frame 39,325,14,73).
const APP = 'com.rndevagent.testapp';
const ID = 'qa-otp-code';
const display = { x: 0, y: 0, width: 720, height: 1600 };
// A density of 2 (720 px across 360 dp): React's measured frames are the native frames halved.
const POINT_SCALE = 2;
const noop = () => {};

interface Page {
  focused?: boolean;
  keyboard?: boolean;
  keyboardY?: number;
  inputClass?: string;
  inputRect?: { x: number; y: number; width: number; height: number };
  // No input at all (a read after the field went away).
  noInput?: boolean;
  secondCarrier?: boolean;
  // A visible text whose label holds the quoted id within a longer label.
  aggregate?: boolean;
  noVisibleFact?: boolean;
  // Application and Window frames empty, so the read gives no clipping viewport.
  emptyRoot?: boolean;
  heading?: string;
  // The code typed so far: the input's text and the boxes' digits.
  typed?: string;
  // A visible text carrying the login marker's testID.
  loginMarker?: boolean;
  // The input's left edge (default 39): a negative one leaves it only overlapping the visible area.
  inputX?: number;
}

const inputRect = (page: Page) =>
  page.inputRect ?? { x: page.inputX ?? 39, y: 325, width: 14, height: 73 };

function snapshot(page: Page, presenceBudgetMs?: number) {
  const presence = presenceBudgetMs !== undefined;
  const nodes: Record<string, unknown>[] = [];
  const add = (parent: number | undefined, rest: Record<string, unknown>) => {
    const index = nodes.length;
    const node: Record<string, unknown> = {
      index,
      depth: parent === undefined ? 0 : (nodes[parent].depth as number) + 1,
      ...(parent === undefined ? {} : { parentIndex: parent }),
      label: '',
      identifier: '',
      packageName: APP,
      enabled: true,
      checked: false,
      selected: false,
      visibleToUser: true,
      scrollable: false,
      ...rest,
    };
    // As the runner: synthetic nodes are not hittable; a view is hittable when enabled and visible.
    node.hittable ??= ['Application', 'Window', 'Keyboard'].includes(node.type as string)
      ? false
      : node.enabled === true && node.visibleToUser === true;
    nodes.push(node);
    return index;
  };
  const frame = page.emptyRoot ? { x: 0, y: 0, width: 0, height: 0 } : display;
  const application = add(undefined, { type: 'Application', rect: frame });
  const window = add(application, { type: 'Window', rect: frame });
  const root = add(window, { type: 'android.widget.FrameLayout', rect: display });
  const content = add(root, {
    type: 'android.view.ViewGroup',
    identifier: 'qa-otp-nofocus-screen',
    rect: { x: 0, y: 82, width: 720, height: 1428 },
  });
  add(content, {
    type: 'android.widget.TextView',
    label: page.heading ?? 'Enter the code',
    rect: { x: 39, y: 200, width: 300, height: 50 },
  });
  if (page.loginMarker)
    add(content, {
      type: 'android.widget.TextView',
      identifier: 'login-screen',
      label: 'Welcome',
      rect: { x: 39, y: 120, width: 300, height: 50 },
    });
  const field = add(content, {
    type: 'android.view.ViewGroup',
    identifier: 'qa-otp-code-field',
    rect: { x: 39, y: 325, width: 642, height: 92 },
  });
  if (!page.noInput)
    add(field, {
      type: page.inputClass ?? 'android.widget.EditText',
      identifier: ID,
      label: page.typed ?? '',
      visibleToUser: false,
      rect: inputRect(page),
      ...(page.focused ? { focused: true } : {}),
    });
  [39, 137, 235, 334].forEach((x, i) =>
    add(field, {
      type: 'android.widget.TextView',
      identifier: `qa-otp-box-${i + 1}`,
      label: page.typed?.[i] ?? '',
      rect: { x, y: 325, width: 80, height: 92 },
    }),
  );
  if (page.secondCarrier)
    add(content, {
      type: 'android.widget.TextView',
      identifier: ID,
      label: 'Code',
      rect: { x: 39, y: 450, width: 200, height: 40 },
    });
  if (page.aggregate)
    add(content, {
      type: 'android.widget.TextView',
      label: `${ID} hint`,
      rect: { x: 39, y: 650, width: 300, height: 40 },
    });
  add(content, {
    type: 'android.widget.Button',
    identifier: 'qa-otp-verify',
    label: 'Verify',
    rect: { x: 39, y: 520, width: 642, height: 88 },
  });
  const keyboardY = page.keyboardY ?? 1000;
  if (page.keyboard)
    add(application, {
      type: 'Keyboard',
      packageName: 'com.android.inputmethod',
      rect: { x: 0, y: keyboardY, width: 720, height: 1600 - keyboardY },
    });
  if (page.noVisibleFact) for (const node of nodes) delete node.visibleToUser;
  const generation = 7;
  if (presence)
    // The runner's presence table (PresenceRules.observe): structural or unnamed nodes are unknown; an invisible
    // node is clipped, or keyboard-covered when it meets the keyboard; a visible named node is observed. Label
    // sources as PresenceRules.labelSources: an editable node with text gives value, a label direct, text
    // below descendant, else none.
    nodes.forEach((node, nodeIndex) => {
      const rect = node.rect as { y: number; height: number };
      const structural = ['Application', 'Window', 'Keyboard'].includes(node.type as string);
      const hasText = (n: Record<string, unknown>) =>
        n.type !== 'android.view.ViewGroup' && typeof n.label === 'string' && n.label.trim() !== '';
      const textBelow = (index: number): boolean =>
        nodes.some(
          (child) =>
            child.parentIndex === index && (hasText(child) || textBelow(child.index as number)),
        );
      const labelSource = structural
        ? 'none'
        : node.type === 'android.widget.EditText' && hasText(node)
          ? 'value'
          : node.label !== ''
            ? 'direct'
            : textBelow(nodeIndex)
              ? 'descendant'
              : 'none';
      const named = node.identifier !== '' || labelSource !== 'none';
      const base = { captureId: 'capture-7', generation, nodeIndex, labelSource };
      node.presence =
        structural || !named
          ? { ...base, status: 'unknown' }
          : node.visibleToUser === false
            ? {
                ...base,
                status: 'unknown',
                unknownReason:
                  page.keyboard && rect.y + rect.height > keyboardY
                    ? 'keyboard-covered'
                    : 'clipped',
              }
            : { ...base, status: 'observed', observedUptimeMs: 150 };
    });
  return {
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotGeneration: generation,
    keyboardVisible: page.keyboard === true,
    ...(presence
      ? {
          presenceCapture: {
            version: 2,
            source: 'android-a11y-live',
            enumeration: 'app-windows',
            captureId: 'capture-7',
            appId: APP,
            generation,
            startedUptimeMs: 100,
            endedUptimeMs: 200,
            complete: true,
            appliedBudgetMs: presenceBudgetMs,
            pointScale: POINT_SCALE,
          },
        }
      : {}),
  };
}

// The page's React tree in a sandbox holding the real injected helper.
function reactSandbox(page: Page) {
  const box = (n: number) => ({
    name: 'Text',
    props: { testID: `qa-otp-box-${n}` },
    children: [
      {
        hostType: 'RCTText',
        props: { testID: `qa-otp-box-${n}` },
        // The digit as React Native renders it: a HostText fiber under the RCTText host.
        ...(page.typed?.[n - 1] ? { children: [{ text: page.typed[n - 1] }] } : {}),
      },
    ],
  });
  const shared = {
    testID: ID,
    onChangeText: noop,
    maxLength: 4,
    ...(page.typed ? { value: page.typed } : {}),
  };
  const input = {
    name: 'TextInput',
    props: shared,
    children: [{ hostType: 'AndroidTextInput', props: { ...shared, onChange: noop } }],
  };
  const field = {
    name: 'View',
    props: { testID: 'qa-otp-code-field', accessible: true },
    children: [
      {
        hostType: 'RCTView',
        props: { testID: 'qa-otp-code-field', accessible: true },
        children: [...(page.noInput ? [] : [input]), box(1), box(2), box(3), box(4)],
      },
    ],
  };
  const verify = {
    name: 'Pressable',
    props: { testID: 'qa-otp-verify', accessibilityRole: 'button', onPress: noop },
    children: [
      {
        hostType: 'RCTView',
        props: { testID: 'qa-otp-verify', accessibilityRole: 'button', onClick: noop },
      },
    ],
  };
  const root = {
    current: buildFiber({
      name: 'Screen',
      children: [
        {
          name: 'View',
          props: { testID: 'qa-otp-nofocus-screen' },
          children: [
            {
              hostType: 'RCTView',
              props: { testID: 'qa-otp-nofocus-screen' },
              children: [field, verify],
            },
          ],
        },
      ],
    }),
  };
  // Host fibers as React Native renders them: tag 5 with a view measureInWindow measures in dp (each host's
  // native frame over the point scale); digits are HostText (tag 6).
  const frames: Record<string, { x: number; y: number; width: number; height: number }> = {
    'qa-otp-nofocus-screen': { x: 0, y: 82, width: 720, height: 1428 },
    'qa-otp-code-field': { x: 39, y: 325, width: 642, height: 92 },
    [ID]: inputRect(page),
    'qa-otp-verify': { x: 39, y: 520, width: 642, height: 88 },
    ...Object.fromEntries(
      [39, 137, 235, 334].map((x, i) => [
        `qa-otp-box-${i + 1}`,
        { x, y: 325, width: 80, height: 92 },
      ]),
    ),
  };
  const hosts = (fiber: Record<string, any> | null) => {
    for (let node = fiber; node; node = node.sibling) {
      if (typeof node.type === 'string') {
        node.tag = 5;
        const rect = frames[node.memoizedProps?.testID] ?? display;
        node.stateNode ??= {
          measureInWindow: (done: (...frame: number[]) => void) =>
            done(
              rect.x / POINT_SCALE,
              rect.y / POINT_SCALE,
              rect.width / POINT_SCALE,
              rect.height / POINT_SCALE,
            ),
        };
      } else if (typeof node.memoizedProps === 'string') node.tag = 6;
      hosts(node.child);
    }
  };
  hosts(root.current);
  const sandbox = createSandbox({ fiberRoot: root.current });
  sandbox.__REACT_DEVTOOLS_GLOBAL_HOOK__.getFiberRoots = (id: number) =>
    id === 1 ? new Set([root]) : new Set();
  return sandbox;
}

async function codePage(page: Page, presence: boolean): Promise<Screen> {
  let data = snapshot(page);
  const sandbox = reactSandbox(page);
  const observed = await captureQaReact(
    {
      isConnected: true,
      async withPrivateHelperWorld(run) {
        return run(async (expression) => vm.runInContext(expression, sandbox));
      },
    },
    // As production (walk.ts:1094): a presence read also reads React's host tree.
    presence,
  );
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
  let clock = 0;
  return captureScreen({
    appId: APP,
    requirePrivateInputs: true,
    platformPresence: presence,
    now: () => (clock += SETTLE_DEFAULT_BUDGET_MS),
    native: async (presenceBudgetMs) => {
      // The runner answers a presence read with the budget it was given (validateNativePresence).
      data = snapshot(page, presence ? presenceBudgetMs : undefined);
      const result = parseEnvelope(
        await runAndroid({
          command: 'snapshot',
          deviceId: 'phone',
          bundleId: APP,
          qaReadOnly: true,
          ...(presence ? { platformPresence: true, presenceBudgetMs } : {}),
        }),
      );
      assert.equal(result.ok, true, JSON.stringify(result));
      return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
    },
    react: async () => observed,
  });
}

beforeEach(() => {
  _setAndroidRunnerStateForTest({
    hostPort: 22089,
    devicePort: 22089,
    pid: process.pid,
    deviceId: 'phone',
    bundleId: APP,
    startedAt: 'now',
  });
});
afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setAndroidRunnerStateForTest(null);
  clearRefMap();
});

// Recovery enabled as in production (it needs hideDevMenu); its read asks for platform presence.
// `after`: the page once a Fill was dispatched; `alternate`: every second capture; `recovered`: the page
// every presence read shows.
function android(
  page: Page,
  platform: 'android' | 'ios' = 'android',
  options: { after?: Page; alternate?: Page; recovered?: Page; noRecovery?: boolean } = {},
) {
  const f = walker(
    [],
    scriptedJudge(() => assert.fail('a quoted wait asks no model')),
  );
  f.deps.platform = platform;
  if (!options.noRecovery) f.deps.hideDevMenu = async () => ({ ok: true, proven: true });
  let captures = 0;
  let presenceReads = 0;
  let current = page;
  const fill = f.deps.fill;
  f.deps.fill = async (ref, value, ...rest) => {
    if (options.after) current = options.after;
    return fill(ref, value, ...rest);
  };
  f.deps.captureScreen = async (capture) => {
    captures += 1;
    const presence = capture?.platformPresence === true;
    if (presence) presenceReads += 1;
    const shown =
      presence && options.recovered
        ? options.recovered
        : options.alternate && captures % 2 === 0
          ? options.alternate
          : current;
    return codePage(shown, presence);
  };
  return { ...f, presenceReads: () => presenceReads };
}

const text = (reason: unknown): string =>
  reason === undefined ? '' : renderReason(reason as never, (value) => value);
const WAIT = `1. Wait for "${ID}" to appear`;
const STABLE = `"${ID}" did not appear within 15s; the screen did not change across`;
const TODAY = `the element carrying the identifier "${ID}" is offscreen: input id=${ID} frame=39,325,14,73 native; target visibility: absent`;
const WORDS =
  '; on the read failure.screen shows, Android reports that element as not visible to the user, its frame overlapping the visible area with its centre inside it (hidden in place)';
const INPUT_NEXT =
  'Wait for the testID of a visible part of the field, such as its wrapper or a digit box. If the input needs focus before Fill and the app provides a control that focuses it, Tap that control first.';
const inputAdvice = (line: number) =>
  `Android reports the target of line ${line} as an input that is not visible to the user (hidden in place); a Wait counts only what the user can see. ${INPUT_NEXT}`;
const OTHER_ADVICE =
  'Android reports the target of line 1 as not visible to the user (hidden in place); a Wait counts only what the user can see. Wait for the testID of a visible control instead.';

test('F1: a Wait on the hidden code input fails as before; the read failure.screen shows carries the diagnosis', async () => {
  for (const [state, page] of [
    ['unfocused', {}],
    ['focused', { focused: true, keyboard: true }],
  ] as const) {
    const f = android(page);
    const result = await runPlan(parsePlan(WAIT).blocks!, f.deps);
    const seen = text(result.failure?.seen);
    // D0's failure: a step failure (CLI PLAN_STEP_FAILED), subreason absent, a stable screen, today's words.
    assert.equal(result.verdict, 'FAIL', state);
    assert.equal(result.failure?.kind, 'step', state);
    assert.equal(result.failure?.subreason, 'absent', state);
    assert.ok(seen.startsWith(STABLE), `${state}: ${seen}`);
    assert.ok(seen.includes(TODAY), `${state}: ${seen}`);
    assert.deepEqual(f.actions, [], state);
    // Recovery read the screen again with presence (the runner calls the input clipped): failure.screen comes
    // from that read, and only that read's facts carry the words and the advice.
    assert.equal(f.presenceReads(), 1, state);
    assert.ok(seen.includes(WORDS), `${state}: ${seen}`);
    assert.equal(result.failure?.suggestion, inputAdvice(1), state);
    // failure.screen agrees with the words: the input is listed, enabled, offscreen, and counted as hidden.
    const input = result.failure?.screen?.controls?.find((control) => control.id === ID);
    assert.equal(input?.role, 'input', state);
    assert.equal(input?.enabled, true, state);
    assert.equal(input?.offscreen, true, state);
    assert.deepEqual(result.failure?.screen?.counts, { controls: 2, enabled: 2, hidden: 1 }, state);
  }
});

test('F1d: a later read that no longer shows the input gets no hidden-in-place words', async () => {
  // The Wait's own reads show the hidden input; recovery's read, which failure.screen shows, does not.
  const f = android({}, 'android', { recovered: { noInput: true } });
  const result = await runPlan(parsePlan(WAIT).blocks!, f.deps);
  assert.equal(result.verdict, 'FAIL');
  assert.ok(!text(result.failure?.seen).includes('hidden in place'), text(result.failure?.seen));
  assert.equal(result.failure?.screen?.counts?.hidden, 0);
  assert.match(String(result.failure?.suggestion), /was not on the last observed screen/);
});

test('F1e: with no recovery read, the Wait’s own read is the one failure.screen shows', async () => {
  const f = android({}, 'android', { noRecovery: true });
  const result = await runPlan(parsePlan(WAIT).blocks!, f.deps);
  assert.equal(f.presenceReads(), 0);
  assert.ok(text(result.failure?.seen).includes(WORDS), text(result.failure?.seen));
  assert.equal(result.failure?.suggestion, inputAdvice(1));
});

test('F2: every Wait form quoting the id gets the same diagnosis', async () => {
  for (const line of [
    `Wait for "${ID}"`,
    `Wait until "${ID}" appears`,
    `Wait until "${ID}" is visible`,
    `Wait until "${ID}" shows up`,
    `Wait for “${ID}” to appear`,
    `Wait for the text "${ID}" to appear`,
  ]) {
    const result = await runPlan(parsePlan(`1. ${line}`).blocks!, android({}).deps);
    assert.equal(result.verdict, 'FAIL', line);
    assert.ok(text(result.failure?.seen).includes(WORDS), `${line}: ${text(result.failure?.seen)}`);
    assert.equal(result.failure?.suggestion, inputAdvice(1), line);
  }
});

test('F3: a stored-id replay names its own line; a production login replay carries the advice for the saved block', async () => {
  const [block] = parsePlan(`## QA\n\n### Code\n${WAIT}\n`).blocks!;
  const stored: StoredBlock = {
    header: { name: 'Code', appId: APP, platform: 'android' },
    steps: [{ raw: block.items[0].raw, kind: 'wait', selector: { id: ID } }],
  } as never;
  const replayed = await walkBlock(
    replayBlock(block, stored),
    android({}).deps,
    0,
    [],
    undefined,
    undefined,
    { mode: 'replay' },
  );
  assert.ok(text(replayed.failure?.seen).includes(WORDS), text(replayed.failure?.seen));
  assert.equal(replayed.failure?.subreason, 'absent');
  assert.equal(replayed.failure?.suggestion, inputAdvice(4));
  // The saved login block built as production loads it (loginBlock: an exact stored selector, its first step on
  // line 1); a login wall during recovery replays it, and its Wait fails on the hidden input. The interrupted outer
  // step sits on line 2 and keeps its own failure.
  const f = android({ loginMarker: true });
  f.deps.login = { marker: { id: 'login-screen' }, block: loginBlock('code', stored) };
  const ledger = await runPlan(
    parsePlan('1. Wait for "qa-otp-verify"\n2. Tap "Settings"').blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.failure?.step, 2);
  // The outer failure keeps develop's shape: no step kind and no subreason on this recovery path.
  assert.equal(ledger.failure?.kind, undefined);
  assert.equal(ledger.failure?.subreason, undefined);
  const seen = text(ledger.failure?.seen);
  assert.ok(seen.startsWith('the login block did not pass: '), seen);
  assert.ok(seen.includes(WORDS), seen);
  assert.equal(ledger.failure?.suggestion, `in the saved login block: ${inputAdvice(1)}`);
});

test('F4: a hidden element that is not a text input gets the general advice', async () => {
  const result = await runPlan(
    parsePlan(WAIT).blocks!,
    android({ inputClass: 'android.view.ViewGroup' }).deps,
  );
  assert.equal(result.verdict, 'FAIL');
  // The candidate list shows the element's role as React reports it (a TextInput), its native class aside.
  assert.ok(text(result.failure?.seen).includes(`${TODAY}${WORDS}`), text(result.failure?.seen));
  assert.equal(result.failure?.suggestion, OTHER_ADVICE);
});

test('F4o: the words claim overlap and the centre only: an input partly outside the visible area', async () => {
  const result = await runPlan(parsePlan(WAIT).blocks!, android({ inputX: -5 }).deps);
  assert.ok(text(result.failure?.seen).includes(WORDS), text(result.failure?.seen));
  assert.equal(result.failure?.suggestion, inputAdvice(1));
});

test('F5: shapes outside the diagnosis keep develop’s words and outcome', async () => {
  // Scrolled out, below the display, or no known viewport: today's words and advice only.
  for (const page of [
    { inputRect: { x: 39, y: 1600, width: 14, height: 0 } },
    { inputRect: { x: 39, y: 1700, width: 14, height: 73 } },
    { emptyRoot: true, inputRect: { x: 39, y: 1750, width: 14, height: 73 } },
  ] as Page[]) {
    const result = await runPlan(parsePlan(WAIT).blocks!, android(page).deps);
    const seen = text(result.failure?.seen);
    assert.ok(seen.includes(`"${ID}" is offscreen`), JSON.stringify(page));
    assert.ok(!seen.includes('hidden in place'), JSON.stringify(page));
    assert.match(String(result.failure?.suggestion), /was not on the last observed screen/);
  }
  // The quoted id also part of a longer visible label, on every read or only on the one failure.screen shows:
  // that read's own diagnosis and advice stand.
  for (const [label, page] of [
    ['every read', { aggregate: true }],
    ['the recovery read only', {}],
  ] as const) {
    const result = await runPlan(
      parsePlan(WAIT).blocks!,
      android(page, 'android', { recovered: { aggregate: true } }).deps,
    );
    assert.equal(result.failure?.subreason, 'only-in-aggregated-label', label);
    assert.ok(!text(result.failure?.seen).includes('hidden in place'), label);
    assert.match(String(result.failure?.suggestion), /is only part of a larger label/, label);
  }
  // The keyboard over the input centre.
  const keyboard = await runPlan(
    parsePlan(WAIT).blocks!,
    android({ focused: true, keyboard: true, keyboardY: 300 }).deps,
  );
  assert.ok(text(keyboard.failure?.seen).includes(`"${ID}" has its centre covered (keyboard)`));
  // Two carriers of the id.
  const carriers = await runPlan(parsePlan(WAIT).blocks!, android({ secondCarrier: true }).deps);
  assert.ok(text(carriers.failure?.seen).includes(`2 elements carry the identifier "${ID}"`));
  // A changing screen is no definite stable absence: no hidden-in-place words or advice.
  const changing = await runPlan(
    parsePlan(WAIT).blocks!,
    android({}, 'android', { alternate: { heading: 'Enter the code now' } }).deps,
  );
  assert.equal(changing.verdict, 'FAIL');
  assert.ok(
    !text(changing.failure?.seen).includes('hidden in place'),
    text(changing.failure?.seen),
  );
  assert.ok(!String(changing.failure?.suggestion ?? '').includes('hidden in place'));
  // iOS reports no visible-to-user fact: develop's pass.
  const ios = await runPlan(parsePlan(WAIT).blocks!, android({ noVisibleFact: true }, 'ios').deps);
  assert.equal(ios.verdict, 'PASS');
  // Fill keeps PR 1428's rule: unfocused refused at once, focused types.
  const unfocused = android({});
  const refused = await runPlan(parsePlan(`1. Fill "${ID}" with "4821"`).blocks!, unfocused.deps);
  assert.match(
    text(refused.failure?.seen),
    /^TARGET_NOT_FOUND: .* does not hold input focus; nothing was typed and no scroll was tried/,
  );
  assert.deepEqual(unfocused.actions, []);
  const focused = android({ focused: true, keyboard: true });
  const typed = await runPlan(parsePlan(`1. Fill "${ID}" with "4821"`).blocks!, focused.deps);
  assert.equal(typed.verdict, 'PASS', text(typed.failure?.seen));
  assert.equal(focused.actions.length, 1);
});

test('F6: after a secret Fill, the diagnosis of a Wait on the filled input does not disclose the secret', async () => {
  const secret = '4821';
  const f = android({ focused: true, keyboard: true }, 'android', {
    after: { focused: true, keyboard: true, typed: secret },
  });
  let shots = 0;
  f.deps.screenshot = async (name) => {
    shots += 1;
    return name;
  };
  // Production shares one privacy object between the run inputs and the walk.
  const privacy = new ObservedPrivacy();
  f.deps.privacy = privacy;
  const result = await withInputs(new RunInputs({ CODE: secret }, ['CODE'], privacy), () =>
    runPlan(
      parsePlan(`1. Fill "${ID}" with input CODE (secret)\n2. Wait for "${ID}" to appear`).blocks!,
      f.deps,
    ),
  );
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 2);
  assert.ok(text(result.failure?.seen).includes(WORDS), text(result.failure?.seen));
  // Disclosure only: the secret does not appear, nor its digits in order with up to 12 non-digit characters
  // between them; the rule reads no value of its own.
  const all = JSON.stringify({ result, rows: f.rows });
  assert.equal(all.includes(secret), false, all);
  assert.doesNotMatch(all, /4\D{0,12}8\D{0,12}2\D{0,12}1/, all);
  // The input's label is masked as today; its testID is not a value and stays.
  const input = result.failure?.screen?.controls?.find((control) => control.id === ID);
  assert.equal(input?.label, MASK);
  // A run holding a secret runtime input takes no screenshot.
  assert.equal(shots, 0);
});
