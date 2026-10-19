import {
  clippingViewport,
  duplicateNodes,
  offscreenNodes,
  outsideViewport,
} from './native-presence.js';
import { INPUT_HOST_TYPES } from './input-host-types.js';
import { reactHitTest, touchReaches } from './react-hit-test.js';
import type { NativePresence } from './native-presence.js';
import type { NativeNode, ReactHostEvidence } from './screen.js';
import type { HostTypography } from './host-typography.js';

type Rect = NonNullable<NativeNode['rect']>;
export type HostAssociation = { nativeIndex: number; anchorIndex: number };

// React frame → native frame: native = host × scale + origin, each edge within tolerance.
// iOS is (1, the window's origin, 0), the exact rule; Android calibrates its origin per capture.
interface FrameTransform {
  scale: number;
  x: number;
  y: number;
  tolerance: number;
}

// Android accessibility bounds against React's measured points, both in the probe's terms.
export const ANDROID_FRAME_TOLERANCE_PX = 2;
const ANDROID_TEXT = 'android.widget.TextView';
const MODAL_HOST_TYPES = new Set(['Modal', 'RCTModalHostView']);

export interface HostAssociationDiagnostic {
  identity:
    | 'evidence-unavailable'
    | 'window-count'
    | 'window-frame'
    | 'origin-unknown'
    | 'inline'
    | 'no-test-id'
    | 'host-id-ambiguous'
    | 'native-id-count'
    | 'outside-window'
    | 'incompatible-type'
    | 'frame-mismatch'
    | 'matched';
  // Null means the association path never evaluated that check.
  nativeIdentityCandidateCount: number | null;
  compatibleCount: number | null;
  sameFrameCount: number | null;
  inputContainmentCount?: number;
  presenceProofCount: number | null;
  ancestorPath:
    | 'not-evaluated'
    | 'valid'
    | 'self-anchor-missing'
    | 'ancestor-structure-missing'
    | 'ancestor-path-mismatch';
  collisions: number | null;
  frameMismatch?: {
    nativeKind: 'TextField' | 'SecureTextField' | 'TextView' | 'other';
    hostFinite: boolean;
    nativeFinite: boolean;
    windowOriginFinite: boolean;
    delta: { x: number | null; y: number | null; width: number | null; height: number | null };
  };
}

export function hostPath(snapshot: HostTypography, start: number): number[] | undefined {
  const path: number[] = [];
  let current: number | null = start;
  while (current !== null) {
    if (path.includes(current) || !snapshot.nodes[current]) return undefined;
    path.push(current);
    current = snapshot.nodes[current].parentHostIndex;
  }
  return path;
}

function nativePath(nodes: NativeNode[], start: number): number[] {
  const path: number[] = [];
  let current: number | undefined = start;
  while (current !== undefined && nodes[current] && !path.includes(current)) {
    path.push(current);
    current = nodes[current].parentIndex;
  }
  return path;
}

export function nativeWindowIndex(nodes: NativeNode[], start: number): number | undefined {
  const path = nativePath(nodes, start);
  if (
    !path.length ||
    nodes[path.at(-1)!].parentIndex !== undefined ||
    path.some((index, depth) => depth + 1 < path.length && path[depth + 1] >= index)
  )
    return undefined;
  const windows = path.filter((i) => nodes[i].type === 'Window');
  return windows.length === 1 ? windows[0] : undefined;
}

