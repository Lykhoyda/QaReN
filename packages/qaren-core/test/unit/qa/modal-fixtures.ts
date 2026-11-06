import {
  join,
  type NativeNode,
  type ReactHostEvidence,
  type Screen,
} from '../../../dist/qa/screen.js';

type Rect = NonNullable<NativeNode['rect']>;
type HostRow = [ReactHostEvidence['hosts'][number], number | null, string, Rect];

const window: Rect = { x: 0, y: 0, width: 402, height: 874 };
const closeRect: Rect = { x: 20, y: 780, width: 362, height: 50 };
const continueRect: Rect = { x: 20, y: 700, width: 362, height: 50 };
const targetRect: Rect = { x: 20, y: 200, width: 362, height: 50 };
const offersRect: Rect = { x: 20, y: 260, width: 362, height: 50 };

const presence = (nodes: NativeNode[]) => ({
  source: 'xcui-live' as const,
  nodes: nodes.map(() => ({ status: 'observed' as const, labelSource: 'direct' as const })),
});

// The iOS device shape: a full-screen React Native Modal over a mounted Home whose Pressables
// stay in React but have no native nodes while the modal is presented.
export function modalOverHome(
  options: {
    modalType?: string;
    homeNative?: boolean;
    secondControl?: boolean;
    input?: boolean;
    // An ordinary press capture: no platform presence, so no host association.
    ordinary?: boolean;
  } = {},
): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: window },
    { ref: '@window', type: 'Window', parentIndex: 0, rect: window },
    { ref: '@promo', type: 'Other', parentIndex: 1, identifier: 'qa-promo', rect: window },
    {
      ref: '@heading',
      type: 'StaticText',
      parentIndex: 2,
      label: 'Limited-time Pro offer',
      rect: { x: 20, y: 120, width: 362, height: 40 },
    },
    {
      ref: '@copy',
      type: 'StaticText',
      parentIndex: 2,
      label: 'Upgrade today. See Pro offers on Home any time.',
      rect: { x: 20, y: 180, width: 362, height: 40 },
    },
    {
      ref: '@close',
      type: 'Button',
      parentIndex: 2,
      identifier: 'qa-promo-close',
      label: 'Close',
      hittable: true,
      rect: closeRect,
    },
  ];
  if (options.secondControl)
    nodes.push({
      ref: '@continue',
      type: 'Button',
      parentIndex: 2,
      identifier: 'qa-promo-continue',
      label: 'Continue',
      hittable: true,
      rect: continueRect,
    });
  if (options.homeNative)
    nodes.push(
      { ref: '@home', type: 'Other', parentIndex: 1, identifier: 'qa-home', rect: window },
      {
        ref: '@home-target',
        type: 'Button',
        parentIndex: nodes.length,
        identifier: 'qa-promo-home-target',
        label: 'Target',
        hittable: true,
        rect: targetRect,
      },
    );
  const pressable = (testID: string) => ({
    testID,
    role: 'button',
    roleSource: 'role' as const,
    capabilities: { press: true as const },
  });
  const plain = (testID?: string) => ({
    ...(testID ? { testID } : {}),
    role: null,
    roleSource: 'none' as const,
    capabilities: {},
  });
  // Breadth-first: root; Home; the modal and Home's controls; the promo; the promo's content.
  // As on device, the Modal renders inside Home's identified container, which native never shows.
  const tree: HostRow[] = [
    [plain(), null, 'RCTRootView', window],
    [plain('qa-home'), 0, 'RCTView', window],
    [plain(), 1, options.modalType ?? 'RCTModalHostView', window],
    [
      options.input
        ? {
            testID: 'qa-promo-home-target',
            role: 'textbox',
            roleSource: 'role' as const,
            capabilities: { fill: true as const },
          }
        : pressable('qa-promo-home-target'),
      1,
      options.input ? 'RCTTextInput' : 'RCTView',
      targetRect,
    ],
    [pressable('qa-promo-offers'), 1, 'RCTView', offersRect],
    [plain('qa-promo'), 2, 'RCTView', window],
    [pressable('qa-promo-close'), 5, 'RCTView', closeRect],
  ];
  if (options.secondControl)
    tree.push([pressable('qa-promo-continue'), 5, 'RCTView', continueRect]);
  const hostEvidence: ReactHostEvidence = {
    complete: true,
    hosts: tree.map(([host]) => host),
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: tree.map(([, parentHostIndex, hostType, rect], hostIndex) => ({
        hostIndex,
        parentHostIndex,
        rootIndex: 0,
        hostType,
        rect,
        text: { kind: 'none' },
      })),
    },
  };
  return join(
    nodes,
    [
      {
        testID: 'qa-promo-home-target',
        role: options.input ? 'textbox' : 'button',
        label: 'Target',
      },
      { testID: 'qa-promo-offers', role: 'button', label: 'See Pro offers' },
      { testID: 'qa-promo-close', role: 'button', label: 'Close' },
    ],
    'app',
    { native: 'complete', react: 'complete' },
    hostEvidence,
    options.ordinary ? undefined : presence(nodes),
  );
}

