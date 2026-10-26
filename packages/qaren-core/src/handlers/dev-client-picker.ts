import { sleep as cancellableSleep } from '../domain/cancellation.js';
import {
  runNative as _runAgentDeviceImpl,
  hasActiveSession,
  getActiveSession,
} from '../agent-device-wrapper.js';
import { detectPlatform } from './platform-utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { fetchFindCandidates, pressCandidate } from './device-interact.js';
import type { FindCandidate } from './device-interact.js';

// GH #136 test seam: production code calls `runAgentDevice` through this
// indirection so unit tests can swap a mock without touching the real
// agent-device CLI subprocess. Production behavior is identity-equivalent
// to the imported function.
let runAgentDeviceFn: typeof _runAgentDeviceImpl = _runAgentDeviceImpl;

export function _setRunAgentDeviceForTest(fn: typeof _runAgentDeviceImpl): void {
  runAgentDeviceFn = fn;
}

export function _resetRunAgentDeviceForTest(): void {
  runAgentDeviceFn = _runAgentDeviceImpl;
}

let fetchCandidatesFn: typeof fetchFindCandidates = fetchFindCandidates;
let pressCandidateFn: typeof pressCandidate = pressCandidate;

export function _setFetchCandidatesForTest(fn: typeof fetchFindCandidates): void {
  fetchCandidatesFn = fn;
}
export function _resetFetchCandidatesForTest(): void {
  fetchCandidatesFn = fetchFindCandidates;
}
export function _setPressCandidateForTest(fn: typeof pressCandidate): void {
  pressCandidateFn = fn;
}
export function _resetPressCandidateForTest(): void {
  pressCandidateFn = pressCandidate;
}

// GH #136 test seam: same pattern as runAgentDeviceFn but for the
// session-presence guard. Lets unit tests force the "session active"
// branch without spinning up an agent-device session.
let hasActiveSessionFn: typeof hasActiveSession = hasActiveSession;

export function _setHasSessionForTest(value: boolean): void {
  hasActiveSessionFn = () => value;
}

export function _resetHasSessionForTest(): void {
  hasActiveSessionFn = hasActiveSession;
}

/**
 * Detect and dismiss the Expo Dev Client server picker.
 *
 * The picker appears after deep links, app restarts, permission changes,
 * or clearState. It's a native screen (not React) so CDP tools can't see it.
 * Uses device_find via agent-device to detect "Development servers" text
 * and tap the first available Metro server entry.
 *
 * Returns:
 *   - { dismissed: true } if picker was found and tapped
 *   - { dismissed: false, reason: '...' } if not detected or no session
 *   - null if no active device session (silent skip)
 */

const PICKER_INDICATORS = ['Development servers', 'DEVELOPMENT SERVERS'];

export interface PickerResult {
  dismissed: boolean;
  reason: string;
  pickerPresent?: boolean;
}

export interface PickerOutcome {
  dismissed: boolean;
  reason: string;
  pickerPresent?: boolean;
  platform?: 'ios' | 'android' | null;
}

// GH #136: structural matcher for dev-client picker rows. The picker shows
// rows shaped like `<host>:<port>` — host may be a LAN IPv4 address, an
// Android emulator alias (10.0.2.2), a `.local` mDNS name, or a bare DNS
// hostname. The Metro port (default 8081, configurable) is the most reliable
// signal that we're looking at a server entry vs decorative text. Constraints:
//   - port must be 80..65535 (rejects version-string fragments like `0.76`)
//   - host must look like a real network address (IPv4 quad OR
//     dotted-domain-style with at least one alphabetic label, OR a single
//     bare alphabetic hostname). Rejects `v123:456`, `v1.2.3:1234`, and
//     other version-shape pseudo-hosts that would otherwise leak through.
const PORT_PATTERN = /\b([\w.-]+):(\d{2,5})\b/g;
const IPV4_QUAD_RE = /^\d+\.\d+\.\d+\.\d+$/;
const VERSION_SHAPE_RE = /^v?\d+(\.\d+)*$/i;
const HOSTNAME_RE = /^[A-Za-z][A-Za-z0-9-]*(\.[A-Za-z][A-Za-z0-9-]*)*$/;