function compatible(
  host: string | null,
  native: string | undefined,
  scrollsBeneath = false,
  android = false,
): boolean {
  if (host === 'RNCSafeAreaView' || host === 'RNCSafeAreaProvider')
    return [
      'Other',
      'Button',
      'Cell',
      'android.view.ViewGroup',
      'android.view.View',
      'android.widget.Button',
    ].includes(native ?? '');
  if (android) {
    if (INPUT_HOST_TYPES.includes(host ?? '')) return native === 'android.widget.EditText';
    if (host === 'RCTText' || host === 'Text') return native === ANDROID_TEXT;
    if (host === 'RCTView' || host === 'View')
      return (
        native === 'android.view.ViewGroup' ||
        native === 'android.view.View' ||
        native === 'android.widget.Button'
      );
    if (host === 'RCTScrollView' || host === 'ScrollView')
      return (
        native === 'android.widget.ScrollView' || native === 'android.widget.HorizontalScrollView'
      );
    return false;
  }
  if (host === 'RCTSinglelineTextInputView')
    return native === 'TextField' || native === 'SecureTextField';
  if (host === 'RCTMultilineTextInputView') return native === 'TextView';
  if (INPUT_HOST_TYPES.includes(host ?? ''))
    return native === 'TextField' || native === 'SecureTextField' || native === 'TextView';
  if (host === 'RCTText' || host === 'Text') return native === 'StaticText';
  if (host === 'RCTView' || host === 'View')
    return native === 'Other' || native === 'Button' || native === 'Cell';
  // On iOS the identifier sits on the scroll view's container view, directly above the native ScrollView.
  if (host === 'RCTScrollView' || host === 'ScrollView')
    return native === 'ScrollView' || (native === 'Other' && scrollsBeneath);
  return false;
}

function near(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}

function sameFrame(
  host: Rect | undefined,
  native: Rect | undefined,
  { scale, x, y, tolerance }: FrameTransform,
): boolean {
  return (
    !!host &&
    !!native &&
    near(host.x * scale + x, native.x, tolerance) &&
    near(host.y * scale + y, native.y, tolerance) &&
    near(host.width * scale, native.width, tolerance) &&
    near(host.height * scale, native.height, tolerance)
  );
}

// The origin React measures from, out of identified hosts whose unclipped native frames agree on it.
function calibratedOrigin(
  snapshot: HostTypography,
  evidence: ReactHostEvidence,
  nodes: NativeNode[],
  scale: number,
  tolerance: number,
): { x: number; y: number } | undefined {
  const finiteRect = (rect: Rect | undefined): rect is Rect =>
    !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  const candidates: Array<{ x: number; y: number }> = [];
  for (const host of snapshot.nodes) {
    const id = evidence.hosts[host.hostIndex].testID;
    if (!id || evidence.hosts.filter((h) => h.testID === id).length !== 1) continue;
    const matches = nodes.filter((node) => node.identifier === id);
    const native = matches[0]?.rect;
    if (matches.length !== 1 || !finiteRect(host.rect) || !finiteRect(native)) continue;
    // A frame the viewport clips has moved its own edge; it cannot speak for the origin.
    if (
      native.width <= 0 ||
      native.height <= 0 ||
      !near(host.rect.width * scale, native.width, tolerance) ||
      !near(host.rect.height * scale, native.height, tolerance)
    )
      continue;
    candidates.push({ x: native.x - host.rect.x * scale, y: native.y - host.rect.y * scale });
  }
  if (candidates.length < 2) return undefined;
  // Agreeing anchors lie within the tolerance of each other, so each also lies within it of the median.
  const axis = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted[sorted.length - 1] - sorted[0] <= tolerance
      ? sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2
      : undefined;
  };
  const x = axis(candidates.map((c) => c.x));
  const y = axis(candidates.map((c) => c.y));
  return x === undefined || y === undefined ? undefined : { x, y };
}

