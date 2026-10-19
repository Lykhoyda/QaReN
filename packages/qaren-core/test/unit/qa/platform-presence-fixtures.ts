export function nativeCapture() {
  const presenceCapture = {
    version: 2,
    appliedBudgetMs: 20_000,
    source: 'xcui-live',
    captureId: 'capture-7',
    appId: 'com.test',
    generation: 7,
    startedUptimeMs: 100,
    endedUptimeMs: 200,
    enumeration: 'raw-unfiltered',
    complete: true,
  };
  const nodes = [
    {
      ref: '@e0',
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Test app',
      enabled: true,
      hittable: true,
      rect: { x: 0, y: 0, width: 400, height: 800 },
      presence: {
        captureId: 'capture-7',
        generation: 7,
        nodeIndex: 0,
        status: 'unknown',
        labelSource: 'direct',
      },
    },
    {
      ref: '@e1',
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'save',
      label: 'Save',
      enabled: true,
      hittable: true,
      rect: { x: 10, y: 20, width: 100, height: 40 },
      presence: {
        captureId: 'capture-7',
        generation: 7,
        nodeIndex: 1,
        status: 'observed',
        labelSource: 'direct',
        observedUptimeMs: 150,
      },
    },
  ];
  return {
    keyboardVisible: false,
    presenceCapture,
    nodes,
    snapshotGeneration: 7,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: { state: 'ok', nodeCount: 2, refMapUpdated: true, reasons: [] },
  };
}

export function attested<T>(nodes: T[]) {
  return {
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotVerdict: { state: 'ok', nodeCount: nodes.length, refMapUpdated: true, reasons: [] },
  };
}

// Probe-measured Android geometry: px = dp × 2.625, and React frames sit 136 px (the status bar) above.
export const ANDROID_SCALE = 2.625;
export const ANDROID_ORIGIN_Y = 136;

export function androidPresenceCapture() {
  const captureId = 'android-capture-4';
  const generation = 4;
  const presence = (nodeIndex: number, status: 'observed' | 'unknown', labelSource: string) => ({
    captureId,
    generation,
    nodeIndex,
    status,
    labelSource,
    ...(status === 'observed' ? { observedUptimeMs: 150 } : {}),
  });
  const node = (
    index: number,
    parentIndex: number | undefined,
    type: string,
    rect: { x: number; y: number; width: number; height: number },
    extra: Record<string, unknown> = {},
  ) => ({
    index,
    depth: parentIndex === undefined ? 0 : index === 1 ? 1 : (extra.depth as number),
    ...(parentIndex === undefined ? {} : { parentIndex }),
    type,
    label: '',
    identifier: '',
    packageName: 'com.test',
    checked: false,
    rect,
    hittable: true,
    enabled: true,
    selected: false,
    visibleToUser: true,
    ...extra,
  });
  const nodes = [
    node(
      0,
      undefined,
      'Application',
      { x: 0, y: 0, width: 1080, height: 2400 },
      {
        hittable: false,
        presence: presence(0, 'unknown', 'none'),
      },
    ),
    node(
      1,
      0,
      'Window',
      { x: 0, y: 0, width: 1080, height: 2400 },
      {
        hittable: false,
        presence: presence(1, 'unknown', 'none'),
      },
    ),
    node(
      2,
      1,
      'android.view.ViewGroup',
      { x: 0, y: 0, width: 1080, height: 2400 },
      {
        depth: 2,
        identifier: 'app-root',
        presence: presence(2, 'observed', 'none'),
      },
    ),
    node(
      3,
      2,
      'android.widget.Button',
      { x: 42, y: 241, width: 1008, height: 105 },
      {
        depth: 3,
        identifier: 'home-pager-qa-btn',
        label: 'Open Pager QA',
        presence: presence(3, 'observed', 'direct'),
      },
    ),
    node(
      4,
      3,
      'android.widget.TextView',
      { x: 84, y: 262, width: 924, height: 63 },
      {
        depth: 4,
        label: 'Open Pager QA',
        presence: presence(4, 'observed', 'direct'),
      },
    ),
  ];
  const data = {
    nodes,
    truncated: false,
    normalizationDroppedNodes: 0,
    snapshotGeneration: generation,
    keyboardVisible: false,
    pointScale: ANDROID_SCALE,
    presenceCapture: {
      version: 2,
      source: 'android-a11y-live',
      enumeration: 'app-windows',
      captureId,
      appId: 'com.test',
      generation,
      startedUptimeMs: 100,
      endedUptimeMs: 200,
      complete: true,
      appliedBudgetMs: 20_000,
      pointScale: ANDROID_SCALE,
    },
  };
  const dp = (px: number, origin = 0) => (px - origin) / ANDROID_SCALE;
  const frame = (rect: { x: number; y: number; width: number; height: number }) => ({
    x: dp(rect.x),
    y: dp(rect.y, ANDROID_ORIGIN_Y),
    width: dp(rect.width),
    height: dp(rect.height),
  });
  const hostEvidence = {
    complete: true,
    hosts: [
      { testID: 'app-root', role: null, roleSource: 'none', capabilities: {}, order: 0 },
      {
        testID: 'home-pager-qa-btn',
        role: 'button',
        roleSource: 'accessibilityRole',
        capabilities: { press: true },
        order: 0,
      },
      { role: null, roleSource: 'none', capabilities: {}, order: 0 },
    ],
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
          rect: frame(nodes[2].rect),
          text: { kind: 'none' },
        },
        {
          hostIndex: 1,
          parentHostIndex: 0,
          rootIndex: 0,
          hostType: 'RCTView',
          rect: frame(nodes[3].rect),
          text: { kind: 'none' },
        },
        {
          hostIndex: 2,
          parentHostIndex: 1,
          rootIndex: 0,
          hostType: 'RCTText',
          rect: frame(nodes[4].rect),
          text: {
            kind: 'block',
            content: 'Open Pager QA',
            runs: [{ start: 0, end: 13, fontSize: 16 }],
            scaling: { allowFontScaling: true, maxFontSizeMultiplier: 0 },
          },
        },
      ],
    },
  };
  return { data, hostEvidence };
}
