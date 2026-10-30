import type { Target } from './plan.js';
import type { Element, Kind, Screen } from './screen.js';
import { ObservedPrivacy, MASK, isPossibleInput } from './privacy.js';
import { scrollUntilBand } from './resolve.js';
import { isRecord } from './questions.js';

export const MISS_REASONS = [
  'absent',
  'only-in-aggregated-label',
  'not-scrollable',
  'present-but-unavailable',
  'evidence-incomplete',
] as const;
export const MISS_MATCHES = ['exact', 'inside-label', 'near'] as const;
export const MISS_CANDIDATES = 20;
export const MISS_TEXT = 256;
const SCAN_LIMIT = 2000;
const MATCH_TEXT = 4096;

export interface TargetMissDiagnostic {
  kind: 'target-miss';
  line: number;
  reason: (typeof MISS_REASONS)[number];
  truncated: boolean;
  candidates: Array<{
    identifier?: string;
    label?: string;
    match: (typeof MISS_MATCHES)[number];
    aggregated: boolean;
  }>;
}

const words = (text: string): string[] =>
  text
    .normalize('NFC')
    .toLocaleLowerCase('en-US')
    .match(/[\p{L}\p{N}]+/gu) ?? [];

export function targetMissDiagnostic(
  target: Target,
  screen: Screen,
  line: number,
  scrolling: boolean,
  privacy: ObservedPrivacy,
): TargetMissDiagnostic {
  const query = target.quoted ?? target.phrase;
  const wantedWords = new Set(words(query.slice(0, MATCH_TEXT)));
  const candidates: TargetMissDiagnostic['candidates'] = [];
  let exact = false;
  let inside = false;
  let unresolved = false;
  let scanIncomplete = screen.elements.length > SCAN_LIMIT || query.length > MATCH_TEXT;
  let truncated = scanIncomplete;
  const withheld = privacy.textWithheld(screen) !== undefined;
  const display = (text: string) =>
    privacy
      .redact(text)
      .slice(0, MISS_TEXT)
      .replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  for (const element of screen.elements.slice(0, SCAN_LIMIT)) {
    if (element.offscreen && element.visibilityEvidence !== 'unresolved') continue;
    const label = element.label ?? '';
    const identifier = element.testID ?? '';
    if (label.length > MATCH_TEXT || identifier.length > MATCH_TEXT) {
      scanIncomplete = true;
      truncated = true;
    }
    const parts = target.exact === 'id' ? [] : words(label.slice(0, MATCH_TEXT));
    const contained =
      target.exact !== 'id' &&
      query.length > 0 &&
      query.length <= MATCH_TEXT &&
      label.length > query.length &&
      label.slice(0, MATCH_TEXT).includes(query);
    const direct =
      (target.exact !== 'id' && label === query) ||
      (target.exact !== 'text' && identifier === query);
    if (element.visibilityEvidence === 'unresolved') {
      unresolved ||= direct || contained;
      continue;
    }
    exact ||= direct;
    inside ||= contained;
    const near = [
      ...parts,
      ...(target.exact === 'text' ? [] : words(identifier.slice(0, MATCH_TEXT))),
    ].some((word) => wantedWords.has(word));
    if (!direct && !contained && !near) continue;
    if (candidates.length >= MISS_CANDIDATES) {
      truncated = true;
      continue;
    }
    candidates.push({
      ...(identifier ? { identifier: display(identifier) } : {}),
      ...(label ? { label: withheld || isPossibleInput(element) ? MASK : display(label) } : {}),
      match: direct ? 'exact' : contained ? 'inside-label' : 'near',
      aggregated:
        target.exact !== 'id' &&
        (contained || element.semantic?.nativePresence?.labelSource === 'descendant'),
    });
  }
  const incomplete =
    (screen.captureCoverage?.native ?? screen.coverage?.native) !== 'complete' ||
    scanIncomplete ||
    unresolved;
  return {
    kind: 'target-miss',
    line,
    truncated,
    candidates,
    reason:
      target.quoted === undefined
        ? 'evidence-incomplete'
        : exact
          ? 'present-but-unavailable'
          : incomplete
            ? 'evidence-incomplete'
            : inside
              ? 'only-in-aggregated-label'
              : scrolling && !scrollUntilBand(target, screen)
                ? 'not-scrollable'
                : 'absent',
  };
}

// The last observed screen's controls for a failed step's receipt: roles, states and protected names only.
export interface ScreenNow {
  ageMs: number;
  afterDispatch: boolean;
  front: Screen['front'];
  coverage: 'complete' | 'incomplete';
  controls: Array<{
    role: Kind;
    id?: string;
    label?: string;
    enabled: boolean;
    hittable: boolean;
    offscreen: boolean;
  }>;
  counts: { controls: number; enabled: number; hidden: number };
}

const CONTROL_KINDS: ReadonlySet<Kind> = new Set(['button', 'input', 'switch', 'link', 'cell']);
const SUGGESTED_IDS = 5;

const shown = (text: string): string =>
  text.slice(0, MISS_TEXT).replace(/[\uD800-\uDFFF]/gu, '\uFFFD');

