import type { privateSnapshotDiagnostics } from './snapshot-diagnostics.js';
import type { joinedSnapshotDiagnostics } from './screen.js';
import { isRecord } from './questions.js';
import type { NativeNode } from './screen.js';

export const NATIVE_PRESENCE_UNKNOWN_REASONS = [
  'empty-frame',
  'clipped',
  'ambiguous-descriptor',
  'not-hittable',
  'read-unavailable',
  'match-count-mismatch',
  'post-hit-mismatch',
  // Android only: the on-screen keyboard covers the node, which is not scrolled out of view.
  'keyboard-covered',
  // Android only, set by the core and never read from the runner: the native rule found the node
  // observed, but React Native's own hit test gives its centre's touch to a React view above it.
  'react-covered',
] as const;

export interface NativePresenceNode {
  status: 'observed' | 'unknown';
  labelSource: 'direct' | 'value' | 'descendant' | 'none';
  unknownReason?: (typeof NATIVE_PRESENCE_UNKNOWN_REASONS)[number];
}

export interface NativePresence {
  source: 'xcui-live' | 'android-a11y-live';
  nodes: NativePresenceNode[];
  // Android only: physical pixels per React point (the display density).
  pointScale?: number;
}

function android(capture: Record<string, unknown>): boolean {
  return capture.source === 'android-a11y-live' && capture.enumeration === 'app-windows';
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function validateNativePresence(
  capture: unknown,
  nodes: NativeNode[],
  generation: unknown,
  expectedAppId: string | undefined,
  requestedBudgetMs: unknown,
): NativePresence | undefined {
  if (
    !Number.isSafeInteger(requestedBudgetMs) ||
    typeof requestedBudgetMs !== 'number' ||
    requestedBudgetMs <= 0 ||
    !isRecord(capture) ||
    capture.version !== 2 ||
    capture.appliedBudgetMs !== requestedBudgetMs ||
    !(
      (capture.source === 'xcui-live' && capture.enumeration === 'raw-unfiltered') ||
      (android(capture) && finite(capture.pointScale) && capture.pointScale > 0)
    ) ||
    capture.complete !== true ||
    !expectedAppId ||
    capture.appId !== expectedAppId ||
    typeof capture.captureId !== 'string' ||
    !capture.captureId ||
    capture.captureId.length > 128 ||
    !Number.isSafeInteger(generation) ||
    typeof generation !== 'number' ||
    generation < 1 ||
    capture.generation !== generation ||
    !finite(capture.startedUptimeMs) ||
    capture.startedUptimeMs < 0 ||
    !finite(capture.endedUptimeMs) ||
    capture.endedUptimeMs < capture.startedUptimeMs ||
    capture.endedUptimeMs - capture.startedUptimeMs >= requestedBudgetMs ||
    nodes.length === 0 ||
    nodes.length > 600 ||
    nodes[0].type !== 'Application' ||
    nodes[0].depth !== 0 ||
    nodes[0].parentIndex !== undefined ||
    new Set(nodes.map((node) => node.ref)).size !== nodes.length
  )
    return undefined;
  const observations: NativePresenceNode[] = [];
  for (const [index, node] of nodes.entries()) {
    const p = node.presence;
    const parent = node.parentIndex;
    if (
      node.index !== index ||
      typeof node.type !== 'string' ||
      !node.type ||
      typeof node.enabled !== 'boolean' ||
      (index > 0 &&
        (parent === undefined ||
          !Number.isSafeInteger(parent) ||
          parent < 0 ||
          parent >= index ||
          node.depth !== nodes[parent].depth! + 1)) ||
      !node.rect ||
      !Object.values(node.rect).every(finite) ||
      !finite(node.rect.x) ||
      !finite(node.rect.y) ||
      !finite(node.rect.width) ||
      !finite(node.rect.height) ||
      node.rect.width < 0 ||
      node.rect.height < 0 ||
      !isRecord(p) ||
      p.captureId !== capture.captureId ||
      p.generation !== generation ||
      p.nodeIndex !== index ||
      (p.status !== 'observed' && p.status !== 'unknown') ||
      (p.labelSource !== 'direct' &&
        p.labelSource !== 'value' &&
        p.labelSource !== 'descendant' &&
        p.labelSource !== 'none') ||
      (p.status === 'observed' &&
        (!finite(p.observedUptimeMs) ||
          p.observedUptimeMs < capture.startedUptimeMs ||
          p.observedUptimeMs > capture.endedUptimeMs ||
          node.rect.width === 0 ||
          node.rect.height === 0)) ||
      (p.status === 'unknown' && p.observedUptimeMs !== undefined)
    )
      return undefined;
    const unknownReason =
      p.status === 'unknown'
        ? NATIVE_PRESENCE_UNKNOWN_REASONS.find(
            (reason) =>
              reason === p.unknownReason &&
              reason !== 'react-covered' &&
              (reason !== 'keyboard-covered' || android(capture)),
          )
        : undefined;
    observations.push({
      status: p.status,
      labelSource: p.labelSource,
      ...(unknownReason ? { unknownReason } : {}),
    });
  }
  return android(capture)
    ? { source: 'android-a11y-live', nodes: observations, pointScale: capture.pointScale as number }
    : { source: 'xcui-live', nodes: observations };
}

type Rect = NonNullable<NativeNode['rect']>;

function validRect(rect: Rect | undefined): rect is Rect {
  return (
    !!rect &&
    [rect.x, rect.y, rect.width, rect.height].every(finite) &&
    rect.width >= 0 &&
    rect.height >= 0
  );
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// An empty clip shows nothing; a zero-size frame is shown only if its origin lies in the clip.
function within(rect: Rect, visible: Rect): boolean {
  if (visible.width <= 0 || visible.height <= 0) return false;
  if (rect.width > 0 && rect.height > 0) return overlaps(rect, visible);
  return (
    rect.x >= visible.x &&
    rect.x <= visible.x + visible.width &&
    rect.y >= visible.y &&
    rect.y <= visible.y + visible.height
  );
}

function centreOutside(rect: Rect, visible: Rect): boolean {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return (
    cx < visible.x ||
    cx >= visible.x + visible.width ||
    cy < visible.y ||
    cy >= visible.y + visible.height
  );
}

export function clip(a: Rect, b: Rect | undefined): Rect {
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  };
}

// Texts of a verified capture indistinguishable from their parent text, as XCUI reports React Native text.
export function duplicateNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  const duplicates = new Set<number>();
  const key = (i: number) => {
    const n = nodes[i];
    return JSON.stringify([
      n.type,
      n.label ?? '',
      n.value ?? null,
      n.rect ? [n.rect.x, n.rect.y, n.rect.width, n.rect.height] : null,
      n.enabled,
      n.hittable,
      n.secure,
      presence?.nodes[i]?.status,
      presence?.nodes[i]?.labelSource,
    ]);
  };
  nodes.forEach((n, i) => {
    const parent = n.parentIndex;
    if (
      n.type === 'StaticText' &&
      parent !== undefined &&
      parent >= 0 &&
      parent < i &&
      (presence || (n.label && n.rect && n.rect.width > 0 && n.rect.height > 0)) &&
      (!n.identifier?.trim() || (presence && n.identifier === nodes[parent].identifier)) &&
      key(parent) === key(i)
    )
      duplicates.add(i);
  });
  return duplicates;
}

