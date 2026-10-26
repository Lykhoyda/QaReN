import { isRecord } from './questions.js';
import { associateHosts, hostPath, nativeWindowIndex } from './host-association.js';
import { PRIVATE_INPUT_LIMITS } from './private-input-limits.js';
import type { HostAssociation } from './host-association.js';
import type { NativePresence } from './native-presence.js';
import type { NativeNode, ReactHostEvidence } from './screen.js';

export const TYPOGRAPHY_TEXT_LIMITS = { maxContentChars: 4096, maxTotalChars: 16384 } as const;

type Rect = { x: number; y: number; width: number; height: number };
type BlockText = {
  kind: 'block';
  content: string;
  runs: Array<{ start: number; end: number; fontSize: number }>;
  scaling: { allowFontScaling: boolean; maxFontSizeMultiplier: number };
};

export interface HostTypography {
  version: 1;
  complete: boolean;
  durationMs: number;
  coordinateSpace: 'window-points';
  nodes: Array<{
    hostIndex: number;
    parentHostIndex: number | null;
    rootIndex: number;
    hostType: string | null;
    accessibility?: {
      accessible: 'true' | 'false' | 'absent' | 'unknown';
      authoredLabel: 'present' | 'absent' | 'unknown';
    };
    rect?: Rect;
    text:
      | { kind: 'none' }
      | { kind: 'inline'; ownerHostIndex: number }
      | { kind: 'unsupported' }
      | BlockText;
  }>;
}

export type HeadingEvidence =
  | {
      kind: 'declared-heading' | 'typographic-title';
      hostIndex: number;
      anchorRef: string;
      bodyRefs: string[];
    }
  | { kind: 'navigation-title'; barRef: string };

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rect(value: unknown): value is Rect {
  return (
    isRecord(value) &&
    finite(value.x) &&
    finite(value.y) &&
    finite(value.width) &&
    finite(value.height) &&
    value.width >= 0 &&
    value.height >= 0
  );
}

function index(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function accessibilityFacts(value: unknown): boolean {
  if (!isRecord(value) || Object.keys(value).length !== 2) return false;
  const accessible = Object.getOwnPropertyDescriptor(value, 'accessible');
  const label = Object.getOwnPropertyDescriptor(value, 'authoredLabel');
  return (
    !!accessible &&
    'value' in accessible &&
    ['true', 'false', 'absent', 'unknown'].includes(accessible.value) &&
    !!label &&
    'value' in label &&
    ['present', 'absent', 'unknown'].includes(label.value)
  );
}

function block(value: Record<string, unknown>): boolean {
  if (
    typeof value.content !== 'string' ||
    value.content.length > TYPOGRAPHY_TEXT_LIMITS.maxContentChars ||
    !Array.isArray(value.runs) ||
    value.runs.length > 128 ||
    !isRecord(value.scaling) ||
    typeof value.scaling.allowFontScaling !== 'boolean' ||
    !finite(value.scaling.maxFontSizeMultiplier) ||
    (value.scaling.maxFontSizeMultiplier !== 0 && value.scaling.maxFontSizeMultiplier < 1)
  )
    return false;
  let end = 0;
  for (const run of value.runs) {
    if (
      !isRecord(run) ||
      run.start !== end ||
      !index(run.end) ||
      run.end <= end ||
      run.end > value.content.length ||
      !finite(run.fontSize) ||
      run.fontSize <= 0
    )
      return false;
    end = run.end;
  }
  return end === value.content.length;
}

export function validateHostTypography(
  value: unknown,
  hostCount: number,
): HostTypography | undefined {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.complete !== 'boolean' ||
    !finite(value.durationMs) ||
    value.durationMs < 0 ||
    (value.complete && value.durationMs >= 1000) ||
    value.coordinateSpace !== 'window-points' ||
    !Array.isArray(value.nodes) ||
    value.nodes.length !== hostCount ||
    hostCount > PRIVATE_INPUT_LIMITS.maxHosts ||
    (value.complete && hostCount === PRIVATE_INPUT_LIMITS.maxHosts)
  )
    return undefined;
  let characters = 0;
  for (const [i, node] of value.nodes.entries()) {
    const accessibility = isRecord(node)
      ? Object.getOwnPropertyDescriptor(node, 'accessibility')
      : undefined;
    if (
      !isRecord(node) ||
      node.hostIndex !== i ||
      !index(node.rootIndex) ||
      (node.parentHostIndex !== null &&
        (!index(node.parentHostIndex) ||
          node.parentHostIndex >= hostCount ||
          node.parentHostIndex === i)) ||
      (node.hostType !== null && (typeof node.hostType !== 'string' || !node.hostType)) ||
      (node.rect !== undefined && !rect(node.rect)) ||
      (accessibility !== undefined &&
        (!('value' in accessibility) ||
          (accessibility.value !== undefined && !accessibilityFacts(accessibility.value)))) ||
      !isRecord(node.text)
    )
      return undefined;
    switch (node.text.kind) {
      case 'none':
      case 'unsupported':
        break;
      case 'inline':
        if (!index(node.text.ownerHostIndex) || node.text.ownerHostIndex >= hostCount)
          return undefined;
        break;
      case 'block':
        if (!block(node.text)) return undefined;
        characters += (node.text.content as string).length;
        break;
      default:
        return undefined;
    }
  }
  if (characters > TYPOGRAPHY_TEXT_LIMITS.maxTotalChars) return undefined;
  const snapshot = value as unknown as HostTypography;
  for (const node of snapshot.nodes) {
    const path = hostPath(snapshot, node.hostIndex);
    if (!path || path.some((i) => snapshot.nodes[i].rootIndex !== node.rootIndex)) return undefined;
    if (
      node.text.kind === 'inline' &&
      (!path.slice(1).includes(node.text.ownerHostIndex) ||
        !['block', 'unsupported'].includes(snapshot.nodes[node.text.ownerHostIndex].text.kind))
    )
      return undefined;
  }
  return structuredClone(snapshot);
}

