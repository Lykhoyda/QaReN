import type { NativePresenceNode } from './native-presence.js';
import type { Screen } from './screen.js';

export interface LabelProvenance {
  ref: string;
  labelSource: NativePresenceNode['labelSource'];
}

export function applyLabelProvenance(
  screen: Screen,
  refs: string[],
  evidence: LabelProvenance[] | undefined,
): boolean {
  if (
    refs.length < 1 ||
    refs.length > 64 ||
    new Set(refs).size !== refs.length ||
    !evidence ||
    evidence.length !== refs.length ||
    new Set(evidence.map((node) => node.ref)).size !== refs.length ||
    evidence.some(
      (node) =>
        !refs.includes(node.ref) ||
        !['direct', 'value', 'descendant', 'none'].includes(node.labelSource),
    )
  )
    return false;
  const elements = refs.map((ref) => screen.elements.find((element) => element.ref === ref));
  if (elements.some((element) => !element?.semantic)) return false;
  for (const element of elements) {
    element!.semantic!.nativePresence = {
      kind: element!.nativeKind ?? element!.kind,
      labelSource: evidence.find((node) => node.ref === element!.ref)!.labelSource,
      structural: false,
    };
  }
  return true;
}

export function labelProvenanceFromWire(
  value: unknown,
  indices: number[],
): LabelProvenance[] | undefined {
  if (!Array.isArray(value) || value.length !== indices.length) return undefined;
  const evidence: LabelProvenance[] = [];
  for (const node of value) {
    if (
      !node ||
      typeof node !== 'object' ||
      !('index' in node) ||
      !('labelSource' in node) ||
      typeof node.index !== 'number' ||
      !indices.includes(node.index)
    )
      return undefined;
    const source = node.labelSource;
    if (source !== 'direct' && source !== 'value' && source !== 'descendant' && source !== 'none')
      return undefined;
    evidence.push({ ref: `@e${node.index}`, labelSource: source });
  }
  return new Set(evidence.map((node) => node.ref)).size === indices.length ? evidence : undefined;
}