const names = (target: Target, element: Element): boolean =>
  target.quoted !== undefined &&
  ((target.exact !== 'id' && element.label === target.quoted) ||
    (target.exact !== 'text' && element.testID === target.quoted));

export function screenNow(
  screen: Screen,
  target: Target,
  ageMs: number,
  afterDispatch: boolean,
  privacy: ObservedPrivacy,
): ScreenNow {
  const withheld = privacy.textWithheld(screen) !== undefined;
  const all = screen.elements
    .slice(0, SCAN_LIMIT)
    .filter((element) => CONTROL_KINDS.has(element.kind) && !element.ref.startsWith('react:'));
  // The target's own matches lead, so the cap never hides them; counts disclose what the cap left out.
  const ordered = [
    ...all.filter((e) => names(target, e)),
    ...all.filter((e) => !names(target, e) && !e.offscreen),
    ...all.filter((e) => !names(target, e) && e.offscreen),
  ];
  return {
    ageMs: Math.max(0, Math.round(ageMs)),
    afterDispatch,
    front: screen.front,
    coverage:
      (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete'
        ? 'complete'
        : 'incomplete',
    controls: ordered.slice(0, MISS_CANDIDATES).map((element) => ({
      role: element.kind,
      ...(element.testID ? { id: shown(privacy.redactIdentifier(element.testID)) } : {}),
      ...(element.label
        ? {
            label:
              withheld || isPossibleInput(element) ? MASK : shown(privacy.redact(element.label)),
          }
        : {}),
      enabled: !element.disabled,
      hittable: element.hittable,
      offscreen: element.offscreen,
    })),
    counts: {
      controls: all.length,
      enabled: all.filter((e) => !e.disabled).length,
      hidden: all.filter((e) => e.offscreen).length,
    },
  };
}

// One deterministic plan edit per miss reason; it states observations and names controls by identifier only.
export function missSuggestion(
  reason: TargetMissDiagnostic['reason'] | 'ambiguous',
  target: Target,
  screen: Screen,
  now: ScreenNow,
  line: number,
): string {
  const step = `line ${line}`;
  if (target.quoted === undefined)
    return `the target of ${step} is described rather than quoted; quote a label or testID listed in failure.screen`;
  switch (reason) {
    case 'ambiguous':
      return `the target of ${step} matched more than one control on the last observed screen; quote a testID only one control in failure.screen carries, or give the control a unique testID`;
    case 'present-but-unavailable': {
      const matches = screen.elements.filter((e) => !e.offscreen && names(target, e));
      const state = !matches.length
        ? undefined
        : matches.every((e) => e.disabled)
          ? 'disabled'
          : matches.every((e) => !e.hittable)
            ? 'not hittable'
            : undefined;
      return state === 'disabled'
        ? `on the last observation the target of ${step} was on screen and disabled; consider adding, before ${step}, the step that enables it`
        : state === 'not hittable'
          ? `on the last observation the target of ${step} was on screen and not hittable; consider adding, before ${step}, the step that uncovers it, or check the screen's orientation and frame if it is a rotated modal`
          : `on the last observation the target of ${step} was on screen but could not take this step; compare its role and state in failure.screen with the step`;
    }
    case 'absent': {
      const enabled = now.controls.filter((c) => c.enabled && !c.offscreen);
      const ids = enabled.flatMap((c) => (c.id && c.id !== MASK ? [JSON.stringify(c.id)] : []));
      const named = ids.length ? ` (ids: ${ids.slice(0, SUGGESTED_IDS).join(', ')})` : '';
      return `the target of ${step} was not on the last observed screen, which lists ${enabled.length} enabled controls${named}; consider reading that screen in source and inserting the missing step before ${step}`;
    }
    case 'only-in-aggregated-label':
      return `the target of ${step} is only part of a larger label; quote the container's testID instead`;
    case 'not-scrollable':
      return `no scrollable area that could reveal the target of ${step} was observed; consider scrolling a named container or inserting the step that reveals the target`;
    case 'evidence-incomplete':
      return 'the last capture was incomplete; one re-run is reasonable, then report';
  }
}

export function cleanTargetMiss(
  value: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !Number.isSafeInteger(value.line) ||
    (value.line as number) <= 0 ||
    !MISS_REASONS.includes(value.reason as TargetMissDiagnostic['reason']) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > MISS_CANDIDATES ||
    Object.keys(value).some(
      (key) => !['kind', 'line', 'reason', 'truncated', 'candidates'].includes(key),
    )
  )
    return;
  for (const candidate of value.candidates) {
    if (
      !isRecord(candidate) ||
      typeof candidate.aggregated !== 'boolean' ||
      !MISS_MATCHES.includes(candidate.match as (typeof MISS_MATCHES)[number]) ||
      Object.keys(candidate).some(
        (key) => !['identifier', 'label', 'match', 'aggregated'].includes(key),
      )
    )
      return;
    for (const key of ['identifier', 'label']) {
      if (
        candidate[key] !== undefined &&
        (typeof candidate[key] !== 'string' || (candidate[key] as string).length > MISS_TEXT)
      )
        return;
    }
  }
  return value;
}
