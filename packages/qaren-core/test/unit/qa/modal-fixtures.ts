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
  // Breadth-first: root; Home and the modal; Home's controls and the promo; the promo's content.
  const tree: HostRow[] = [
    [plain(), null, 'RCTRootView', window],
    [plain('qa-home'), 0, 'RCTView', window],
    [plain(), 0, options.modalType ?? 'RCTModalHostView', window],
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
      { testID: 'qa-promo-home-target', role: options.input ? 'textbox' : 'button', label: 'Target' },
      { testID: 'qa-promo-offers', role: 'button', label: 'See Pro offers' },
      { testID: 'qa-promo-close', role: 'button', label: 'Close' },
    ],
    'app',
    { native: 'complete', react: 'complete' },
    hostEvidence,
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
