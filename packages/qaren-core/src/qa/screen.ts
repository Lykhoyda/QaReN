import { isRecord } from './questions.js';
import {
  captureInputPrivacy,
  nativeLabelMayBeValue,
  SCROLL_BAR_PERCENT,
  SYSTEM_SCROLL_BAR_LABEL,
} from './privacy.js';
import { PRIVATE_INPUT_LIMITS } from './private-input-limits.js';
import { INPUT_HOST_TYPES } from './input-host-types.js';
import {
  clippingViewport,
  duplicateNodes,
  frameContradictions,
  navigationTitles,
  offscreenNodes,
  outsideViewport,
  scrollChromeNodes,
  NATIVE_PRESENCE_UNKNOWN_REASONS,
} from './native-presence.js';
import type { NativePresence, NativePresenceNode } from './native-presence.js';
import { associateHeadings, validateHostTypography } from './host-typography.js';
import type { HeadingEvidence, HostTypography } from './host-typography.js';
import {
  associateHosts,
  hostPath,
  finiteHostTypes,
  finiteNativeTypes,
  unavailableTypeOperands,
  type HostAssociationDiagnostic,
  type HostTypeOperand,
  type NativeTypeOperand,
  type DirectChildScrollView,
} from './host-association.js';

export type Kind = 'button' | 'input' | 'switch' | 'link' | 'cell' | 'text' | 'image' | 'other';
export type EvidenceStatus = 'supported' | 'unsupported' | 'unknown';
export type Visibility = 'visible' | 'offscreen' | 'hidden' | 'unknown';
export type VisibilityEvidence = 'visible' | 'offscreen' | 'unresolved';

export interface Element {
  ref: string;
  kind: Kind;
  nativeKind?: Kind;
  label?: string;
  testID?: string;
  value?: string;
  placeholder?: string;
  hittable: boolean;
  disabled: boolean;
  // A platform-reported selection-only change still proves a screen change.
  selected?: true;
  secure: boolean;
  offscreen: boolean;
  // Literal-text evidence from the node's own frame; `offscreen` stays the targeting flag.
  visibilityEvidence?: VisibilityEvidence;
  where?: 'top' | 'middle' | 'bottom';
  side?: 'left' | 'center' | 'right';
  semantic?: {
    press: EvidenceStatus;
    fill: EvidenceStatus;
    visibility: Visibility;
    disabled?: boolean;
    heading?: HeadingEvidence;
    nativePresence?: {
      kind: Kind;
      labelSource: NativePresenceNode['labelSource'];
      structural: boolean;
    };
  };
}

export type Front = 'app' | 'dev-menu' | 'dev-fab' | 'picker' | 'dialog';

export interface Screen {
  renderError?: boolean;
  elements: Element[];
  visibleText: string[];
  paintedText?: string[];
  // Merged accessibility labels of visible label-only elements, and text on unresolved frames.
  labelText?: string[];
  unresolvedText?: string[];
  front: Front;
  semanticUnassociatedReact?: number;
  coverage?: {
    native: 'complete' | 'incomplete' | 'unknown';
    react: 'complete' | 'incomplete' | 'unknown';
  };
  captureCoverage?: Screen['coverage'];
  nativeCaptureCauses?: string[];
  pressEvidenceGap?: string;
  reactHostEvidence?: ReactHostEvidence;
  appProcessIdentifier?: number;
  keyboardVisible?: boolean;
  keyboardFrame?: NonNullable<NativeNode['rect']>;
  // A captured keyboard without its keys (Android's synthetic node); its presence alone is the visible change.
  keylessKeyboard?: true;
  // Literal text and merged labels not painted under the keyboard; present only when one is captured.
  uncoveredText?: string[];
  uncoveredLabelText?: string[];
}

const forwardedInputs = new WeakMap<Element, string>();

export function forwardedInputOf(element: Element): string | undefined {
  return forwardedInputs.get(element);
}

// The one fill-capable React host a React-only element is proven to be or to contain.
const reactInputHosts = new WeakMap<Element, number>();

export function reactInputHostOf(element: Element): number | undefined {
  return reactInputHosts.get(element);
}

const labelAncestors = new WeakMap<Element, Element[]>();
const soleLabelTexts = new WeakMap<Element, Element>();
const elementFrames = new WeakMap<Element, NonNullable<NativeNode['rect']>>();
const nativeAncestors = new WeakMap<Element, Element[]>();
const elementViewports = new WeakMap<Element, NonNullable<NativeNode['rect']>>();
const keyboardCoveredElements = new WeakSet<Element>();
// Press/fill from the element's own React evidence, without the screen-wide capability gaps.
const localCapabilities = new WeakMap<
  Element,
  Pick<NonNullable<Element['semantic']>, 'press' | 'fill'>
>();

export function keyboardCoversElement(element: Element): boolean {
  return keyboardCoveredElements.has(element);
}

export function labelAncestorsOf(element: Element): readonly Element[] {
  return labelAncestors.get(element) ?? [];
}

export function soleLabelTextOf(element: Element): Element | undefined {
  return soleLabelTexts.get(element);
}

// Native tree ancestors, nearest first.
export function ancestorsOf(element: Element): readonly Element[] {
  return nativeAncestors.get(element) ?? [];
}

export function elementFrame(element: Element): NativeNode['rect'] {
  return elementFrames.get(element);
}

export function elementViewport(element: Element): NativeNode['rect'] {
  return elementViewports.get(element);
}

const joinedDiagnosticFacts = new WeakMap<
  Element,
  {
    nativeStatus?: NativePresenceNode['status'];
    nativeUnknownReason?: NativePresenceNode['unknownReason'];
    pressGapCount: number;
    fillGapCount: number;
    gapHosts?: GapHostDiagnostics;
    pressGap?: PressGapDiagnostic;
  }
>();

const hostAssociationIdentities = new WeakMap<Element, HostAssociationDiagnostic['identity']>();

export function hostAssociationIdentity(
  element: Element,
): HostAssociationDiagnostic['identity'] | undefined {
  return hostAssociationIdentities.get(element);
}