export function associateHeadings(
  nodes: NativeNode[],
  evidence: ReactHostEvidence | undefined,
  presence: NativePresence | undefined,
  associations: Map<number, HostAssociation> = associateHosts(nodes, evidence, presence),
): Map<number, HeadingEvidence> {
  const result = new Map<number, HeadingEvidence>();
  const snapshot = evidence?.typography;
  if (!evidence?.complete || !snapshot?.complete || !presence) return result;
  const paths = snapshot.nodes.map((node) => hostPath(snapshot, node.hostIndex)!);
  const container = (i: number): number | undefined =>
    paths[i]
      .slice(1)
      .find(
        (p) => snapshot.nodes[p].text.kind !== 'inline' && snapshot.nodes[p].text.kind !== 'block',
      );
  for (const host of snapshot.nodes) {
    const association = associations.get(host.hostIndex);
    if (!association || presence.nodes[association.nativeIndex]?.status !== 'observed') continue;
    const identity = evidence.hosts[host.hostIndex];
    const base = {
      hostIndex: host.hostIndex,
      anchorRef: nodes[association.anchorIndex].ref,
      bodyRefs: [] as string[],
    };
    if (
      identity.roleSource !== 'none' &&
      (identity.role === 'heading' || identity.role === 'header')
    ) {
      result.set(association.nativeIndex, { ...base, kind: 'declared-heading' });
      continue;
    }
    if (
      host.text.kind !== 'block' ||
      !host.text.content.trim() ||
      !host.rect ||
      nodes[association.nativeIndex].type !== 'StaticText' ||
      nodes[association.nativeIndex].label !== host.text.content ||
      presence.nodes[association.nativeIndex].labelSource !== 'direct'
    )
      continue;
    const windowIndex = nativeWindowIndex(nodes, association.nativeIndex);
    if (windowIndex === undefined) continue;
    const parent = container(host.hostIndex);
    if (parent === undefined || snapshot.nodes[parent].text.kind !== 'none') continue;
    const siblings = snapshot.nodes.filter(
      (h) =>
        h.hostIndex !== host.hostIndex &&
        container(h.hostIndex) === parent &&
        h.text.kind !== 'inline',
    );
    if (siblings.some((h) => h.text.kind === 'unsupported')) continue;
    const bodies = siblings.filter((h) => h.text.kind === 'block' && h.text.content.trim());
    const title = host.text;
    const titleRect = host.rect;
    const smallest = Math.min(...title.runs.map((run) => run.fontSize));
    if (
      !bodies.length ||
      !bodies.every((body) => {
        const text = body.text as BlockText;
        const bodyAssociation = associations.get(body.hostIndex);
        return (
          bodyAssociation &&
          nativeWindowIndex(nodes, bodyAssociation.nativeIndex) === windowIndex &&
          body.rect &&
          nodes[bodyAssociation.nativeIndex].type === 'StaticText' &&
          nodes[bodyAssociation.nativeIndex].label === text.content &&
          presence.nodes[bodyAssociation.nativeIndex].labelSource === 'direct' &&
          title.scaling.allowFontScaling === text.scaling.allowFontScaling &&
          title.scaling.maxFontSizeMultiplier === text.scaling.maxFontSizeMultiplier &&
          smallest >= 1.25 * Math.max(...text.runs.map((run) => run.fontSize)) &&
          titleRect.height >= 1.25 * body.rect.height &&
          titleRect.y + titleRect.height <= body.rect.y
        );
      })
    )
      continue;
    result.set(association.nativeIndex, {
      ...base,
      kind: 'typographic-title',
      bodyRefs: bodies.map((body) => nodes[associations.get(body.hostIndex)!.nativeIndex].ref),
    });
  }
  return result;
}