// An ordinary form with its own Cancel and no interruption, with full React and presence evidence,
// so Cancel is a visible, press-supported decline control.
export function formWithCancel(): Screen {
  const formRect: Rect = { x: 0, y: 100, width: 402, height: 300 };
  const nameRect: Rect = { x: 20, y: 120, width: 362, height: 44 };
  const cancelRect: Rect = { x: 20, y: 330, width: 362, height: 50 };
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: window },
    { ref: '@window', type: 'Window', parentIndex: 0, rect: window },
    { ref: '@form', type: 'Other', parentIndex: 1, identifier: 'qa-promo-form', rect: formRect },
    {
      ref: '@name',
      type: 'TextField',
      parentIndex: 2,
      identifier: 'qa-promo-form-name',
      label: 'Display name',
      hittable: true,
      rect: nameRect,
    },
    {
      ref: '@cancel',
      type: 'Button',
      parentIndex: 2,
      identifier: 'qa-promo-form-cancel',
      label: 'Cancel',
      hittable: true,
      rect: cancelRect,
    },
  ];
  const tree: HostRow[] = [
    [{ role: null, roleSource: 'none', capabilities: {} }, null, 'RCTRootView', window],
    [
      { testID: 'qa-promo-form', role: null, roleSource: 'none', capabilities: {} },
      0,
      'RCTView',
      formRect,
    ],
    [
      {
        testID: 'qa-promo-form-name',
        role: 'textbox',
        roleSource: 'role',
        capabilities: { fill: true },
      },
      1,
      'RCTSinglelineTextInputView',
      nameRect,
    ],
    [
      {
        testID: 'qa-promo-form-cancel',
        role: 'button',
        roleSource: 'role',
        capabilities: { press: true },
      },
      1,
      'RCTView',
      cancelRect,
    ],
  ];
  return join(
    nodes,
    [
      { testID: 'qa-promo-form-name', role: 'textbox', label: 'Display name' },
      { testID: 'qa-promo-form-cancel', role: 'button', label: 'Cancel' },
    ],
    'app',
    { native: 'complete', react: 'complete' },
    {
      complete: true,
      hosts: tree.map(([host]) => host),
      typography: {
        version: 1,
        complete: true,
        durationMs: 1,
        coordinateSpace: 'window-points',
        nodes: tree.map(([, parentHostIndex, hostType, rect], hostIndex) => ({
          hostIndex,
          parentHostIndex,
          rootIndex: 0,
          hostType,
          rect,
          text: { kind: 'none' },
        })),
      },
    },
    presence(nodes),
  );
}

// Home once the promo is closed: its controls are native again.
export function homeAfterPromo(): Screen {
  const nodes: NativeNode[] = [
    { ref: '@app', type: 'Application', rect: window },
    { ref: '@window', type: 'Window', parentIndex: 0, rect: window },
    {
      ref: '@home-target',
      type: 'Button',
      parentIndex: 1,
      identifier: 'qa-promo-home-target',
      label: 'Target',
      hittable: true,
      rect: targetRect,
    },
    {
      ref: '@offers',
      type: 'Button',
      parentIndex: 1,
      identifier: 'qa-promo-offers',
      label: 'See Pro offers',
      hittable: true,
      rect: offersRect,
    },
  ];
  return join(
    nodes,
    [],
    'app',
    { native: 'complete', react: 'complete' },
    { hosts: [], complete: true },
    presence(nodes),
  );
}