function looksLikeNetworkHost(host: string): boolean {
  if (IPV4_QUAD_RE.test(host)) return true;
  if (VERSION_SHAPE_RE.test(host)) return false;
  return HOSTNAME_RE.test(host);
}

export function parsePortPatternEntry(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const match of text.matchAll(PORT_PATTERN)) {
    const host = match[1];
    const portNum = Number.parseInt(match[2], 10);
    if (portNum < 80 || portNum > 65535) continue;
    if (!looksLikeNetworkHost(host)) continue;
    return `${host}:${portNum}`;
  }
  return null;
}

// Rows that appear in the dev-client picker but are NOT server entries.
// Used as a deny-list for the first-non-header-row fallback when port-pattern
// matching fails (e.g., picker shows only the manifest name without the URL).
//
// Stored as lowercase strings; lookups normalize input the same way so the
// deny-list is robust against Expo casing/locale shifts (`ENTER URL MANUALLY`
// vs `Enter URL Manually`). HEADER_PATTERNS already use case-insensitive
// regex; this brings the footer check in line with that convention.
const FOOTER_ROWS = new Set([
  'enter url manually',
  'fetch development servers',
  'development servers',
  'connect to a development build',
]);

const HEADER_PATTERNS = [/development servers/i];

/**
 * GH #136: orchestrates the picker matcher fallbacks. Matching priority:
 *   1. A whole-line literal IP match (`localhost`, `127.0.0.1`, `10.0.2.2`)
 *      — preserves the original heuristic for known-good rows. The match
 *      is anchored to a complete trimmed line so a decorative row like
 *      `"Open localhost in browser"` cannot short-circuit the smarter
 *      port-pattern path.
 *   2. Port-pattern via parsePortPatternEntry (catches LAN IPs, .local
 *      hostnames, and DNS names that show up on real-world dev setups).
 *   3. First non-header, non-footer row below the picker title — the row
 *      a user would tap with their finger when the URL is hidden.
 *
 * Returns the literal text to pass to `device_find <text>` for tapping, or
 * null when the snapshot doesn't look like a dev-client picker at all.
 */
export function parseFirstServerEntry(
  snapshot: string | null | undefined,
  preferredPort?: number,
): string | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null;
  if (preferredPort !== undefined) {
    const exact = new Set<string>();
    for (const match of snapshot.matchAll(PORT_PATTERN)) {
      const host = match[1];
      const portNum = Number.parseInt(match[2], 10);
      if (portNum === preferredPort && looksLikeNetworkHost(host)) {
        exact.add(`${host}:${portNum}`);
      }
    }
    return exact.size === 1 ? [...exact][0] : null;
  }

  const lines = snapshot
    .split('\n')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const literalIps = new Set(['localhost', '127.0.0.1', '10.0.2.2']);
  for (const line of lines) {
    if (literalIps.has(line)) return line;
    if (line.includes(':') && literalIps.has(line.split(':', 1)[0])) return line;
  }

  const entries: Array<{ entry: string; linkLocal: boolean }> = [];
  for (const match of snapshot.matchAll(PORT_PATTERN)) {
    const host = match[1];
    const portNum = Number.parseInt(match[2], 10);
    if (portNum < 80 || portNum > 65535 || !looksLikeNetworkHost(host)) continue;
    entries.push({
      entry: `${host}:${portNum}`,
      linkLocal: host.startsWith('169.254.'),
    });
  }
  if (entries.length > 0) {
    return (entries.find((entry) => !entry.linkLocal) ?? entries[0]).entry;
  }

  const headerIndex = lines.findIndex((line) =>
    HEADER_PATTERNS.some((pattern) => pattern.test(line)),
  );
  if (headerIndex === -1) return null;
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    if (!FOOTER_ROWS.has(lines[index].toLowerCase())) return lines[index];
  }
  return null;
}