// Android reports the visible part of a frame: cut by its clip, or, wholly clipped, an empty rect at its
// own top below the clip or at the clip's top above it.
function clippedFrame(
  host: Rect | undefined,
  native: Rect | undefined,
  t: FrameTransform,
  clip: Rect | undefined,
): boolean {
  if (!host || !native || !clip) return false;
  const frame = {
    x: host.x * t.scale + t.x,
    y: host.y * t.scale + t.y,
    width: host.width * t.scale,
    height: host.height * t.scale,
  };
  if (!near(frame.x, native.x, t.tolerance) || !near(frame.width, native.width, t.tolerance))
    return false;
  if (native.height === 0) {
    if (frame.y >= clip.y + clip.height) return near(native.y, frame.y, t.tolerance);
    if (frame.y + frame.height <= clip.y) return near(native.y, clip.y, t.tolerance);
    return false;
  }
  const top = Math.max(frame.y, clip.y);
  const bottom = Math.min(frame.y + frame.height, clip.y + clip.height);
  return (
    bottom > top &&
    near(native.y, top, t.tolerance) &&
    near(native.y + native.height, bottom, t.tolerance)
  );
}

function frameMismatchDiagnostic(
  host: Rect | undefined,
  native: NativeNode,
  transform: FrameTransform,
): NonNullable<HostAssociationDiagnostic['frameMismatch']> {
  const rectFinite = (rect: Rect | undefined) =>
    !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  const delta = (a: number | undefined, b: number | undefined, offset: number | undefined) => {
    if (![a, b, offset].every(Number.isFinite)) return null;
    const difference = a! - (b! * transform.scale + offset!);
    return Number.isFinite(difference) ? difference : null;
  };
  const type = native.type;
  return {
    nativeKind:
      type === 'TextField' || type === 'SecureTextField' || type === 'TextView' ? type : 'other',
    hostFinite: rectFinite(host),
    nativeFinite: rectFinite(native.rect),
    windowOriginFinite: Number.isFinite(transform.x) && Number.isFinite(transform.y),
    // Native minus host, through the same transform as the comparison.
    delta: {
      x: delta(native.rect?.x, host?.x, transform.x),
      y: delta(native.rect?.y, host?.y, transform.y),
      width: delta(native.rect?.width, host?.width, 0),
      height: delta(native.rect?.height, host?.height, 0),
    },
  };
}

function contains(outer: Rect, inner: Rect): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

function containsInputFrame(
  host: Rect | undefined,
  native: Rect | undefined,
  window: Rect,
  { scale, x, y, tolerance }: FrameTransform,
): boolean {
  try {
    if (!host || !native) return false;
    const outer = {
      x: host.x * scale + x - tolerance,
      y: host.y * scale + y - tolerance,
      width: host.width * scale + 2 * tolerance,
      height: host.height * scale + 2 * tolerance,
    };
    return (
      [host, outer, native, window].every(
        (r) =>
          r.width > 0 &&
          r.height > 0 &&
          [r.x, r.y, r.width, r.height, r.x + r.width, r.y + r.height].every(Number.isFinite),
      ) && contains(outer, native)
    );
  } catch {
    return false;
  }
}

function possibleTextOwner(host: HostTypography['nodes'][number], content: string): boolean {
  const accessibility = host.accessibility;
  if (
    (!accessibility && host.hostType !== 'RCTVirtualText') ||
    accessibility?.accessible === 'true' ||
    accessibility?.accessible === 'unknown' ||
    accessibility?.authoredLabel === 'present' ||
    accessibility?.authoredLabel === 'unknown'
  )
    return true;
  switch (host.text.kind) {
    case 'block':
      return host.text.content === content;
    case 'inline':
      return host.hostType !== 'RCTVirtualText';
    case 'none':
      // A generic host type cannot rule out native accessibility text traits.
      return true;
    case 'unsupported':
      return true;
  }
}

