import { duplicateNodes, offscreenNodes } from './native-presence.js';
import { INPUT_HOST_TYPES } from './input-host-types.js';
import type { NativePresence } from './native-presence.js';
import type { NativeNode, ReactHostEvidence } from './screen.js';
import type { HostTypography } from './host-typography.js';

type Rect = NonNullable<NativeNode['rect']>;
export type HostAssociation = { nativeIndex: number; anchorIndex: number };

export const finiteHostTypes = [
  'TextInput',
  'RCTTextInput',
  'RCTSinglelineTextInputView',
  'RCTMultilineTextInputView',
  'AndroidTextInput',
  'RCTText',
  'Text',
  'RCTView',
  'View',
  'RCTScrollView',
  'ScrollView',
  'RCTVirtualText',
] as const;
export const finiteNativeTypes = [
  'Application',
  'Window',
  'Button',
  'Cell',
  'StaticText',
  'TextField',
  'TextView',
  'SecureTextField',
  'Switch',
  'Slider',
  'Link',
  'Image',
  'NavigationBar',
  'TabBar',
  'CollectionView',
  'Table',
  'ScrollView',
  'SearchField',
  'Toolbar',
  'SegmentedControl',
  'Stepper',
  'Picker',
  'CheckBox',
  'MenuItem',
  'Other',
  'Keyboard',
  'Key',
] as const;
export const unavailableTypeOperands = ['null', 'absent', 'unrecognized', 'unknown'] as const;
type UnavailableTypeOperand = (typeof unavailableTypeOperands)[number];
export type HostTypeOperand = (typeof finiteHostTypes)[number] | UnavailableTypeOperand;
export type NativeTypeOperand = (typeof finiteNativeTypes)[number] | UnavailableTypeOperand;
export type DirectChildScrollView = boolean | 'unknown' | 'not-collected' | 'not-applicable';

function finiteType<T extends string>(
  value: unknown,
  codes: readonly T[],
): T | UnavailableTypeOperand {
  if (value === null) return 'null';
  if (value === undefined) return 'absent';
  if (typeof value !== 'string') return 'unknown';
  return codes.find((code) => code === value) ?? 'unrecognized';
}