// An observed title of a verified capture that a navigation bar is named after; iOS exposes it as the bar's header.
export function navigationTitles(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Map<number, { kind: 'navigation-title'; barRef: string }> {
  const titles = new Map<number, { kind: 'navigation-title'; barRef: string }>();
  if (!presence) return titles;
  nodes.forEach((bar, b) => {
    const name = bar.identifier?.trim();
    if (bar.type !== 'NavigationBar' || !name) return;
    // A bar may hold a hidden twin of its title, as iOS large titles do; exactly one may be observed.
    const observed = nodes.flatMap((n, i) =>
      n.parentIndex === b &&
      n.type === 'StaticText' &&
      n.label === bar.identifier &&
      presence.nodes[i]?.status === 'observed' &&
      presence.nodes[i].labelSource === 'direct'
        ? [i]
        : [],
    );
    if (observed.length === 1)
      titles.set(observed[0], { kind: 'navigation-title', barRef: bar.ref });
  });
  return titles;
}

// Unidentified views of a verified capture repeated identically beside each other directly under a
// scroll view, as XCUI reports the platform's scroll indicators.
export function scrollChromeNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  const chrome = new Set<number>();
  if (!presence) return chrome;
  const key = (n: NativeNode) =>
    JSON.stringify([
      n.parentIndex,
      n.label ?? '',
      n.value ?? null,
      n.rect ? [n.rect.x, n.rect.y, n.rect.width, n.rect.height] : null,
      n.enabled,
    ]);
  const counts = new Map<string, number>();
  const candidate = (n: NativeNode) =>
    n.type === 'Other' &&
    !n.identifier &&
    n.parentIndex !== undefined &&
    nodes[n.parentIndex]?.type === 'ScrollView';
  for (const n of nodes) if (candidate(n)) counts.set(key(n), (counts.get(key(n)) ?? 0) + 1);
  nodes.forEach((n, i) => {
    if (candidate(n) && counts.get(key(n))! > 1) chrome.add(i);
  });
  return chrome;
}