// Android: an observed anchor's touch must also reach its host in React Native's own hit test at the
// node's centre; [reactCovered] collects the native nodes where a React view above takes it. They stay
// anchored, as the native observation still proves identity, but are not observed at this capture.
export function associateHosts(
  nodes: NativeNode[],
  evidence: ReactHostEvidence | undefined,
  presence: NativePresence | undefined,
  diagnostics?: Map<number, HostAssociationDiagnostic>,
  reactCovered?: Set<number>,
): Map<number, HostAssociation> {
  const associations = new Map<number, HostAssociation>();
  const note = (index: number, facts: Partial<HostAssociationDiagnostic>) => {
    if (!diagnostics) return;
    try {
      diagnostics.set(index, {
        identity: 'evidence-unavailable',
        nativeIdentityCandidateCount: null,
        compatibleCount: null,
        sameFrameCount: null,
        presenceProofCount: null,
        ancestorPath: 'not-evaluated',
        collisions: null,
        ...diagnostics.get(index),
        ...facts,
      });
    } catch {
      // Diagnostics cannot change association results.
    }
  };
  const unavailable = (identity: HostAssociationDiagnostic['identity']) => {
    if (diagnostics) evidence?.hosts.forEach((_, index) => note(index, { identity }));
    return associations;
  };
  const snapshot = evidence?.typography;
  if (!evidence?.complete || !snapshot?.complete || !presence)
    return unavailable('evidence-unavailable');
  const windows = nodes.flatMap((node, i) => (node.type === 'Window' ? [i] : []));
  if (!windows.length) return unavailable('window-count');
  const android = presence.source === 'android-a11y-live';
  // Android lists only a React Native Modal's own window, so the second window shows only in React.
  if (
    android &&
    snapshot.nodes.some(
      (host) =>
        MODAL_HOST_TYPES.has(host.hostType ?? '') &&
        snapshot.nodes.some((child) => child.parentHostIndex === host.hostIndex),
    )
  )
    return unavailable('window-count');
  let androidTransform: FrameTransform | undefined;
  if (android) {
    const scale = presence.pointScale!;
    const origin = calibratedOrigin(snapshot, evidence, nodes, scale, ANDROID_FRAME_TOLERANCE_PX);
    if (!origin) return unavailable('origin-unknown');
    androidTransform = { scale, ...origin, tolerance: ANDROID_FRAME_TOLERANCE_PX };
  }
  // iOS compares exactly against the node's own window origin; Android uses the capture's calibrated one.
  const transformFor = (window: Rect): FrameTransform =>
    androidTransform ?? { scale: 1, x: window.x, y: window.y, tolerance: 0 };
  const text = android ? ANDROID_TEXT : 'StaticText';
  const viewport = android ? outsideViewport(nodes) : undefined;
  const paths = snapshot.nodes.map((node) => hostPath(snapshot, node.hostIndex)!);
  const nativePaths = nodes.map((_, i) => nativePath(nodes, i));
  const nativeWindows = nodes.map((_, i) => nativeWindowIndex(nodes, i));
  const inWindow = (i: number) =>
    nativeWindows[i] !== undefined &&
    typeof nodes[i].ref === 'string' &&
    !!nodes[i].ref.trim() &&
    nodes.filter((node) => node.ref === nodes[i].ref).length === 1;
  const positive = (i: number) => presence.nodes[i]?.status === 'observed' && inWindow(i);
  const inline = (i: number) =>
    snapshot.nodes[i].hostType === 'RCTVirtualText' && snapshot.nodes[i].text.kind === 'inline';
  const duplicates = duplicateNodes(nodes, presence);
  const structural = new Map<number, number>();
  for (const host of snapshot.nodes) {
    if (inline(host.hostIndex)) {
      note(host.hostIndex, { identity: 'inline' });
      continue;
    }
    const id = evidence.hosts[host.hostIndex].testID;
    if (!id) {
      note(host.hostIndex, { identity: 'no-test-id' });
      continue;
    }
    if (evidence.hosts.filter((h) => h.testID === id).length !== 1) {
      note(host.hostIndex, { identity: 'host-id-ambiguous' });
      continue;
    }
    const inputHost =
      host.hostType === 'RCTSinglelineTextInputView' ||
      host.hostType === 'RCTMultilineTextInputView' ||
      (android && host.hostType === 'AndroidTextInput');
    const matches = nodes.flatMap((node, i) =>
      node.identifier === id && (inputHost || !duplicates.has(i)) ? [i] : [],
    );
    note(host.hostIndex, {
      identity: 'native-id-count',
      nativeIdentityCandidateCount: matches.length,
    });
    if (matches.length !== 1) continue;
    const nativeIndex = matches[0];
    if (!inWindow(nativeIndex)) {
      note(host.hostIndex, { identity: 'outside-window' });
      continue;
    }
    const window = nodes[nativeWindows[nativeIndex]!].rect;
    if (
      !window ||
      !Object.values(window).every(Number.isFinite) ||
      window.width <= 0 ||
      window.height <= 0
    ) {
      note(host.hostIndex, { identity: 'window-frame' });
      continue;
    }
    const transform = transformFor(window);
    const compatibleType = compatible(
      host.hostType,
      nodes[nativeIndex].type,
      nodes.some((n) => n.parentIndex === nativeIndex && n.type === 'ScrollView'),
      android,
    );
    note(host.hostIndex, {
      identity: 'incompatible-type',
      compatibleCount: Number(compatibleType),
    });
    if (!compatibleType) continue;
    const matchingFrame =
      sameFrame(host.rect, nodes[nativeIndex].rect, transform) ||
      (viewport !== undefined &&
        clippedFrame(
          host.rect,
          nodes[nativeIndex].rect,
          transform,
          clippingViewport(viewport, nativeIndex),
        ));
    // Native input accessibility frames can be inset from their React host's outer frame.
    const matchingGeometry = inputHost
      ? !evidence.hosts[host.hostIndex].hidden &&
        containsInputFrame(host.rect, nodes[nativeIndex].rect, window, transform)
      : matchingFrame;
    note(host.hostIndex, {
      identity: 'frame-mismatch',
      sameFrameCount: Number(matchingFrame),
      ...(inputHost ? { inputContainmentCount: Number(matchingGeometry) } : {}),
    });
    if (!matchingGeometry) {
      if (diagnostics) {
        try {
          note(host.hostIndex, {
            frameMismatch: frameMismatchDiagnostic(host.rect, nodes[nativeIndex], transform),
          });
        } catch {
          // Frame diagnostics cannot change association decisions.
        }
      }
      continue;
    }
    structural.set(host.hostIndex, nativeIndex);
    note(host.hostIndex, { identity: 'matched' });
  }
  if (androidTransform && reactCovered) {
    const { scale, x, y } = androidTransform;
    const hit = reactHitTest(evidence, (rect) => ({
      x: rect.x * scale + x,
      y: rect.y * scale + y,
      width: rect.width * scale,
      height: rect.height * scale,
    }));
    for (const [hostIndex, i] of structural) {
      const rect = nodes[i].rect;
      if (!positive(i) || !rect) continue;
      // The runner's own centre: integer pixels, as the native rule tests it.
      const centre = hit(Math.trunc(rect.x + rect.width / 2), Math.trunc(rect.y + rect.height / 2));
      if (!touchReaches(evidence, hostIndex, centre)) reactCovered.add(i);
    }
  }
  const offscreen = offscreenNodes(nodes, presence);
  const anchors = new Map(
    [...structural].filter(([hostIndex, i]) => {
      const eligible = positive(i) || offscreen.has(i);
      note(hostIndex, { presenceProofCount: Number(eligible) });
      return eligible;
    }),
  );
  // Identified ancestors may be hoisted beside the native path; only the host needs presence.
  const onNativePath = (child: number, ancestor: number) => {
    if (nativeWindows[child] !== nativeWindows[ancestor]) return false;
    if (child === ancestor || nativePaths[ancestor].includes(child)) return false;
    // Direct native ancestry proves itself, even when the child overflows its parent.
    if (nativePaths[child].includes(ancestor)) return true;
    const parent = nodes[ancestor].parentIndex;
    return (
      parent !== undefined &&
      nativePaths[child].slice(1).includes(parent) &&
      !!nodes[ancestor].rect &&
      !!nodes[child].rect &&
      contains(nodes[ancestor].rect!, nodes[child].rect!)
    );
  };
  const anchoredPath = (i: number): boolean => {
    const named = paths[i].filter((p) => !inline(p) && !!evidence.hosts[p].testID);
    let reason: HostAssociationDiagnostic['ancestorPath'] = 'valid';
    const valid = named.every((p, n) => {
      const nativeIndex = (p === i ? anchors : structural).get(p);
      if (nativeIndex === undefined) {
        reason = p === i ? 'self-anchor-missing' : 'ancestor-structure-missing';
        return false;
      }
      if (n + 1 === named.length) return true;
      const ancestor = structural.get(named[n + 1]);
      if (ancestor === undefined) {
        reason = 'ancestor-structure-missing';
        return false;
      }
      if (!onNativePath(nativeIndex, ancestor)) {
        reason = 'ancestor-path-mismatch';
        return false;
      }
      return true;
    });
    note(i, { ancestorPath: reason });
    return valid;
  };
  for (const host of snapshot.nodes) {
    if (!anchoredPath(host.hostIndex)) continue;
    const direct = anchors.get(host.hostIndex);
    if (direct !== undefined) {
      associations.set(host.hostIndex, { nativeIndex: direct, anchorIndex: direct });
      continue;
    }
    if (
      host.text.kind !== 'block' ||
      !host.text.content.trim() ||
      !host.rect ||
      !compatible(host.hostType, text, false, android)
    )
      continue;
    // The nearest identified ancestor scopes the search, even without measured presence.
    const anchorHost = paths[host.hostIndex].slice(1).find((i) => structural.has(i));
    if (anchorHost === undefined) continue;
    const anchorIndex = structural.get(anchorHost)!;
    const windowIndex = nativeWindows[anchorIndex]!;
    const transform = transformFor(nodes[windowIndex].rect!);
    const ancestors = paths[host.hostIndex].slice(1).map((i) => snapshot.nodes[i]);
    if (
      ancestors.some(
        (h) =>
          h.text.kind === 'unsupported' ||
          h.hostType === null ||
          (['RCTText', 'Text', 'RCTVirtualText'].includes(h.hostType) && h.text.kind === 'none'),
      ) ||
      !contains(snapshot.nodes[anchorHost].rect!, host.rect)
    )
      continue;
    const content = host.text.content;
    const matches = nodes.flatMap((node, i) =>
      i !== anchorIndex &&
      nativeWindows[i] === windowIndex &&
      !duplicates.has(i) &&
      nativePaths[i].includes(anchorIndex) &&
      node.type === text &&
      node.label === content &&
      sameFrame(host.rect, node.rect, transform)
        ? [i]
        : [],
    );
    if (
      matches.length !== 1 ||
      !!nodes[matches[0]].identifier ||
      !positive(matches[0]) ||
      presence.nodes[matches[0]].labelSource !== 'direct'
    )
      continue;
    const owners = snapshot.nodes.filter((h) => {
      const identified = anchors.get(h.hostIndex);
      if (identified !== undefined && identified !== matches[0] && anchoredPath(h.hostIndex))
        return false;
      return (
        possibleTextOwner(h, content) &&
        (!h.rect || sameFrame(h.rect, nodes[matches[0]].rect, transform))
      );
    });
    if (owners.length !== 1) continue;
    associations.set(host.hostIndex, { nativeIndex: matches[0], anchorIndex });
  }
  const admitted = [...associations.values()];
  for (const [hostIndex, association] of associations) {
    const collides = (other: HostAssociation) =>
      other !== association && other.nativeIndex === association.nativeIndex;
    if (admitted.some(collides)) associations.delete(hostIndex);
    if (diagnostics) note(hostIndex, { collisions: admitted.filter(collides).length });
  }
  return associations;
}