export interface NativeNode {
  ref: string;
  index?: number;
  parentIndex?: number;
  depth?: number;
  presence?: unknown;
  label?: string;
  identifier?: string;
  type?: string;
  hittable?: boolean;
  enabled?: boolean;
  selected?: boolean;
  // Android only: a scrolled-out node keeps an empty clipped rect inside the viewport.
  visibleToUser?: boolean;
  secure?: boolean;
  value?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface DigestEntry {
  role: string;
  testID?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  value?: string | boolean;
  disabled?: boolean;
  capabilities?: { press: boolean; fill: boolean };
  // Interactive only by role or component name: no handler prop and nothing to fill.
  handlerless?: boolean;
  // Custom composite with a separately emitted interactive descendant, not a view or declared control.
  compositeWrapper?: true;
  inputHostIndices?: number[];
  // Under a host view that hides its subtree from accessibility.
  hidden?: boolean;
}

export interface ReactHostObservation {
  testID?: string;
  nativeID?: string;
  role: string | null;
  roleSource: 'role' | 'accessibilityRole' | 'none';
  capabilities: { press?: true; fill?: true };
  disabled?: true;
  readOnly?: true;
  hidden?: true;
}

export interface ReactHostEvidence {
  hosts: ReactHostObservation[];
  complete: boolean;
  typography?: HostTypography;
}

export function validateReactHostEvidence(value: unknown): ReactHostEvidence | undefined {
  if (
    !isRecord(value) ||
    typeof value.complete !== 'boolean' ||
    !Array.isArray(value.hosts) ||
    value.hosts.length > PRIVATE_INPUT_LIMITS.maxHosts ||
    (value.complete && value.hosts.length === PRIVATE_INPUT_LIMITS.maxHosts)
  )
    return undefined;
  const hosts: ReactHostObservation[] = [];
  for (const host of value.hosts) {
    if (
      !isRecord(host) ||
      (host.roleSource !== 'role' &&
        host.roleSource !== 'accessibilityRole' &&
        host.roleSource !== 'none') ||
      (host.role !== null &&
        (typeof host.role !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(host.role))) ||
      (host.roleSource === 'none' && host.role !== null) ||
      (value.complete && host.roleSource !== 'none' && host.role === null) ||
      !isRecord(host.capabilities) ||
      Object.entries(host.capabilities).some(
        ([key, fact]) => !['press', 'fill'].includes(key) || fact !== true,
      ) ||
      ['testID', 'nativeID'].some(
        (key) => host[key] !== undefined && typeof host[key] !== 'string',
      ) ||
      ['disabled', 'readOnly', 'hidden'].some(
        (key) => host[key] !== undefined && host[key] !== true,
      )
    )
      return undefined;
    hosts.push({
      role: host.role as string | null,
      roleSource: host.roleSource as ReactHostObservation['roleSource'],
      capabilities: { ...host.capabilities },
      ...(host.testID !== undefined ? { testID: host.testID as string } : {}),
      ...(host.nativeID !== undefined ? { nativeID: host.nativeID as string } : {}),
      ...(host.disabled === true ? { disabled: true } : {}),
      ...(host.readOnly === true ? { readOnly: true } : {}),
      ...(host.hidden === true ? { hidden: true as const } : {}),
    });
  }
  const typography =
    value.typography === undefined
      ? undefined
      : validateHostTypography(value.typography, hosts.length);
  if (value.typography !== undefined && !typography) return undefined;
  return { hosts, complete: value.complete, ...(typography ? { typography } : {}) };
}

const IOS_KINDS: Record<string, Kind> = {
  Button: 'button',
  TextField: 'input',
  SecureTextField: 'input',
  SearchField: 'input',
  TextView: 'input',
  Switch: 'switch',
  Toggle: 'switch',
  Link: 'link',
  Cell: 'cell',
  StaticText: 'text',
  Image: 'image',
};

// Most specific suffix first: ToggleButton and RadioButton must not read as Button.
const ANDROID_KINDS: Array<[string, Kind]> = [
  ['ToggleButton', 'switch'],
  ['RadioButton', 'switch'],
  ['ImageButton', 'button'],
  ['Button', 'button'],
  ['AutoCompleteTextView', 'input'],
  ['EditText', 'input'],
  ['Switch', 'switch'],
  ['CheckBox', 'switch'],
  ['TextView', 'text'],
  ['ImageView', 'image'],
];

export function kindOf(type: string | undefined): Kind {
  if (!type) return 'other';
  if (IOS_KINDS[type]) return IOS_KINDS[type];
  const leaf = type.slice(type.lastIndexOf('.') + 1);
  for (const [suffix, kind] of ANDROID_KINDS) {
    if (leaf.endsWith(suffix)) return kind;
  }
  return 'other';
}

function kindOfRole(role: string): Kind {
  switch (role.toLowerCase()) {
    case 'textinput':
    case 'search':
    case 'textbox':
    case 'searchbox':
      return 'input';
    case 'switch':
    case 'checkbox':
    case 'radio':
    case 'togglebutton':
      return 'switch';
    case 'link':
      return 'link';
    case 'image':
    case 'img':
    case 'imagebutton':
      return 'image';
    case 'text':
    case 'header':
    case 'heading':
      return 'text';
    case 'button':
    case 'tab':
    case 'menuitem':
    case 'combobox':
    case 'adjustable':
    case 'slider':
      return 'button';
    default:
      return 'other';
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// iOS's own scroll-bar position is not app data; the indicator keeps its label.
function nativeValue(n: NativeNode): string | undefined {
  const value = nonEmpty(n.value);
  return n.type === 'Other' &&
    SYSTEM_SCROLL_BAR_LABEL.test(n.label?.trim() ?? '') &&
    SCROLL_BAR_PERCENT.test(value ?? '')
    ? undefined
    : value;
}

function norm(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function digestValue(value: string | boolean | undefined): string | undefined {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return nonEmpty(value);
}

function thirds(center: number, extent: number, names: readonly [string, string, string]): string {
  if (extent <= 0) return names[1];
  const ratio = center / extent;
  return ratio < 1 / 3 ? names[0] : ratio < 2 / 3 ? names[1] : names[2];
}

function nativeCapabilities(
  kind: Kind,
  type: string | undefined,
  react: { press: boolean; fill: boolean },
): Pick<NonNullable<Element['semantic']>, 'press' | 'fill'> {
  // Plain iOS views and scroll containers carry no press or text entry of their own.
  const plain =
    kind === 'text' ||
    kind === 'image' ||
    type === 'Other' ||
    type === 'ScrollView' ||
    type === 'NavigationBar';
  return {
    press:
      kind === 'button' || kind === 'switch' || kind === 'link'
        ? 'supported'
        : plain && !react.press
          ? 'unsupported'
          : 'unknown',
    fill:
      kind === 'input'
        ? 'supported'
        : kind === 'other' && !(plain && !react.fill)
          ? 'unknown'
          : 'unsupported',
  };
}

function idCounts(ids: Array<string | undefined>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

interface GapHostDiagnostics {
  total: number;
  truncated: boolean;
  rows: Array<{
    hostOrdinal: number;
    hostKind: 'view' | 'text' | 'virtual-text' | 'scroll-view' | 'input' | 'unknown';
    capabilities: { press: boolean; fill: boolean };
    roleCategory: 'none' | 'input' | 'interactive' | 'noninteractive';
    testIDPresent: boolean;
    nativeIDPresent: boolean;
    hidden: boolean;
    rectStatus: 'positive' | 'zero' | 'unknown';
    pressGap: boolean;
    fillGap: boolean;
    association?: Omit<HostAssociationDiagnostic, 'incompatibleType'>;
  }>;
}

function legacyAssociation(
  value: HostAssociationDiagnostic | undefined,
): GapHostDiagnostics['rows'][number]['association'] {
  if (!value) return undefined;
  return {
    identity: value.identity,
    nativeIdentityCandidateCount: value.nativeIdentityCandidateCount,
    compatibleCount: value.compatibleCount,
    sameFrameCount: value.sameFrameCount,
    ...(value.inputContainmentCount === undefined
      ? {}
      : { inputContainmentCount: value.inputContainmentCount }),
    presenceProofCount: value.presenceProofCount,
    ancestorPath: value.ancestorPath,
    collisions: value.collisions,
    ...(value.frameMismatch === undefined ? {} : { frameMismatch: value.frameMismatch }),
  };
}

const ancestryReasons = [
  'host-id-ambiguous',
  'native-id-count',
  'outside-window',
  'window-frame',
  'incompatible-type',
  'frame-mismatch',
  'absent',
  'unknown',
] as const;
const ancestryNativeCounts = [
  'zero',
  'multiple',
  'null',
  'absent',
  'unknown',
  'not-applicable',
] as const;

type TypeOperandGroup =
  | {
      binding: 'same-witness';
      hostType: HostTypeOperand;
      nativeType: NativeTypeOperand;
      directChildScrollView: DirectChildScrollView;
      count: number;
    }
  | { binding: 'not-collected' | 'unknown' | 'inconsistent'; count: number };
type TypeOperandSample =
  | Omit<Extract<TypeOperandGroup, { binding: 'same-witness' }>, 'count'>
  | { binding: 'not-collected' | 'unknown' | 'inconsistent' };
const typeBindings = ['same-witness', 'not-collected', 'unknown', 'inconsistent'] as const;
const hostTypeCodes = [...finiteHostTypes, ...unavailableTypeOperands];
const nativeTypeCodes = [...finiteNativeTypes, ...unavailableTypeOperands];
const scrollTypeCodes = [false, true, 'unknown', 'not-collected', 'not-applicable'] as const;
const unreadableTypeField = Symbol();

function typeField(value: unknown, key: PropertyKey): unknown {
  try {
    if (!isRecord(value) && !Array.isArray(value)) return unreadableTypeField;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined
      ? undefined
      : 'value' in descriptor
        ? descriptor.value
        : unreadableTypeField;
  } catch {
    return unreadableTypeField;
  }
}

function scrollApplicability(host: HostTypeOperand, native: NativeTypeOperand) {
  if (
    (host !== 'unknown' && host !== 'RCTScrollView' && host !== 'ScrollView') ||
    (native !== 'unknown' && native !== 'Other')
  )
    return 'not-applicable';
  return host === 'unknown' || native === 'unknown' ? 'unknown' : 'applicable';
}

function compareTypeOperands(a: TypeOperandSample, b: TypeOperandSample): number {
  const binding = typeBindings.indexOf(a.binding) - typeBindings.indexOf(b.binding);
  if (binding || a.binding !== 'same-witness' || b.binding !== 'same-witness') return binding;
  return (
    hostTypeCodes.indexOf(a.hostType) - hostTypeCodes.indexOf(b.hostType) ||
    nativeTypeCodes.indexOf(a.nativeType) - nativeTypeCodes.indexOf(b.nativeType) ||
    scrollTypeCodes.indexOf(a.directChildScrollView) -
      scrollTypeCodes.indexOf(b.directChildScrollView)
  );
}

function boundTypeOperands(record: unknown, witness: number): TypeOperandSample {
  try {
    const sample = typeField(record, 'incompatibleType');
    if (sample === undefined) return { binding: 'not-collected' };
    if (!isRecord(sample)) return { binding: 'unknown' };
    const index = typeField(sample, 'hostIndex');
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
      return { binding: 'unknown' };
    if (index !== witness) return { binding: 'inconsistent' };
    const nativeCount = typeField(record, 'nativeIdentityCandidateCount');
    const compatibleCount = typeField(record, 'compatibleCount');
    if (nativeCount !== 1 || compatibleCount !== 0)
      return {
        binding:
          nativeCount === undefined ||
          nativeCount === null ||
          compatibleCount === undefined ||
          compatibleCount === null ||
          nativeCount === unreadableTypeField ||
          compatibleCount === unreadableTypeField
            ? 'unknown'
            : 'inconsistent',
      };
    const host = typeField(sample, 'hostType'),
      native = typeField(sample, 'nativeType');
    const hostType = hostTypeCodes.find((code) => code === host);
    const nativeType = nativeTypeCodes.find((code) => code === native);
    if (!hostType || !nativeType) return { binding: 'unknown' };
    const bit = typeField(sample, 'directChildScrollView');
    const applicability = scrollApplicability(hostType, nativeType);
    const directChildScrollView =
      applicability === 'not-applicable'
        ? 'not-applicable'
        : applicability === 'unknown'
          ? 'unknown'
          : typeof bit === 'boolean'
            ? bit
            : bit === undefined || bit === 'not-collected'
              ? 'not-collected'
              : 'unknown';
    return { binding: 'same-witness', hostType, nativeType, directChildScrollView };
  } catch {
    return { binding: 'unknown' };
  }
}

function projectTypeOperands(
  value: unknown,
  count: number,
  allSame: unknown,
): TypeOperandGroup[] | undefined {
  try {
    if (value === undefined || value === null || !Array.isArray(value)) return undefined;
    const length = typeField(value, 'length');
    if (typeof length !== 'number' || length < 1 || length > count) return undefined;
    const groups: TypeOperandGroup[] = [];
    for (let i = 0; i < length; i++) {
      const raw = typeField(value, String(i));
      const bindingValue = typeField(raw, 'binding');
      const binding = typeBindings.find((code) => code === bindingValue);
      const n = typeField(raw, 'count');
      if (!binding || !ancestryCount(n) || n === 0) return undefined;
      let group: TypeOperandGroup;
      if (binding === 'same-witness') {
        const host = typeField(raw, 'hostType'),
          native = typeField(raw, 'nativeType');
        const hostType = hostTypeCodes.find((code) => code === host);
        const nativeType = nativeTypeCodes.find((code) => code === native);
        const bit = typeField(raw, 'directChildScrollView');
        const directChildScrollView = scrollTypeCodes.find((code) => code === bit);
        if (!hostType || !nativeType || directChildScrollView === undefined) return undefined;
        const applicability = scrollApplicability(hostType, nativeType);
        if (
          applicability === 'not-applicable'
            ? directChildScrollView !== 'not-applicable'
            : applicability === 'unknown'
              ? directChildScrollView !== 'unknown'
              : directChildScrollView === 'not-applicable'
        )
          return undefined;
        group = { binding, hostType, nativeType, directChildScrollView, count: n };
      } else {
        if (
          ['hostType', 'nativeType', 'directChildScrollView'].some(
            (key) => typeField(raw, key) !== undefined,
          )
        )
          return undefined;
        group = { binding, count: n };
      }
      if (groups.length && compareTypeOperands(groups.at(-1)!, group) >= 0) return undefined;
      groups.push(group);
    }
    if (
      groups.reduce((sum, group) => sum + group.count, 0) !== count ||
      (allSame === true && groups.filter((group) => group.binding === 'same-witness').length > 1)
    )
      return undefined;
    return groups;
  } catch {
    return undefined;
  }
}

type AncestryQualification = {
  typeOperands?: TypeOperandGroup[];
  reason: (typeof ancestryReasons)[number];
  nativeCandidates: (typeof ancestryNativeCounts)[number];
  count: number;
};

export interface AncestryGapSummary {
  retained: number;
  paths: {
    structureMissing: number;
    selfAnchorMissing: number;
    other: number;
    notEvaluated: number;
    absent: number;
    unknown: number;
  };
  firstMissing: { known: number; absent: number; unknown: number };
  qualifications: AncestryQualification[];
  allSame: boolean | 'unknown' | 'not-applicable';
  retainedAmbiguous: { count: number; absent: number; unknown: number };
  sameAsRetainedAmbiguous: boolean | 'unknown' | 'not-applicable' | 'absent' | 'ambiguous';
}

function ancestryMembership(rows: readonly { hostOrdinal: number; association?: unknown }[]) {
  const paths = {
    structureMissing: 0,
    selfAnchorMissing: 0,
    other: 0,
    notEvaluated: 0,
    absent: 0,
    unknown: 0,
  };
  const retainedAmbiguous = { count: 0, absent: 0, unknown: 0 };
  let ambiguousHost: number | undefined;
  const identities: HostAssociationDiagnostic['identity'][] = [
    'evidence-unavailable',
    'window-count',
    'window-frame',
    'inline',
    'no-test-id',
    'host-id-ambiguous',
    'native-id-count',
    'outside-window',
    'incompatible-type',
    'frame-mismatch',
    'matched',
  ];
  for (const row of rows) {
    const association = row.association;
    const record = isRecord(association) ? association : undefined;
    const path = record?.ancestorPath;
    if (association === undefined || (record && !Object.hasOwn(record, 'ancestorPath')))
      paths.absent++;
    else
      switch (path) {
        case 'ancestor-structure-missing':
          paths.structureMissing++;
          break;
        case 'self-anchor-missing':
          paths.selfAnchorMissing++;
          break;
        case 'valid':
        case 'ancestor-path-mismatch':
          paths.other++;
          break;
        case 'not-evaluated':
          paths.notEvaluated++;
          break;
        default:
          paths.unknown++;
      }
    const identity = record?.identity;
    if (association === undefined || (record && !Object.hasOwn(record, 'identity')))
      retainedAmbiguous.absent++;
    else if (identity === 'host-id-ambiguous') {
      retainedAmbiguous.count++;
      ambiguousHost = retainedAmbiguous.count === 1 ? row.hostOrdinal : undefined;
    } else if (!identities.some((code) => code === identity)) retainedAmbiguous.unknown++;
  }
  return { paths, retainedAmbiguous, ambiguousHost };
}

function ancestryQualification(value: unknown): Omit<AncestryQualification, 'count'> {
  const absent = { reason: 'absent', nativeCandidates: 'absent' } as const;
  const unknown = { reason: 'unknown', nativeCandidates: 'unknown' } as const;
  if (value === undefined) return absent;
  if (!isRecord(value)) return unknown;
  if (!Object.hasOwn(value, 'identity')) return absent;
  const reason = ancestryReasons.find((code) => code === value.identity);
  if (!reason || reason === 'absent' || reason === 'unknown') return unknown;
  const native = value.nativeIdentityCandidateCount;
  const compatible = value.compatibleCount;
  const frame = value.sameFrameCount;
  const input = value.inputContainmentCount;
  const measured = (count: unknown) => count !== null && count !== undefined;
  const later = [value.presenceProofCount, value.collisions];
  if (later.some(measured)) return unknown;
  if (reason === 'host-id-ambiguous')
    return [native, compatible, frame, input].some(measured)
      ? unknown
      : { reason, nativeCandidates: 'not-applicable' };
  if (reason === 'native-id-count') {
    if (native === 1 || [compatible, frame, input].some(measured)) return unknown;
    const nativeCandidates =
      native === undefined
        ? 'absent'
        : native === null
          ? 'null'
          : typeof native !== 'number' || !Number.isSafeInteger(native) || native < 0
            ? 'unknown'
            : native === 0
              ? 'zero'
              : 'multiple';
    return { reason, nativeCandidates };
  }
  if (measured(native) && native !== 1) return unknown;
  if (reason === 'outside-window' || reason === 'window-frame')
    return [compatible, frame, input].some(measured)
      ? unknown
      : { reason, nativeCandidates: 'not-applicable' };
  if (reason === 'incompatible-type')
    return (measured(compatible) && compatible !== 0) || [frame, input].some(measured)
      ? unknown
      : { reason, nativeCandidates: 'not-applicable' };
  if (
    (measured(compatible) && compatible !== 1) ||
    input === 1 ||
    (frame !== 0 && input !== 0) ||
    (measured(frame) && frame !== 0 && frame !== 1) ||
    (measured(input) && input !== 0)
  )
    return unknown;
  return { reason, nativeCandidates: 'not-applicable' };
}

function summarizeAncestry(
  rows: GapHostDiagnostics['rows'],
  witnesses: Map<number, number>,
  diagnostics: Map<number, HostAssociationDiagnostic>,
  hostCount: number,
): AncestryGapSummary | undefined {
  try {
    const { paths, retainedAmbiguous, ambiguousHost } = ancestryMembership(rows);
    const firstMissing = { known: 0, absent: 0, unknown: 0 };
    let shared: number | undefined;
    let different = false;
    const qualifications: AncestryQualification[] = [];
    const typeSamples: Array<{ witness: number; sample: TypeOperandSample }> = [];
    for (const row of rows) {
      if (row.association?.ancestorPath !== 'ancestor-structure-missing') continue;
      let witness: number | undefined | 'unknown';
      try {
        witness = witnesses.get(row.hostOrdinal);
      } catch {
        witness = 'unknown';
      }
      let qualification: Omit<AncestryQualification, 'count'>;
      if (witness === undefined) {
        firstMissing.absent++;
        qualification = { reason: 'absent', nativeCandidates: 'absent' };
      } else if (
        witness === 'unknown' ||
        !Number.isSafeInteger(witness) ||
        witness < 0 ||
        witness >= hostCount ||
        witness === row.hostOrdinal
      ) {
        firstMissing.unknown++;
        qualification = { reason: 'unknown', nativeCandidates: 'unknown' };
      } else {
        firstMissing.known++;
        if (firstMissing.known === 1) shared = witness;
        else if (shared !== witness) different = true;
        try {
          const record = diagnostics.get(witness);
          qualification = ancestryQualification(record);
          if (qualification.reason === 'incompatible-type')
            typeSamples.push({ witness, sample: boundTypeOperands(record, witness) });
        } catch {
          qualification = { reason: 'unknown', nativeCandidates: 'unknown' };
        }
      }
      const group = qualifications.find(
        (group) =>
          group.reason === qualification.reason &&
          group.nativeCandidates === qualification.nativeCandidates,
      );
      if (group) group.count++;
      else qualifications.push({ ...qualification, count: 1 });
    }
    for (const entry of typeSamples) {
      if (
        typeSamples.some(
          (other) =>
            other.witness === entry.witness &&
            (other.sample.binding === 'inconsistent' ||
              (entry.sample.binding === 'same-witness' &&
                other.sample.binding === 'same-witness' &&
                compareTypeOperands(entry.sample, other.sample) !== 0)),
        )
      ) {
        for (const other of typeSamples)
          if (other.witness === entry.witness) other.sample = { binding: 'inconsistent' };
      }
    }
    const incompatible = qualifications.find((group) => group.reason === 'incompatible-type');
    if (incompatible) {
      const groups: TypeOperandGroup[] = [];
      for (const { sample } of typeSamples) {
        const group = groups.find((group) => compareTypeOperands(group, sample) === 0);
        if (group) group.count++;
        else groups.push({ ...sample, count: 1 });
      }
      incompatible.typeOperands = groups.sort(compareTypeOperands);
    }
    qualifications.sort(
      (a, b) =>
        ancestryReasons.indexOf(a.reason) - ancestryReasons.indexOf(b.reason) ||
        ancestryNativeCounts.indexOf(a.nativeCandidates) -
          ancestryNativeCounts.indexOf(b.nativeCandidates),
    );
    const allSame =
      paths.structureMissing === 0
        ? 'not-applicable'
        : firstMissing.absent || firstMissing.unknown
          ? 'unknown'
          : !different;
    const sameAsRetainedAmbiguous =
      allSame === 'not-applicable' || allSame === false
        ? 'not-applicable'
        : allSame === 'unknown' || retainedAmbiguous.absent || retainedAmbiguous.unknown
          ? 'unknown'
          : retainedAmbiguous.count === 0
            ? 'absent'
            : retainedAmbiguous.count > 1
              ? 'ambiguous'
              : shared === ambiguousHost;
    return {
      retained: rows.length,
      paths,
      firstMissing,
      qualifications,
      allSame,
      retainedAmbiguous,
      sameAsRetainedAmbiguous,
    };
  } catch {
    return undefined;
  }
}

export interface PressGapDiagnostic {
  ancestry?: AncestryGapSummary;
  category: 'missing-host-evidence' | 'incomplete-host-evidence' | 'unassociated-hosts';
  hostEvidencePresent: boolean;
  hostEvidenceComplete: boolean;
  typographyComplete: boolean;
  nativePresenceAvailable: boolean;
  pressGapCount: number;
  gapHosts?: {
    total: number;
    truncated: boolean;
    rows: Array<
      Pick<
        GapHostDiagnostics['rows'][number],
        'hostOrdinal' | 'hostKind' | 'capabilities' | 'pressGap'
      > & {
        association?: Pick<
          HostAssociationDiagnostic,
          | 'identity'
          | 'nativeIdentityCandidateCount'
          | 'compatibleCount'
          | 'sameFrameCount'
          | 'inputContainmentCount'
          | 'presenceProofCount'
          | 'ancestorPath'
          | 'collisions'
        >;
      }
    >;
  };
}

function ancestryCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8;
}

function projectAncestry(
  value: unknown,
  rows: NonNullable<PressGapDiagnostic['gapHosts']>['rows'],
): AncestryGapSummary | undefined {
  try {
    if (!isRecord(value) || !ancestryCount(value.retained) || value.retained !== rows.length)
      return undefined;
    const paths = value.paths,
      first = value.firstMissing,
      ambiguous = value.retainedAmbiguous;
    if (
      !isRecord(paths) ||
      !ancestryCount(paths.structureMissing) ||
      !ancestryCount(paths.selfAnchorMissing) ||
      !ancestryCount(paths.other) ||
      !ancestryCount(paths.notEvaluated) ||
      !ancestryCount(paths.absent) ||
      !ancestryCount(paths.unknown) ||
      !isRecord(first) ||
      !ancestryCount(first.known) ||
      !ancestryCount(first.absent) ||
      !ancestryCount(first.unknown) ||
      !isRecord(ambiguous) ||
      !ancestryCount(ambiguous.count) ||
      !ancestryCount(ambiguous.absent) ||
      !ancestryCount(ambiguous.unknown) ||
      !Array.isArray(value.qualifications) ||
      value.qualifications.length > value.retained
    )
      return undefined;
    const memberships = ancestryMembership(rows);
    if (
      !Object.entries(memberships.paths).every(([key, count]) => paths[key] === count) ||
      !Object.entries(memberships.retainedAmbiguous).every(
        ([key, count]) => ambiguous[key] === count,
      ) ||
      first.known + first.absent + first.unknown !== paths.structureMissing
    )
      return undefined;
    const qualifications: AncestryQualification[] = [];
    let previous = -1;
    for (const group of value.qualifications) {
      if (!isRecord(group) || !ancestryCount(group.count) || group.count === 0) return undefined;
      const reason = ancestryReasons.find((code) => code === group.reason);
      const nativeCandidates = ancestryNativeCounts.find((code) => code === group.nativeCandidates);
      if (!reason || !nativeCandidates) return undefined;
      const rank =
        ancestryReasons.indexOf(reason) * ancestryNativeCounts.length +
        ancestryNativeCounts.indexOf(nativeCandidates);
      if (
        rank <= previous ||
        (reason === 'absent'
          ? nativeCandidates !== 'absent'
          : reason === 'unknown'
            ? nativeCandidates !== 'unknown'
            : reason === 'native-id-count'
              ? nativeCandidates === 'not-applicable'
              : nativeCandidates !== 'not-applicable')
      )
        return undefined;
      previous = rank;
      const typeOperands =
        reason === 'incompatible-type'
          ? projectTypeOperands(typeField(group, 'typeOperands'), group.count, value.allSame)
          : undefined;
      qualifications.push({
        reason,
        nativeCandidates,
        count: group.count,
        ...(typeOperands ? { typeOperands } : {}),
      });
    }
    const countReason = (reason: AncestryQualification['reason']) =>
      qualifications
        .filter((group) => group.reason === reason)
        .reduce((sum, group) => sum + group.count, 0);
    if (
      qualifications.reduce((sum, group) => sum + group.count, 0) !== paths.structureMissing ||
      countReason('absent') < first.absent ||
      countReason('unknown') < first.unknown
    )
      return undefined;
    const allSame = value.allSame,
      equality = value.sameAsRetainedAmbiguous;
    if (typeof allSame !== 'boolean' && allSame !== 'unknown' && allSame !== 'not-applicable')
      return undefined;
    if (
      typeof equality !== 'boolean' &&
      equality !== 'unknown' &&
      equality !== 'not-applicable' &&
      equality !== 'absent' &&
      equality !== 'ambiguous'
    )
      return undefined;
    if (paths.structureMissing === 0) {
      if (allSame !== 'not-applicable' || equality !== 'not-applicable') return undefined;
    } else if (first.absent || first.unknown) {
      if (allSame !== 'unknown' || equality !== 'unknown') return undefined;
    } else {
      if (typeof allSame !== 'boolean' || (paths.structureMissing === 1 && !allSame))
        return undefined;
      const expected = !allSame
        ? 'not-applicable'
        : ambiguous.absent || ambiguous.unknown
          ? 'unknown'
          : ambiguous.count === 0
            ? 'absent'
            : ambiguous.count > 1
              ? 'ambiguous'
              : undefined;
      if (expected === undefined ? typeof equality !== 'boolean' : equality !== expected)
        return undefined;
    }
    return {
      retained: value.retained,
      paths: {
        structureMissing: paths.structureMissing,
        selfAnchorMissing: paths.selfAnchorMissing,
        other: paths.other,
        notEvaluated: paths.notEvaluated,
        absent: paths.absent,
        unknown: paths.unknown,
      },
      firstMissing: { known: first.known, absent: first.absent, unknown: first.unknown },
      qualifications,
      allSame,
      retainedAmbiguous: {
        count: ambiguous.count,
        absent: ambiguous.absent,
        unknown: ambiguous.unknown,
      },
      sameAsRetainedAmbiguous: equality,
    };
  } catch {
    return undefined;
  }
}

export function projectPressGap(fact: PressGapDiagnostic): PressGapDiagnostic {
  const gapHosts = fact.gapHosts
    ? {
        total: fact.gapHosts.total,
        truncated: fact.gapHosts.truncated,
        rows: fact.gapHosts.rows
          .slice(0, 8)
          .map(({ hostOrdinal, hostKind, capabilities, pressGap, association }) => ({
            hostOrdinal,
            hostKind,
            capabilities: { press: capabilities.press, fill: capabilities.fill },
            pressGap,
            ...(association
              ? {
                  association: {
                    identity: association.identity,
                    nativeIdentityCandidateCount: association.nativeIdentityCandidateCount,
                    compatibleCount: association.compatibleCount,
                    sameFrameCount: association.sameFrameCount,
                    ...(association.inputContainmentCount === undefined
                      ? {}
                      : { inputContainmentCount: association.inputContainmentCount }),
                    presenceProofCount: association.presenceProofCount,
                    ancestorPath: association.ancestorPath,
                    collisions: association.collisions,
                  },
                }
              : {}),
          })),
      }
    : undefined;
  let ancestry: AncestryGapSummary | undefined;
  try {
    if (fact.category === 'unassociated-hosts' && gapHosts)
      ancestry = projectAncestry(fact.ancestry, gapHosts.rows);
  } catch {
    // A diagnostic projection cannot change refusal.
  }
  return {
    category: fact.category,
    hostEvidencePresent: fact.hostEvidencePresent,
    hostEvidenceComplete: fact.hostEvidenceComplete,
    typographyComplete: fact.typographyComplete,
    nativePresenceAvailable: fact.nativePresenceAvailable,
    pressGapCount: fact.pressGapCount,
    ...(gapHosts ? { gapHosts } : {}),
    ...(ancestry ? { ancestry } : {}),
  };
}

export function pressGapOf(element: Element): PressGapDiagnostic | undefined {
  return joinedDiagnosticFacts.get(element)?.pressGap;
}

function diagnosticHostKind(
  type: string | null | undefined,
): GapHostDiagnostics['rows'][number]['hostKind'] {
  if (INPUT_HOST_TYPES.includes(type ?? '')) return 'input';
  switch (type) {
    case 'RCTView':
    case 'View':
      return 'view';
    case 'RCTText':
    case 'Text':
      return 'text';
    case 'RCTVirtualText':
      return 'virtual-text';
    case 'RCTScrollView':
    case 'ScrollView':
      return 'scroll-view';
    default:
      return 'unknown';
  }
}

export function join(
  nodes: NativeNode[],
  digest: DigestEntry[],
  front: Front = 'app',
  coverage?: Screen['coverage'],
  reactHostEvidence?: ReactHostEvidence,
  nativePresence?: NativePresence | 'unknown',
): Screen {
  const presenceMode =
    nativePresence !== undefined || nodes.some((node) => Object.hasOwn(node, 'presence'));
  const presence = nativePresence === 'unknown' ? undefined : nativePresence;
  const duplicates = duplicateNodes(nodes, presence);
  const nativeIds = idCounts(
    nodes.map((n, i) => (duplicates.has(i) ? undefined : nonEmpty(n.identifier))),
  );
  const reactIds = idCounts(digest.map((d) => (d.hidden ? undefined : d.testID)));
  const hasPositiveHostFill = (id: string | undefined): boolean =>
    id !== undefined &&
    (reactHostEvidence?.hosts.some(
      (host) => host.capabilities.fill === true && (host.testID === id || host.nativeID === id),
    ) ??
      false);
  const offscreen = offscreenNodes(nodes, presence);
  const viewport = outsideViewport(nodes);
  const keyboardIndex = nodes.findIndex(
    (n) => n.type === 'Keyboard' && !!n.rect && n.rect.width > 0 && n.rect.height > 0,
  );
  const keyboardFrame = keyboardIndex >= 0 ? nodes[keyboardIndex].rect : undefined;
  const keylessKeyboard = keyboardIndex >= 0 && !nodes.some((n) => n.parentIndex === keyboardIndex);
  const windowOf = (index: number): number | undefined => {
    for (
      let p = nodes[index].parentIndex;
      p !== undefined && p >= 0 && p < index;
      p = nodes[p].parentIndex
    )
      if (nodes[p].type === 'Window') return p;
    return undefined;
  };
  const keyboardWindow = keyboardIndex >= 0 ? windowOf(keyboardIndex) : undefined;
  const ownWindow =
    keyboardWindow !== undefined && nodes.findIndex((n) => n.type === 'Window') !== keyboardWindow;
  const screenRect = nodes[0]?.type === 'Application' ? nodes[0].rect : undefined;
  // A docked full-width keyboard paints its chrome below the frame XCUI reports, to the screen bottom.
  const keyboardBottom =
    keyboardFrame && screenRect && keyboardFrame.width >= screenRect.width
      ? Math.max(keyboardFrame.y + keyboardFrame.height, screenRect.y + screenRect.height)
      : keyboardFrame && keyboardFrame.y + keyboardFrame.height;
  const underKeyboard = (n: NativeNode, i: number): boolean => {
    if (!keyboardFrame || keyboardBottom === undefined || !n.rect) return false;
    if (ownWindow && windowOf(i) === keyboardWindow) return false;
    if (n.type === 'Keyboard') return false;
    for (let p = n.parentIndex; p !== undefined && p >= 0 && p < i; p = nodes[p].parentIndex)
      if (nodes[p].type === 'Keyboard') return false;
    const x = n.rect.x + n.rect.width / 2;
    const y = n.rect.y + n.rect.height / 2;
    return (
      x >= keyboardFrame.x &&
      x < keyboardFrame.x + keyboardFrame.width &&
      y >= keyboardFrame.y &&
      y < keyboardBottom
    );
  };
  // Android reports a node the keyboard covers as not visible to the user; it is covered, not scrolled out.
  const keyboardHidden = (n: NativeNode, i: number): boolean =>
    n.visibleToUser === false &&
    !!n.rect &&
    n.rect.width > 0 &&
    n.rect.height > 0 &&
    underKeyboard(n, i);
  const contradicted = frameContradictions(nodes);
  const chrome = scrollChromeNodes(nodes, presence);
  const associationDiagnostics = new Map<number, HostAssociationDiagnostic>();
  const firstMissingAncestors = new Map<number, number>();
  const associations = associateHosts(
    nodes,
    reactHostEvidence,
    presence,
    associationDiagnostics,
    firstMissingAncestors,
  );
  const associatedHosts = new Map(
    [...associations].map(([hostIndex, { nativeIndex }]) => [
      nativeIndex,
      reactHostEvidence!.hosts[hostIndex],
    ]),
  );
  // React heading evidence wins over a navigation title on the same node.
  const headings = new Map<number, HeadingEvidence>([
    ...navigationTitles(nodes, presence),
    ...associateHeadings(nodes, reactHostEvidence, presence, associations),
  ]);
  const interactiveRole = (role: string | null | undefined) =>
    !!role && ['button', 'input', 'switch', 'link'].includes(kindOfRole(role));
  const inputRole = (role: string | null | undefined) => !!role && kindOfRole(role) === 'input';
  // Native type may rule out an operation only while every React host offering it is accounted for.
  const unassociated = (offers: (host: ReactHostObservation) => boolean) =>
    reactHostEvidence?.hosts.flatMap((host, hostIndex) =>
      !host.hidden && offers(host) && !associations.has(hostIndex) ? [hostIndex] : [],
    ) ?? [];
  const evidenceGap = (count: number) =>
    reactHostEvidence === undefined
      ? 'React host evidence missing'
      : !reactHostEvidence.complete
        ? 'React host evidence incomplete'
        : count > 0
          ? `${count} interactive React host${count === 1 ? '' : 's'} unassociated`
          : undefined;
  // A host without a testID that is interactive only by role offers no React handler to press.
  const pressGaps = new Set(
    unassociated(
      (host) => host.capabilities.press === true || (interactiveRole(host.role) && !!host.testID),
    ),
  );
  const fillGaps = new Set(
    unassociated((host) => host.capabilities.fill === true || inputRole(host.role)),
  );
  const gapCounts = { pressGapCount: pressGaps.size, fillGapCount: fillGaps.size };
  const pressEvidenceGap = evidenceGap(gapCounts.pressGapCount);
  const fillEvidenceGap = evidenceGap(gapCounts.fillGapCount);
  let gapHosts: GapHostDiagnostics | undefined;
  try {
    const ordinals = [...new Set([...pressGaps, ...fillGaps])].sort((a, b) => a - b);
    if (ordinals.length)
      gapHosts = {
        total: ordinals.length,
        truncated: ordinals.length > 8,
        rows: ordinals.slice(0, 8).map((hostOrdinal) => {
          const host = reactHostEvidence!.hosts[hostOrdinal];
          const measured = reactHostEvidence!.typography?.nodes[hostOrdinal];
          const rect = measured?.rect;
          const validRect =
            rect &&
            [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
            rect.width >= 0 &&
            rect.height >= 0;
          return {
            hostOrdinal,
            hostKind: diagnosticHostKind(measured?.hostType),
            capabilities: {
              press: host.capabilities.press === true,
              fill: host.capabilities.fill === true,
            },
            roleCategory:
              host.role === null
                ? 'none'
                : inputRole(host.role)
                  ? 'input'
                  : interactiveRole(host.role)
                    ? 'interactive'
                    : 'noninteractive',
            testIDPresent: typeof host.testID === 'string' && host.testID.length > 0,
            nativeIDPresent: typeof host.nativeID === 'string' && host.nativeID.length > 0,
            hidden: host.hidden === true,
            rectStatus: !validRect
              ? 'unknown'
              : rect.width > 0 && rect.height > 0
                ? 'positive'
                : 'zero',
            pressGap: pressGaps.has(hostOrdinal),
            fillGap: fillGaps.has(hostOrdinal),
            association: legacyAssociation(associationDiagnostics.get(hostOrdinal)),
          };
        }),
      };
  } catch {
    // Diagnostic dependencies cannot change host accounting.
  }
  const pressGap = pressEvidenceGap
    ? projectPressGap({
        category:
          reactHostEvidence === undefined
            ? 'missing-host-evidence'
            : !reactHostEvidence.complete
              ? 'incomplete-host-evidence'
              : 'unassociated-hosts',
        hostEvidencePresent: reactHostEvidence !== undefined,
        hostEvidenceComplete: reactHostEvidence?.complete === true,
        typographyComplete: reactHostEvidence?.typography?.complete === true,
        nativePresenceAvailable: presence !== undefined,
        pressGapCount: gapCounts.pressGapCount,
        ...(reactHostEvidence?.complete && gapHosts
          ? {
              gapHosts,
              ancestry: summarizeAncestry(
                gapHosts.rows,
                firstMissingAncestors,
                associationDiagnostics,
                reactHostEvidence.hosts.length,
              ),
            }
          : {}),
      })
    : undefined;
  const diagnosticFacts = {
    ...gapCounts,
    ...(gapHosts ? { gapHosts } : {}),
    ...(pressGap ? { pressGap } : {}),
  };
  let width = 0;
  let height = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    width = Math.max(width, n.rect.x + n.rect.width);
    height = Math.max(height, n.rect.y + n.rect.height);
  }
  const used = new Set<number>();
  // Unnamed role-only entries and custom wrappers do not count as independent controls.
  let semanticUnassociatedReact = digest.filter(
    (d) => !d.hidden && !((d.handlerless || d.compositeWrapper) && !d.testID),
  ).length;
  const elements: Element[] = nodes.map((n, nodeIndex) => {
    const observed = nativePresence === 'unknown' ? undefined : nativePresence?.nodes[nodeIndex];
    const testID = nonEmpty(n.identifier);
    const label = nonEmpty(n.label);
    let match: DigestEntry | undefined;
    for (let i = 0; !duplicates.has(nodeIndex) && i < digest.length; i += 1) {
      if (used.has(i) || digest[i].hidden) continue;
      const d = digest[i];
      if (kindOf(n.type) === 'input' && d.compositeWrapper) continue;
      const byId = testID !== undefined && d.testID === testID;
      const byLabel =
        !byId &&
        label !== undefined &&
        d.testID === undefined &&
        norm(d.text ?? d.label) === norm(label);
      if (byId || byLabel) {
        used.add(i);
        match = d;
        break;
      }
    }
    let kind = kindOf(n.type);
    const nativeKind = kind;
    const nodeValue = nativeValue(n);
    const host = associatedHosts.get(nodeIndex);
    // Over-associated on purpose: any React hint of interactivity keeps press unknown.
    const reactCandidates = digest.filter(
      (d) =>
        !d.hidden &&
        ((testID !== undefined && d.testID === testID) ||
          (d.testID === undefined &&
            label !== undefined &&
            norm(d.text ?? d.label) === norm(label))),
    );
    const hints = {
      press:
        host?.capabilities.press === true ||
        interactiveRole(host?.role) ||
        reactCandidates.some(
          (d) =>
            d.capabilities?.press === true ||
            (interactiveRole(d.role) && !(d.handlerless && !d.testID)),
        ),
      fill:
        host?.capabilities.fill === true ||
        inputRole(host?.role) ||
        reactCandidates.some((d) => d.capabilities?.fill === true || inputRole(d.role)),
    };
    const capabilities = nativeCapabilities(kind, n.type, {
      press: pressEvidenceGap !== undefined || hints.press,
      fill: fillEvidenceGap !== undefined || hints.fill,
    });
    const local = nativeCapabilities(kind, n.type, hints);
    if (host?.capabilities.press === true) capabilities.press = 'supported';
    if (host?.capabilities.fill === true) capabilities.fill = 'supported';
    const uniqueIdentity =
      testID !== undefined &&
      n.identifier === testID &&
      nativeIds.get(testID) === 1 &&
      reactIds.get(testID) === 1;
    const uniqueMatch = uniqueIdentity && match?.testID === testID;
    if (uniqueMatch || (uniqueIdentity && host?.testID === testID)) semanticUnassociatedReact -= 1;
    if (uniqueMatch) {
      if (!presenceMode && match?.capabilities?.press === true) capabilities.press = 'supported';
      if (!presenceMode && match?.capabilities?.fill === true) capabilities.fill = 'supported';
    }
    if (!presenceMode && kind === 'other' && match) kind = kindOfRole(match.role);
    const element: Element = {
      ref: n.ref,
      kind,
      nativeKind,
      // Android's hittable is enabled and visible-to-user; the keyboard explains a covered node's invisibility.
      hittable: n.hittable === true || (keyboardHidden(n, nodeIndex) && n.enabled !== false),
      disabled: n.enabled === false || match?.disabled === true,
      ...(n.selected === true ? { selected: true as const } : {}),
      secure: n.secure === true || n.type === 'SecureTextField',
      offscreen:
        viewport.has(nodeIndex) || (n.visibleToUser === false && !keyboardHidden(n, nodeIndex)),
      visibilityEvidence:
        n.visibleToUser === false && !keyboardHidden(n, nodeIndex)
          ? 'offscreen'
          : contradicted.has(nodeIndex)
            ? 'unresolved'
            : viewport.has(nodeIndex)
              ? 'offscreen'
              : 'visible',
      semantic: {
        ...capabilities,
        ...(headings.has(nodeIndex) ? { heading: headings.get(nodeIndex)! } : {}),
        visibility:
          observed?.status === 'observed'
            ? 'visible'
            : offscreen.has(nodeIndex)
              ? 'offscreen'
              : 'unknown',
        disabled:
          n.enabled === false ||
          host?.disabled === true ||
          host?.readOnly === true ||
          (!presenceMode && uniqueMatch && match?.disabled === true),
        ...(observed
          ? {
              nativePresence: {
                kind: nativeKind,
                labelSource: observed.labelSource,
                structural:
                  n.type === 'Application' || n.type === 'Window' || chrome.has(nodeIndex),
              },
            }
          : {}),
      },
    };
    if (label) element.label = label;
    if (testID) element.testID = testID;
    const privateNativeLabel = presenceMode && observed?.labelSource !== 'direct';
    // Privacy may over-associate input observations without granting semantic capabilities.
    const possibleDigestInput = reactCandidates.some(
      (d) => kindOfRole(d.role) === 'input' || d.capabilities?.fill === true,
    );
    if (
      nativeKind === 'input' ||
      (nativeKind === 'other' && !!nodeValue) ||
      kind === 'input' ||
      element.secure ||
      possibleDigestInput ||
      hasPositiveHostFill(testID)
    )
      captureInputPrivacy(element, {
        checkSubject:
          nativeKind === 'input' ||
          host?.capabilities.fill === true ||
          (!presenceMode && uniqueMatch && match?.capabilities?.fill === true)
            ? 'supported'
            : nativeKind === 'text' &&
                n.value === undefined &&
                !hasPositiveHostFill(testID) &&
                !uniqueMatch
              ? 'unsupported'
              : 'unknown',
        values: [
          nodeValue,
          digestValue(match?.value),
          ...reactCandidates.map((d) => digestValue(d.value)),
          ...(privateNativeLabel ? [label] : []),
        ].filter((value): value is string => !!value),
        nativeLabelMayBeValue:
          privateNativeLabel ||
          ANDROID_KINDS.some(([suffix, kind]) => kind === 'input' && n.type?.endsWith(suffix)),
      });
    // Secure values stay in private boundary data, never in the public value property.
    const value = element.secure ? undefined : (digestValue(match?.value) ?? nodeValue);
    if (value !== undefined) element.value = value;
    const placeholder = nonEmpty(match?.placeholder);
    if (placeholder) element.placeholder = placeholder;
    if (n.rect) {
      element.where = thirds(n.rect.y + n.rect.height / 2, height, [
        'top',
        'middle',
        'bottom',
      ]) as Element['where'];
      element.side = thirds(n.rect.x + n.rect.width / 2, width, [
        'left',
        'center',
        'right',
      ]) as Element['side'];
    }
    joinedDiagnosticFacts.set(element, {
      ...diagnosticFacts,
      nativeStatus: observed?.status,
      nativeUnknownReason: observed?.status === 'unknown' ? observed.unknownReason : undefined,
    });
    try {
      const matchingHosts =
        reactHostEvidence?.hosts.flatMap((host, index) =>
          host.testID && host.testID === n.identifier ? [index] : [],
        ) ?? [];
      if (matchingHosts.length === 1) {
        const identity = associationDiagnostics.get(matchingHosts[0])?.identity;
        if (identity) hostAssociationIdentities.set(element, identity);
      }
    } catch {
      // Diagnostics cannot change host association.
    }
    localCapabilities.set(element, local);
    return element;
  });
  digest.forEach((d, i) => {
    if (used.has(i) || !d.testID || d.hidden) return;
    if (
      nativeIds.get(d.testID) === 1 &&
      reactIds.get(d.testID) === 1 &&
      [...associatedHosts.values()].some((host) => host.testID === d.testID)
    )
      return;
    const element: Element = {
      ref: `react:${d.testID}`,
      kind: kindOfRole(d.role),
      testID: d.testID,
      hittable: false,
      disabled: d.disabled === true,
      secure: false,
      offscreen: true,
      semantic: {
        press: !presenceMode && d.capabilities?.press === true ? 'supported' : 'unknown',
        fill: !presenceMode && d.capabilities?.fill === true ? 'supported' : 'unknown',
        visibility: 'unknown',
        disabled: !presenceMode && d.disabled === true,
      },
    };
    // Screen text comes only from the native tree, so a React-only element shows no user-visible string;
    // its value still joins the mask set, which can only reduce what is written.
    const value = digestValue(d.value);
    if (element.kind === 'input' || d.capabilities?.fill === true || hasPositiveHostFill(d.testID))
      captureInputPrivacy(element, {
        checkSubject: 'unknown',
        values: value ? [value] : [],
        nativeLabelMayBeValue: false,
      });
    const inputHosts = d.inputHostIndices?.map((index) => reactHostEvidence?.hosts[index]);
    const provenHost =
      reactHostEvidence?.complete === true &&
      inputHosts?.length === 1 &&
      inputHosts[0]?.capabilities.fill === true &&
      inputHosts[0].testID === d.testID;
    // Either the composite ancestor of its input host, or that host's own entry left over after
    // the native input joined a composite ancestor proven to contain the same host.
    const hostOfJoinedAncestor =
      provenHost &&
      !d.compositeWrapper &&
      digest.some(
        (other, j) =>
          used.has(j) &&
          other.testID === d.testID &&
          other.inputHostIndices?.length === 1 &&
          other.inputHostIndices[0] === d.inputHostIndices![0],
      );
    if (provenHost) reactInputHosts.set(element, d.inputHostIndices![0]);
    if (provenHost && (d.compositeWrapper || hostOfJoinedAncestor))
      forwardedInputs.set(element, d.testID);
    const typography = reactHostEvidence?.typography;
    if (provenHost && typography?.complete && element.kind === 'input' && !d.compositeWrapper) {
      const path = hostPath(typography, d.inputHostIndices![0]);
      const ancestors: Element[] = [];
      for (const parent of path?.slice(1) ?? []) {
        const host = reactHostEvidence!.hosts[parent];
        const ids = [host.testID, host.nativeID].filter((id): id is string => !!id);
        if (
          reactHostEvidence!.hosts.filter((h) =>
            ids.some((id) => h.testID === id || h.nativeID === id),
          ).length !== 1
        )
          continue;
        const native = elements.filter(
          (e) => !e.ref.startsWith('react:') && e.testID !== undefined && ids.includes(e.testID),
        );
        if (native.length !== 1) continue;
        ancestors.push(native[0]);
        const inputs = reactHostEvidence!.hosts.filter(
          (h, index) =>
            h.capabilities.fill && hostPath(typography, index)?.slice(1).includes(parent),
        );
        if (
          inputs.length === 1 &&
          native[0].nativeKind !== 'input' &&
          native[0].label !== undefined &&
          [d.testID, d.text, d.label, d.placeholder].includes(native[0].label)
        )
          forwardedInputs.set(native[0], d.testID);
      }
      if (ancestors.length) nativeAncestors.set(element, ancestors);
    }
    joinedDiagnosticFacts.set(element, diagnosticFacts);
    elements.push(element);
  });

  const ordered = nodes
    .map((n, i) => ({ n, i, e: elements[i] }))
    .sort((a, b) => {
      const ay = a.n.rect?.y ?? Number.MAX_SAFE_INTEGER;
      const by = b.n.rect?.y ?? Number.MAX_SAFE_INTEGER;
      if (ay !== by) return ay - by;
      const ax = a.n.rect?.x ?? 0;
      const bx = b.n.rect?.x ?? 0;
      return ax !== bx ? ax - bx : a.i - b.i;
    });
  const voiced = new Set<number>();
  nodes.forEach((n, i) => {
    const e = elements[i];
    if (duplicates.has(i) || !e.label || e.kind === 'other' || e.kind === 'image') return;
    for (let p = n.parentIndex; p !== undefined && p >= 0 && p < i; p = nodes[p].parentIndex)
      voiced.add(p);
  });
  // Label-only hittable rows supply literal evidence without accessibility text descendants.
  const mergedLabel = (n: NativeNode, e: Element, i: number) =>
    n.type === 'Other' &&
    n.hittable === true &&
    !!e.label &&
    !voiced.has(i) &&
    !SYSTEM_SCROLL_BAR_LABEL.test(e.label);
  // Structural and image labels stay excluded; merged labels use their own evidence channel.
  const visibleText: string[] = [];
  const paintedText: string[] = [];
  const labelText: string[] = [];
  const unresolvedText: string[] = [];
  const paintedKeys = new Map<number, string>();
  const uncoveredText: string[] = [];
  const uncoveredLabelText: string[] = [];
  for (const { n, e, i } of ordered) {
    if (n.rect && !(n.rect.width > 0 && n.rect.height > 0)) continue;
    if (duplicates.has(i) || e.kind === 'image' || e.visibilityEvidence === 'offscreen') continue;
    // A React role can re-kind a label-only native row; its label still came from accessibility.
    const merged = e.kind !== 'input' && mergedLabel(n, e, i);
    if (e.kind === 'other' && !merged) continue;
    const line =
      e.kind === 'input'
        ? e.value !== undefined
          ? `${e.label ?? e.placeholder ?? e.testID ?? 'input'}: ${e.value}`
          : e.label
        : e.label;
    if (!line) continue;
    if (e.visibilityEvidence === 'unresolved') {
      unresolvedText.push(line);
      continue;
    }
    if (merged) {
      labelText.push(line);
      if (!underKeyboard(n, i)) uncoveredLabelText.push(line);
      continue;
    }
    const key = JSON.stringify([
      line,
      n.type,
      n.identifier ?? '',
      n.rect ? [n.rect.x, n.rect.y, n.rect.width, n.rect.height] : null,
    ]);
    let echo = false;
    for (let p = n.parentIndex; p !== undefined && p >= 0 && p < i; p = nodes[p].parentIndex) {
      if (paintedKeys.get(p) === key) {
        echo = true;
        break;
      }
    }
    paintedKeys.set(i, key);
    if (!echo) {
      paintedText.push(line);
      if (!underKeyboard(n, i)) uncoveredText.push(line);
    }
    if (visibleText[visibleText.length - 1] !== line) visibleText.push(line);
  }
  const textDescendants = new Map<number, number[]>();
  nodes.forEach((n, i) => {
    if (n.rect) elementFrames.set(elements[i], n.rect);
    if (underKeyboard(n, i)) keyboardCoveredElements.add(elements[i]);
    const ancestors: Element[] = [];
    for (let p = n.parentIndex; p !== undefined && p >= 0 && p < i; p = nodes[p].parentIndex)
      ancestors.push(elements[p]);
    if (ancestors.length) nativeAncestors.set(elements[i], ancestors);
    const bounds = clippingViewport(viewport, i);
    if (bounds) elementViewports.set(elements[i], bounds);
    if (duplicates.has(i) || elements[i].kind !== 'text') return;
    for (let p = n.parentIndex; p !== undefined && p >= 0 && p < i; p = nodes[p].parentIndex)
      textDescendants.set(p, [...(textDescendants.get(p) ?? []), i]);
  });
  textDescendants.forEach(([only, ...more], p) => {
    const control = elements[p];
    if (
      !more.length &&
      control.label !== undefined &&
      control.kind !== 'text' &&
      control.kind !== 'input' &&
      elements[only].label === control.label
    ) {
      soleLabelTexts.set(control, elements[only]);
      labelAncestors.set(elements[only], [...labelAncestorsOf(elements[only]), control]);
    }
  });
  return {
    elements: elements.filter((_, i) => !duplicates.has(i)),
    visibleText,
    ...(keyboardFrame ? { keyboardFrame, uncoveredText, uncoveredLabelText } : {}),
    ...(keylessKeyboard ? { keylessKeyboard: true as const } : {}),
    paintedText,
    ...(labelText.length ? { labelText } : {}),
    ...(unresolvedText.length ? { unresolvedText } : {}),
    front,
    semanticUnassociatedReact,
    ...(coverage ? { coverage } : {}),
    ...(reactHostEvidence ? { reactHostEvidence } : {}),
    ...(pressEvidenceGap ? { pressEvidenceGap } : {}),
  };
}

export function isNativeInput(element: Element): boolean {
  return !element.ref.startsWith('react:') && element.nativeKind === 'input';
}

export function actionView(screen: Pick<Screen, 'elements'>): Element[] {
  return screen.elements.filter((e) => !e.disabled && (e.offscreen || e.hittable));
}

export function assertionView(screen: Screen): string[] {
  return screen.visibleText;
}

export interface VisibilityBlockerDiagnostic {
  ordinal: number;
  kind: Kind | 'unknown';
  nativePresence: boolean;
  nativeStatus: NativePresenceNode['status'] | 'missing';
  nativeUnknownReason?: NativePresenceNode['unknownReason'];
  visibility: Visibility;
  press: EvidenceStatus;
  fill: EvidenceStatus;
  labelSource: NativePresenceNode['labelSource'] | 'missing' | 'unknown';
  structural: boolean;
  fields: Record<
    'label' | 'value' | 'placeholder' | 'identifier',
    { defined: boolean; nonempty: boolean }
  >;
  semanticUnassociatedReact?: number;
  pressGapCount?: number;
  fillGapCount?: number;
  gapHosts?: GapHostDiagnostics;
}

type Projection =
  | { elements: Element[] }
  | { refuse: string; reason: string; diagnostic?: VisibilityBlockerDiagnostic };

function visibilityBlocker(
  screen: Screen,
  element: Element,
  ordinal: number,
): VisibilityBlockerDiagnostic {
  const semantic = element.semantic!;
  const native = semantic.nativePresence;
  const facts = joinedDiagnosticFacts.get(element);
  const unknownReason = NATIVE_PRESENCE_UNKNOWN_REASONS.find(
    (reason) => reason === facts?.nativeUnknownReason,
  );
  const member = <T extends string>(value: unknown, allowed: readonly T[]): T | 'unknown' =>
    allowed.find((item) => item === value) ?? 'unknown';
  const count = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const field = (value: unknown) => ({
    defined: value !== undefined,
    nonempty: typeof value === 'string' && value.trim().length > 0,
  });
  return {
    ordinal,
    kind: member(element.kind, [
      'button',
      'input',
      'switch',
      'link',
      'cell',
      'text',
      'image',
      'other',
    ]),
    nativePresence: native !== undefined,
    nativeStatus: member(facts?.nativeStatus ?? 'missing', ['observed', 'unknown', 'missing']),
    ...(unknownReason ? { nativeUnknownReason: unknownReason } : {}),
    visibility: member(semantic.visibility, ['visible', 'offscreen', 'hidden', 'unknown']),
    press: member(semantic.press, ['supported', 'unsupported', 'unknown']),
    fill: member(semantic.fill, ['supported', 'unsupported', 'unknown']),
    labelSource: member(native?.labelSource ?? 'missing', [
      'direct',
      'value',
      'descendant',
      'none',
      'missing',
    ]),
    structural: native?.structural === true,
    fields: {
      label: field(element.label),
      value: field(element.value),
      placeholder: field(element.placeholder),
      identifier: field(element.testID),
    },
    semanticUnassociatedReact: count(screen.semanticUnassociatedReact ?? 0),
    ...(facts
      ? {
          pressGapCount: count(facts.pressGapCount),
          fillGapCount: count(facts.fillGapCount),
          ...(facts.gapHosts ? { gapHosts: facts.gapHosts } : {}),
        }
      : {}),
  };
}

function incomplete(reason: string): { refuse: string; reason: string } {
  return { refuse: 'SCREEN_EVIDENCE_INCOMPLETE', reason };
}

function projectionRefusal(screen: Screen): { refuse: string; reason: string } | undefined {
  if (new Set(screen.elements.map((e) => e.ref)).size !== screen.elements.length)
    return { refuse: 'AMBIGUOUS_REFS', reason: 'screen references are not unique' };
  if (screen.coverage?.native !== 'complete' || screen.coverage.react !== 'complete') {
    const sides = (c?: Screen['coverage']) =>
      c ? `native=${c.native} react=${c.react}` : 'missing';
    const causes = screen.nativeCaptureCauses?.length
      ? `; native capture: ${screen.nativeCaptureCauses.join(', ')}`
      : '';
    return incomplete(
      `semantic projection requires complete native and React coverage (capture ${sides(screen.captureCoverage)}; projected ${sides(screen.coverage)}${causes})`,
    );
  }
  return undefined;
}

export function semanticDisabled(element: Element): boolean {
  return element.semantic?.disabled ?? element.disabled;
}

export function semanticActionView(screen: Screen, kind: 'press' | 'fill'): Projection {
  const refusal = projectionRefusal(screen);
  if (refusal) return refusal;
  if ((screen.semanticUnassociatedReact ?? 0) > 0)
    return incomplete('React observations lack a proven unique native association');
  const elements: Element[] = [];
  for (const e of screen.elements) {
    if (e.semantic?.nativePresence?.structural) continue;
    if (semanticDisabled(e)) continue;
    if (!e.semantic) return incomplete('an observation has no semantic facts');
    if (e.semantic.visibility === 'hidden' || e.semantic[kind] === 'unsupported') continue;
    if (e.semantic[kind] !== 'supported')
      return incomplete(
        `an observation has unknown ${kind} capability (${e.ref}, ${e.kind}${kind === 'press' && screen.pressEvidenceGap ? `; ${screen.pressEvidenceGap}` : ''})`,
      );
    if (e.semantic.nativePresence && e.semantic.visibility === 'unknown')
      return incomplete('a native control lacks positive platform presence');
    if (e.semantic.visibility !== 'offscreen' && !e.hittable)
      return incomplete('a supported control has neither a hit hint nor offscreen evidence');
    elements.push(e);
  }
  return { elements };
}

export interface AssertionEvidence {
  elements: Element[];
  unknown: Array<{ element: Element; reason: 'visibility' | 'name-provenance' | 'content' }>;
  unassociatedReact: number;
  // Plain containers left out only because their own evidence rules out press and fill despite a screen-wide gap.
  capabilityGapContainers?: number;
  diagnostic?: VisibilityBlockerDiagnostic;
}

export function visibilityView(
  screen: Screen,
  diagnostics = false,
): AssertionEvidence | { refuse: string; reason: string } {
  const refusal = projectionRefusal(screen);
  if (refusal) return refusal;
  const elements: Element[] = [];
  const unknown: AssertionEvidence['unknown'] = [];
  let capabilityGapContainers = 0;
  let gapContainer: Element | undefined;
  for (const e of screen.elements) {
    if (!e.semantic) return incomplete('an observation has no semantic facts');
    const native = e.semantic.nativePresence;
    if (native?.structural) continue;
    if (e.semantic.visibility === 'hidden' || e.semantic.visibility === 'offscreen') continue;
    // A plain container offering no operation names nothing its own descendants don't name themselves.
    const ruledOut = (capability: 'press' | 'fill') =>
      e.semantic![capability] === 'unsupported' ||
      (e.semantic![capability] !== 'supported' &&
        localCapabilities.get(e)?.[capability] === 'unsupported');
    if (
      native?.kind === 'other' &&
      (native.labelSource === 'none' || native.labelSource === 'descendant') &&
      e.value === undefined &&
      e.placeholder === undefined &&
      ruledOut('press') &&
      ruledOut('fill')
    ) {
      if (e.semantic.press !== 'unsupported' || e.semantic.fill !== 'unsupported') {
        capabilityGapContainers++;
        if (!unknown.length) gapContainer ??= e;
      }
      continue;
    }
    const control =
      ['button', 'input', 'switch', 'link', 'cell'].includes(native?.kind ?? e.kind) ||
      e.semantic.press === 'supported' ||
      e.semantic.fill === 'supported';
    const content = [e.label, e.value, e.placeholder].some(
      (value) => nonEmpty(value) !== undefined,
    );
    if (
      !control &&
      !content &&
      !nonEmpty(e.testID) &&
      e.semantic.press === 'unsupported' &&
      e.semantic.fill === 'unsupported'
    )
      continue;
    if (e.semantic.visibility !== 'visible') {
      unknown.push({ element: e, reason: 'visibility' });
      continue;
    }
    if (native && native.labelSource !== 'direct' && native.labelSource !== 'none') {
      unknown.push({ element: e, reason: 'name-provenance' });
      continue;
    }
    const kind = native?.kind ?? e.kind;
    if (!control && !((kind === 'text' || kind === 'input') && content)) {
      unknown.push({ element: e, reason: 'content' });
      continue;
    }
    elements.push(e);
  }
  const evidence: AssertionEvidence = {
    elements,
    unknown,
    unassociatedReact: screen.semanticUnassociatedReact ?? 0,
    ...(capabilityGapContainers ? { capabilityGapContainers } : {}),
  };
  const blocker = gapContainer ?? unknown[0]?.element;
  if (diagnostics && blocker) {
    try {
      evidence.diagnostic = visibilityBlocker(screen, blocker, screen.elements.indexOf(blocker));
    } catch {
      // Diagnostics cannot change assertion admission.
    }
  }
  return evidence;
}

export function describe(e: Element): string {
  const parts = [e.kind.charAt(0).toUpperCase() + e.kind.slice(1)];
  if (e.label) parts.push(`"${e.label}"`);
  if (e.testID) parts.push(`[testID ${e.testID}]`);
  if (e.placeholder) parts.push(`placeholder "${e.placeholder}"`);
  if (!e.secure && e.value !== undefined) parts.push(`value "${e.value}"`);
  if (e.offscreen) parts.push('off screen');
  else if (e.where && e.side) parts.push(e.side === 'center' ? e.where : `${e.where}-${e.side}`);
  if (e.disabled) parts.push('disabled');
  return parts.join(' ');
}

// Compare content and layout, excluding secure input text and snapshot refs.
export function screenSignature(screen: Screen): string {
  const secureLines = new Set(
    screen.elements
      .filter((e) => e.secure)
      .flatMap((e) => [
        e.label,
        `${e.label ?? e.placeholder ?? e.testID ?? 'input'}: ${e.value ?? ''}`,
      ]),
  );
  return JSON.stringify({
    front: screen.front,
    ...(screen.keylessKeyboard ? { keyboard: true } : {}),
    text: screen.visibleText.filter((text) => !secureLines.has(text)),
    elements: screen.elements
      .filter((e) => e.label !== undefined || e.testID !== undefined || e.value !== undefined)
      .map((e) => [
        e.kind,
        e.secure && nativeLabelMayBeValue(e) ? null : (e.label ?? null),
        e.testID ?? null,
        e.secure ? null : (e.value ?? null),
        e.hittable,
        e.disabled,
        e.selected === true,
        e.offscreen,
        e.where ?? null,
        e.side ?? null,
      ]),
  });
}

export function frontFromSurface(surface: string | undefined, nodes: NativeNode[]): Front {
  if (nodes[0]?.type === 'Alert') return 'dialog';
  switch (surface) {
    case 'expo_dev_menu':
    case 'react_native_dev_menu':
      return 'dev-menu';
    case 'dev_client_picker':
    case 'first_run_tutorial':
      return 'picker';
    default:
      return devFabWindow(nodes) ? 'dev-fab' : 'app';
  }
}

const DEV_FAB_MAX_PT = 96;
const NOT_DEV_FAB_CONTENT = new Set([
  'Keyboard',
  'Key',
  'TextField',
  'SecureTextField',
  'TextView',
  'SearchField',
]);

// Expo's floating dev-menu button: an extra Window whose only content is one small pill (value-free).
function devFabWindow(nodes: NativeNode[]): boolean {
  const windows = new Set(nodes.flatMap((node, i) => (node.type === 'Window' ? [i] : [])));
  if (windows.size < 2) return false;
  const content = new Map<number, { x0: number; y0: number; x1: number; y1: number } | null>();
  nodes.forEach((node) => {
    if (node.type === 'Window' || node.type === 'Other') return;
    let window = node.parentIndex;
    for (let hops = 0; window !== undefined && !windows.has(window) && hops < nodes.length; hops++)
      window = nodes[window]?.parentIndex;
    if (window === undefined || !windows.has(window) || content.get(window) === null) return;
    const r = node.rect;
    if (NOT_DEV_FAB_CONTENT.has(node.type ?? '') || !r) return void content.set(window, null);
    if (!(r.width > 0) || !(r.height > 0)) return;
    const box = content.get(window);
    content.set(window, {
      x0: Math.min(box?.x0 ?? r.x, r.x),
      y0: Math.min(box?.y0 ?? r.y, r.y),
      x1: Math.max(box?.x1 ?? r.x + r.width, r.x + r.width),
      y1: Math.max(box?.y1 ?? r.y + r.height, r.y + r.height),
    });
  });
  return [...content.values()].some(
    (box) => !!box && box.x1 - box.x0 <= DEV_FAB_MAX_PT && box.y1 - box.y0 <= DEV_FAB_MAX_PT,
  );
}