// Unknown nodes with centres outside the clip, plus Android's explicitly clipped nodes.
export function offscreenNodes(
  nodes: NativeNode[],
  presence: NativePresence | undefined,
): Set<number> {
  if (!presence) return new Set();
  const offscreen = new Set(
    [...outsideViewport(nodes)].filter(
      (i) =>
        presence.nodes[i]?.status === 'unknown' &&
        nodes[i].rect!.width > 0 &&
        nodes[i].rect!.height > 0,
    ),
  );
  if (presence.source === 'android-a11y-live')
    presence.nodes.forEach((node, i) => {
      if (node.status === 'unknown' && node.unknownReason === 'clipped') offscreen.add(i);
    });
  return offscreen;
}

const TEXT_INPUT_TYPES = new Set([
  'TextView',
  'TextField',
  'SecureTextField',
  'SearchField',
  'android.widget.EditText',
]);
type Exclusion = { rule: 'anc' | 'scroll' | 'window'; ancestor: number };
// Diagnostic only: which rule and ancestor removed an in-app node; never read by decisions.
const exclusions = new WeakMap<Set<number>, Map<number, Exclusion>>();

const viewports = new WeakMap<Set<number>, Map<number, Rect>>();

export function clippingViewport(offscreen: Set<number>, index: number): Rect | undefined {
  return viewports.get(offscreen)?.get(index);
}

// iOS exact names; Android accessibility class leaves by suffix, as kindOf does for kinds.
const IOS_SCROLL_CONTAINERS = new Set(['ScrollView', 'Table', 'CollectionView']);
const ANDROID_SCROLL_CONTAINER_SUFFIXES = [
  'RecyclerView',
  'ListView',
  'GridView',
  'ExpandableListView',
  'HorizontalScrollView',
  'NestedScrollView',
  'ScrollView',
  'ViewPager2',
  'ViewPager',
];
export function isScrollContainerType(type: string | undefined): boolean {
  if (!type) return false;
  if (IOS_SCROLL_CONTAINERS.has(type)) return true;
  const leaf = type.slice(type.lastIndexOf('.') + 1);
  return ANDROID_SCROLL_CONTAINER_SUFFIXES.some((suffix) => leaf.endsWith(suffix));
}

