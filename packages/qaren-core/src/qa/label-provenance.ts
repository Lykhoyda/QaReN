import type { NativePresenceNode } from './native-presence.js';
import type { Screen } from './screen.js';

export interface LabelProvenance {
  ref: string;
  labelSource: NativePresenceNode['labelSource'];
}

export const PROVENANCE_FIELDS = [
  'type',
  'identifier',
  'label',
  'value',
  'frame',
  'enabled',
  'depth',
  'parentIndex',
  'labelSource',
  'selected',
  'secure',
  'editable',
  'visibleToUser',
  'clickable',
] as const;
export const PROVENANCE_OUTCOMES = [
  'available',
  'unavailable',
  'ref-unavailable',
  'process-mismatch',
  'malformed',
  'read-failed',
  'adapter-unavailable',
  'baseline-unavailable',
  'identity-mismatch',
  'observation-unavailable',
  'deadline',
  'not-hittable',
  'match-count-mismatch',
  'post-hit-mismatch',
  'read-unavailable',
  'ineligible',
  'enumeration-incomplete',
  'clipped',
  'keyboard-covered',
  'empty-frame',
  'ambiguous-descriptor',
] as const;

export interface ProvenanceReadDiagnostic {
  requested: boolean;
  sampleCount: number | null;
  nodeIndex: number | null;
  differedFields: Array<(typeof PROVENANCE_FIELDS)[number]>;
  deadlineExpired: boolean | null;
  outcome: (typeof PROVENANCE_OUTCOMES)[number];
}

export type ProvenanceReporter = (event: ProvenanceReadDiagnostic) => void;
export interface LabelProvenanceDiagnostic extends ProvenanceReadDiagnostic {
  kind: 'label-provenance';
  line: number;
}

export function unavailableProvenance(
  outcome: ProvenanceReadDiagnostic['outcome'] = 'unavailable',
): ProvenanceReadDiagnostic {
  return {
    requested: true,
    sampleCount: null,
    nodeIndex: null,
    differedFields: [],
    deadlineExpired: null,
    outcome,
  };
}

export function cleanProvenanceReadDiagnostic(
  value: unknown,
): ProvenanceReadDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  const count = (n: unknown) => n === null || (Number.isSafeInteger(n) && (n as number) >= 0);
  if (
    typeof v.requested !== 'boolean' ||
    !count(v.sampleCount) ||
    !count(v.nodeIndex) ||
    (v.deadlineExpired !== null && typeof v.deadlineExpired !== 'boolean') ||
    !Array.isArray(v.differedFields) ||
    v.differedFields.length > PROVENANCE_FIELDS.length ||
    new Set(v.differedFields).size !== v.differedFields.length ||
    !v.differedFields.every((field) => PROVENANCE_FIELDS.includes(field)) ||
    !PROVENANCE_OUTCOMES.includes(v.outcome as ProvenanceReadDiagnostic['outcome'])
  )
    return;
  return {
    requested: v.requested,
    sampleCount: v.sampleCount as number | null,
    nodeIndex: v.nodeIndex as number | null,
    differedFields: [...v.differedFields],
    deadlineExpired: v.deadlineExpired as boolean | null,
    outcome: v.outcome as ProvenanceReadDiagnostic['outcome'],
  };
}

export function provenanceDiagnosticFromWire(value: unknown): ProvenanceReadDiagnostic | undefined {
  if (!value || typeof value !== 'object') return;
  const v = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(v.fieldMask) ||
    (v.fieldMask as number) < 0 ||
    (v.fieldMask as number) >= 1 << PROVENANCE_FIELDS.length
  )
    return;
  return cleanProvenanceReadDiagnostic({
    ...v,
    requested: true,
    nodeIndex: v.nodeIndex ?? null,
    differedFields: PROVENANCE_FIELDS.filter(
      (_, bit) => ((v.fieldMask as number) & (1 << bit)) !== 0,
    ),
  });
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
