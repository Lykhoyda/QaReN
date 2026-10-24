import type { NativeNode, Screen } from './screen.js';
import { kindOf } from './screen.js';
import { capturePrivateScreen, isPossibleInput } from './privacy.js';

export class PrivateInputCaptureError extends Error {
  readonly code = 'PRIVATE_INPUT_CAPTURE_UNKNOWN' as const;

  constructor(detail?: string) {
    super(`Private input capture could not be established safely.${detail ? ` ${detail}` : ''}`);
    this.name = 'PrivateInputCaptureError';
  }
}

// Built only from a node count and fixed cause codes, so it carries no screen content.
const NATIVE_CAUSE =
  /^(unattested|truncated|ref-map-not-updated|node-count-mismatch|keyboard-state-unknown|snapshot-generation-unknown|dropped=\d{1,7}|verdict=(failed|degraded)|reason=(empty-capture|snapshot-ref-freshness-unknown|unrecognized)|presence-failure=(initial-eligibility|preparation|enumeration|observation|final-eligibility|revalidation|finalization):(deadline|read-unavailable|ineligible|node-limit|enumeration-changed)|presence-deadline=(initial-eligibility|preparation|enumeration|observation|final-eligibility|revalidation|finalization):(app-state|alerts|sheets|root-snapshot|preparation-poll|enumeration|observation-loop|observation|first-match|all-matches|candidate-snapshot|candidate-hit|post-hit-snapshot|revalidation|finalization):(before|after))$/;

export class NativeSnapshotIncomplete extends PrivateInputCaptureError {
  readonly nodes: number;
  readonly causes: readonly string[];

  constructor(nodes: number, causes: readonly string[]) {
    const count = Number.isSafeInteger(nodes) && nodes >= 0 ? nodes : 0;
    const known = causes.filter((cause) => typeof cause === 'string' && NATIVE_CAUSE.test(cause));
    super(`The native snapshot was incomplete (nodes=${count}; causes=${known.join(',')}).`);
    this.nodes = count;
    this.causes = known;
  }
}

const VERDICT_REASON =
  'no-renderer|renderer-error|root-enumeration-incomplete|renderers-unscanned|scan-budget-exhausted|output-truncated|unscanned-renderers|renderer-errors|dropped-subtrees|collapsed-child-lists|incomplete|unrecognized';
const REACT_CAUSE = new RegExp(
  `^(deadline|disconnected|reconnected|evaluate-error|completion-shape|tree-shape|tree-too-large|interactive-cap|truncated|host-evidence-incomplete|entry-shape|producer-deadline|producer-error|producer-refused|tree-changed|overlay-scan-cap|digest-prop-opaque|digest-visit-cap|typography-deadline|typography-incomplete|verdict-reasons:(${VERDICT_REASON})(,(${VERDICT_REASON}))*)$`,
);
const REACT_COUNTERS = [
  'scanned',
  'budget',
  'roots',
  'hosts',
  'interactive',
  'queued',
  'pruned',
  'ms',
] as const;
export type ReactCaptureCounters = Partial<Record<(typeof REACT_COUNTERS)[number], number>>;

export function isReactCaptureCause(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 256 && REACT_CAUSE.test(value);
}

function reactCounters(counters: Readonly<Record<string, unknown>>): ReactCaptureCounters {
  const known: ReactCaptureCounters = {};
  for (const key of REACT_COUNTERS) {
    const count = counters[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0) known[key] = count;
  }
  return known;
}

function reactDetail(reason: string, counters: ReactCaptureCounters): string {
  const parts = [`cause=${reason}`];
  if (counters.scanned !== undefined)
    parts.push(
      `scanned=${counters.scanned}${counters.budget === undefined ? '' : `/${counters.budget}`}`,
    );
  for (const key of ['roots', 'hosts', 'interactive', 'queued', 'pruned', 'ms'] as const)
    if (counters[key] !== undefined) parts.push(`${key}=${counters[key]}`);
  return parts.join('; ');
}

// Built only from a fixed cause code and integer counters, so it carries no screen content.
export class ReactCaptureIncomplete extends PrivateInputCaptureError {
  readonly reason: string;
  readonly counters: ReactCaptureCounters;
  readonly detail: string;

  constructor(reason: string, counters: Readonly<Record<string, unknown>> = {}) {
    const known = isReactCaptureCause(reason) ? reason : 'completion-shape';
    const counted = reactCounters(counters);
    const detail = reactDetail(known, counted);
    super(`The React capture was incomplete (${detail}).`);
    this.reason = known;
    this.counters = counted;
    this.detail = detail;
  }
}

// The native snapshot is the privacy boundary: every readable input or secure value it shows is private.
export function applyNativePrivateInputs(screen: Screen, nodes: readonly NativeNode[]): Screen {
  const byRef = new Map(nodes.map((node) => [node.ref, node]));
  capturePrivateScreen(
    screen,
    screen.elements
      .filter(
        (element) =>
          isPossibleInput(element) ||
          element.secure ||
          (kindOf(byRef.get(element.ref)?.type) === 'other' &&
            !['Application', 'Window'].includes(byRef.get(element.ref)?.type ?? '')),
      )
      .map((element) => ({
        values: element.value ? [element.value] : [],
        secure: element.secure,
        labelMayBeValue:
          element.secure || element.semantic?.nativePresence?.labelSource === 'value',
        testID: element.testID,
        elements: [element],
        associationUnique: true,
      })),
  );
  return screen;
}