function outsideTrustedViewport(nodes: NativeNode[], contradicted: Set<number>): Set<number> {
  const offscreen = new Set<number>();
  const decided = new Map<number, Exclusion>();
  const bounds = new Map<number, Rect>();
  viewports.set(offscreen, bounds);
  exclusions.set(offscreen, decided);
  const root = nodes[0];
  // The screen clips every node, whatever its ancestry; a keyboard can detach content from its Window.
  const screen =
    root?.type === 'Application' &&
    validRect(root.rect) &&
    root.rect.width > 0 &&
    root.rect.height > 0
      ? root.rect
      : undefined;
  nodes.forEach((node, i) => {
    if (!node.rect) return;
    let visible = screen;
    let parent = node.parentIndex;
    let decider: Exclusion | undefined;
    for (let hops = 0; parent !== undefined && hops < nodes.length; hops++) {
      const ancestor = nodes[parent];
      if (
        ancestor?.type === 'Window' &&
        !contradicted.has(parent) &&
        validRect(ancestor.rect) &&
        ancestor.rect.width > 0 &&
        ancestor.rect.height > 0
      ) {
        visible = clip(ancestor.rect, visible);
        if (!decider && !within(node.rect, ancestor.rect))
          decider = { rule: 'window', ancestor: parent };
      }
      if (
        !contradicted.has(parent) &&
        validRect(ancestor?.rect) &&
        isScrollContainerType(ancestor.type)
      ) {
        visible = clip(ancestor.rect, visible);
        if (!decider && !within(node.rect, ancestor.rect))
          decider = { rule: 'scroll', ancestor: parent };
      }
      parent = ancestor?.parentIndex;
    }
    if (visible) bounds.set(i, visible);
    if (visible && (!within(node.rect, visible) || centreOutside(node.rect, visible))) {
      offscreen.add(i);
      if (decider) decided.set(i, decider);
    }
  });
  return offscreen;
}

export function outsideViewport(nodes: NativeNode[]): Set<number> {
  const contradicted = frameContradictions(nodes);
  const offscreen = outsideTrustedViewport(nodes, contradicted);
  const root = nodes[0]?.rect;
  if (!root) return offscreen;
  for (const i of contradicted) {
    if (!TEXT_INPUT_TYPES.has(nodes[i].type ?? '') || offscreen.has(i)) continue;
    let parent = nodes[i].parentIndex;
    for (let hops = 0; parent !== undefined && hops < nodes.length; hops++) {
      const ancestor = nodes[parent];
      if (validRect(ancestor?.rect) && !within(ancestor.rect, root)) {
        offscreen.add(i);
        exclusions.get(offscreen)!.set(i, { rule: 'anc', ancestor: parent });
        break;
      }
      parent = ancestor?.parentIndex;
    }
  }
  return offscreen;
}

export function frameContradictions(nodes: NativeNode[]): Set<number> {
  const contradicted = new Set<number>();
  const root = nodes[0]?.rect;
  if (nodes[0]?.type !== 'Application' || !validRect(root) || !root.width || !root.height)
    return contradicted;
  const sized = (rect: Rect | undefined): rect is Rect =>
    validRect(rect) && rect.width > 0 && rect.height > 0;
  const containers = new Set<number>();
  const witnesses: Array<[number, number]> = [];
  nodes.forEach((node, i) => {
    if (!validRect(node.rect) || !within(node.rect, root)) return;
    let parent = node.parentIndex;
    for (let hops = 0; parent !== undefined && hops < nodes.length; hops++) {
      const ancestor = nodes[parent];
      if (ancestor && sized(ancestor.rect) && !within(ancestor.rect, root)) {
        containers.add(parent);
        witnesses.push([i, parent]);
      }
      parent = ancestor?.parentIndex;
    }
  });
  const offscreen = outsideTrustedViewport(nodes, containers);
  for (const [i, parent] of witnesses) {
    if (offscreen.has(i)) continue;
    contradicted.add(parent);
    if (TEXT_INPUT_TYPES.has(nodes[i].type ?? '')) contradicted.add(i);
  }
  return contradicted;
}

const DIAGNOSTIC_TYPES = new Set([
  'Application',
  'Window',
  'Other',
  'StaticText',
  'Button',
  'TextField',
  'SecureTextField',
  'TextView',
  'SearchField',
  'Switch',
  'Image',
  'Cell',
  'Table',
  'CollectionView',
  'ScrollView',
  'Keyboard',
  'Key',
  'Link',
  'NavigationBar',
  'TabBar',
]);
const DIAGNOSTIC_LIMIT = 2048;

