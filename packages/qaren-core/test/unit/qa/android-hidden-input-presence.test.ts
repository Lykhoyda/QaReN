import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import vm from 'node:vm';
import { buildFiber, createSandbox } from '../helpers/inject-harness.js';
import { readBlock, serializeBlock, type StoredBlock } from '../../../dist/qa/blocks.js';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { captureQaReact } from '../../../dist/qa/react-capture.js';
import * as resolve from '../../../dist/qa/resolve.js';
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

// AI-717: an explicit Android Wait counts a native text input hidden in place present on the terms of a visible
// id (native-only parity), on the Test App code page (OtpFixtureScreens.tsx:219-237), through the production
// capture path: a runner-shaped QA snapshot through the Android client and captureScreen, React from the real
// injected helper, and recovery enabled as in production, whose read is a presence capture the runner answers
// as PresenceRules.observe does. Geometry from the D0 phone (720x1600; the hidden input 39,325,14,73).
// Each regression shape runs twice: hidden in place, and the same input visible to the user (the visible id).
const APP = 'com.rndevagent.testapp';
const ID = 'qa-otp-code';
const OTHER = 'qa-otp-other';
const display = { x: 0, y: 0, width: 720, height: 1600 };
// A density of 2 (720 px across 360 dp): React's measured frames are the native frames halved.
const POINT_SCALE = 2;
const noop = () => {};
type Rect = { x: number; y: number; width: number; height: number };

interface Page {
  focused?: boolean;
  keyboard?: boolean;
  keyboardY?: number;
  inputClass?: string;
  inputRect?: Rect;
  // The input's left edge (default 39): a negative one leaves it only overlapping the visible area.
  inputX?: number;
  // The visible-id twin of a shape: the same input, visible to the user.
  inputVisible?: boolean;
  nativeEnabled?: boolean;
  // No input at all, native or React (a read after the field went away).
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
  // The page inside a ScrollView with a wide footer drawn over its lower part (y 300 to 1510).
  footer?: boolean;
  // No resource id: the runner reports the content description (the id) as identifier and label.
  descriptionOnly?: boolean;
  // A separate text carrying the quoted string on a frame its on-screen child contradicts (an unsure text).
  unsureText?: boolean;
  // The native app windows, bottom to top (default the page): a React Native Modal's own window, or a
  // native, non-React dialog of the app (60,300,600,400). The code field sits in `nativeField`'s window.
  windows?: Array<'page' | 'modal' | 'dialog'>;
  nativeField?: 'page' | 'modal' | 'dialog';
  // A native EditText of another React input, below the display, carrying this identifier (an id swap).
  extraNative?: string;
  // React: the field TextInput's testID (default the quoted id); another React TextInput outside the field
  // with no native node; the field's TextInput mounted inside an inactive route the capture prunes
  // (a Screen with activityState 0) under this testID; a React read of another screen holding only a
  // TextInput with the quoted id; a mounted Modal over the page, or one whose first host lies in a pruned
  // route (split across the two traversals); or no React capture at all.
  inputTestID?: string;
  extraInput?: string;
  prunedInput?: string;
  reactScreen?: 'replaced';
  reactModal?: 'over' | 'split';
  noReact?: boolean;
  // React: the field TextInput disabled (accessibilityState), its native node left enabled.
  reactDisabled?: boolean;
  // Hittable label-only rows (type Other, the pin's merged-label rows) whose comma-separated labels hold the
  // quoted id: one, or two separate ones.
  commaAggregate?: 1 | 2;
  // The input wrapped in a non-scrolling ViewGroup whose frame lies below the display, the input's own frame
  // unchanged: QaReN's ancestor exclusion (native-presence.ts outsideViewport, rule anc).
  ancestorOutside?: boolean;
  // The native read of the screen that replaced the code page: one EditText carrying the id, below the display.
  nextScreen?: boolean;
  // React hosts measured at these native frames (by testID) instead of the defaults.
  reactFrames?: Record<string, Rect>;
  // The code input's native identifier (and, with descriptionOnly, its content description) instead of the id.
  inputId?: string;
  // A visible Close button on the page (an interruption control a later step may own).
  closeButton?: boolean;
}