export interface HostAssociationDiagnostic {
  incompatibleType?: {
    hostIndex: number;
    hostType: HostTypeOperand;
    nativeType: NativeTypeOperand;
    directChildScrollView: DirectChildScrollView;
  };
  identity:
    | 'evidence-unavailable'
    | 'window-count'
    | 'window-frame'
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
): boolean {
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

function sameFrame(host: Rect | undefined, native: Rect | undefined, window: Rect): boolean {
  return (
    !!host &&
    !!native &&
    host.x + window.x === native.x &&
    host.y + window.y === native.y &&
    host.width === native.width &&
    host.height === native.height
  );
}

function frameMismatchDiagnostic(
  host: Rect | undefined,
  native: NativeNode,
  window: Rect,
): NonNullable<HostAssociationDiagnostic['frameMismatch']> {
  const rectFinite = (rect: Rect | undefined) =>
    !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite);
  const delta = (a: number | undefined, b: number | undefined, offset: number | undefined) => {
    if (![a, b, offset].every(Number.isFinite)) return null;
    const difference = a! - (b! + offset!);
    return Number.isFinite(difference) ? difference : null;
  };
  const type = native.type;
  return {
    nativeKind:
      type === 'TextField' || type === 'SecureTextField' || type === 'TextView' ? type : 'other',
    hostFinite: rectFinite(host),
    nativeFinite: rectFinite(native.rect),
    windowOriginFinite: Number.isFinite(window.x) && Number.isFinite(window.y),
    // Native minus host, with the same window-origin translation as the strict comparison.
    delta: {
      x: delta(native.rect?.x, host?.x, window.x),
      y: delta(native.rect?.y, host?.y, window.y),
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
): boolean {
  try {
    if (!host || !native) return false;
    const outer = { ...host, x: host.x + window.x, y: host.y + window.y };
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

export function associateHosts(
  nodes: NativeNode[],
  evidence: ReactHostEvidence | undefined,
  presence: NativePresence | undefined,
  diagnostics?: Map<number, HostAssociationDiagnostic>,
  firstMissingAncestors?: Map<number, number>,
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
      host.hostType === 'RCTMultilineTextInputView';
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
    const hostType = host.hostType;
    const nativeType = nodes[nativeIndex].type;
    const scrollsBeneath = nodes.some(
      (n) => n.parentIndex === nativeIndex && n.type === 'ScrollView',
    );
    const compatibleType = compatible(hostType, nativeType, scrollsBeneath);
    let incompatibleType: HostAssociationDiagnostic['incompatibleType'];
    if (!compatibleType && diagnostics) {
      try {
        const hostOperand = finiteType(hostType, finiteHostTypes);
        const nativeOperand = finiteType(nativeType, finiteNativeTypes);
        const notApplicable =
          (hostOperand !== 'unknown' &&
            hostOperand !== 'RCTScrollView' &&
            hostOperand !== 'ScrollView') ||
          (nativeOperand !== 'unknown' && nativeOperand !== 'Other');
        incompatibleType = {
          hostIndex: host.hostIndex,
          hostType: hostOperand,
          nativeType: nativeOperand,
          directChildScrollView: notApplicable
            ? 'not-applicable'
            : hostOperand === 'unknown' || nativeOperand === 'unknown'
              ? 'unknown'
              : scrollsBeneath,
        };
      } catch {
        // Operand diagnostics cannot prevent the existing failure note.
      }
    }
    note(host.hostIndex, {
      identity: 'incompatible-type',
      compatibleCount: Number(compatibleType),
      ...(incompatibleType ? { incompatibleType } : {}),
    });
    if (!compatibleType) continue;
    const matchingFrame = sameFrame(host.rect, nodes[nativeIndex].rect, window);
    // Native input accessibility frames can be inset from their React host's outer frame.
    const matchingGeometry = inputHost
      ? !evidence.hosts[host.hostIndex].hidden &&
        containsInputFrame(host.rect, nodes[nativeIndex].rect, window)
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
            frameMismatch: frameMismatchDiagnostic(host.rect, nodes[nativeIndex], window),
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
  const missingAncestor = (host: number, ancestor: number) => {
    try {
      firstMissingAncestors?.set(host, ancestor);
    } catch {
      // Diagnostic witnesses cannot change association.
    }
  };
  const anchoredPath = (i: number): boolean => {
    const named = paths[i].filter((p) => !inline(p) && !!evidence.hosts[p].testID);
    let reason: HostAssociationDiagnostic['ancestorPath'] = 'valid';
    const valid = named.every((p, n) => {
      const nativeIndex = (p === i ? anchors : structural).get(p);
      if (nativeIndex === undefined) {
        reason = p === i ? 'self-anchor-missing' : 'ancestor-structure-missing';
        if (p !== i) missingAncestor(i, p);
        return false;
      }
      if (n + 1 === named.length) return true;
      const ancestor = structural.get(named[n + 1]);
      if (ancestor === undefined) {
        missingAncestor(i, named[n + 1]);
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
      !compatible(host.hostType, 'StaticText')
    )
      continue;
    // The nearest identified ancestor scopes the search, even without measured presence.
    const anchorHost = paths[host.hostIndex].slice(1).find((i) => structural.has(i));
    if (anchorHost === undefined) continue;
    const anchorIndex = structural.get(anchorHost)!;
    const windowIndex = nativeWindows[anchorIndex]!;
    const window = nodes[windowIndex].rect!;
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
      node.type === 'StaticText' &&
      node.label === content &&
      sameFrame(host.rect, node.rect, window)
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
        (!h.rect || sameFrame(h.rect, nodes[matches[0]].rect, window))
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