// Value-free viewport facts for one capture; it observes production geometry and never decides anything.
export function viewportDiagnostic(
  nodes: NativeNode[],
  offscreen: Set<number>,
  capture?: {
    observation: number | null;
    mode: 'ordinary' | 'platform-presence';
    native: {
      acquisition: 'returned';
      coverage: string;
      truncated: boolean | null;
      normalizationDroppedNodes: number | null;
      verdict: 'ok' | 'degraded' | 'failed' | null;
      reasons: string[];
    };
    snapshot: ReturnType<typeof privateSnapshotDiagnostics>;
    projection: ReturnType<typeof joinedSnapshotDiagnostics>;
  },
): string {
  const box = (rect: Rect | undefined) =>
    rect ? [rect.x, rect.y, rect.width, rect.height].map(Math.round) : [null, null, null, null];
  const sized = (rect: Rect | undefined) => !!rect && rect.width > 0 && rect.height > 0;
  const app = nodes.find((node) => node.type === 'Application')?.rect;
  const windows = nodes.flatMap((node, i) =>
    node.type === 'Window' ? [[i, ...box(node.rect)]] : [],
  );
  const known = sized(app);
  const symptoms: Array<[number, string, number, number, number, number, number, number]> = [];
  let outsideApp = 0;
  nodes.forEach((node, i) => {
    if (!known || !node.rect || within(node.rect, app!)) return;
    outsideApp++;
    if (offscreen.has(i)) return;
    let w = -1;
    let wv = -1;
    let u = -1;
    let s = -1;
    let parent = node.parentIndex;
    for (let hops = 0; parent !== undefined && hops < nodes.length; hops++) {
      const ancestor = nodes[parent];
      if (ancestor?.type === 'Window') {
        if (w < 0) {
          w = parent;
          wv = sized(ancestor.rect) ? 1 : 0;
        }
        if (sized(ancestor.rect)) {
          u = parent;
          break;
        }
      }
      if (s < 0 && isScrollContainerType(ancestor?.type)) s = parent;
      parent = ancestor?.parentIndex;
    }
    const type = DIAGNOSTIC_TYPES.has(node.type ?? '') ? node.type! : 'Other';
    const [x, y] = box(node.rect) as number[];
    symptoms.push([i, type, w, wv, u, s, x, y]);
  });
  const count = (test: (entry: (typeof symptoms)[number]) => boolean) =>
    known ? symptoms.filter(test).length : null;
  const decided = exclusions.get(offscreen);
  const excludedAll = known
    ? [...offscreen]
        .filter((i) => nodes[i]?.rect && within(nodes[i].rect!, app!))
        .sort((a, b) => a - b)
    : [];
  const excludedEntries = excludedAll.map((i) => {
    const node = nodes[i];
    const exclusion = decided?.get(i);
    const ancestor = exclusion ? nodes[exclusion.ancestor] : undefined;
    const typeOf = (type: string | undefined) =>
      DIAGNOSTIC_TYPES.has(type ?? '') ? type! : 'Other';
    return [
      i,
      typeOf(node.type),
      exclusion?.rule ?? null,
      exclusion?.ancestor ?? null,
      ancestor ? typeOf(ancestor.type) : null,
      ...box(ancestor?.rect),
    ];
  });
  const line = (windowList: unknown[], sample: unknown[], excluded: unknown[]) =>
    `viewport-diagnostic ${JSON.stringify({
      v: 1,
      ...capture,
      app: app ? box(app) : null,
      windowCount: windows.length,
      windows: windowList,
      rectless: nodes.filter((node) => !node.rect).length,
      outsideApp: known ? outsideApp : null,
      symptom: known ? symptoms.length : null,
      noWindow: count(([, , w]) => w < 0),
      invalidWindowOnly: count(([, , w, , u]) => w >= 0 && u < 0),
      scrollClipped: count(([, , , , , s]) => s >= 0),
      sample,
      excludedCount: known ? excludedAll.length : null,
      excluded,
    })}`;
  // Counts stay whole; only the listed entries shrink so the line keeps its 2 KB bound.
  let windowList = windows.slice(0, 8);
  let sample = symptoms.slice(0, 20);
  let excluded = excludedEntries.slice(0, 10);
  let text = line(windowList, sample, excluded);
  while (
    Buffer.byteLength(text, 'utf8') > DIAGNOSTIC_LIMIT &&
    (sample.length || windowList.length || excluded.length)
  ) {
    if (sample.length) sample = sample.slice(0, -1);
    else if (excluded.length) excluded = excluded.slice(0, -1);
    else windowList = windowList.slice(0, -1);
    text = line(windowList, sample, excluded);
  }
  return text;
}