// GH #523 sub-3: the stale-server error dialog. After a network change the
// app auto-retries the previous (now unreachable, often link-local) Metro URL
// and lands on a native "Error loading app" dialog that blocks the picker.
// Dismissing it drops the user back on the picker, which the normal flow can
// then clear — so both are handled by the same auto-dismiss.
const ERROR_DIALOG_INDICATORS = ['Error loading app'];
const ERROR_DIALOG_DISMISS_LABELS = ['Dismiss', 'OK', 'Close'];

async function isPickerIndicatorPresent(): Promise<boolean> {
  for (const indicator of PICKER_INDICATORS) {
    try {
      const findResult = await fetchCandidatesFn(indicator);
      if (findResult.ok && findResult.candidates.length > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

async function dismissStaleServerErrorDialog(): Promise<boolean> {
  for (const indicator of ERROR_DIALOG_INDICATORS) {
    try {
      const found = await fetchCandidatesFn(indicator);
      if (!found.ok || found.candidates.length === 0) continue;
      for (const label of ERROR_DIALOG_DISMISS_LABELS) {
        const button = await fetchCandidatesFn(label, true);
        if (button.ok && button.candidates.length === 1) {
          const press = await pressCandidateFn(button.candidates[0] as FindCandidate, 'click');
          if (!press.isError) return true;
        }
      }
    } catch {
      continue;
    }
  }
  return false;
}

export async function handleDevClientPicker(preferredPort?: number): Promise<PickerResult | null> {
  if (!hasActiveSessionFn()) return null;

  // Step 1: Detect if the picker is showing
  if (await isPickerIndicatorPresent()) {
    return dismissPicker(preferredPort);
  }

  // Step 2 (GH #523 sub-3): no picker — check for the stale-server error
  // dialog that hides it. Clearing the dialog usually reveals the picker.
  if (await dismissStaleServerErrorDialog()) {
    if (await isPickerIndicatorPresent()) {
      const res = await dismissPicker(preferredPort);
      return { ...res, reason: `Stale-server error dialog dismissed; ${res.reason}` };
    }
    return {
      dismissed: true,
      reason: 'Stale-server error dialog dismissed (no picker shown afterwards)',
    };
  }

  return { dismissed: false, reason: 'Dev Client picker not detected', pickerPresent: false };
}

/**
 * GH #136 sub-3 / GH #523 sub-3: the single guarded seam every on-demand/auto
 * consumer routes through. The historical iOS short-circuit protected against
 * the legacy agent-device daemon respawning (D1219); every primitive this flow
 * needs (snapshot -i, press @ref) now routes through rn-fast-runner on iOS, so
 * both platforms take the real dismiss path. Returns null ONLY when no device
 * session is open, so the MCP tool can surface a NO_SESSION error.
 */
export async function clearDevClientPickerIfPresent(
  platform?: 'ios' | 'android',
  preferredPort?: number,
): Promise<PickerOutcome | null> {
  if (preferredPort === undefined) {
    return {
      dismissed: false,
      platform: platform ?? null,
      reason: 'Exact authority-bound Metro port is required; no picker row was selected.',
    };
  }
  // SessionState.platform is typed `string | undefined`, so narrow it to the
  // valid platforms before it can short-circuit the detectPlatform() fallback.
  const sessionPlatform = getActiveSession()?.platform;
  const resolved =
    platform ??
    (sessionPlatform === 'ios' || sessionPlatform === 'android' ? sessionPlatform : undefined) ??
    (await detectPlatform());
  if (resolved !== 'ios' && resolved !== 'android') {
    return { dismissed: false, platform: null, reason: 'No iOS/Android device detected.' };
  }
  const res = await handleDevClientPicker(preferredPort);
  if (res === null) return null;
  return { ...res, platform: resolved };
}

/**
 * GH #136: rewritten to use parseFirstServerEntry against an upfront snapshot.
 * The previous "try literal IPs in turn, then regex-scan" approach missed
 * every LAN-IP-only setup we hit in the field. Exporting for unit tests so
 * the dispatch can be exercised through the runAgentDeviceFn test seam.
 */
/**
 * GH #523 sub-3: iOS snapshots come back as a JSON envelope
 * (`{ok, data:{nodes:[...]}}`), not a plain-text tree. Feeding raw JSON to
 * the line-based matcher can hit pseudo-entries like `"y":100` (host "y",
 * port 100 passes the shape checks). Extract node labels/identifiers as
 * lines when the payload parses; fall back to the raw text for the legacy
 * plain-text tree.
 */
export function snapshotToSearchText(raw: string): string {
  try {
    const env = JSON.parse(raw) as {
      data?: { nodes?: Array<{ label?: unknown; identifier?: unknown }> };
    };
    const nodes = env?.data?.nodes;
    if (Array.isArray(nodes)) {
      const lines: string[] = [];
      for (const n of nodes) {
        for (const field of [n?.label, n?.identifier]) {
          if (typeof field === 'string' && field.trim().length > 0) lines.push(field.trim());
        }
      }
      return lines.join('\n');
    }
  } catch {
    /* not JSON — legacy plain-text tree */
  }
  return raw;
}

export async function dismissPicker(preferredPort?: number): Promise<PickerResult> {
  // GH #136: re-probe the picker before attempting to tap. Single-server
  // pickers auto-advance on a ~3-5s timer; if the auto-advance fired between
  // detect and dispatch, we don't need to act — return success now. This
  // closes the ~30% race failure documented in #136 issue 3 where Maestro
  // flows hit "unable to find element" errors when the picker auto-advanced
  // before tapOn could fire.
  const stillShowing = await isDevClientPickerShowing();
  if (!stillShowing) {
    return { dismissed: true, reason: 'Dev Client picker auto-advanced before tap' };
  }

  const snapshot = await runAgentDeviceFn(['snapshot', '-i']);
  const snapshotText = snapshot.isError ? '' : (snapshot.content[0]?.text ?? '');
  const target = parseFirstServerEntry(snapshotToSearchText(snapshotText), preferredPort);

  if (target) {
    const findResult = await fetchCandidatesFn(target);
    if (findResult.ok && findResult.candidates.length === 1) {
      const pressResult = await pressCandidateFn(
        findResult.candidates[0] as FindCandidate,
        'click',
      );
      if (!pressResult.isError) {
        await waitForBundle();
        return { dismissed: true, reason: `Tapped server entry "${target}"` };
      }
    }
  }

  return {
    dismissed: false,
    pickerPresent: true,
    reason:
      'Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually.',
  };
}

/**
 * GH #136: fast-then-slow cadence. Single-server pickers auto-advance in a
 * few hundred milliseconds; LAN-IP picker tap settles within ~1s. The
 * previous fixed-2s polling burned wall-clock time we don't have to spend.
 *
 *   Phase 1 (0..1000ms):    poll every 100ms — catches auto-advance + fast taps.
 *   Phase 2 (1000..10000ms): poll every 500ms — covers slower bundle loads.
 *
 * Total budget: 10s (was 20s). Empirically the picker is either gone in
 * <2s or stuck in a way no extra polling will fix. Exported for unit tests.
 */
export async function waitForBundle(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const elapsed = Date.now() - start;
    const interval = elapsed < 1_000 ? 100 : 500;
    await cancellableSleep(interval);
    const findResult = await fetchCandidatesFn('Development servers');
    if (!findResult.ok || findResult.candidates.length === 0) return; // Picker gone — bundle loaded.
  }
}

/**
 * Quick check: is the Dev Client picker likely showing?
 * Uses device_find without tapping — lighter than full handleDevClientPicker.
 */
export async function isDevClientPickerShowing(): Promise<boolean> {
  if (!hasActiveSessionFn()) return false;
  return isPickerIndicatorPresent();
}

export interface DismissPickerAuthorityDeps {
  reproveOrigin?: (args: object, options?: { readinessTimeoutMs?: number }) => Promise<void>;
  completeOrigin?: (args: object, targetExpected: boolean) => Promise<void>;
  isBundleBound?: () => boolean;
  isSessionRuntimeAbsent?: () => Promise<boolean>;
}

// GH #750: a defensive picker probe only fails fast when the exact device
// advertises no session target AND the app is provably not running; a slow
// bridgeless re-registration still gets a window wider than the >15s the
// dev-client needs, while cdp_connect keeps the full exact-target budget.
const PICKER_PROBE_ABSENT_RUNTIME_TIMEOUT_MS = 15_000;
const PICKER_PROBE_READINESS_TIMEOUT_MS = 45_000;

export function createDismissDevClientPickerHandler(
  getMetroPort?: () => number | null | undefined,
  authorityDeps: DismissPickerAuthorityDeps = {},
): (args: { platform?: 'ios' | 'android' }) => Promise<ToolResult> {
  let dismissalAwaitingProof = false;
  return async (args) => {
    const t0 = Date.now();
    // GH #523 sub-3: prefer the picker row matching the project's Metro port
    // over stale entries the app remembered from a previous network state.
    let preferredPort: number | undefined;
    try {
      preferredPort = getMetroPort?.() ?? undefined;
    } catch {
      preferredPort = undefined;
    }
    const outcome = await clearDevClientPickerIfPresent(args.platform, preferredPort);
    const meta = { timings_ms: { total: Date.now() - t0 } };

    if (outcome === null) {
      return failResult(
        'No device session open. Call device_snapshot action="open" first.',
        'DEV_CLIENT_PICKER_NO_SESSION',
        meta,
      );
    }
    // GH #750: the tool runs without A/B (the stranded state it repairs), so
    // after a dismissal it must reconnect the exact target and prove A/B.
    const proveOrigin = async (readinessTimeoutMs?: number): Promise<void> => {
      await (authorityDeps.reproveOrigin ?? (async () => {}))(
        args,
        readinessTimeoutMs === undefined ? undefined : { readinessTimeoutMs },
      );
      await (authorityDeps.completeOrigin ?? (async () => {}))(args, true);
      dismissalAwaitingProof = false;
    };
    const pickerProbeReadinessTimeoutMs = async (): Promise<number | undefined> => {
      if (dismissalAwaitingProof) return undefined;
      let runtimeAbsent = false;
      try {
        runtimeAbsent = (await authorityDeps.isSessionRuntimeAbsent?.()) ?? false;
      } catch {
        runtimeAbsent = false;
      }
      return runtimeAbsent
        ? PICKER_PROBE_ABSENT_RUNTIME_TIMEOUT_MS
        : PICKER_PROBE_READINESS_TIMEOUT_MS;
    };
    if (outcome.dismissed) {
      dismissalAwaitingProof = true;
      await proveOrigin();
      return okResult(
        { dismissed: true, reason: outcome.reason, platform: outcome.platform },
        { meta },
      );
    }
    // GH #750: a retry after a failed post-dismissal proof finds the picker
    // already gone; re-prove rather than reporting ok with B still unbound. A
    // probe that never dismissed anything gets the bounded budget instead.
    const isBundleBound = authorityDeps.isBundleBound ?? (() => true);
    const bundleBound = isBundleBound();
    if (bundleBound) dismissalAwaitingProof = false;
    if (
      outcome.pickerPresent === false &&
      !bundleBound &&
      authorityDeps.reproveOrigin !== undefined
    ) {
      await proveOrigin(await pickerProbeReadinessTimeoutMs());
      return okResult(
        { dismissed: false, reproved: true, reason: outcome.reason, platform: outcome.platform },
        { meta },
      );
    }
    if (outcome.reason.toLowerCase().includes('could not find')) {
      return warnResult({ dismissed: false, platform: outcome.platform }, outcome.reason, meta);
    }
    return okResult(
      { dismissed: false, reason: outcome.reason, platform: outcome.platform },
      { meta },
    );
  };
}