const inputRect = (page: Page): Rect =>
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
  const nativeField = page.nativeField ?? 'page';
  const visibleInput = page.inputVisible === true;
  // Nodes whose label is a content description, not text (the runner's hasText is false for them).
  const described = new Set<number>();
  const codeInput = (under: number, rect: Rect) => {
    const parent = page.ancestorOutside
      ? add(under, {
          type: 'android.view.ViewGroup',
          rect: { x: 0, y: 1700, width: 720, height: 200 },
        })
      : under;
    const index = add(parent, {
      type: page.inputClass ?? 'android.widget.EditText',
      identifier: page.inputId ?? ID,
      label: page.descriptionOnly ? (page.inputId ?? ID) : (page.typed ?? ''),
      enabled: page.nativeEnabled ?? true,
      visibleToUser: visibleInput,
      rect,
      ...(page.focused ? { focused: true } : {}),
    });
    if (page.descriptionOnly && !page.typed) described.add(index);
    return index;
  };
  const codeField = (under: number) => {
    const field = add(under, {
      type: 'android.view.ViewGroup',
      identifier: 'qa-otp-code-field',
      rect: { x: 39, y: 325, width: 642, height: 92 },
    });
    if (!page.noInput) codeInput(field, inputRect(page));
    [39, 137, 235, 334].forEach((x, i) =>
      add(field, {
        type: 'android.widget.TextView',
        identifier: `qa-otp-box-${i + 1}`,
        label: page.typed?.[i] ?? '',
        rect: { x, y: 325, width: 80, height: 92 },
      }),
    );
  };
  const pageWindow = () => {
    const window = add(application, { type: 'Window', rect: frame });
    if (page.nextScreen) {
      const next = add(window, {
        type: 'android.view.ViewGroup',
        identifier: 'qa-next-screen',
        rect: { x: 0, y: 82, width: 720, height: 1428 },
      });
      add(next, {
        type: 'android.widget.EditText',
        identifier: ID,
        enabled: true,
        visibleToUser: page.inputVisible === true,
        rect: { x: 39, y: 1700, width: 300, height: 73 },
      });
      return;
    }
    const root = add(window, { type: 'android.widget.FrameLayout', rect: display });
    const content = add(root, {
      type: 'android.view.ViewGroup',
      identifier: 'qa-otp-nofocus-screen',
      rect: { x: 0, y: 82, width: 720, height: 1428 },
    });
    const parent = page.footer
      ? add(content, {
          type: 'android.widget.ScrollView',
          scrollable: true,
          rect: { x: 0, y: 82, width: 720, height: 1428 },
        })
      : content;
    add(parent, {
      type: 'android.widget.TextView',
      label: page.heading ?? 'Enter the code',
      rect: { x: 39, y: 200, width: 300, height: 50 },
    });
    if (page.loginMarker)
      add(parent, {
        type: 'android.widget.TextView',
        identifier: 'login-screen',
        label: 'Welcome',
        rect: { x: 39, y: 120, width: 300, height: 50 },
      });
    if (nativeField === 'page') codeField(parent);
    if (page.secondCarrier)
      add(parent, {
        type: 'android.widget.TextView',
        identifier: ID,
        label: 'Code',
        rect: { x: 39, y: 450, width: 200, height: 40 },
      });
    for (const suffix of ['A', 'B'].slice(0, page.commaAggregate ?? 0))
      add(parent, {
        type: 'Other',
        label: `${ID}, ${suffix}`,
        rect: { x: 39, y: suffix === 'A' ? 1100 : 1200, width: 300, height: 60 },
      });
    if (page.aggregate)
      add(parent, {
        type: 'android.widget.TextView',
        label: `${ID} hint`,
        rect: { x: 39, y: 650, width: 300, height: 40 },
      });
    if (page.unsureText) {
      const shown = add(parent, {
        type: 'android.widget.TextView',
        label: ID,
        rect: { x: -500, y: 700, width: 400, height: 40 },
      });
      add(shown, {
        type: 'android.widget.TextView',
        label: 'Hint',
        rect: { x: 10, y: 705, width: 50, height: 30 },
      });
    }
    if (page.extraNative)
      add(parent, {
        type: 'android.widget.EditText',
        identifier: page.extraNative,
        rect: { x: 39, y: 1700, width: 300, height: 73 },
      });
    if (page.closeButton)
      add(parent, {
        type: 'android.widget.Button',
        identifier: 'qa-close',
        label: 'Close',
        rect: { x: 560, y: 100, width: 140, height: 80 },
      });
    add(parent, {
      type: 'android.widget.Button',
      identifier: 'qa-otp-verify',
      label: 'Verify',
      rect: { x: 39, y: 520, width: 642, height: 88 },
    });
    if (page.footer)
      add(content, {
        type: 'android.widget.Button',
        identifier: 'qa-footer',
        label: 'Footer',
        rect: { x: 0, y: 300, width: 720, height: 1210 },
      });
  };
  const modalWindow = () => {
    const top = add(application, { type: 'Window', rect: frame });
    const sheet = add(top, {
      type: 'android.view.ViewGroup',
      identifier: 'qa-modal',
      rect: { x: 0, y: 82, width: 720, height: 1428 },
    });
    if (nativeField === 'modal') codeField(sheet);
    else
      add(sheet, {
        type: 'android.widget.Button',
        identifier: 'qa-modal-ok',
        label: 'OK',
        rect: { x: 39, y: 900, width: 642, height: 88 },
      });
  };
  const dialogWindow = () => {
    const top = add(application, {
      type: 'Window',
      rect: { x: 60, y: 300, width: 600, height: 400 },
    });
    const box = add(top, {
      type: 'android.widget.FrameLayout',
      rect: { x: 60, y: 300, width: 600, height: 400 },
    });
    if (nativeField === 'dialog') codeInput(box, { x: 100, y: 400, width: 14, height: 73 });
    add(box, {
      type: 'android.widget.Button',
      identifier: 'qa-dialog-ok',
      label: 'OK',
      rect: { x: 100, y: 600, width: 400, height: 80 },
    });
  };
  for (const kind of page.windows ?? ['page'])
    ({ page: pageWindow, modal: modalWindow, dialog: dialogWindow })[kind]();
  const keyboardY = page.keyboardY ?? 1000;
  if (page.keyboard)
    add(application, {
      type: 'Keyboard',
      packageName: 'com.android.inputmethod',
      rect: { x: 0, y: keyboardY, width: 720, height: 1600 - keyboardY },
    });
  if (page.noVisibleFact) for (const node of nodes) delete node.visibleToUser;
  const generation = 7;
  // The runner's presence pass (CommandDispatcher PresencePass): eligible only with exactly one app window
  // (QaHierarchy.assemble); an ineligible pass is incomplete and leaves every node unknown with no reason.
  const appWindows = nodes.filter((node) => node.type === 'Window').length;
  const eligible = appWindows === 1;
  if (presence)
    // Per node as PresenceRules.observe, first match: structural or unnamed nodes unknown; an invisible node
    // keyboard-covered when its frame meets the keyboard's, else clipped; an empty frame empty-frame; a shared
    // descriptor ambiguous-descriptor; then the live hit: a window drawn above (the keyboard's) or a later,
    // enabled, visible, clickable node of its window over its centre, outside its own ancestry, is
    // not-hittable; else observed. Label sources as PresenceRules.labelSources: an editable node with text
    // gives value, any other label direct (a content description too), text below descendant, else none.
    nodes.forEach((node, nodeIndex) => {
      const rect = node.rect as Rect;
      const structural = ['Application', 'Window', 'Keyboard'].includes(node.type as string);
      const label = typeof node.label === 'string' ? node.label : '';
      const hasText = (n: Record<string, unknown>) =>
        !described.has(n.index as number) &&
        typeof n.label === 'string' &&
        n.label.trim() !== '' &&
        n.type !== 'android.view.ViewGroup';
      const textBelow = (index: number): boolean =>
        nodes.some(
          (child) =>
            child.parentIndex === index && (hasText(child) || textBelow(child.index as number)),
        );
      const editable = String(node.type).endsWith('EditText');
      const labelSource = structural
        ? 'none'
        : editable && hasText(node)
          ? 'value'
          : label.trim() !== ''
            ? 'direct'
            : textBelow(nodeIndex)
              ? 'descendant'
              : 'none';
      const named = node.identifier !== '' || labelSource !== 'none';
      const base = { captureId: 'capture-7', generation, nodeIndex, labelSource };
      if (!eligible) {
        node.presence = { ...base, status: 'unknown' };
        return;
      }
      // The runner's Bounds (QaHierarchy.kt): an empty rect contains and meets nothing; containment is
      // half-open; the centre is the integer midpoint of the edges (PresenceRules.hit).
      const empty = (r: Rect) => r.width <= 0 || r.height <= 0;
      const meets = (a: Rect, b: Rect) =>
        !empty(a) &&
        !empty(b) &&
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      const keyboardRect = page.keyboard
        ? { x: 0, y: keyboardY, width: 720, height: 1600 - keyboardY }
        : undefined;
      const cx = Math.trunc((rect.x + rect.x + rect.width) / 2);
      const cy = Math.trunc((rect.y + rect.y + rect.height) / 2);
      const contains = (r: Rect) =>
        !empty(r) && cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height;
      const ancestry = (a: number, b: number) => {
        for (let p = nodes[b].parentIndex as number | undefined; p !== undefined; )
          if (p === a) return true;
          else p = nodes[p].parentIndex as number | undefined;
        return false;
      };
      const windowOf = (index: number): number => {
        let i = index;
        while (nodes[i].type !== 'Window' && nodes[i].parentIndex !== undefined)
          i = nodes[i].parentIndex as number;
        return i;
      };
      const covered =
        (keyboardRect !== undefined && contains(keyboardRect)) ||
        nodes.some(
          (other, otherIndex) =>
            otherIndex > nodeIndex &&
            other.type === 'android.widget.Button' &&
            other.enabled === true &&
            other.visibleToUser === true &&
            windowOf(otherIndex) === windowOf(nodeIndex) &&
            !ancestry(otherIndex, nodeIndex) &&
            !ancestry(nodeIndex, otherIndex) &&
            contains(other.rect as Rect),
        );
      const descriptor = JSON.stringify([node.type, node.identifier, label, rect]);
      const shared =
        nodes.filter(
          (other) =>
            !['Application', 'Window', 'Keyboard'].includes(other.type as string) &&
            JSON.stringify([other.type, other.identifier, other.label, other.rect]) === descriptor,
        ).length > 1;
      const reason =
        structural || !named
          ? undefined
          : node.visibleToUser === false
            ? keyboardRect && meets(rect, keyboardRect)
              ? 'keyboard-covered'
              : 'clipped'
            : !(rect.width > 0 && rect.height > 0)
              ? 'empty-frame'
              : shared
                ? 'ambiguous-descriptor'
                : covered
                  ? 'not-hittable'
                  : 'observed';
      node.presence =
        reason === 'observed'
          ? { ...base, status: 'observed', observedUptimeMs: 150 }
          : { ...base, status: 'unknown', ...(reason ? { unknownReason: reason } : {}) };
    });
  return {
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotGeneration: generation,
    // The runner reports the display density on every snapshot (CommandDispatcher snapshot data).
    pointScale: POINT_SCALE,
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
            complete: eligible,
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
  const textInput = (testID: string, disabled = false) => {
    const shared = {
      testID,
      onChangeText: noop,
      maxLength: 4,
      ...(page.typed && testID === (page.inputTestID ?? ID) ? { value: page.typed } : {}),
      ...(disabled ? { accessibilityState: { disabled: true } } : {}),
    };
    return {
      name: 'TextInput',
      props: shared,
      children: [{ hostType: 'AndroidTextInput', props: { ...shared, onChange: noop } }],
    };
  };
  const input = textInput(page.inputTestID ?? ID, page.reactDisabled);
  // An inactive route the capture prunes (legacy.program.txt inactiveRoute): a Screen with activityState 0.
  const pruned = (children: unknown[]) => ({
    name: 'Screen',
    props: { activityState: 0 },
    children,
  });
  const fieldChildren = page.noInput
    ? []
    : page.prunedInput
      ? [pruned([textInput(page.prunedInput)])]
      : [input];
  const field = {
    name: 'View',
    props: { testID: 'qa-otp-code-field', accessible: true },
    children: [
      {
        hostType: 'RCTView',
        props: { testID: 'qa-otp-code-field', accessible: true },
        children: [...fieldChildren, box(1), box(2), box(3), box(4)],
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
  const extra = page.extraInput ? [textInput(page.extraInput)] : [];
  const okButton = {
    name: 'Pressable',
    props: { testID: 'qa-modal-ok', accessibilityRole: 'button', onPress: noop },
    children: [
      {
        hostType: 'RCTView',
        props: { testID: 'qa-modal-ok', accessibilityRole: 'button', onClick: noop },
      },
    ],
  };
  // A shown Modal: Modal.js renders RCTModalHostView only while shown. `split`: its first host lies inside a
  // pruned route, so the two traversals see the Modal and its content separately (round 5, case 4).
  const modal = page.reactModal
    ? [
        {
          name: 'Modal',
          props: { visible: true, transparent: false },
          children: [
            {
              hostType: 'RCTModalHostView',
              props: {},
              children:
                page.reactModal === 'split'
                  ? [
                      pruned([
                        {
                          hostType: 'RCTView',
                          props: { testID: 'qa-modal' },
                          children: [okButton],
                        },
                      ]),
                    ]
                  : [{ hostType: 'RCTView', props: { testID: 'qa-modal' }, children: [okButton] }],
            },
          ],
        },
      ]
    : [];
  const screen =
    page.reactScreen === 'replaced' || page.nextScreen
      ? // The screen that replaced the code page between the native and the React read: one input with the id.
        [
          {
            name: 'View',
            props: { testID: 'qa-next-screen' },
            children: [
              {
                hostType: 'RCTView',
                props: { testID: 'qa-next-screen' },
                children: [textInput(ID)],
              },
            ],
          },
        ]
      : [
          {
            name: 'View',
            props: { testID: 'qa-otp-nofocus-screen' },
            children: [
              {
                hostType: 'RCTView',
                props: { testID: 'qa-otp-nofocus-screen' },
                children: [field, ...extra, verify],
              },
            ],
          },
          ...modal,
        ];
  const root = { current: buildFiber({ name: 'Screen', children: screen }) };
  // Host fibers as React Native renders them: tag 5 with a view measureInWindow measures in dp (each host's
  // native frame over the point scale); digits are HostText (tag 6).
  const frames: Record<string, Rect> = {
    'qa-otp-nofocus-screen': { x: 0, y: 82, width: 720, height: 1428 },
    'qa-otp-code-field': { x: 39, y: 325, width: 642, height: 92 },
    [page.inputTestID ?? ID]: inputRect(page),
    'qa-otp-verify': { x: 39, y: 520, width: 642, height: 88 },
    ...Object.fromEntries(
      [39, 137, 235, 334].map((x, i) => [
        `qa-otp-box-${i + 1}`,
        { x, y: 325, width: 80, height: 92 },
      ]),
    ),
    // The screen that replaced the code page: its own frame, and its input below the display (round 5, case 3).
    ...(page.reactScreen === 'replaced' || page.nextScreen
      ? {
          'qa-next-screen': { x: 0, y: 82, width: 720, height: 1428 },
          [ID]: { x: 39, y: 1700, width: 300, height: 73 },
        }
      : {}),
    ...page.reactFrames,
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
    // React is read inside the capture, after the native read, as in production (capture.ts).
    react: async () =>
      (page.noReact
        ? {}
        : await captureQaReact(
            {
              isConnected: true,
              async withPrivateHelperWorld(run) {
                return run(async (expression) => vm.runInContext(expression, sandbox));
              },
            },
            // As production (walk.ts:1094): a presence read also reads React's host tree.
            presence,
          )) as never,
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
  return { ...f, presenceReads: () => presenceReads, captures: () => captures };
}

const text = (reason: unknown): string =>
  reason === undefined ? '' : renderReason(reason as never, (value) => value);
const WAIT = `1. Wait for "${ID}" to appear`;
const PRESENT =
  'present: Android reports a native text input carrying this id, not visible to the user (hidden in place)';
const STABLE = `"${ID}" did not appear within 15s; the screen did not change across`;
const TODAY = `the element carrying the identifier "${ID}" is offscreen: input id=${ID} frame=39,325,14,73 native; target visibility: absent`;
const WORDS =
  '; on the read failure.screen shows, Android reports that element as not visible to the user, its frame overlapping the visible area with its centre inside it (hidden in place)';
const INPUT = (line: number) =>
  `Android reports the target of line ${line} as an input that is not visible to the user (hidden in place)`;
const PART =
  'wait for the testID of a visible part of the field, such as its wrapper or a digit box';
const ADVICE = {
  form: (line: number) =>
    `${INPUT(line)}; only a Wait written Wait for "<testID>", optionally followed by "to appear", or Wait until "<testID>" appears counts such an input present. If the plan needs only the input to be present, write line ${line} in one of those forms; otherwise ${PART}.`,
  notInput: (line: number) =>
    `Android reports the target of line ${line} as not visible to the user (hidden in place); a Wait counts a hidden element present only when it is a native text input. Wait for the testID of a visible control instead.`,
  disabled: (line: number) =>
    `${INPUT(line)}; on the read failure.screen shows it is disabled, and a Wait counts a hidden input present only while it is enabled. If an earlier step enables the field, put it before line ${line}; otherwise ${PART}.`,
  covered: (line: number) =>
    `${INPUT(line)}; on the read failure.screen shows its centre does not pass the keyboard and overlay clearance check a visible testID passes. Dismiss the keyboard or bring the field clear before line ${line}, or ${PART}.`,
  unmet: (line: number) =>
    `${INPUT(line)}; this Wait did not establish the input's presence during polling. Wait for the testID of a visible part of the field, such as its wrapper or a digit box.`,
  blockStart: (line: number) =>
    `Android reports the target of line ${line} as not visible to the user (hidden in place); a block's starts on: line counts only what the user can see. Use the testID of a visible control of that screen in starts on:, then re-record the block if it is saved.`,
  storedLabel: (line: number) =>
    `${INPUT(line)}; this saved line quotes other text than the input's testID, and a Wait counts such an input present only when its line quotes that testID. Quote the field's testID itself in the saved plan line, then re-record the block, or wait for a visible control.`,
};

async function walk(plan: string, page: Page, options?: Parameters<typeof android>[2]) {
  const f = android(page, 'android', options);
  const result = await runPlan(parsePlan(plan).blocks!, f.deps);
  return { f, result, seen: text(result.failure?.seen) };
}

for (const [state, page] of [
  ['unfocused', {}],
  ['focused', { focused: true, keyboard: true }],
] as Array<[string, Page]>)
  test(`W1: ${state}: an explicit Wait passes at the first read on the hidden code input`, async () => {
    const { f, result, seen } = await walk(WAIT, page);
    assert.equal(result.verdict, 'PASS', seen);
    assert.deepEqual(f.actions, []);
    assert.equal(f.captures(), 1);
    assert.equal(f.presenceReads(), 0);
    const row = result.steps!.find((r) => r.line === 1)!;
    assert.equal(result.steps!.length, 1);
    assert.equal(row.outcome, 'pass');
    assert.deepEqual(row.selector, { id: ID });
    assert.equal(row.reason, PRESENT);
  });

for (const line of [
  `Wait for "${ID}"`,
  `Wait until "${ID}" appears`,
  `Wait for “${ID}” to appear`,
  `WAIT FOR "${ID}" TO APPEAR`,
])
  test(`W2: the presence form ${line} counts the hidden input`, async () => {
    const { result, seen } = await walk(`1. ${line}`, {});
    assert.equal(result.verdict, 'PASS', seen);
    assert.equal(result.steps!.find((r) => r.line === 1)?.reason, PRESENT);
  });

for (const line of [
  `Wait until "${ID}" is visible`,
  `Wait until "${ID}" shows up`,
  `Wait for the text "${ID}" to appear`,
  `Wait until "${ID}"`,
  `Wait for "${ID}" to appears`,
  `Wait for "${ID}" appears`,
  `Wait until "${ID}" to appear`,
])
  test(`W2: ${line} does not count it and fails with the form advice`, async () => {
    const { result, seen } = await walk(`1. ${line}`, {});
    assert.equal(result.verdict, 'FAIL', line);
    assert.equal(result.failure?.kind, 'step', line);
    assert.equal(result.failure?.subreason, 'absent', line);
    assert.ok(seen.startsWith(STABLE), seen);
    assert.ok(seen.includes(`${TODAY}${WORDS}`), seen);
    assert.equal(result.failure?.suggestion, ADVICE.form(1), line);
  });

// The regression set: each shape hidden in place and visible to the user gives one verdict.
// Below the display: the frame round 5 gives the other input in cases 2 and 3.
const BELOW = { x: 39, y: 1700, width: 300, height: 73 };
const PASSES: Array<[string, Page]> = [
  // Round 5, case 1: the field's TextInput is pruned (an inactive route) under "row/qa-otp-code", which the
  // runner normalizes to the quoted id, while another React TextInput carries the exact id with no native node.
  ['round 5 case 1, pruned React alias', { prunedInput: `row/${ID}`, extraInput: ID }],
  // Round 5, case 2: setNativeProps swapped the native ids: the hidden node carries the id React gave an input
  // below the display, whose native node carries the other id; each React host measures at its own native
  // frame (React's qa-otp-code host below the display).
  [
    'round 5 case 2, native id swap',
    { inputTestID: OTHER, extraInput: ID, extraNative: OTHER, reactFrames: { [ID]: BELOW } },
  ],
  // Round 5, case 3, screen A alone: only "row/qa-otp-code", hidden in place, on both reads.
  ['round 5 case 3, screen A alone', { inputTestID: `row/${ID}` }],
  // Round 5, case 3, the mixed read: screen A's native read, then the React read of screen B, which replaced
  // it, holding a different TextInput qa-otp-code measured below the display.
  [
    'round 5 case 3, native A then React B',
    { inputTestID: `row/${ID}`, reactScreen: 'replaced', reactFrames: { [ID]: BELOW } },
  ],
  // Round 5, case 4: Android lists only the Modal's window, holding the native input; React's input is on
  // the page behind, and the Modal's first host lies in a pruned route.
  [
    'round 5 case 4, Modal split across traversals',
    { windows: ['modal'], nativeField: 'modal', reactModal: 'split' },
  ],
  // R1: a native, non-React dialog of the app is the only window listed, and its input carries the id.
  ['R1, a non-React dialog input', { windows: ['dialog'], nativeField: 'dialog' }],
  // R2: the native read lists only the Modal's window holding the input; React, read after it closed, has none.
  ['R2, a Modal closing between reads', { windows: ['modal'], nativeField: 'modal' }],
  // A Modal's window over the page, the input in the page behind it.
  ['the input behind a Modal window', { windows: ['page', 'modal'], reactModal: 'over' }],
  ['identifier from the content description', { descriptionOnly: true }],
  ['partly outside the visible area, centre inside', { inputX: -5 }],
  ['the quoted id also part of a longer visible label', { aggregate: true }],
  ['no React capture', { noReact: true }],
];
// Each shape a visible id fails: the words today's diagnosis gives, and whether the read failure.screen shows still
// carries the hidden-in-place diagnosis (the interim's F5 shapes carry none: today's words and advice only).
const FAILS: Array<[string, Page, string, 'today' | 'hidden']> = [
  [
    'a second carrier of the id',
    { secondCarrier: true },
    `2 elements carry the identifier "${ID}"`,
    'today',
  ],
  [
    'scrolled out',
    { inputRect: { x: 39, y: 1600, width: 14, height: 0 } },
    `"${ID}" is offscreen`,
    'today',
  ],
  [
    'below the display',
    { inputRect: { x: 39, y: 1700, width: 14, height: 73 } },
    `"${ID}" is offscreen`,
    'today',
  ],
  [
    'the keyboard over the centre',
    { focused: true, keyboard: true, keyboardY: 300 },
    `"${ID}" has its centre covered (keyboard)`,
    'today',
  ],
  // Hidden, the input is offscreen by QaReN's own fact; visible, its centre is under the footer.
  ['a wide footer over the centre', { footer: true }, 'is offscreen', 'hidden'],
  // Round 5, case 3, screen B alone: its only input carrying the id lies below the display on both reads.
  ['round 5 case 3, screen B alone', { nextScreen: true }, 'is offscreen', 'today'],
  // The input's own frame in view, its non-scrolling parent below the display (the ancestor exclusion).
  ['an ancestor outside the screen', { ancestorOutside: true }, 'is offscreen', 'hidden'],
];
const row = (walked: { result: Awaited<ReturnType<typeof runPlan>> }) =>
  walked.result.steps!.find((r) => r.line === 1)!;

for (const [name, page] of PASSES)
  test(`W3: ${name}: passes exactly as a visible id passes`, async () => {
    const hidden = await walk(WAIT, page);
    const visible = await walk(WAIT, { ...page, inputVisible: true });
    assert.equal(visible.result.verdict, 'PASS', `${name} (visible): ${visible.seen}`);
    assert.equal(hidden.result.verdict, 'PASS', `${name} (hidden): ${hidden.seen}`);
    assert.equal(row(hidden).reason, PRESENT, name);
    assert.equal(row(visible).reason, undefined, name);
    // The same stored selector as the visible id (withheld alike when privacy holds the id as a value).
    assert.deepEqual(row(hidden).selector, row(visible).selector, name);
  });

for (const count of [1, 2] as const)
  test(`W3a: ${count} comma-aggregated container(s) also carrying the id: the hidden input passes as the visible id`, async () => {
    // The pin's aggregate-label check (resolve.ts aggregateTargetVisible) passes one such container with no
    // selector and refuses two as ambiguous; a visible id passes before it is asked, and so must the hidden one.
    const hidden = await walk(WAIT, { commaAggregate: count });
    const visible = await walk(WAIT, { commaAggregate: count, inputVisible: true });
    assert.equal(visible.result.verdict, 'PASS', visible.seen);
    assert.deepEqual(row(visible).selector, { id: ID });
    assert.equal(hidden.result.verdict, 'PASS', hidden.seen);
    assert.equal(row(hidden).reason, PRESENT);
    assert.deepEqual(row(hidden).selector, { id: ID });
  });

for (const [name, page, words, diagnosis] of FAILS)
  test(`W3f: ${name}: the hidden input fails as the visible id fails`, async () => {
    const hidden = await walk(WAIT, page);
    const visible = await walk(WAIT, { ...page, inputVisible: true });
    assert.equal(visible.result.verdict, 'FAIL', `${name} (visible)`);
    assert.equal(hidden.result.verdict, 'FAIL', `${name} (hidden)`);
    assert.ok(hidden.seen.includes(words), `${name}: ${hidden.seen}`);
    assert.deepEqual(hidden.f.actions, [], name);
    const suggestion = String(hidden.result.failure?.suggestion ?? '');
    if (diagnosis === 'today') {
      // As the interim's F5: no hidden-in-place words and no hidden-in-place advice.
      assert.ok(!hidden.seen.includes('hidden in place'), hidden.seen);
      assert.ok(!suggestion.includes('hidden in place'), suggestion);
    } else assert.ok(hidden.seen.includes(WORDS), hidden.seen);
    // F5's next step for an input outside the visible area: today's absent advice, present, not empty.
    if (name === 'scrolled out' || name === 'below the display')
      assert.match(suggestion, /was not on the last observed screen/);
  });

test('W3u: an unresolved text carrying the quote leaves the hidden input counted', async () => {
  const hidden = await walk(WAIT, { unsureText: true });
  const visible = await walk(WAIT, { unsureText: true, inputVisible: true });
  assert.equal(visible.result.verdict, 'PASS', visible.seen);
  assert.equal(hidden.result.verdict, 'PASS', hidden.seen);
  assert.equal(row(hidden).reason, PRESENT);
});

// React's measured host frames (window points, as the injected helper reports them) for round 5's cases 2 and 3,
// by host: each TextInput carrying a testID sits where the case puts it.
const CASE_2 = PASSES.find(([name]) => name === 'round 5 case 2, native id swap')![1];
const CASE_3A = PASSES.find(([name]) => name === 'round 5 case 3, screen A alone')![1];
const CASE_3B = FAILS.find(([name]) => name === 'round 5 case 3, screen B alone')![1];
const AT_FIELD = { x: 19.5, y: 162.5, width: 7, height: 36.5 };
const AT_BELOW = { x: 19.5, y: 850, width: 150, height: 36.5 };
for (const [name, page, inputs] of [
  ['case 2, the swap', CASE_2, { [ID]: AT_BELOW, [OTHER]: AT_FIELD }],
  ['case 3, screen A alone', CASE_3A, { [`row/${ID}`]: AT_FIELD }],
  [
    'case 3, screen B (B alone; the mixed read uses the same React read)',
    CASE_3B,
    { [ID]: AT_BELOW },
  ],
] as Array<[string, Page, Record<string, Rect>]>)
  test(`W3m: round 5 ${name}: each React input host measures at the case's frame`, async () => {
    const sandbox = reactSandbox(page);
    const observed = (await captureQaReact(
      {
        isConnected: true,
        async withPrivateHelperWorld(run) {
          return run(async (expression) => vm.runInContext(expression, sandbox));
        },
      },
      true,
    )) as {
      interactive: Array<{ role: string; testID?: string; inputHostIndices?: number[] }>;
      hostEvidence?: { typography?: { nodes: Array<{ hostIndex: number; rect?: Rect }> } };
    };
    const nodes = observed.hostEvidence!.typography!.nodes;
    const measured = Object.fromEntries(
      observed.interactive
        .filter((entry) => entry.role === 'textinput')
        .map((entry) => [
          entry.testID,
          nodes.find((node) => node.hostIndex === entry.inputHostIndices![0])?.rect,
        ]),
    );
    assert.deepEqual(measured, inputs);
  });

// The hidden-in-place facts a visible id does not need: a native text input, enabled, a known viewport.
for (const [name, page, advice] of [
  ['a hidden ViewGroup', { inputClass: 'android.view.ViewGroup' }, ADVICE.notInput(1)],
  ['native enabled false', { nativeEnabled: false }, ADVICE.disabled(1)],
  // React's TextInput disabled while its native node is enabled: React's facts can only refuse. The Wait's
  // ordinary reads take it from the unique React entry, recovery's presence read from the associated host.
  ['the React TextInput disabled', { reactDisabled: true }, ADVICE.disabled(1)],
] as Array<[string, Page, string]>)
  test(`W4: ${name}: the visible id passes, the hidden input fails with the advice`, async () => {
    const visible = await walk(WAIT, { ...page, inputVisible: true });
    assert.equal(visible.result.verdict, 'PASS', `${name} (visible): ${visible.seen}`);
    const hidden = await walk(WAIT, page);
    assert.equal(hidden.result.verdict, 'FAIL', name);
    assert.equal(hidden.result.failure?.subreason, 'absent', name);
    assert.ok(hidden.seen.includes(WORDS), `${name}: ${hidden.seen}`);
    assert.equal(hidden.result.failure?.suggestion, advice, name);
  });

test('W4: with no recovery read, the Wait’s own read names the disabled input', async () => {
  const own = await walk(WAIT, { reactDisabled: true }, { noRecovery: true });
  assert.equal(own.result.verdict, 'FAIL');
  assert.equal(own.result.failure?.suggestion, ADVICE.disabled(1));
  assert.equal(own.result.failure?.screen?.controls?.find((c) => c.id === ID)?.enabled, false);
});

// No clipping viewport known (empty Application and Window frames), or a frame of no size: the visible id
// passes; the hidden input fails with today's words and advice (hiddenInView needs a frame of positive size,
// and no read establishes the visible area).
for (const [name, page] of [
  ['no clipping viewport', { emptyRoot: true }],
  ['a 0x0 frame', { inputRect: { x: 39, y: 325, width: 0, height: 0 } }],
  // The interim's F5 shape: with no clip known a visible id below the display still passes on the pin.
  [
    'no clip, below the display',
    { emptyRoot: true, inputRect: { x: 39, y: 1750, width: 14, height: 73 } },
  ],
] as Array<[string, Page]>)
  test(`W4: ${name}: the visible id passes, the hidden input fails with today’s advice`, async () => {
    const visible = await walk(WAIT, { ...page, inputVisible: true });
    assert.equal(visible.result.verdict, 'PASS', `${name}: ${visible.seen}`);
    const hidden = await walk(WAIT, page);
    assert.equal(hidden.result.verdict, 'FAIL', `${name}: ${hidden.seen}`);
    assert.ok(hidden.seen.includes(`"${ID}" is offscreen`), hidden.seen);
    assert.ok(!hidden.seen.includes('hidden in place'), hidden.seen);
    assert.match(String(hidden.result.failure?.suggestion), /was not on the last observed screen/);
  });

test('W4c: the capture facts, asked of the rule directly', async () => {
  const screen = await codePage({}, false);
  const target = { quoted: ID, phrase: ID };
  assert.equal(resolve.hiddenInputPresence(target, screen), true);
  assert.equal(resolve.hiddenInputPresence({ ...target, exact: 'id' as const }, screen), true);
  assert.equal(resolve.hiddenInputPresence({ ...target, exact: 'text' as const }, screen), false);
  const input = screen.elements.find((e) => e.testID === ID && !e.ref.startsWith('react:'))!;
  assert.equal(resolve.hiddenInputGap(input, screen), undefined);
  for (const front of ['dialog', 'picker', 'dev-menu', 'dev-fab', 'dev-redbox'] as const) {
    assert.equal(resolve.hiddenInputGap(input, { ...screen, front }), 'capture', front);
    assert.equal(resolve.hiddenInputPresence(target, { ...screen, front }), false, front);
  }
  for (const native of ['incomplete', 'unknown'] as const) {
    const partial = { ...screen, captureCoverage: { ...screen.captureCoverage!, native } };
    assert.equal(resolve.hiddenInputGap(input, partial), 'capture', native);
    assert.equal(resolve.hiddenInputPresence(target, partial), false, native);
  }
  // A visible input is no hidden-in-place identity: the rule leaves it to evidence.
  assert.equal(
    resolve.hiddenInputPresence(target, await codePage({ inputVisible: true }, false)),
    false,
  );
});

const VISIBLE_FORM = `1. Wait until "${ID}" is visible`;

test('W5: a hidden non-input gets the non-input advice before the form', async () => {
  const viewGroup = await walk(VISIBLE_FORM, { inputClass: 'android.view.ViewGroup' });
  assert.ok(viewGroup.seen.includes(`${TODAY}${WORDS}`), viewGroup.seen);
  assert.equal(viewGroup.result.failure?.suggestion, ADVICE.notInput(1));
});

// The interim's F1 failure shape, carried on a form that still fails on head.
for (const [state, page] of [
  ['unfocused', {}],
  ['focused', { focused: true, keyboard: true }],
] as Array<[string, Page]>)
  test(`W5: ${state}: a non-presence Wait on the hidden input keeps the interim's failure shape`, async () => {
    const { f, result, seen } = await walk(VISIBLE_FORM, page);
    assert.equal(result.verdict, 'FAIL');
    assert.equal(result.failure?.kind, 'step');
    assert.equal(result.failure?.subreason, 'absent');
    assert.ok(seen.startsWith(STABLE), seen);
    assert.ok(seen.includes(`${TODAY}${WORDS}`), seen);
    assert.deepEqual(f.actions, []);
    assert.equal(f.presenceReads(), 1);
    assert.equal(result.failure?.suggestion, ADVICE.form(1));
    const input = result.failure?.screen?.controls?.find((control) => control.id === ID);
    assert.equal(input?.role, 'input');
    assert.equal(input?.enabled, true);
    assert.equal(input?.offscreen, true);
    assert.deepEqual(result.failure?.screen?.counts, { controls: 2, enabled: 2, hidden: 1 });
  });

// The interim's F4o: the words claim overlap and the centre only, for an input partly outside the visible area.
test('W5: partly outside the visible area, on a non-presence form: the words and the form advice', async () => {
  const partial = await walk(VISIBLE_FORM, { inputX: -5 });
  assert.ok(partial.seen.includes(WORDS), partial.seen);
  assert.equal(partial.result.failure?.suggestion, ADVICE.form(1));
});

test('W5: a disabled input on a non-presence form gets the form advice first', async () => {
  const formFirst = await walk(VISIBLE_FORM, { nativeEnabled: false });
  assert.equal(formFirst.result.failure?.suggestion, ADVICE.form(1));
});

test('W5: a wide footer over the centre gets the clearance advice', async () => {
  const footer = await walk(WAIT, { footer: true });
  assert.ok(footer.seen.includes(WORDS), footer.seen);
  assert.equal(footer.result.failure?.suggestion, ADVICE.covered(1));
});

test('W5: the Wait’s reads without the input and recovery’s read with it: the fallback advice', async () => {
  // Recovery's read, which failure.screen shows, has the hidden input and no gap it can name.
  const late = await walk(WAIT, { noInput: true }, { recovered: {} });
  assert.equal(late.result.verdict, 'FAIL');
  assert.ok(late.seen.includes(WORDS), late.seen);
  assert.equal(late.result.failure?.suggestion, ADVICE.unmet(1));
});

test('W5: an ancestor outside the screen: both twins fail; the hidden one gets the fallback advice', async () => {
  // Every condition the advice could name looks met on failure.screen's read; the ancestor exclusion is what
  // kept the input offscreen, so the advice claims only that this Wait did not establish presence.
  const hidden = await walk(WAIT, { ancestorOutside: true });
  assert.equal(hidden.result.verdict, 'FAIL');
  assert.equal(hidden.result.failure?.subreason, 'absent');
  assert.ok(hidden.seen.includes(WORDS), hidden.seen);
  assert.equal(hidden.result.failure?.suggestion, ADVICE.unmet(1));
  const visible = await walk(WAIT, { ancestorOutside: true, inputVisible: true });
  assert.equal(visible.result.verdict, 'FAIL');
  assert.ok(!visible.seen.includes('hidden in place'), visible.seen);
});

test('W5: the Wait’s reads with the input and recovery’s read without it: no hidden-in-place words', async () => {
  const gone = await walk(VISIBLE_FORM, {}, { recovered: { noInput: true } });
  assert.ok(!gone.seen.includes('hidden in place'), gone.seen);
  assert.equal(gone.result.failure?.screen?.counts?.hidden, 0);
  assert.match(String(gone.result.failure?.suggestion), /was not on the last observed screen/);
});

test('W5: with no recovery read, the Wait’s own read is the one failure.screen shows', async () => {
  const own = await walk(VISIBLE_FORM, {}, { noRecovery: true });
  assert.equal(own.f.presenceReads(), 0);
  assert.ok(own.seen.includes(WORDS), own.seen);
  assert.equal(own.result.failure?.suggestion, ADVICE.form(1));
  // failure.screen agrees with the words: the input listed, enabled, offscreen.
  const input = own.result.failure?.screen?.controls?.find((control) => control.id === ID);
  assert.equal(input?.role, 'input');
  assert.equal(input?.enabled, true);
  assert.equal(input?.offscreen, true);
});

for (const [name, page] of [
  ['on every read', { aggregate: true }],
  ['on recovery’s read only', {}],
] as Array<[string, Page]>)
  test(`W5: the quoted id inside a longer label ${name}: that read’s own diagnosis and advice stand`, async () => {
    const result = await walk(VISIBLE_FORM, page, { recovered: { aggregate: true } });
    assert.equal(result.result.verdict, 'FAIL');
    assert.equal(result.result.failure?.subreason, 'only-in-aggregated-label');
    assert.ok(!result.seen.includes('hidden in place'), result.seen);
    assert.match(String(result.result.failure?.suggestion), /is only part of a larger label/);
  });

// Recovery's own plan edit for an interruption a later step owns keeps precedence over the hidden-input advice.
test('W5: a disabled hidden input, then a step that taps a visible Close: recovery’s plan edit stands', async () => {
  const { result, seen } = await walk(`${WAIT}\n2. Tap "Close"`, {
    nativeEnabled: false,
    closeButton: true,
  });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.failure?.step, 1);
  assert.equal(result.failure?.subreason, 'absent');
  assert.equal(result.failure?.screen?.controls?.find((c) => c.id === ID)?.enabled, false);
  assert.equal(
    result.failure?.suggestion,
    'line 2 targets this control; if the interruption is optional, move that step before line 1 or remove it',
    seen,
  );
});

test('W5: a changing screen is no definite stable absence: no hidden-in-place words or advice', async () => {
  const changing = await walk(VISIBLE_FORM, {}, { alternate: { heading: 'Enter the code now' } });
  assert.equal(changing.result.verdict, 'FAIL');
  assert.ok(!changing.seen.includes('hidden in place'), changing.seen);
  assert.ok(!String(changing.result.failure?.suggestion ?? '').includes('hidden in place'));
});

function storedWait(raw: string): StoredBlock {
  return {
    header: { name: 'Code', appId: APP, platform: 'android' },
    steps: [{ raw, kind: 'wait', selector: { id: ID } }],
  } as never;
}
const LABEL_WAIT = '1. Wait for "Verification code" to appear';
const codeBlock = (line: string) => parsePlan(`## QA\n\n### Code\n${line}\n`).blocks![0];

test('W6s: the passing Wait saves its testID', async () => {
  const block = codeBlock(WAIT);
  const walked = await runPlan([block], android({}).deps);
  assert.equal(walked.verdict, 'PASS');
  const saved = serializeBlock(block, walked.steps!, { appId: APP, platform: 'android' });
  assert.ok('yaml' in saved, JSON.stringify(saved));
  assert.ok(
    saved.yaml.includes(`- extendedWaitUntil: { visible: { id: "${ID}" }, timeout: 15000 }`),
  );
  assert.deepEqual((readBlock(saved.yaml) as StoredBlock).steps[0].selector, { id: ID });
});

// Stored blocks seeded independently of the walk, so the pin measures each replay on its own.
for (const focus of ['unfocused', 'focused'] as const)
  for (const how of ['replayBlock', 'loginBlock'] as const) {
    const page: Page = focus === 'focused' ? { focused: true, keyboard: true } : {};
    const replay = (line: string) =>
      how === 'replayBlock'
        ? replayBlock(codeBlock(line), storedWait(line))
        : loginBlock('code', storedWait(line));
    test(`W6r: ${how}, ${focus}: a saved presence Wait replays under the same rule`, async () => {
      const outcome = await walkBlock(
        replay(WAIT),
        android(page).deps,
        0,
        [],
        undefined,
        undefined,
        {
          mode: 'replay',
        },
      );
      assert.equal(outcome.failure, undefined, text(outcome.failure?.seen));
      assert.equal(outcome.rows[0].reason, PRESENT);
    });
    test(`W6r: ${how}, ${focus}: a label Wait saved with the testID fails with the stored-label advice`, async () => {
      // The visible label's Wait stored the input's id; its line quotes the label, so it is no presence Wait
      // for that id, and the advice must not prescribe the form the line already has.
      const replayed = replay(LABEL_WAIT);
      const outcome = await walkBlock(replayed, android(page).deps, 0, [], undefined, undefined, {
        mode: 'replay',
      });
      assert.ok(outcome.failure, 'the replay fails');
      assert.equal(outcome.failure.subreason, 'absent');
      assert.ok(text(outcome.failure.seen).includes(WORDS), text(outcome.failure.seen));
      // The advice names the replayed item's own plan line (4 in the plan file, 1 in a login block).
      assert.equal(outcome.failure.suggestion, ADVICE.storedLabel(replayed.items[0].line));
    });
  }

for (const [name, line, advice] of [
  ['not in a presence form', VISIBLE_FORM, ADVICE.form(1)],
  ['a label Wait saved with the testID', LABEL_WAIT, ADVICE.storedLabel(1)],
  ['a saved block start', `starts on: "${ID}"`, ADVICE.blockStart(1)],
] as const)
  test(`W6l: a saved login block whose Wait is ${name} carries its advice to the interrupted step`, async () => {
    const f = android({ loginMarker: true });
    f.deps.login = { marker: { id: 'login-screen' }, block: loginBlock('code', storedWait(line)) };
    const ledger = await runPlan(
      parsePlan('1. Wait for "qa-otp-verify"\n2. Tap "Settings"').blocks!,
      f.deps,
    );
    assert.equal(ledger.verdict, 'FAIL');
    assert.equal(ledger.failure?.step, 2);
    assert.equal(ledger.failure?.kind, undefined);
    assert.equal(ledger.failure?.subreason, undefined);
    const seen = text(ledger.failure?.seen);
    assert.ok(seen.startsWith('the login block did not pass: '), seen);
    assert.ok(seen.includes(WORDS), seen);
    assert.equal(ledger.failure?.suggestion, `in the saved login block: ${advice}`);
  });

// A Wait whose counted testID privacy withholds (the identifier is the content description, W3), hidden and visible,
// for the id and for "input", a word of the hidden-pass reason itself (redaction masks it there): each twin is its
// own test, and the unsaved reason is the same true, value-free text for all of them.
for (const id of [ID, 'input'])
  for (const twin of ['hidden', 'visible'] as const)
    test(`W6p: ${twin}, identifier "${id}" from the content description: unsaved for a true reason`, async () => {
      const block = codeBlock(`1. Wait for "${id}" to appear`);
      const page: Page = { descriptionOnly: true, inputId: id, inputVisible: twin === 'visible' };
      const walked = await runPlan([block], android(page).deps);
      assert.equal(walked.verdict, 'PASS', text(walked.failure?.seen));
      const passed = walked.steps!.find((r) => r.line === 4)!;
      assert.equal(passed.selector, undefined);
      // The hidden pass's reason is the fixed words, with "input" masked where privacy holds it.
      if (twin === 'hidden')
        assert.equal(
          text(passed.reason),
          id === 'input' ? PRESENT.replace('text input', `text ${MASK}`) : PRESENT,
        );
      assert.deepEqual(serializeBlock(block, walked.steps!, { appId: APP, platform: 'android' }), {
        unsavable:
          'line 4: this Wait stored no selector: its target has no testID or label, or privacy withholds it as a protected value',
      });
    });

test('W6b: a block start walked visible, saved, and replayed by login recovery on the hidden input', async () => {
  // Walked and saved while the input is visible; loginBlock rebuilds its starts on: as a plain Wait with that raw line.
  const [block] = parsePlan(
    `## QA\n\n### Code\nstarts on: "${ID}"\n1. Wait for "qa-otp-verify"\n`,
  ).blocks!;
  const walked = await runPlan([block], android({ inputVisible: true }).deps);
  assert.equal(walked.verdict, 'PASS', text(walked.failure?.seen));
  const saved = serializeBlock(block, walked.steps!, { appId: APP, platform: 'android' });
  assert.ok('yaml' in saved, JSON.stringify(saved));
  const stored = readBlock(saved.yaml) as StoredBlock;
  assert.equal(stored.steps[0].raw, `starts on: "${ID}"`);
  const f = android({ loginMarker: true });
  f.deps.login = { marker: { id: 'login-screen' }, block: loginBlock('code', stored) };
  const ledger = await runPlan(
    parsePlan('1. Wait for "qa-otp-verify"\n2. Tap "Settings"').blocks!,
    f.deps,
  );
  assert.equal(ledger.verdict, 'FAIL');
  assert.equal(ledger.failure?.step, 2);
  assert.ok(text(ledger.failure?.seen).includes(WORDS), text(ledger.failure?.seen));
  assert.equal(ledger.failure?.suggestion, `in the saved login block: ${ADVICE.blockStart(1)}`);
});

test('W7: unfocused: the Wait passes; the Fill types nothing while the field stays unfocused', async () => {
  const unfocused = await walk(`${WAIT}\n2. Fill "${ID}" with "4821"`, {});
  assert.equal(unfocused.result.steps!.find((r) => r.line === 1)?.reason, PRESENT);
  assert.equal(unfocused.result.failure?.step, 2);
  assert.match(
    unfocused.seen,
    /^TARGET_NOT_FOUND: .* does not hold input focus; nothing was typed and no scroll was tried/,
  );
  assert.deepEqual(unfocused.f.actions, []);
  // PR 1428's refusal at once; with AI-715 (pull request 1529) one retry row on a fresh read first.
  const outcomes = unfocused.result.steps!.filter((r) => r.line === 2).map((r) => r.outcome);
  assert.ok(
    JSON.stringify(outcomes) === '["fail"]' || JSON.stringify(outcomes) === '["retry","fail"]',
    JSON.stringify(outcomes),
  );
});

test('W7: focused: the Wait passes and the Fill types once', async () => {
  const focused = await walk(`${WAIT}\n2. Fill "${ID}" with "4821"`, {
    focused: true,
    keyboard: true,
  });
  assert.equal(focused.result.verdict, 'PASS', focused.seen);
  assert.equal(focused.f.actions.length, 1);
});

for (const [form, verdict] of [
  [`Wait for "${ID}" to appear`, 'PASS'],
  [`Wait until "${ID}" is visible`, 'FAIL'],
] as const)
  test(`W8: after a secret Fill, ${form} ends ${verdict} and discloses no digit`, async () => {
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
      runPlan(parsePlan(`1. Fill "${ID}" with input CODE (secret)\n2. ${form}`).blocks!, f.deps),
    );
    assert.equal(result.verdict, verdict, text(result.failure?.seen));
    if (verdict === 'PASS') assert.equal(result.steps!.find((r) => r.line === 2)?.reason, PRESENT);
    else {
      assert.equal(result.failure?.step, 2);
      assert.ok(text(result.failure?.seen).includes(WORDS));
      const input = result.failure?.screen?.controls?.find((control) => control.id === ID);
      assert.equal(input?.label, MASK);
    }
    // Disclosure only: the secret does not appear, nor its digits in order with up to 12 other characters
    // between them; the rule reads no value of its own.
    const all = JSON.stringify({ result, rows: f.rows });
    assert.equal(all.includes(secret), false, all);
    assert.doesNotMatch(all, /4\D{0,12}8\D{0,12}2\D{0,12}1/, all);
    // A run holding a secret runtime input takes no screenshot.
    assert.equal(shots, 0);
  });

test('W9: iOS reports no visible-to-user fact and keeps develop’s pass', async () => {
  const f = android({ noVisibleFact: true }, 'ios');
  const result = await runPlan(parsePlan(WAIT).blocks!, f.deps);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.steps!.find((r) => r.line === 1)?.reason, undefined);
});
