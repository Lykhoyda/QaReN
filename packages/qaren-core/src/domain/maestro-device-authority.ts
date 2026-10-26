import type { MaestroRunner } from '../handlers/maestro-dispatch.js';

export interface MaestroDeviceAuthority {
  requestedDeviceId: string | null;
  reportedDeviceId: string | null;
  observedDeviceIds: string[];
  wdaDeviceIds: string[];
  verified: boolean;
  source: 'maestro-runner-log' | 'maestro-cli-explicit-udid' | 'none';
  /** Corroborating iOS WDA receipt: absent narration is not a contradiction. */
  wdaProvenance?: 'exact-match' | 'unavailable';
  reason:
    | 'exact-runner-and-wda-match'
    | 'exact-runner-match'
    | 'no-exact-device-request'
    | 'direct-runner-evidence-unavailable'
    | 'reported-device-missing'
    | 'reported-device-ambiguous'
    | 'reported-device-mismatch'
    | 'reported-device-weak-identity'
    | 'wda-device-mismatch';
}

// iOS UDIDs are hex and are rendered in different cases by the report writer,
// the log stream and the session store; identity must stay exact but must not
// depend on which producer emitted it.
function canonicalDeviceId(value: string): string {
  return value.toLowerCase();
}

export function sameDevice(left: string, right: string): boolean {
  return canonicalDeviceId(left) === canonicalDeviceId(right);
}

function uniqueValues(values: Array<string | undefined>): string[] {
  const seen = new Map<string, string>();
  for (const value of values) {
    if (!value) continue;
    const key = canonicalDeviceId(value);
    if (!seen.has(key)) seen.set(key, value);
  }
  return [...seen.values()];
}

function uniqueMatches(output: string, pattern: RegExp): string[] {
  return uniqueValues([...output.matchAll(pattern)].map((match) => match[1]));
}

/**
 * Verify the process that actually executed the flow, not the metadata used to
 * request it. maestro-runner 1.0.9 emits the selected device in its report/log
 * and every iOS WDA build/start target in its log stream; those direct receipts
 * are replay authority. A requested UDID alone is never accepted as proof.
 */
export function verifyMaestroDeviceAuthority(input: {
  runner: MaestroRunner;
  platform: 'ios' | 'android';
  requestedDeviceId?: string | null;
  output: string;
  directReportDeviceIds?: string[];
  /** 'weak' when the report only carried a last-resort id (bare string / `id`). */
  directReportIdentityStrength?: 'strong' | 'weak' | 'none';
  requireWdaProvenance?: boolean;
}): MaestroDeviceAuthority {
  const requestedDeviceId = input.requestedDeviceId?.trim() || null;
  const reportedIds = uniqueValues([
    ...(input.directReportDeviceIds ?? []),
    ...uniqueMatches(
      input.output,
      /\b(?:Found|Using specified|Connecting to) (?:(?:iOS|Android) )?device:\s*([A-Za-z0-9._:-]+)/gi,
    ),
  ]);
  const wdaDeviceIds = uniqueMatches(
    input.output,
    /\b(?:Building|Starting|Launching|Installing)\s+(?:WDA|WebDriverAgent(?:Runner)?)\s+(?:for|on|to)\s+device\s+([A-Za-z0-9._:-]+)/gi,
  );
  const observedDeviceIds = uniqueValues([...reportedIds, ...wdaDeviceIds]);
  const reportedDeviceId = reportedIds.length === 1 ? reportedIds[0] : null;

  if (!requestedDeviceId) {
    return {
      requestedDeviceId,
      reportedDeviceId,
      observedDeviceIds,
      wdaDeviceIds,
      verified: false,
      source: reportedIds.length > 0 ? 'maestro-runner-log' : 'none',
      reason: 'no-exact-device-request',
    };
  }

  // The official Maestro CLI receives --udid too, but its normal output does
  // not provide a stable direct-device receipt. Forward the exact target while
  // declining to manufacture RunRecord authority from argv metadata.
  if (input.runner !== 'maestro-runner') {
    return {
      requestedDeviceId,
      reportedDeviceId,
      observedDeviceIds,
      wdaDeviceIds,
      verified: false,
      source: 'maestro-cli-explicit-udid',
      reason: 'direct-runner-evidence-unavailable',
    };
  }

  const base = {
    requestedDeviceId,
    reportedDeviceId,
    observedDeviceIds,
    wdaDeviceIds,
    source: 'maestro-runner-log' as const,
  };
  if (reportedIds.length === 0) {
    return { ...base, verified: false, reason: 'reported-device-missing' };
  }
  if (reportedIds.length !== 1) {
    return { ...base, verified: false, reason: 'reported-device-ambiguous' };
  }
  if (!reportedDeviceId || !sameDevice(reportedDeviceId, requestedDeviceId)) {
    // A last-resort id (bare string or `id`) is frequently a model name, not an
    // identity. It still refuses — absence of proof is not proof — but it must
    // not read as "the runner executed on a different device".
    const weakOnly =
      input.directReportIdentityStrength === 'weak' &&
      (input.directReportDeviceIds ?? []).some((id) => sameDevice(id, reportedDeviceId ?? ''));
    return {
      ...base,
      verified: false,
      reason: weakOnly ? 'reported-device-weak-identity' : 'reported-device-mismatch',
    };
  }
  if (observedDeviceIds.some((id) => !sameDevice(id, requestedDeviceId))) {
    return { ...base, verified: false, reason: 'wda-device-mismatch' };
  }
  // A warm WDA does not re-narrate its target, so missing narration proves
  // nothing either way; contradictory narration is already rejected above.
  return {
    ...base,
    verified: true,
    ...(input.platform === 'ios' && input.requireWdaProvenance === true
      ? {
          wdaProvenance:
            wdaDeviceIds.length > 0 ? ('exact-match' as const) : ('unavailable' as const),
        }
      : {}),
    reason:
      input.platform === 'ios' && wdaDeviceIds.length > 0
        ? 'exact-runner-and-wda-match'
        : 'exact-runner-match',
  };
}

export function shouldRejectMaestroDeviceAuthority(authority: MaestroDeviceAuthority): boolean {
  return (
    authority.requestedDeviceId !== null &&
    authority.source === 'maestro-runner-log' &&
    !authority.verified
  );
}

// Single refusal wording for every verify call site. `underlyingError` is
// appended rather than replaced: a refusal must never be the only channel a
// real runner failure has (a masked ENOENT reads as a wrong-device run).
export function maestroAuthorityRefusal(
  authority: MaestroDeviceAuthority,
  underlyingError?: string,
): string | null {
  if (!shouldRejectMaestroDeviceAuthority(authority)) return null;
  const headline = `Maestro device authority refused: requested ${authority.requestedDeviceId}, direct runner/WDA evidence was ${authority.reportedDeviceId ?? 'missing'} (${authority.reason}).`;
  return underlyingError ? `${headline} Underlying failure: ${underlyingError}` : headline;
}
