import type { Target } from './plan.js';
import type { Screen } from './screen.js';
import { ObservedPrivacy, MASK, concealsScreen, isPossibleInput } from './privacy.js';
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
  const wanted = words(query.slice(0, MATCH_TEXT));
  const wantedWords = new Set(wanted);
  const wantedPhrase = ` ${wanted.join(' ')} `;
  const candidates: TargetMissDiagnostic['candidates'] = [];
  let exact = false;
  let inside = false;
  let scanIncomplete = screen.elements.length > SCAN_LIMIT || query.length > MATCH_TEXT;
  let truncated = scanIncomplete;
  const withheld = concealsScreen(screen);
  const display = (text: string) =>
    privacy
      .redact(text)
      .slice(0, MISS_TEXT)
      .replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
  for (const element of screen.elements.slice(0, SCAN_LIMIT)) {
    if (element.offscreen || element.visibilityEvidence === 'unresolved') continue;
    const label = element.label ?? '';
    const identifier = element.testID ?? '';
    if (label.length > MATCH_TEXT || identifier.length > MATCH_TEXT) {
      scanIncomplete = true;
      truncated = true;
    }
    const parts = words(label.slice(0, MATCH_TEXT));
    const contained =
      query.length <= MATCH_TEXT &&
      wanted.length > 0 &&
      parts.length > wanted.length &&
      ` ${parts.join(' ')} `.includes(wantedPhrase);
    const direct = label === query || identifier === query;
    exact ||= direct;
    inside ||= contained;
    const near = [...parts, ...words(identifier.slice(0, MATCH_TEXT))].some((word) =>
      wantedWords.has(word),
    );
    if (!direct && !contained && !near) continue;
    if (candidates.length >= MISS_CANDIDATES) {
      truncated = true;
      continue;
    }
    candidates.push({
      ...(identifier ? { identifier: display(identifier) } : {}),
      ...(label ? { label: withheld || isPossibleInput(element) ? MASK : display(label) } : {}),
      match: direct ? 'exact' : contained ? 'inside-label' : 'near',
      aggregated: contained || element.semantic?.nativePresence?.labelSource === 'descendant',
    });
  }
  const incomplete =
    (screen.captureCoverage?.native ?? screen.coverage?.native) !== 'complete' || scanIncomplete;
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
