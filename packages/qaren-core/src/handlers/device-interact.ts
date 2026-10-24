import { sleep as cancellableSleep } from '../domain/cancellation.js';
import { randomUUID } from 'node:crypto';
import { measureDispatchPhase, measureTiming, type TimingContext } from '../qa/timing.js';
import type { QaDispatchContext } from '../domain/qa-dispatch.js';
import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';

import {
  runNative,
  getActiveSession,
  clearActiveSession,
  getCachedScreenRect,
  cacheSnapshot,
  getCachedSnapshot,
  isSnapshotCacheValid,
  markSnapshotDirty,
  IME_KEY_FLAG,
  settleAfterMutation,
} from '../agent-device-wrapper.js';
import { buildIosProbes } from '../lifecycle/settle.js';
import {
  isFastRunnerAvailable,
  fastSwipe,
  stopFastRunner,
  adoptPersistedFastRunnerState,
} from '../runners/rn-fast-runner-client.js';
import { stopAndroidRunner } from '../runners/rn-android-runner-client.js';
import {
  surfaceKeyboardGuard,
  healKeyboardOccludedTap,
  type KeyboardAutoHealDeps,
} from '../runners/keyboard-guard.js';
import { resolveBundleId } from '../project-config.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { withSession } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult, createStepTimer } from '../utils.js';
import { isAgentDeviceRunnerSentinel, recoverFromRunnerLeak } from './runner-leak-recovery.js';
import type { RecoveryTier } from './runner-leak-recovery.js';
import { reopenSessionForRecovery } from './device-session.js';
import type { FlatNode } from '../fast-runner-ref-map.js';
import type { CDPClient } from '../cdp-client.js';
import { exactIdentities } from '../qa/identity.js';
import { join, type NativeNode } from '../qa/screen.js';
import {
  getCachedSignature,
  getKeyboardTop,
  getScreenPointScale,
  isRefMapFresh,
  refreshRef,
  lookupRef,
  pinnedElementRef,
  refCenter,
  type RefSignature,
} from '../fast-runner-ref-map.js';
import {
  classifyNativeVerification,
  type NativeVerifyVerdict,
  type NativeVerification,
} from './fill-verify.js';

const execFile = promisify(execFileCb);
const IME_PROBE_TIMEOUT_MS = 5_000;

function withQaSession<T extends { qaContext?: QaDispatchContext }>(
  handler: (args: T) => Promise<ToolResult>,
): (args: T) => Promise<ToolResult> {
  const wrapped = withSession(handler);
  return async (args) => {
    args.qaContext?.check();
    if (!getActiveSession()) args.qaContext?.invalidate();
    return wrapped(args);
  };
}

export interface SnapshotNode {
  ref: string;
  label?: string;
  identifier?: string;
  type?: string;
  packageName?: string;
  checked?: boolean;
  hittable?: boolean;
  /** GH #581: Android password fields (iOS secure inputs are typed SecureTextField). */
  secure?: boolean;
  enabled?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface FindCandidate {
  ref: string;
  label?: string;
  testID?: string;
  type?: string;
  hittable?: boolean;
  position?: { x: number; y: number };
}

function candidateFromNode(n: SnapshotNode): FindCandidate {
  return {
    ref: pinnedElementRef(n.ref),
    label: n.label,
    testID: n.identifier,
    type: n.type,
    hittable: n.hittable,
    position: n.rect ? { x: n.rect.x, y: n.rect.y } : undefined,
  };
}

// GH #59 #4: when device_find returns AMBIGUOUS_MATCH, the agent has to
// pick a candidate by index. Without ranking, the order is arbitrary —
// in the reporter's iOS share-sheet case, "Copy" matched 5 candidates
// (ScrollView, Cell, Other, Other, StaticText) and the actual tap target
// was the Cell, which sat in position 1 by luck. We rank candidates so
// the most likely tap target sits at index 0.
//
// Ranking signals (highest weight first):
//   1. Element-type priority for tap intent: Button/Cell/Switch >
//      Other/Link > StaticText/Image > ScrollView. Containers like
//      ScrollView are usually parents of the real tap target.
//   2. hittable as the same-type tiebreak only (#519 review): since #395,
//      iOS hittable means "enabled AND center-on-screen" — NOT "directly
//      tappable". An inert on-screen StaticText is legitimately hittable,
//      so a type-dominating hittable bonus would steer taps to body text
//      over a real control half-scrolled off-screen.
//   3. Dedupe by visual rect — when two elements share the same bounds
//      (e.g. a Cell wrapping a StaticText), keep only the higher-scored
//      one. The user wants ONE candidate per unique screen position.
//
// Pure helper exported for unit testing.
const TYPE_PRIORITY_FOR_TAP: Record<string, number> = {
  Button: 100,
  Cell: 95,
  Switch: 90,
  Link: 80,
  Other: 60,
  StaticText: 30,
  Image: 25,
  ScrollView: 10,
};

function typePriority(type: string | undefined): number {
  if (!type) return 50;
  return TYPE_PRIORITY_FOR_TAP[type] ?? 50;
}

function rectKey(rect: SnapshotNode['rect']): string | null {
  if (!rect) return null;
  return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`;
}

export function rankSnapshotNodes(nodes: SnapshotNode[]): SnapshotNode[] {
  const withScore = nodes.map((node, originalIndex) => ({
    node,
    originalIndex,
    score: typePriority(node.type) * 10 + (node.hittable === true ? 1 : 0),
  }));

  withScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.originalIndex - b.originalIndex;
  });

  const seenRects = new Set<string>();
  const ranked: SnapshotNode[] = [];
  for (const s of withScore) {
    const key = rectKey(s.node.rect);
    if (key !== null) {
      if (seenRects.has(key)) continue;
      seenRects.add(key);
    }
    ranked.push(s.node);
  }
  return ranked;
}

function parseSnapshotEnvelope(result: ToolResult): SnapshotNode[] | null {
  if (result.isError) return null;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { nodes?: SnapshotNode[] };
    };
    if (!envelope.ok || !envelope.data?.nodes) return null;
    return envelope.data.nodes;
  } catch {
    return null;
  }
}

export type SnapshotFetchResult =
  | {
      ok: true;
      nodes: SnapshotNode[];
      provenance: SnapshotProvenance;
      recoveredTier?: RecoveryTier;
    }
  | { ok: false; reason: 'fetch-failed' }
  | { ok: false; reason: 'empty-capture' }
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

interface SnapshotProvenance {
  source: 'cache' | 'fresh';
  originAuthority: 'proven' | 'not-proven';
}

export async function fetchSnapshotNodes(
  allowCache = false,
  qaContext?: QaDispatchContext,
): Promise<SnapshotFetchResult> {
  if (qaContext) return fetchSnapshotNodesForSameScreenProof(qaContext);
  return fetchSnapshotNodesWithPolicy(allowCache, true);
}

export async function fetchSnapshotNodesForSameScreenProof(
  qaContext?: QaDispatchContext,
): Promise<SnapshotFetchResult> {
  const result = await fetchSnapshotNodesWithPolicy(false, false, qaContext);
  if (!result.ok) qaContext?.invalidate();
  return result;
}

async function fetchSnapshotNodesWithPolicy(
  allowCache = false,
  recoverRunnerLeak = true,
  qaContext?: QaDispatchContext,
): Promise<SnapshotFetchResult> {
  // GH #321 (live-sim speedup): serve device_find from the snapshot we already
  // captured when it's still a faithful picture of the screen (clean + fresh),
  // skipping a redundant runner round-trip. isSnapshotCacheValid() is false the
  // moment any mutating verb runs, so we never target against a stale screen.
  if (allowCache) {
    const platform = getActiveSession()?.platform;
    if (platform && isSnapshotCacheValid(platform)) {
      const cached = getCachedSnapshot(platform);
      if (cached) {
        return {
          ok: true,
          nodes: cached.nodes,
          provenance: {
            source: 'cache',
            originAuthority: cached.authorityReceipt.originAuthority,
          },
        };
      }
    }
  }

  const first = await runNative(['snapshot', '-i'], {
    qaContext,
    qaReadOnly: qaContext !== undefined,
  });
  const initialNodes = parseSnapshotEnvelope(first);
  if (initialNodes === null) return { ok: false, reason: 'fetch-failed' };
  // GH #409: a zero-node capture cannot support any "element absent" verdict —
  // it is indistinguishable from a degraded walk. Interactive consumers fail
  // closed instead of concluding "nothing on screen".
  if (initialNodes.length === 0) return { ok: false, reason: 'empty-capture' };

  if (!isAgentDeviceRunnerSentinel(initialNodes)) {
    const platform = getActiveSession()?.platform;
    if (platform) cacheSnapshot(platform, initialNodes);
    return {
      ok: true,
      nodes: initialNodes,
      provenance: { source: 'fresh', originAuthority: 'not-proven' },
    };
  }

  const session = getActiveSession();
  markSnapshotDirty(session?.platform);
  if (!recoverRunnerLeak) {
    return {
      ok: false,
      reason: 'runner-leak-unrecovered',
      recoveryReason: 'recovery-disabled-for-proof',
    };
  }
  const recovery = await recoverFromRunnerLeak(
    {
      platform: session?.platform,
      appId: session?.appId,
      deviceId: session?.deviceId,
      sessionName: session?.name,
    },
    {
      closeSession: async () => {
        await stopFastRunner(session?.deviceId);
        await stopAndroidRunner(session?.deviceId);
        clearActiveSession();
        return okResult({ closed: true });
      },
      openSession: ({ appId, platform, deviceId, attachOnly }) =>
        reopenSessionForRecovery(appId, platform, attachOnly, deviceId),
      resnapshot: () => runNative(['snapshot', '-i']),
      parseNodes: parseSnapshotEnvelope,
    },
  );

  if (!recovery.recovered) {
    return { ok: false, reason: 'runner-leak-unrecovered', recoveryReason: recovery.reason };
  }

  const recoveredNodes = parseSnapshotEnvelope(recovery.result);
  if (recoveredNodes === null) return { ok: false, reason: 'fetch-failed' };
  if (recoveredNodes.length === 0) return { ok: false, reason: 'empty-capture' };

  const platform = getActiveSession()?.platform;
  if (platform) cacheSnapshot(platform, recoveredNodes);
  return {
    ok: true,
    nodes: recoveredNodes,
    provenance: { source: 'fresh', originAuthority: 'not-proven' },
    recoveredTier: recovery.tier,
  };
}

// GH #409: refusal for a zero-node capture — asserting NOT_FOUND on it would
// present a degraded capture as a legitimately empty screen.
function emptyCaptureFailResult(query?: string): ToolResult {
  return failResult(
    `Snapshot returned zero nodes — cannot distinguish an empty screen from a degraded capture` +
      (query !== undefined ? `; not asserting "${query}" is absent` : '') +
      `. Confirm the screen with device_screenshot or cdp_component_tree, then retry.`,
    { code: 'SNAPSHOT_DEGRADED', ...(query !== undefined ? { query } : {}) },
  );
}

export type FindCandidatesResult =
  | {
      ok: true;
      candidates: FindCandidate[];
      provenance: SnapshotProvenance;
      recoveredTier?: RecoveryTier;
    }
  | { ok: false; reason: 'fetch-failed' }
  | { ok: false; reason: 'empty-capture' }
  | { ok: false; reason: 'runner-leak-unrecovered'; recoveryReason?: string };

export function scopeSnapshotNodesForFind(
  nodes: SnapshotNode[],
  platform: string | undefined,
  appId: string | undefined,
  includeSystemUi: boolean,
): SnapshotNode[] {
  if (platform !== 'android' || includeSystemUi) return nodes;
  if (!appId) return [];
  return nodes.filter((node) => node.packageName === appId);
}

export async function fetchFindCandidates(
  query: string,
  exact = false,
  allowCache = false,
  includeSystemUi = false,
): Promise<FindCandidatesResult> {
  const snap = await fetchSnapshotNodes(allowCache);
  if (!snap.ok) return snap;

  const session = getActiveSession();
  const scopedNodes = scopeSnapshotNodesForFind(
    snap.nodes,
    session?.platform,
    session?.appId,
    includeSystemUi,
  );
  const needle = query.toLowerCase();
  const matched = scopedNodes.filter((n) => {
    const label = n.label ?? '';
    const id = n.identifier ?? '';
    if (exact) return label === query || id === query;
    return label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
  });
  // GH #59 #4: rank before slicing so the truncation never drops the
  // most-likely tap target. Without this, a query that matches 12
  // elements (10 ScrollViews + 2 Cells) could lose both Cells to the
  // 10-element cap.
  const ranked = rankSnapshotNodes(matched);
  const candidates = ranked.slice(0, 10).map(candidateFromNode);
  return {
    ok: true,
    candidates,
    provenance: snap.provenance,
    recoveredTier: snap.recoveredTier,
  };
}

function runnerLeakFailResult(query: string | undefined, recoveryReason?: string): ToolResult {
  const queryHint = query ? ` (while resolving "${query}")` : '';
  return failResult(
    `device_find/snapshot returned AgentDeviceRunner's own UI tree instead of the target app${queryHint} (B119 / GH #35 — agent-device daemon dropped appBundleId on dispatch). Auto-recovery did not restore the target.`,
    {
      code: 'RUNNER_LEAK',
      recoveryReason,
      hint: 'Manually close + reopen the session with device_snapshot action=open appId=<your.bundle.id> platform=ios (full launch, not attachOnly). The recovery may have killed the JS context — re-establish CDP via cdp_connect before reading state. Upstream: Callstack/agent-device, see B119/GH#35.',
    },
  );
}

export async function pressCandidate(
  candidate: FindCandidate,
  action?: string,
  getClient?: () => CDPClient,
  includeSystemUi = false,
  qaContext?: QaDispatchContext,
): Promise<ToolResult> {
  const ref = candidate.ref.startsWith('@') ? candidate.ref : `@${candidate.ref}`;
  if (action === 'click') {
    const identity = getCachedSignature(ref);
    const tap = async (at = ref): Promise<ToolResult> =>
      surfaceKeyboardGuard(
        await runNative(['press', at, ...(includeSystemUi ? ['--include-system-ui'] : [])], {
          qaContext,
        }),
      );
    const first = await tap();
    return first.isError
      ? healKeyboardOccludedTap(
          first,
          getClient ? keyboardHealDeps(getClient, tap, qaContext, { ref, identity }) : null,
          qaContext,
        )
      : first;
  }
  return okResult({
    ref: candidate.ref,
    label: candidate.label,
    testID: candidate.testID,
    ...(includeSystemUi ? { scope: 'system-ui-explicit' } : {}),
  });
}

// B119: when an underlying snapshot triggered runner-leak recovery, surface
// that side-effect on the wrapping result so callers (LLM agents) know the
// app may have been relaunched and CDP/state may have been invalidated.
function tagFindSnapshot(
  result: ToolResult,
  provenance: SnapshotProvenance,
  tier?: RecoveryTier,
): ToolResult {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: unknown;
      meta?: Record<string, unknown>;
    };
    envelope.meta = {
      ...envelope.meta,
      snapshotProvenance: provenance,
      ...(tier ? { recovered: 'agent-device-runner-leak', recoveryTier: tier } : {}),
    };
    return {
      ...result,
      content: [
        { type: 'text' as const, text: JSON.stringify(envelope) },
        ...result.content.slice(1),
      ],
    };
  } catch {
    return result;
  }
}

// --- Find ---

interface FindArgs {
  text: string;
  action?: string;
  exact?: boolean;
  index?: number;
  includeSystemUi?: boolean;
}

export function createDeviceFindHandler(
  getClient?: () => CDPClient,
): (args: FindArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    // Fast path when caller already knows they want exact or a specific index:
    // go straight to a snapshot-based client-side match so we never roll the dice
    // on agent-device's fuzzy matcher returning AMBIGUOUS_MATCH.
    if (args.exact === true || args.index !== undefined) {
      const find = await fetchFindCandidates(
        args.text,
        args.exact === true,
        true,
        args.includeSystemUi === true,
      );
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.reason === 'empty-capture') {
          return emptyCaptureFailResult(args.text);
        }
        // Snapshot failed and caller has strict requirements — do NOT fall through
        // to the fuzzy agent-device path because it cannot honor exact/index. Fail
        // cleanly so the caller knows exact/index semantics aren't reachable.
        return failResult(
          `Snapshot unavailable — cannot resolve ${args.exact ? 'exact' : 'index-based'} match for "${args.text}". Retry after device_snapshot action=open/snapshot.`,
          { code: 'SNAPSHOT_UNAVAILABLE', query: args.text },
        );
      }
      const { candidates, provenance, recoveredTier } = find;
      const tagResult = (result: ToolResult) => tagFindSnapshot(result, provenance, recoveredTier);
      if (candidates.length === 0) {
        return tagResult(
          failResult(`No element matches "${args.text}" (exact=${args.exact === true})`, {
            code: 'NOT_FOUND',
            query: args.text,
          }),
        );
      }
      if (args.index !== undefined) {
        if (args.index < 0 || args.index >= candidates.length) {
          return tagResult(
            failResult(`index ${args.index} out of range (got ${candidates.length} candidates)`, {
              code: 'INDEX_OUT_OF_RANGE',
              count: candidates.length,
              candidates,
            }),
          );
        }
        return tagResult(
          await pressCandidate(
            candidates[args.index],
            args.action,
            getClient,
            args.includeSystemUi === true,
          ),
        );
      }
      // exact=true, no index: require single match
      if (candidates.length === 1) {
        return tagResult(
          await pressCandidate(
            candidates[0],
            args.action,
            getClient,
            args.includeSystemUi === true,
          ),
        );
      }
      return tagResult(
        failResult(`AMBIGUOUS_MATCH: exact "${args.text}" matched ${candidates.length} elements`, {
          code: 'AMBIGUOUS_MATCH',
          query: args.text,
          candidates,
          hint: 'Add index: N to pick one.',
        }),
      );
    }

    // GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: route
    // non-exact text finds through the snapshot-based orchestrator on iOS
    // always and on Android (default-on; opt-out via RN_ANDROID_RUNNER=0).
    // The legacy CLI path would respawn the upstream agent-device daemon,
    // which fights our in-tree runner for focus / UIAutomator. Using
    // runNative + fetchFindCandidates keeps us on the platform-aware
    // short-circuit.
    const activeSession = getActiveSession();
    const usesInTreeRunner =
      activeSession?.platform === 'ios' ||
      (activeSession?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');
    if (usesInTreeRunner) {
      const find = await fetchFindCandidates(args.text, false, true, args.includeSystemUi === true);
      if (!find.ok) {
        if (find.reason === 'runner-leak-unrecovered') {
          return runnerLeakFailResult(args.text, find.recoveryReason);
        }
        if (find.reason === 'empty-capture') {
          return emptyCaptureFailResult(args.text);
        }
        return failResult(`Snapshot unavailable — cannot resolve "${args.text}"`, {
          code: 'SNAPSHOT_UNAVAILABLE',
          query: args.text,
        });
      }
      const { candidates, provenance, recoveredTier } = find;
      const tagResult = (result: ToolResult) => tagFindSnapshot(result, provenance, recoveredTier);
      // Surface recoveredTier on every outcome (not just the single-match press)
      // so callers can tell the app was relaunched mid-find even on NOT_FOUND /
      // AMBIGUOUS.
      const recoveredMeta = recoveredTier ? { recoveredTier } : {};
      if (candidates.length === 0) {
        return tagResult(
          failResult(`No element matches "${args.text}"`, {
            code: 'NOT_FOUND',
            query: args.text,
            ...recoveredMeta,
          }),
        );
      }
      if (candidates.length === 1) {
        return tagResult(
          await pressCandidate(
            candidates[0],
            args.action,
            getClient,
            args.includeSystemUi === true,
          ),
        );
      }
      return tagResult(
        failResult(
          `AMBIGUOUS_MATCH: "${args.text}" matched ${candidates.length} elements. Use device_press with one of these refs, or retry with index: N.`,
          {
            code: 'AMBIGUOUS_MATCH',
            query: args.text,
            candidates,
            ...recoveredMeta,
            hint: 'Pick the correct ref (prefer one with hittable=true) and call device_press(ref="...") directly, or call device_find again with index: N.',
          },
        ),
      );
    }

    return failResult(
      `device_find requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${(activeSession as { platform?: string } | null)?.platform ?? 'none'}.`,
      {
        code: 'IN_TREE_RUNNER_REQUIRED',
        platform: (activeSession as { platform?: string } | null)?.platform ?? null,
      },
    );
  });
}

// GH #60 Bug 7: agent-device + Maestro emit a few different timeout strings
// ("daemon timeout", "Daemon error: daemon timeout", "request timed out")
// depending on tier. Match the patterns broadly enough to catch all of them
// without snagging unrelated timeouts (e.g. CDP evaluate timeouts inside
// other tools have different shapes that don't reach this path).
export function isDaemonTimeoutError(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes('daemon timeout') ||
    t.includes('daemon error: daemon') ||
    /\bdaemon\b.*\btimed?\s?out\b/.test(t)
  );
}

// GH #581: exact fill-target binding. Bind exactly one current-generation
// input to the caller's direct ref/testID, or uniquely map a
// `${base}-pressable` wrapper to exactly one `${base}` recognized input in the
// same snapshot. Zero/duplicate/conflicting matches reject without mutation.
const IOS_INPUT_TYPES = new Set(['TextField', 'SecureTextField', 'SearchField', 'TextView']);
const ANDROID_INPUT_TYPE_RE = /.+\.(\w*EditText|\w*AutoCompleteTextView)$/;
const PRESSABLE_SUFFIX = '-pressable';

export function isRecognizedInputType(type: string | undefined): boolean {
  if (!type) return false;
  return IOS_INPUT_TYPES.has(type) || ANDROID_INPUT_TYPE_RE.test(type);
}

function isSecureInputNode(node: SnapshotNode): boolean {
  return node.type === 'SecureTextField' || node.secure === true;
}

export interface ExactFillBinding {
  inputRef: string;
  inputTestId: string | null;
  inputSignature: RefSignature;
  focusRef: string;
  wrapper: boolean;
  secure: boolean;
}

export type ExactBindOutcome =
  | { ok: true; binding: ExactFillBinding }
  | { ok: false; detail: string; unobservable?: true; ambiguous?: true };

function cleanNodeRef(node: SnapshotNode): string {
  return node.ref.startsWith('@') ? node.ref.slice(1) : node.ref;
}

function inputTestId(identifier: string | undefined): string | null {
  return identifier && identifier.trim().length > 0 ? identifier : null;
}

function signatureForNode(node: SnapshotNode): RefSignature {
  return {
    type: node.type ?? '',
    label: node.label,
    identifier: node.identifier,
    rect: node.rect,
  };
}

function rectsMatch(
  a: NonNullable<SnapshotNode['rect']>,
  b: NonNullable<SnapshotNode['rect']>,
  tolerance = 8,
): boolean {
  return (
    Math.abs(a.x + a.width / 2 - (b.x + b.width / 2)) <= tolerance &&
    Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= tolerance &&
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance
  );
}

// Every node carrying the testID counts, whatever its type; proven XCUI echoes collapse in the shared identity model.
function nodesWithTestID(nodes: SnapshotNode[], id: string): SnapshotNode[] {
  return exactIdentities(
    join(nodes as unknown as NativeNode[], []),
    { quoted: id, phrase: id, exact: 'id' },
    'fill',
  ).flatMap(({ element }) => nodes.filter((n) => n.ref === element.ref));
}

// A positional @eN may only bind when its identity still matches the
// signature captured BEFORE this binding snapshot; a shifted generation
// rebinds by unique identity or rejects — never by recycled position.
export function bindExactFillTarget(
  nodes: SnapshotNode[],
  rawRef: string,
  priorSignature?: RefSignature | null,
): ExactBindOutcome {
  const clean = rawRef.replace(/^@/, '');
  const positional = /^e\d+$/.test(clean);
  let node: SnapshotNode | undefined;
  if (positional) {
    const hasRobustIdentity =
      priorSignature !== null &&
      priorSignature !== undefined &&
      ((priorSignature.identifier?.trim().length ?? 0) > 0 ||
        (priorSignature.label?.trim().length ?? 0) > 0);
    if (!hasRobustIdentity) {
      return {
        ok: false,
        detail: `ref @${clean} has no robust pre-refresh identity for unique rebinding`,
      };
    }
    const signature = priorSignature as RefSignature;
    const signatureIdentifier = inputTestId(signature.identifier);
    const matches =
      signatureIdentifier !== null
        ? nodesWithTestID(nodes, signatureIdentifier)
        : nodes.filter((n) => {
            if (
              (n.type ?? '') !== signature.type ||
              n.label !== signature.label ||
              inputTestId(n.identifier) !== null
            )
              return false;
            if (signature.rect !== undefined && n.rect !== undefined) {
              return rectsMatch(n.rect, signature.rect);
            }
            return n.label === signature.label && inputTestId(n.identifier) === null;
          });
    if (matches.length !== 1) {
      return {
        ok: false,
        ...(matches.length > 1 ? { ambiguous: true as const } : {}),
        detail: `ref @${clean} identity ${matches.length > 1 ? 'matches multiple elements' : 'is absent'} in the current snapshot`,
      };
    }
    node = matches[0];
  } else {
    const matches = nodesWithTestID(nodes, clean);
    if (matches.length === 0) {
      return { ok: false, detail: `no element with testID "${clean}" in the current snapshot` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        ambiguous: true,
        detail: `testID "${clean}" matches ${matches.length} elements — duplicate identifiers cannot bind an exact input`,
      };
    }
    node = matches[0];
  }
  if (isRecognizedInputType(node.type)) {
    return {
      ok: true,
      binding: {
        inputRef: `@${cleanNodeRef(node)}`,
        inputTestId: inputTestId(node.identifier),
        inputSignature: signatureForNode(node),
        focusRef: `@${cleanNodeRef(node)}`,
        wrapper: false,
        secure: isSecureInputNode(node),
      },
    };
  }
  const id = node.identifier;
  if (id?.endsWith(PRESSABLE_SUFFIX)) {
    const base = id.slice(0, -PRESSABLE_SUFFIX.length);
    if (base) {
      const named = nodesWithTestID(nodes, base);
      if (named.length > 1)
        return {
          ok: false,
          ambiguous: true,
          detail: `wrapper "${id}" maps to ${named.length} elements with testID "${base}" — ambiguous`,
        };
      const inputs = named.filter((n) => isRecognizedInputType(n.type));
      if (inputs.length === 1) {
        return {
          ok: true,
          binding: {
            inputRef: `@${cleanNodeRef(inputs[0])}`,
            inputTestId: base,
            inputSignature: signatureForNode(inputs[0]),
            focusRef: `@${cleanNodeRef(node)}`,
            wrapper: true,
            secure: isSecureInputNode(inputs[0]),
          },
        };
      }
      return {
        ok: false,
        unobservable: true,
        detail: `wrapper "${id}" has no recognized input with testID "${base}" in the current snapshot`,
      };
    }
  }
  return {
    ok: false,
    unobservable: true,
    detail: `element @${cleanNodeRef(node)} (${node.type ?? 'unknown type'}) is not a recognized text input — pass the inner input's ref or testID`,
  };
}

// --- Press (enhanced with doubleTap, count, holdMs, waitForFocusMs) ---

interface PressArgs {
  qaTiming?: TimingContext;
  qaContext?: QaDispatchContext;
  ref?: string;
  x?: number;
  y?: number;
  doubleTap?: boolean;
  count?: number;
  holdMs?: number;
  waitForFocusMs?: number;
  settleTimeoutMs?: number;
  retryIfNoChange?: boolean;
}

// Story 04 (#385): thread a caller-supplied settle budget into runNative.
function settleOpts(args: {
  settleTimeoutMs?: number;
  qaContext?: QaDispatchContext;
  qaTiming?: TimingContext;
}): {
  qaTiming?: TimingContext;
  qaContext?: QaDispatchContext;
  settle?: { timeoutMs: number };
} {
  return {
    ...(args.qaTiming ? { qaTiming: args.qaTiming } : {}),
    ...(args.qaContext ? { qaContext: args.qaContext } : {}),
    ...(args.settleTimeoutMs !== undefined ? { settle: { timeoutMs: args.settleTimeoutMs } } : {}),
  };
}

// Story 05 (#386): thread caller-supplied settle and retryIfNoChange into runNative opts.
function interactOpts(args: {
  settleTimeoutMs?: number;
  retryIfNoChange?: boolean;
  qaContext?: QaDispatchContext;
  qaTiming?: TimingContext;
}): {
  qaContext?: QaDispatchContext;
  qaTiming?: TimingContext;
  settle?: { timeoutMs: number };
  retryIfNoChange?: boolean;
} {
  return {
    ...settleOpts(args),
    ...(args.retryIfNoChange !== undefined ? { retryIfNoChange: args.retryIfNoChange } : {}),
  };
}

function snapshotNodes(result: unknown): FlatNode[] | null {
  try {
    const envelope = JSON.parse((result as ToolResult).content[0].text) as {
      ok?: boolean;
      data?: { nodes?: FlatNode[] };
    };
    return envelope.ok !== false && Array.isArray(envelope.data?.nodes)
      ? envelope.data.nodes
      : null;
  } catch {
    return null;
  }
}

// The heal retries the identity the refused tap named, never whatever its refreshed ref now names.
function keyboardHealDeps(
  getClient: () => CDPClient,
  tapAt: (ref?: string) => Promise<ToolResult>,
  qaContext?: QaDispatchContext,
  target?: { ref: string; identity: RefSignature | null },
): KeyboardAutoHealDeps | null {
  const client = cdpClientOrNull(getClient);
  if (!client) return null;
  let refreshed: unknown;
  return {
    dismissViaJs: async () => {
      qaContext?.authorize();
      const r = await client.evaluate('__QAREN.dismissKeyboard()');
      if (typeof r.value !== 'string') return false;
      try {
        const parsed = JSON.parse(r.value) as { dismissed?: boolean } | null;
        return parsed?.dismissed === true;
      } catch {
        return false;
      }
    },
    refreshSnapshot: async () =>
      // Identity re-resolution counts every node, not only interactive ones.
      (refreshed = await runNative(['snapshot', '--full'], {
        qaContext,
        qaReadOnly: qaContext !== undefined,
      })),
    retryTap: async () => {
      if (!target) return tapAt();
      const nodes = snapshotNodes(refreshed);
      const outcome =
        target.identity && nodes ? refreshRef(target.identity, nodes) : { kind: 'absent' as const };
      if (outcome.kind === 'unique') return tapAt(outcome.node.ref);
      return failResult(
        `Element at ref ${target.ref} did not re-resolve to exactly one element after the keyboard was dismissed — refusing to guess-tap`,
        outcome.kind === 'ambiguous' ? 'TARGET_AMBIGUOUS' : 'STALE_REF',
        { reResolution: outcome.kind, mutation: 'none' },
      );
    },
  };
}

export function createDevicePressHandler(
  getClient: () => CDPClient,
): (args: PressArgs) => Promise<ToolResult> {
  return withQaSession(async (args) => {
    const hasRef = typeof args.ref === 'string' && args.ref.length > 0;
    const hasCoordinates = args.x !== undefined && args.y !== undefined;
    if (hasRef === hasCoordinates) {
      return failResult(
        'Provide exactly one press target: ref, or both x and y coordinates',
        'INVALID_ARGUMENT',
      );
    }
    const target = hasRef ? (args.ref!.startsWith('@') ? args.ref! : `@${args.ref!}`) : undefined;
    const flags: string[] = [];
    if (args.doubleTap) flags.push('--double-tap');
    if (args.count && args.count > 1) flags.push('--count', String(args.count));
    if (args.holdMs && args.holdMs > 0) flags.push('--hold-ms', String(args.holdMs));
    const identity = target ? getCachedSignature(target) : null;
    const tap = async (ref = target): Promise<ToolResult> =>
      surfaceKeyboardGuard(
        await runNative(
          [...(ref ? ['press', ref] : ['press', String(args.x!), String(args.y!)]), ...flags],
          interactOpts(args),
        ),
      );
    let result = await tap();
    if (result.isError) {
      result = await healKeyboardOccludedTap(
        result,
        keyboardHealDeps(
          getClient,
          tap,
          args.qaContext,
          target ? { ref: target, identity } : undefined,
        ),
        args.qaContext,
      );
    }
    if (!result.isError && args.waitForFocusMs && args.waitForFocusMs > 0) {
      await cancellableSleep(args.waitForFocusMs);
    }
    return result;
  });
}

// --- Long Press ---

interface LongPressArgs {
  ref?: string;
  x?: number;
  y?: number;
  durationMs?: number;
  retryIfNoChange?: boolean;
}

export function createDeviceLongPressHandler(
  getClient: () => CDPClient,
): (args: LongPressArgs) => Promise<ToolResult> {
  return withSession(async (args) => {
    const target = args.ref ? (args.ref.startsWith('@') ? args.ref : `@${args.ref}`) : undefined;
    let cliArgs: (ref?: string) => string[];
    if (target) {
      cliArgs = (ref = target) => ['press', ref, '--hold-ms', String(args.durationMs ?? 1000)];
    } else if (args.x != null && args.y != null) {
      cliArgs = () => [
        'longpress',
        String(args.x),
        String(args.y),
        ...(args.durationMs ? [String(args.durationMs)] : []),
      ];
    } else {
      return failResult('Provide either ref or x+y coordinates');
    }
    const identity = target ? getCachedSignature(target) : null;
    const tap = async (ref?: string): Promise<ToolResult> =>
      surfaceKeyboardGuard(await runNative(cliArgs(ref), interactOpts(args)));
    const result = await tap();
    if (result.isError) {
      return healKeyboardOccludedTap(
        result,
        keyboardHealDeps(getClient, tap, undefined, target ? { ref: target, identity } : undefined),
      );
    }
    return result;
  });
}

// --- Fill (exact target + final verification — GH #581) ---

export interface FillArgs {
  qaTiming?: TimingContext;
  qaContext?: QaDispatchContext;
  ref: string;
  text: string;
  /** Bounded in-operation focus wait forwarded to the runner (default 1500ms). */
  waitForKeyboardMs?: number;
  /** Explicit native testID; it must equal the exact bound input's current identifier. */
  testID?: string;
  /** Type into the field that already has keyboard focus instead of binding an input. */
  focused?: boolean;
  /** With focused: refuse before typing when the React read of the intended input reports it unfocused. */
  vetoUnfocused?: boolean;
  requireFocused?: boolean;
  skipFinalValidation?: boolean;
  /** Replace the field's content instead of appending. */
  clearFirst?: boolean;
  privateValue?: boolean;
  /** Story 04 (#385): per-call settle budget override in ms. */
  settleTimeoutMs?: number;
}

function isSetTextRejectedError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  try {
    const envelope = JSON.parse(text) as { code?: string };
    return envelope.code === 'SET_TEXT_REJECTED';
  } catch {
    return false;
  }
}

// Story 10 (#391): typing telemetry the iOS runner attaches to its `type`
// response (two-burst recipe + keyboard-presence wait). Surfaced as
// meta.typing when device_fill re-wraps the runner envelope.
export function extractTypingMeta(
  result: ToolResult,
): { burst?: boolean; keyboardWaitMs?: number } | null {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      data?: { typingBurst?: boolean; keyboardWaitMs?: number };
    };
    const data = envelope.data;
    if (!data || (data.typingBurst === undefined && data.keyboardWaitMs === undefined)) return null;
    return {
      ...(data.typingBurst !== undefined ? { burst: data.typingBurst } : {}),
      ...(data.keyboardWaitMs !== undefined ? { keyboardWaitMs: data.keyboardWaitMs } : {}),
    };
  } catch {
    return null;
  }
}

function extractSettleMeta(result: ToolResult): { settle?: unknown; settleMs?: number } {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      meta?: { settle?: unknown; timings_ms?: { settle?: number } };
    };
    const out: { settle?: unknown; settleMs?: number } = {};
    if (envelope.meta?.settle !== undefined) out.settle = envelope.meta.settle;
    if (typeof envelope.meta?.timings_ms?.settle === 'number') {
      out.settleMs = envelope.meta.timings_ms.settle;
    }
    return out;
  } catch {
    return {};
  }
}

export function cdpClientOrNull(getClient: () => CDPClient): CDPClient | null {
  try {
    const client = getClient();
    return client?.isConnected ? client : null;
  } catch {
    return null;
  }
}

export type FillMutationDisposition = 'none' | 'observed' | 'possible';

// Conservative default: an unlabeled failure after dispatch may have mutated.
export function extractMutationDisposition(result: ToolResult): FillMutationDisposition {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
      meta?: { mutation?: unknown };
    };
    const m = envelope.meta?.mutation;
    if (m === 'none' || m === 'observed' || m === 'possible') return m;
  } catch {
    /* fall through */
  }
  return 'possible';
}

function extractErrorText(result: ToolResult): string {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as { error?: string };
    return typeof envelope.error === 'string' ? envelope.error : 'unknown runner error';
  } catch {
    return 'unknown runner error';
  }
}

function extractErrorCode(result: ToolResult): string | undefined {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as { code?: unknown };
    return typeof envelope.code === 'string' ? envelope.code : undefined;
  } catch {
    return undefined;
  }
}

const NATIVE_VERIFY_VERDICTS = new Set([
  'exact',
  'mismatch',
  'case-normalized',
  'unreadable',
  'secure-masked',
  'target-lost',
  'ambiguous',
]);

async function runNativeVerifyInput(
  binding: ExactFillBinding,
  text: string,
  operationToken?: string,
  qaContext?: QaDispatchContext,
): Promise<{ verdict: NativeVerifyVerdict; stable: boolean }> {
  const result = await runNative(['verify-input', binding.inputRef, text], {
    qaContext,
    settle: { enabled: false },
    exactTarget: {
      inputRef: binding.inputRef,
      secure: binding.secure,
      ...(operationToken ? { operationToken } : {}),
    },
  });
  if (result.isError) return { verdict: 'unavailable', stable: false };
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      data?: { verifyVerdict?: string; verifyStable?: boolean };
    };
    const v = envelope.data?.verifyVerdict;
    if (typeof v === 'string' && NATIVE_VERIFY_VERDICTS.has(v)) {
      return { verdict: v as NativeVerifyVerdict, stable: envelope.data?.verifyStable === true };
    }
  } catch {
    /* fall through */
  }
  return { verdict: 'unavailable', stable: false };
}

async function finalVerification(
  binding: ExactFillBinding,
  text: string,
  operationToken: string,
  qaContext?: QaDispatchContext,
  qaTiming?: TimingContext,
): Promise<NativeVerification> {
  return measureTiming(
    qaTiming?.observe,
    qaTiming?.now ?? (() => performance.now()),
    'type-readback',
    async () => {
      const native = await measureDispatchPhase('dispatch-readback', qaContext?.line, () =>
        runNativeVerifyInput(binding, text, operationToken, qaContext),
      );
      return classifyNativeVerification(native.verdict, native.stable);
    },
    (result) =>
      result.verified ? 'ok' : result.evidence === 'unavailable' ? 'unavailable' : 'failed',
  );
}

type FillMethod = 'native';

// The ONLY producer of public fill success (single-success-rule invariant).
function verifiedFillResult(
  method: FillMethod,
  textLength: number,
  meta: Record<string, unknown>,
): ToolResult {
  return okResult(
    { filled: true, method, length: textLength },
    { meta: { ...meta, verify: 'exact' } },
  );
}

interface FillFailureOpts {
  mutation: FillMutationDisposition;
  pathsTried: string[];
  verification?: NativeVerification;
  hint?: string;
}

function fillFailure(
  code:
    | 'NO_TEXT_INPUT_TARGET'
    | 'FOCUS_TARGET_OCCLUDED'
    | 'TEXT_ENTRY_UNVERIFIED'
    | 'TARGET_AMBIGUOUS',
  message: string,
  opts: FillFailureOpts,
): ToolResult {
  return failResult(message, code, {
    mutation: opts.mutation,
    pathsTried: opts.pathsTried,
    ...(opts.verification
      ? {
          verification: {
            evidence: opts.verification.evidence,
            native: opts.verification.native,
            nativeStable: opts.verification.nativeStable,
          },
        }
      : {}),
    hint:
      opts.hint ??
      (code === 'TARGET_AMBIGUOUS'
        ? 'The target identity is ambiguous; do not retry this fill.'
        : opts.mutation === 'none'
          ? 'No text was entered. Refresh the snapshot (device_snapshot action=snapshot) and rebind the input before retrying.'
          : 'The field may have been mutated. Read the field state with device_snapshot before any manual retry — do not blindly re-run device_fill.'),
  });
}

function attachFillFailureDisposition(
  result: ToolResult,
  mutation: FillMutationDisposition,
  pathsTried: string[],
): ToolResult {
  try {
    const envelope = JSON.parse(result.content[0]?.text ?? '{}') as {
      error?: unknown;
      code?: unknown;
      meta?: Record<string, unknown>;
    };
    const error = typeof envelope.error === 'string' ? envelope.error : 'Text entry was refused.';
    const meta = {
      ...envelope.meta,
      mutation,
      pathsTried,
      hint:
        mutation === 'none'
          ? 'No text was entered. Refresh the snapshot (device_snapshot action=snapshot) and rebind the input before retrying.'
          : 'The field may have been mutated. Read the field state with device_snapshot before any manual retry — do not blindly re-run device_fill.',
    };
    return typeof envelope.code === 'string'
      ? failResult(error, envelope.code as never, meta)
      : failResult(error, meta);
  } catch {
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'Text entry was refused.', {
      mutation,
      pathsTried,
    });
  }
}

export interface ExactFillTiers {
  abortSignal?: AbortSignal;
}

// GH #581 exact fill orchestrator (device_fill and device_batch's fill step):
// bind exactly one native input and emit success only from stable exact native verification.
export async function performExactFill(
  args: FillArgs,
  _client: CDPClient | null,
  tiers: ExactFillTiers,
): Promise<ToolResult> {
  const pathsTried: string[] = [];
  let mutationSeen: FillMutationDisposition = 'none';

  // Capture the positional ref's identity BEFORE the binding snapshot so a
  // refreshed generation can only rebind by identity, never by recycled id.
  const cleanRefForSignature = args.ref.replace(/^@/, '');
  const cachedSignature = /^e\d+$/.test(cleanRefForSignature)
    ? getCachedSignature(cleanRefForSignature)
    : null;
  const cachedRect = cachedSignature ? lookupRef(cleanRefForSignature) : null;
  const priorSignature =
    cachedSignature && cachedRect ? { ...cachedSignature, rect: cachedRect } : cachedSignature;

  const snap = args.qaContext
    ? await measureDispatchPhase('dispatch-bind', args.qaContext.line, () =>
        fetchSnapshotNodesForSameScreenProof(args.qaContext!),
      )
    : await fetchSnapshotNodes(true);
  if (!snap.ok) {
    if (snap.reason === 'runner-leak-unrecovered') {
      return attachFillFailureDisposition(
        runnerLeakFailResult(args.ref, snap.recoveryReason),
        'none',
        pathsTried,
      );
    }
    return fillFailure(
      'NO_TEXT_INPUT_TARGET',
      `device_fill could not snapshot the screen to bind "${args.ref}" (${snap.reason}); no text was entered.`,
      { mutation: 'none', pathsTried },
    );
  }
  const bind = bindExactFillTarget(snap.nodes, args.ref, priorSignature);
  if (!bind.ok) {
    if (bind.ambiguous)
      return failResult(
        `TARGET_AMBIGUOUS: device_fill found more than one element for the target: ${bind.detail}. No text was entered.`,
        'TARGET_AMBIGUOUS',
        { mutation: 'none', pathsTried },
      );
    if (!bind.unobservable) args.qaContext?.invalidate();
    const focusedHint =
      getActiveSession()?.platform !== 'android' &&
      (bind.detail.startsWith('wrapper "') ||
        bind.detail.includes('is not a recognized text input'))
        ? ' If you already tapped this field and the software keyboard is up, retry with focused: true.'
        : '';
    return fillFailure(
      'NO_TEXT_INPUT_TARGET',
      `device_fill could not bind an exact input: ${bind.detail}. No text was entered.${focusedHint}`,
      { mutation: 'none', pathsTried },
    );
  }
  const binding = bind.binding;

  if (args.testID && args.testID !== binding.inputTestId) {
    return fillFailure(
      'NO_TEXT_INPUT_TARGET',
      `device_fill could not prove that testID "${args.testID}" identifies the bound input. No text was entered.`,
      { mutation: 'none', pathsTried },
    );
  }
  pathsTried.push('native');
  if (tiers.abortSignal?.aborted) {
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'device_fill was cancelled before native typing.', {
      mutation: mutationSeen === 'none' ? 'none' : 'possible',
      pathsTried,
    });
  }
  const focusCenter = isRefMapFresh() ? refCenter(binding.focusRef) : null;
  const exactTarget = {
    inputRef: binding.inputRef,
    ...(focusCenter ? { focusX: focusCenter.x, focusY: focusCenter.y } : {}),
    ...(args.waitForKeyboardMs !== undefined ? { focusWaitMs: args.waitForKeyboardMs } : {}),
  };
  const tNative = Date.now();
  const operationToken = randomUUID();
  const primary = await runNative(
    // A fill replaces the field's content; verification expects exactly args.text.
    ['fill', binding.inputRef, args.text, '--clear-first'],
    {
      ...settleOpts(args),
      exactTarget: { ...exactTarget, operationToken },
    },
  );
  if (primary.isError) {
    const mutation = extractMutationDisposition(primary);
    if (isSetTextRejectedError(primary)) {
      if (mutation === 'possible') {
        return fillFailure(
          'TEXT_ENTRY_UNVERIFIED',
          `device_fill's native attempt may have mutated the field before rejecting text entry: ${extractErrorText(primary)}`,
          { mutation: 'possible', pathsTried },
        );
      }
      if (mutation === 'observed') {
        mutationSeen = 'observed';
        const verification = await finalVerification(
          binding,
          args.text,
          operationToken,
          args.qaContext,
          args.qaTiming,
        );
        if (verification.verified) {
          return verifiedFillResult('native', args.text.length, {
            textEntryPath: 'native',
            verifiedOracle: 'native',
            recovered: 'post-error-exact-readback',
            timings_ms: { nativeType: Date.now() - tNative },
          });
        }
        return fillFailure(
          'TEXT_ENTRY_UNVERIFIED',
          'device_fill observed a rejected native mutation but could not verify the retained target; not retrying.',
          {
            mutation: verification.observedMismatch ? 'observed' : 'possible',
            pathsTried,
            verification,
          },
        );
      }
      return fillFailure(
        'TEXT_ENTRY_UNVERIFIED',
        'device_fill could not verify the fill through the retained native target.',
        { mutation: 'none', pathsTried },
      );
    }
    if (mutation === 'none') {
      const code = extractErrorCode(primary);
      return fillFailure(
        code === 'FOCUS_TARGET_OCCLUDED' || code === 'TARGET_AMBIGUOUS'
          ? code
          : 'NO_TEXT_INPUT_TARGET',
        `device_fill's native attempt was refused before mutation: ${extractErrorText(primary)}`,
        { mutation: 'none', pathsTried },
      );
    }
    const verification = await finalVerification(
      binding,
      args.text,
      operationToken,
      args.qaContext,
      args.qaTiming,
    );
    if (verification.verified) {
      return verifiedFillResult('native', args.text.length, {
        textEntryPath: 'native',
        verifiedOracle: 'native',
        recovered: 'post-error-exact-readback',
        timings_ms: { nativeType: Date.now() - tNative },
      });
    }
    return fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      `device_fill's native attempt failed and the field could not be verified: ${extractErrorText(primary)}`,
      { mutation, pathsTried, verification },
    );
  }
  mutationSeen = 'observed';
  const primarySettle = extractSettleMeta(primary);
  const primaryTyping = extractTypingMeta(primary);
  const verification = await finalVerification(
    binding,
    args.text,
    operationToken,
    args.qaContext,
    args.qaTiming,
  );
  if (verification.verified) {
    return verifiedFillResult('native', args.text.length, {
      textEntryPath: 'native',
      verifiedOracle: 'native',
      ...(primaryTyping ? { typing: primaryTyping } : {}),
      ...(primarySettle.settle !== undefined ? { settle: primarySettle.settle } : {}),
      timings_ms: {
        nativeType: Date.now() - tNative,
        ...(primarySettle.settleMs !== undefined ? { settle: primarySettle.settleMs } : {}),
      },
    });
  }
  if (verification.evidence === 'case-normalized') {
    return fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      'device_fill typed the value and the field changed only its letter case; not verified, not retrying.',
      { mutation: mutationSeen, pathsTried, verification },
    );
  }
  return fillFailure(
    'TEXT_ENTRY_UNVERIFIED',
    verification.observedMismatch
      ? 'device_fill typed a different value on the retained native target; not retrying.'
      : 'device_fill typed but the retained native target could not be verified; not retrying.',
    {
      mutation: verification.observedMismatch ? mutationSeen : 'possible',
      pathsTried,
      verification,
    },
  );
}

export async function readReactInputValue(
  client: CDPClient | null,
  testID: string | null | undefined,
  options?: { focusOnly?: boolean; privateValue?: boolean; protectSecure?: boolean },
): Promise<{
  value: string | null;
  controlled: boolean;
  focused: boolean;
  privateValue?: boolean;
} | null> {
  if (!client || !testID) return null;
  try {
    const result = await client.evaluate(
      '__QAREN.readInputValue(' +
        JSON.stringify(testID) +
        (options ? ',' + JSON.stringify(options) : '') +
        ')',
    );
    if (result.error || typeof result.value !== 'string') return null;
    const parsed: {
      value?: string | null;
      controlled?: boolean;
      focused?: boolean;
      privateValue?: boolean;
      __agent_error?: string;
    } = JSON.parse(result.value);
    if (parsed.__agent_error) return null;
    return {
      value: parsed.value ?? null,
      controlled: parsed.controlled === true,
      focused: parsed.focused === true,
      ...(parsed.privateValue === true ? { privateValue: true } : {}),
    };
  } catch {
    return null;
  }
}

type ReactValueVerification = 'exact' | 'mismatch' | 'unreadable';

async function awaitReactInputValue(
  readInput: () => Promise<{ value: string | null; controlled: boolean } | null>,
  expected: string,
  signal?: AbortSignal,
): Promise<{ verdict: ReactValueVerification; observed?: string }> {
  let previous: { value: string | null; controlled: boolean } | null = null;
  let last: { value: string | null; controlled: boolean } | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    if (signal?.aborted) break;
    const read = await readInput();
    if (read?.controlled && read.value === expected) {
      await cancellableSleep(150);
      if (signal?.aborted) return { verdict: 'unreadable' };
      const confirm = await readInput();
      return {
        verdict:
          confirm?.controlled === true && confirm.value === expected ? 'exact' : 'unreadable',
      };
    }
    if (read) {
      previous = last;
      last = read;
    } else {
      previous = null;
      last = null;
    }
    if (attempt < 5) await cancellableSleep(100);
  }
  return last?.controlled === true &&
    previous?.controlled === true &&
    last.value !== null &&
    last.value === previous.value
    ? { verdict: 'mismatch', observed: last.value }
    : { verdict: 'unreadable' };
}

// Same length and equal ignoring letter case, but not identical: the app normalized case only.
function caseOnly(observed: string | undefined, expected: string): boolean {
  return (
    observed !== undefined &&
    observed !== expected &&
    [...observed].length === [...expected].length &&
    observed.toLowerCase() === expected.toLowerCase()
  );
}

// The observed length when the field holds a nonempty, strictly shorter in-order subset of what was typed.
function droppedLength(observed: string | undefined, expected: string): number | undefined {
  if (observed === undefined) return undefined;
  const typed = [...expected];
  const held = [...observed];
  if (held.length === 0 || held.length >= typed.length) return undefined;
  let next = 0;
  for (const char of typed) if (next < held.length && held[next] === char) next++;
  return next === held.length ? held.length : undefined;
}

// The requested identity itself; a wrapper id is never rewritten to an unobserved inner id.
function focusedFillOracleTestId(args: FillArgs): string | null {
  if (args.testID) return args.testID;
  const clean = args.ref.replace(/^@/, '');
  return /^e\d+$/.test(clean) ? null : clean;
}

function extractTextEntryRoute(result: ToolResult): string | undefined {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      data?: { textEntryRoute?: unknown };
    };
    return typeof envelope.data?.textEntryRoute === 'string'
      ? envelope.data.textEntryRoute
      : undefined;
  } catch {
    return undefined;
  }
}

function controlledReactValue(
  read: { value: string | null; controlled: boolean } | null,
): string | null {
  if (!read?.controlled) return null;
  return read.value ?? '';
}

export async function performFocusedFill(
  args: FillArgs,
  client: CDPClient | null,
): Promise<ToolResult> {
  const pathsTried = ['focused'];
  if (getActiveSession()?.platform === 'android') {
    return fillFailure(
      'NO_TEXT_INPUT_TARGET',
      'device_fill focused: true is iOS-only in this version; no text was entered.',
      { mutation: 'none', pathsTried },
    );
  }
  const oracleTestId = focusedFillOracleTestId(args);
  let before: string | null = null;
  let privateValue = args.privateValue === true;
  let expectedBeforeClear: string | null | undefined;
  const focusedProof = async (focusOnly = false): Promise<boolean> => {
    const read = await readReactInputValue(client, oracleTestId, {
      protectSecure: true,
      ...(focusOnly ? { focusOnly: true } : {}),
      ...(privateValue ? { privateValue: true } : {}),
    });
    if (focusOnly) return read?.focused === true;
    privateValue ||= read?.privateValue === true;
    before = controlledReactValue(read);
    return (
      read?.focused === true &&
      (expectedBeforeClear === undefined || before === expectedBeforeClear)
    );
  };
  const dispatchFill = async (deleteCount?: number, observed?: string): Promise<ToolResult> => {
    expectedBeforeClear = observed;
    if (args.clearFirst) {
      if (!(await focusedProof())) {
        return failResult(
          'The intended input is not focused; no text was entered.',
          'NO_TEXT_INPUT_TARGET',
          { mutation: 'none' },
        );
      }
      expectedBeforeClear = before;
      deleteCount ??= before?.length || undefined;
      if (deleteCount !== undefined && deleteCount > 256) {
        return failResult(
          'Focused replacement exceeds its bounded clear budget.',
          'TEXT_ENTRY_UNVERIFIED',
          { mutation: 'none' },
        );
      }
    }
    return runNative(['fill', args.ref, args.text, ...(args.clearFirst ? ['--clear-first'] : [])], {
      qaContext: args.qaContext,
      qaTiming: args.qaTiming,
      focusedType: true,
      focusedProof,
      focusedDeleteCount: deleteCount,
      settle: { enabled: false },
    });
  };
  const native = await dispatchFill();
  if (native.isError) {
    const mutation = extractMutationDisposition(native);
    if (mutation === 'none') {
      const code = extractErrorCode(native);
      return fillFailure(
        code === 'TARGET_AMBIGUOUS' || code === 'TEXT_ENTRY_UNVERIFIED'
          ? code
          : 'NO_TEXT_INPUT_TARGET',
        extractErrorText(native),
        {
          mutation: 'none',
          pathsTried,
          ...(code === 'TEXT_SYNTHESIS_UNAVAILABLE'
            ? {
                hint: 'No text was entered. This Xcode cannot synthesize text, so device_fill focused: true cannot type here. Do not retry focused: true.',
              }
            : {}),
        },
      );
    }
    return fillFailure('TEXT_ENTRY_UNVERIFIED', extractErrorText(native), {
      mutation: 'possible',
      pathsTried,
    });
  }
  const textEntryRoute = extractTextEntryRoute(native);
  const unverified = (
    kept?: { typedLength: number; observedLengths: number[] } | { caseNormalizedChars: number },
  ) =>
    warnResult(
      {
        typed: true,
        chars: args.text.length,
        verified: false,
        verifiedOracle: 'none',
        textEntryPath: 'focused-synthesized',
        textEntryRoute,
        ...kept,
      },
      'Typed into the focused field; the value could not be confirmed. Confirm with device_screenshot or expect_text before relying on it.',
    );
  const initialBefore = before;
  const boundedClear = async (
    deleteCount: number,
    observed: string,
  ): Promise<ToolResult | null> => {
    if (deleteCount < 1 || deleteCount > 256 || args.qaContext?.expired) {
      return fillFailure(
        'TEXT_ENTRY_UNVERIFIED',
        'Focused replacement could not clear within its bounded budget.',
        { mutation: 'observed', pathsTried },
      );
    }
    const result = await dispatchFill(deleteCount, observed);
    return result.isError
      ? fillFailure('TEXT_ENTRY_UNVERIFIED', extractErrorText(result), {
          mutation: extractMutationDisposition(result) === 'none' ? 'observed' : 'possible',
          pathsTried,
        })
      : null;
  };
  if (privateValue || initialBefore === null) {
    await measureTiming(
      args.qaTiming?.observe,
      args.qaTiming?.now ?? (() => performance.now()),
      'type-readback',
      async () => undefined,
      () => 'unavailable',
    );
    return unverified();
  }
  const expected = (args.clearFirst ? '' : initialBefore) + args.text;
  const readBack = () =>
    measureTiming(
      args.qaTiming?.observe,
      args.qaTiming?.now ?? (() => performance.now()),
      'type-readback',
      () =>
        measureDispatchPhase('dispatch-readback', args.qaContext?.line, () =>
          awaitReactInputValue(
            () => readReactInputValue(client, oracleTestId, { protectSecure: true, privateValue }),
            expected,
          ),
        ),
      (result) =>
        result.verdict === 'exact'
          ? 'ok'
          : result.verdict === 'unreadable'
            ? 'unavailable'
            : 'failed',
    );
  const verified = () =>
    verifiedFillResult('native', args.text.length, {
      textEntryPath: 'focused-synthesized',
      verifiedOracle: 'react-tree',
      textEntryRoute,
    });
  const retainedPrefix = (
    verification: Awaited<ReturnType<typeof readBack>>,
    dispatchBefore: string | null,
  ) =>
    args.clearFirst &&
    verification.verdict === 'mismatch' &&
    verification.observed !== undefined &&
    verification.observed.endsWith(args.text) &&
    verification.observed.length > args.text.length &&
    [initialBefore, dispatchBefore].some(
      (value) =>
        value !== null && value.startsWith(verification.observed!.slice(0, -args.text.length)),
    );
  const replacementFailure = () =>
    fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      'device_fill could not verify replacement after one clear-and-retype; not retrying.',
      { mutation: 'observed', pathsTried },
    );
  const verification = await readBack();
  if (verification.verdict === 'exact') return verified();
  if (retainedPrefix(verification, initialBefore)) {
    const observed = verification.observed!;
    const failure = await boundedClear(observed.length, observed);
    if (failure) return failure;
    const cleared = await readBack();
    return cleared.verdict === 'exact' ? verified() : replacementFailure();
  }
  const caseNormalized =
    verification.verdict === 'mismatch' && caseOnly(verification.observed, expected)
      ? { caseNormalizedChars: [...expected].length }
      : undefined;
  if (caseNormalized) return unverified(caseNormalized);
  if (!args.skipFinalValidation) {
    if (verification.verdict === 'mismatch') {
      return fillFailure(
        'TEXT_ENTRY_UNVERIFIED',
        'device_fill typed into the focused field but its React value differs; not retrying.',
        { mutation: 'observed', pathsTried },
      );
    }
    return unverified();
  }
  // Host load can drop keystrokes on a controlled field; normalizing fields keep the unverified pass.
  const first = args.clearFirst ? droppedLength(verification.observed, expected) : undefined;
  if (first === undefined) return unverified();
  const lost = (held: number, why: string) =>
    fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      `typed ${[...expected].length} characters but the field holds ${held}${why}`,
      { mutation: 'observed', pathsTried },
    );
  if (args.qaContext?.expired) return lost(first, '; no step time remained to retype');
  const retyped = await dispatchFill();
  const retypeBefore = before;
  if (retyped.isError) {
    return extractMutationDisposition(retyped) === 'none'
      ? lost(first, '; the retype was refused')
      : fillFailure('TEXT_ENTRY_UNVERIFIED', extractErrorText(retyped), {
          mutation: 'possible',
          pathsTried,
        });
  }
  const second = await readBack();
  if (second.verdict === 'exact') return verified();
  if (retainedPrefix(second, retypeBefore)) return replacementFailure();
  const held = droppedLength(second.observed, expected);
  if (held === undefined) return unverified();
  // The same loss twice is the field's own stripping or maxLength: unverified, with the lengths disclosed.
  return held === first
    ? unverified({ typedLength: [...expected].length, observedLengths: [first, held] })
    : lost(held, ' after one clear-and-retype');
}

export async function performReactTreeInput(
  testID: string,
  text: string,
  client: CDPClient | null,
  signal?: AbortSignal,
  options: { designationToken?: string } = {},
): Promise<ToolResult> {
  const pathsTried = ['react-tree'];
  if (!client) {
    return fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      `React-tree input "${testID}" cannot be verified because the authoritative bundle is unavailable.`,
      { mutation: 'none', pathsTried },
    );
  }
  if (signal?.aborted) {
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'React-tree input was cancelled before mutation.', {
      mutation: 'none',
      pathsTried,
    });
  }
  const readInput = (): Promise<{ value: string | null; controlled: boolean } | null> =>
    readReactInputValue(client, testID);
  const designated = typeof options.designationToken === 'string';
  let requestedText = text;
  if (!designated) {
    const before = await readInput();
    if (signal?.aborted) {
      return fillFailure(
        'TEXT_ENTRY_UNVERIFIED',
        'React-tree input was cancelled before mutation.',
        {
          mutation: 'none',
          pathsTried,
        },
      );
    }
    if (!before?.controlled) {
      return fillFailure(
        'TEXT_ENTRY_UNVERIFIED',
        `React-tree input "${testID}" is uncontrolled or unreadable. Run this native text-entry check on a WDA-healthy runtime; secure masked native values are not plaintext proof.`,
        { mutation: 'none', pathsTried },
      );
    }
    requestedText = `${before.value ?? ''}${text}`;
  }
  let dispatch:
    | { handler: string; resultingText: string }
    | {
        error: string;
        mutation: 'none' | 'possible';
        code?: 'AMBIGUOUS_TESTID' | 'ASSERTION_FAILED' | 'INTERACTION_NOT_ACTUATED';
        focusOnly?: true;
      };
  try {
    const result = await client.evaluate(
      '__QAREN.interact(' +
        JSON.stringify({
          action: 'typeText',
          testID,
          text: requestedText,
          verify: true,
          ...(designated
            ? {
                requireLiveInputDesignation: true,
                designationToken: options.designationToken,
              }
            : {}),
        }) +
        ')',
    );
    if (result.error || typeof result.value !== 'string') {
      dispatch = { error: 'dispatch result is unavailable', mutation: 'possible' };
    } else {
      const parsed: {
        error?: string;
        code?: unknown;
        focusOnly?: boolean;
        handlerCalled?: string | false;
        controlled?: boolean;
        text?: string;
      } = JSON.parse(result.value);
      if (parsed.error) {
        const designationCode =
          parsed.code === 'AMBIGUOUS_TESTID' ||
          parsed.code === 'ASSERTION_FAILED' ||
          parsed.code === 'INTERACTION_NOT_ACTUATED'
            ? parsed.code
            : undefined;
        dispatch = {
          error: parsed.error,
          mutation: 'none',
          ...(designationCode ? { code: designationCode } : {}),
          ...(parsed.focusOnly === true ? { focusOnly: true } : {}),
        };
      } else if (
        typeof parsed.handlerCalled === 'string' &&
        parsed.controlled !== undefined &&
        typeof parsed.text === 'string'
      ) {
        dispatch = { handler: parsed.handlerCalled, resultingText: parsed.text };
      } else {
        dispatch = { error: 'dispatch result is inconclusive', mutation: 'possible' };
      }
    }
  } catch {
    dispatch = { error: 'dispatch result is unavailable', mutation: 'possible' };
  }
  if ('error' in dispatch) {
    if (dispatch.focusOnly) {
      return failResult(
        `React-tree input "${testID}" refused: ${dispatch.error}`,
        dispatch.code ?? 'TEXT_ENTRY_UNVERIFIED',
        {
          mutation: dispatch.mutation,
          pathsTried,
          focusOnly: true,
          hint: 'No text was entered. Refresh the snapshot (device_snapshot action=snapshot) and rebind the input before retrying.',
        },
      );
    }
    if (dispatch.code) {
      return failResult(`React-tree input "${testID}" refused: ${dispatch.error}`, dispatch.code, {
        mutation: dispatch.mutation,
        pathsTried,
      });
    }
    return fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      dispatch.mutation === 'possible'
        ? `React-tree input "${testID}" may have mutated but its onChangeText result is unknown.`
        : `React-tree input "${testID}" has no verifiable controlled onChangeText path.`,
      { mutation: dispatch.mutation, pathsTried },
    );
  }
  if (signal?.aborted) {
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'React-tree input was cancelled after mutation.', {
      mutation: 'possible',
      pathsTried,
    });
  }
  const expected = dispatch.resultingText;
  const verification = await awaitReactInputValue(readInput, expected, signal);
  if (verification.verdict !== 'exact') {
    return fillFailure(
      'TEXT_ENTRY_UNVERIFIED',
      `React-tree input "${testID}" dispatched onChangeText but exact fiber read-back was ${verification.verdict}.`,
      { mutation: 'possible', pathsTried },
    );
  }
  if (signal?.aborted) {
    return fillFailure('TEXT_ENTRY_UNVERIFIED', 'React-tree input was cancelled after mutation.', {
      mutation: 'possible',
      pathsTried,
    });
  }
  return okResult(
    { filled: true, method: 'js-onChangeText', length: text.length },
    {
      meta: {
        textEntryPath: 'react-tree',
        verifiedOracle: 'fiber',
        handler: dispatch.handler,
        appendedLength: text.length,
        resultingLength: expected.length,
        verify: 'exact',
      },
    },
  );
}

export function createDeviceFillHandler(
  getClient: () => CDPClient,
): (args: FillArgs) => Promise<ToolResult> {
  return withQaSession(async (args) =>
    args.focused === true
      ? performFocusedFill(args, cdpClientOrNull(getClient))
      : performExactFill(args, null, {}),
  );
}

// --- Swipe (coordinate-based with direction shortcut) ---

interface SwipeArgs {
  qaContext?: QaDispatchContext;
  direction?: 'up' | 'down' | 'left' | 'right';
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  durationMs?: number;
  count?: number;
  pattern?: 'one-way' | 'ping-pong';
  /**
   * B123: when true, REQUIRE fast-runner. The agent-device daemon caps swipe
   * duration at ~60ms via `safe-normalized` mode, which causes momentum
   * overshoot on UIDatePicker wheels and similar momentum-sensitive UIs.
   * Fast-runner uses the raw user-supplied duration with no clamp.
   * Fails with EXACT_REQUIRES_FAST_RUNNER when fast-runner unavailable
   * instead of silently degrading to a 60ms-capped daemon swipe.
   */
  exact?: boolean;
}

// Default screen dimensions for common devices — used when screen rect cache is empty.
// Covers iPhone 17 Pro / 15 Pro / 14 Pro Max and similar Android 1080x2400 phones.
const DEFAULT_SCREEN = { width: 402, height: 874 };
const SWIPE_FRACTION = 0.4;
// The middle of the band: chrome above the keyboard and the top bar sit at its edges.
const CLEARANCE_BAND_FRACTION = 0.6;
// shortcut: 48 covers Android's 8 dp touch slop up to 6x density and iOS's pan hysteresis; read the slop from the runner if a legitimate band is ever refused.
const MIN_DRAG_TRAVEL = 48;
const DEFAULT_SWIPE_DURATION_MS = 300;

function computeSwipeFromDirection(
  direction: 'up' | 'down' | 'left' | 'right',
  screen: { width: number; height: number },
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const dy = Math.round(screen.height * SWIPE_FRACTION);
  const dx = Math.round(screen.width * SWIPE_FRACTION);
  switch (direction) {
    // "swipe down" means finger moves from top to bottom (pull-to-refresh gesture)
    case 'down':
      return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy };
    // "swipe up" means finger moves from bottom to top
    case 'up':
      return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy };
    case 'left':
      return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy };
    case 'right':
      return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy };
  }
}

// Shared by the standalone swipe handler and device_batch so a batched
// "swipe" performs a real swipe gesture (not a scroll) and honors duration.
export function buildDirectionalSwipeCliArgs(
  direction: 'up' | 'down' | 'left' | 'right',
  durationMs?: number,
): string[] {
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const coords = computeSwipeFromDirection(direction, screen);
  const duration = durationMs ?? DEFAULT_SWIPE_DURATION_MS;
  return [
    'swipe',
    String(coords.x1),
    String(coords.y1),
    String(coords.x2),
    String(coords.y2),
    String(duration),
  ];
}

// A drag that starts or ends on a visible keyboard types or dismisses instead of scrolling.
function scrollBand(): { width: number; height: number } {
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const keyboardTop = getKeyboardTop();
  return keyboardTop !== null && keyboardTop > 0 && keyboardTop < screen.height
    ? { width: screen.width, height: keyboardTop }
    : screen;
}

type Band = { x?: number; y?: number; width: number; height: number };

// A caller-named band only narrows the keyboard-safe band, so the drag lands on the scrolled view.
function dragBand(within?: Band): Band {
  const band = scrollBand();
  if (!within) return { width: band.width, height: band.height };
  const bandTop = Math.max(within.y ?? 0, 0);
  const bandBottom = Math.min((within.y ?? 0) + within.height, band.height);
  if (bandBottom <= bandTop) return band;
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const androidInset = 48 * getScreenPointScale();
  const android = getActiveSession()?.platform === 'android';
  const top = Math.max(bandTop, android ? androidInset : 20);
  const bottom = Math.min(bandBottom, screen.height - (android ? androidInset : 34));
  return { x: within.x, y: top, width: within.width, height: Math.max(0, bottom - top) };
}

// A band too short for a real drag would be dispatched as a tap on whatever lies under the finger.
function bandTooSmall(band: Band): string | undefined {
  return band.height - 2 < MIN_DRAG_TRAVEL
    ? `the ${Math.round(band.height)}px band cannot host a ${MIN_DRAG_TRAVEL}px drag`
    : undefined;
}

// Scroll direction → finger gesture is INVERTED vs swipe ("scroll down" = content
// moves up = finger moves up) and scaled by `amount` (0..1). Centred half-spans
// keep the gesture inside the viewport.
// A caller band is precise, so a drag without a distance spans it a pixel inside each edge; a
// distance is clamped between the minimum drag and the span. The window fallback keeps its fractions.
function computeScrollFromDirection(
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number,
  screen: Band,
  distance?: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const cx = Math.round((screen.x ?? 0) + screen.width / 2);
  const cy = Math.round((screen.y ?? 0) + screen.height / 2);
  const caller = screen.x !== undefined || screen.y !== undefined;
  const span = caller ? screen.height - 2 : screen.height * CLEARANCE_BAND_FRACTION;
  const dy = Math.round(
    distance !== undefined && Number.isFinite(distance) && distance > 0
      ? Math.max(Math.min(distance, span), Math.min(MIN_DRAG_TRAVEL, span))
      : caller
        ? span
        : screen.height * SWIPE_FRACTION * amount,
  );
  const dx = Math.round(screen.width * SWIPE_FRACTION * amount);
  // Rounding the centre and the half-span up together can land an end on the band's edge row.
  const top = Math.max(cy - Math.round(dy / 2), Math.ceil((screen.y ?? 0) + 1));
  const bottom = Math.min(cy + Math.round(dy / 2), Math.floor((screen.y ?? 0) + screen.height - 1));
  switch (direction) {
    case 'down':
      return { x1: cx, y1: bottom, x2: cx, y2: top };
    case 'up':
      return { x1: cx, y1: top, x2: cx, y2: bottom };
    case 'left':
      return { x1: cx + Math.round(dx / 2), y1: cy, x2: cx - Math.round(dx / 2), y2: cy };
    case 'right':
      return { x1: cx - Math.round(dx / 2), y1: cy, x2: cx + Math.round(dx / 2), y2: cy };
  }
}

// Shared by the standalone scroll handler's daemon fallthrough and device_batch
// so a "scroll" step always dispatches the COORDINATE form. The arg builders
// (buildRunIOSArgs / buildRunAndroidArgs) map scroll → a 4-coordinate drag and
// throw on the direction form — so the raw ['scroll', direction] shape that used
// to be dispatched here crashed on Android (always) and on the iOS fast-runner
// fallback path.
export function buildDirectionalScrollCliArgs(
  direction: 'up' | 'down' | 'left' | 'right',
  amount?: number,
  durationMs?: number,
  distance?: number,
  within?: Band,
): string[] {
  const clamped = Math.min(Math.max(amount ?? 0.5, 0), 1);
  const band = dragBand(within);
  const refusal = bandTooSmall(band);
  if (refusal) throw new Error(`SCROLL_BAND_TOO_SMALL: ${refusal}`);
  const coords = computeScrollFromDirection(direction, clamped, band, distance);
  const duration = durationMs ?? DEFAULT_SWIPE_DURATION_MS;
  return [
    'scroll',
    String(coords.x1),
    String(coords.y1),
    String(coords.x2),
    String(coords.y2),
    String(duration),
  ];
}

export function exactModeRejectionMessage(
  reason: 'fast-runner-unavailable' | 'count-pattern-incompatible',
): string {
  if (reason === 'count-pattern-incompatible') {
    return 'exact: true is incompatible with count/pattern (those route through agent-device daemon which enforces safe-normalized timing). Drop count/pattern or drop exact.';
  }
  return 'exact: true requires fast-runner (iOS only, session must be open). Fast-runner unavailable — open a device session via device_snapshot action=open, then retry.';
}

export function createDeviceSwipeHandler(): (args: SwipeArgs) => Promise<ToolResult> {
  return withQaSession(async (args) => {
    // GH #383: a respawned worker starts with empty in-memory runner state, so
    // adopt the persisted per-device file before the isFastRunnerAvailable()
    // gates below (else they false-report "unavailable" after a respawn).
    if (!args.qaContext) adoptPersistedFastRunnerState(getActiveSession()?.deviceId);
    // B106 fix: use fast-runner's HID-level synthesis to bypass XCTest
    // `waitForIdle` hangs on Reanimated-driven screens. Only applies when
    // fast-runner is available (iOS) and count/pattern are not used (those
    // are daemon-specific features — fall back to agent-device for them).
    const canUseFastRunner =
      (!args.qaContext || getActiveSession()?.platform === 'ios') &&
      isFastRunnerAvailable() &&
      !args.count &&
      !args.pattern;

    // B123: exact: true requires fast-runner. Fail loud if unavailable instead
    // of silently degrading to a 60ms-capped daemon swipe.
    if (args.exact === true) {
      if (args.count || args.pattern) {
        return failResult(exactModeRejectionMessage('count-pattern-incompatible'), {
          code: 'EXACT_INCOMPATIBLE',
          hint: 'count and pattern only work via agent-device daemon, which enforces safe-normalized timing. Drop one to proceed.',
        });
      }
      if (!isFastRunnerAvailable()) {
        return failResult(exactModeRejectionMessage('fast-runner-unavailable'), {
          code: 'EXACT_REQUIRES_FAST_RUNNER',
          hint: 'fast-runner is the only path that respects user-supplied durationMs verbatim. Open a device session first.',
        });
      }
    }

    if (args.x1 != null && args.y1 != null && args.x2 != null && args.y2 != null) {
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(
            args.x1,
            args.y1,
            args.x2,
            args.y2,
            args.durationMs,
            getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined,
            args.qaContext,
            getActiveSession()?.deviceId,
          );
          if (resp.ok) {
            return okResult({
              x1: args.x1,
              y1: args.y1,
              x2: args.x2,
              y2: args.y2,
              durationMs: args.durationMs,
              method: 'fast-runner',
            });
          }
          args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
          if (args.exact === true) {
            return failResult(
              'fast-runner swipe call failed and exact: true forbids daemon fallback',
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
        } catch (err) {
          args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
          if (args.exact === true) {
            return failResult(
              `fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`,
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
          /* fall through */
        }
      }
      const cliArgs = ['swipe', String(args.x1), String(args.y1), String(args.x2), String(args.y2)];
      if (args.durationMs) cliArgs.push(String(args.durationMs));
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runNative(cliArgs, { qaContext: args.qaContext });
    }
    if (args.direction) {
      // B-Tier3 fix: Use real swipe gesture (not scroll) for direction-based swipes.
      const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
      const coords = computeSwipeFromDirection(args.direction, screen);
      const duration = args.durationMs ?? DEFAULT_SWIPE_DURATION_MS;
      if (canUseFastRunner) {
        try {
          const resp = await fastSwipe(
            coords.x1,
            coords.y1,
            coords.x2,
            coords.y2,
            duration,
            getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined,
            args.qaContext,
            getActiveSession()?.deviceId,
          );
          if (resp.ok) {
            return okResult({
              direction: args.direction,
              durationMs: duration,
              method: 'fast-runner',
              ...coords,
            });
          }
          args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
          if (args.exact === true) {
            return failResult(
              'fast-runner swipe call failed and exact: true forbids daemon fallback',
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
        } catch (err) {
          args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
          if (args.exact === true) {
            return failResult(
              `fast-runner swipe call threw and exact: true forbids daemon fallback: ${err instanceof Error ? err.message : String(err)}`,
              { code: 'EXACT_FAST_RUNNER_FAILED' },
            );
          }
          /* fall through */
        }
      }
      const cliArgs = [
        'swipe',
        String(coords.x1),
        String(coords.y1),
        String(coords.x2),
        String(coords.y2),
        String(duration),
      ];
      if (args.count && args.count > 1) cliArgs.push('--count', String(args.count));
      if (args.pattern) cliArgs.push('--pattern', args.pattern);
      return runNative(cliArgs, { qaContext: args.qaContext });
    }
    return failResult('Provide either direction or x1,y1,x2,y2 coordinates');
  });
}

// --- Scroll ---

interface ScrollArgs {
  qaContext?: QaDispatchContext;
  direction: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  // Pixels to move the content for a clearance scroll.
  distance?: number;
  // The visible part of the scrolled view; the drag starts inside it.
  within?: Band;
}

export function createDeviceScrollHandler(): (args: ScrollArgs) => Promise<ToolResult> {
  return withQaSession(async (args) => {
    // The fast path bypasses XCTest quiescence on animated scroll views.
    const amount = Math.min(Math.max(args.amount ?? 0.5, 0), 1);
    const band = dragBand(args.within);
    const refusal = bandTooSmall(band);
    if (refusal) return failResult(refusal, 'SCROLL_BAND_TOO_SMALL', { mutation: 'none' });
    const { x1, y1, x2, y2 } = computeScrollFromDirection(
      args.direction,
      amount,
      band,
      args.distance,
    );
    // GH #383: adopt persisted per-device state so a respawned worker sees a
    // live runner before this fast-path gate.
    if (!args.qaContext) adoptPersistedFastRunnerState(getActiveSession()?.deviceId);
    if ((!args.qaContext || getActiveSession()?.platform === 'ios') && isFastRunnerAvailable()) {
      if (args.qaContext)
        process.stderr.write(
          `qaren-core: scroll drag (${x1},${y1})->(${x2},${y2}) band=(${band.x ?? 0},${band.y ?? 0},${band.width},${band.height}) kb=${getKeyboardTop() ?? 'none'} duration=${DEFAULT_SWIPE_DURATION_MS}ms\n`,
        );
      try {
        const bundleId = getActiveSession()?.appId ?? resolveBundleId('ios') ?? undefined;
        const resp = await fastSwipe(
          x1,
          y1,
          x2,
          y2,
          DEFAULT_SWIPE_DURATION_MS,
          bundleId,
          args.qaContext,
          getActiveSession()?.deviceId,
        );
        if (resp.ok) {
          return settleAfterMutation(
            okResult({
              direction: args.direction,
              amount: args.amount ?? 0.5,
              method: 'fast-runner',
              x1,
              y1,
              x2,
              y2,
            }),
            { platform: 'ios', verb: 'scroll', appId: bundleId, qaContext: args.qaContext },
            { probes: () => buildIosProbes(bundleId, args.qaContext) },
          );
        }
        args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      } catch {
        args.qaContext?.refuse('ACTION_OUTCOME_UNCERTAIN');
      }
    }
    // Daemon / Android fallthrough: dispatch the COORDINATE form. The arg
    // builders throw on the raw direction form, so this previously crashed on
    // Android (always) and on the iOS fast-runner fallback.
    return runNative(
      buildDirectionalScrollCliArgs(
        args.direction,
        args.amount,
        undefined,
        args.distance,
        args.within,
      ),
      { qaContext: args.qaContext },
    );
  });
}

// --- Scroll Into View ---

interface ScrollIntoViewArgs {
  text?: string;
  ref?: string;
}

export function createDeviceScrollIntoViewHandler(): (
  args: ScrollIntoViewArgs,
) => Promise<ToolResult> {
  return withSession(async (args) => {
    if (!args.ref && !args.text) {
      return failResult('Provide either text or ref to scroll into view');
    }
    // GH #105 iOS-MVP follow-up: the Swift runner has no `scrollintoview`
    // command; this is TS-orchestrated on iOS (snapshot → find → swipe loop).
    // Task 8 of the Android MVP plan extends the same orchestrator to
    // Android (default-on; opt-out via RN_ANDROID_RUNNER=0) — the snapshot
    // + swipe verbs route through the platform-aware short-circuit in
    // runNative so this function is platform-neutral. The in-tree
    // runners are the only execution targets for scrollintoview now; the
    // upstream agent-device CLI never owned a stable scrollintoview verb
    // and routing through it re-spawns the legacy runner that fights us
    // for focus / UIAutomator.
    const session = getActiveSession();
    const usesInTreeRunner =
      session?.platform === 'ios' ||
      (session?.platform === 'android' && process.env.RN_ANDROID_RUNNER !== '0');

    if (usesInTreeRunner) {
      return scrollIntoViewWithRunner(args);
    }
    return failResult(
      `device_scrollintoview requires an in-tree runner — iOS (rn-fast-runner) or Android with RN_ANDROID_RUNNER unset/non-zero (rn-android-runner). Active session: ${session?.platform ?? 'none'}.`,
      { code: 'IN_TREE_RUNNER_REQUIRED', platform: session?.platform ?? null },
    );
  });
}

/**
 * GH #105 iOS-MVP follow-up + Task 8 of the Android MVP plan: platform-neutral
 * TS orchestrator for device_scrollintoview. Loops snapshot → find → check
 * viewport → swipe up to MAX_ITERATIONS times. Uses runNative for both
 * the `snapshot` and `swipe` verbs so the in-tree iOS short-circuit
 * (rn-fast-runner) and the Android short-circuit (rn-android-runner, env-gated)
 * both apply transparently — no daemon, no upstream agent-device runner.
 */
async function scrollIntoViewWithRunner(args: ScrollIntoViewArgs): Promise<ToolResult> {
  const MAX_ITERATIONS = 12;
  const timer = createStepTimer();
  const screen = getCachedScreenRect() ?? DEFAULT_SCREEN;
  const screenRect: ViewportRect = { x: 0, y: 0, width: screen.width, height: screen.height };
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const snapRes = await runNative(['snapshot', '-i']);
    timer.mark('snapshot');
    if (snapRes.isError) {
      return failResult(
        `scrollintoview: snapshot failed at iteration ${i}: ${snapRes.content?.[0]?.text ?? 'unknown'}`,
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }
    let nodes: FlatNode[] = [];
    try {
      const envelope = JSON.parse(snapRes.content?.[0]?.text ?? '{}') as {
        data?: { nodes?: FlatNode[] };
      };
      nodes = envelope.data?.nodes ?? [];
    } catch {
      return failResult(`scrollintoview: failed to parse snapshot envelope at iteration ${i}`);
    }
    const target = args.ref
      ? (nodes.find((n) => n.ref === (args.ref!.startsWith('@') ? args.ref : `@${args.ref!}`)) ??
        null)
      : findInLatestSnapshot(nodes, args.text!);
    if (!target) {
      // Element not in snapshot at all; can't decide direction. Probably needs
      // initial scroll. Default to swiping up (down-direction-of-content) once
      // and retry — common case is reaching a below-fold element.
      if (i === 0) {
        const fallbackDir = decideScrollDirection(
          { x: 0, y: screen.height * 2, width: 1, height: 1 },
          screenRect,
        );
        const coords = computeSwipeFromDirection(fallbackDir ?? 'down', screen);
        await runNative([
          'swipe',
          String(coords.x1),
          String(coords.y1),
          String(coords.x2),
          String(coords.y2),
          String(DEFAULT_SWIPE_DURATION_MS),
        ]);
        continue;
      }
      return failResult(
        `scrollintoview: element "${args.ref ?? args.text}" not found after ${i} swipe iteration(s)`,
        { code: 'NOT_FOUND', iterations: i },
      );
    }
    if (!target.rect) {
      return failResult(`scrollintoview: target has no rect — cannot decide direction`);
    }
    const direction = decideScrollDirection(target.rect, screenRect);
    if (direction === null) {
      return okResult(
        {
          ref: target.ref,
          rect: target.rect,
          iterations: i,
          method: 'runner-orchestrator',
        },
        { meta: { timings_ms: timer.timings() } },
      );
    }
    const coords = computeSwipeFromDirection(direction, screen);
    const swipeResp = await runNative([
      'swipe',
      String(coords.x1),
      String(coords.y1),
      String(coords.x2),
      String(coords.y2),
      String(DEFAULT_SWIPE_DURATION_MS),
    ]);
    timer.mark('swipe');
    if (swipeResp.isError) {
      return failResult(
        `scrollintoview: swipe failed at iteration ${i}: ${swipeResp.content?.[0]?.text ?? 'unknown'}`,
      );
    }
  }
  return failResult(
    `scrollintoview: target "${args.ref ?? args.text}" did not enter viewport after ${MAX_ITERATIONS} swipe iterations`,
    { code: 'SCROLL_EXHAUSTED', iterations: MAX_ITERATIONS },
  );
}

// --- Pinch ---

interface PinchArgs {
  scale: number;
  x?: number;
  y?: number;
}

export function createDevicePinchHandler(): (args: PinchArgs) => Promise<ToolResult> {
  return withSession((args) => {
    const cliArgs = ['pinch', String(args.scale)];
    if (args.x != null && args.y != null) {
      cliArgs.push(String(args.x), String(args.y));
    }
    return runNative(cliArgs);
  });
}

// --- Back ---

export function createDeviceBackHandler(): (args: {
  qaContext?: QaDispatchContext;
}) => Promise<ToolResult> {
  return withQaSession((args) => runNative(['back'], { qaContext: args.qaContext }));
}

// --- Focus Next (keyboard Next/Return button) ---

// Label priority order: "Go" and "Done" first because they are less likely to
// appear on in-app navigation buttons than "Next", reducing false-positive taps
// on wizard/form navigation buttons. Callers with a visible in-app "Next" button
// should use device_press on the next input @ref directly instead of this tool.
const NEXT_KEY_LABELS = ['Go', 'Done', 'Return', 'Next'];

// GH #736: an Android IME key lives in the input-method package, never the
// session app, so the app-window ownership gate would refuse it. The grant is
// per-call and per-ref (it lives only in this call's CLI args, so nothing
// persists for a later device_press) and requires the node to belong to the
// device's actual default IME — a label match on any other outside-app window
// earns nothing.
export function parseDefaultInputMethodPackage(raw: string): string | null {
  const value = raw.trim().split(/\r?\n/)[0]?.trim() ?? '';
  if (!value || value === 'null') return null;
  const pkg = value.split('/')[0]?.trim() ?? '';
  return isValidBundleId(pkg) ? pkg : null;
}

export async function resolveAndroidImePackage(
  deviceId: string | undefined,
): Promise<string | null> {
  try {
    const { stdout } = await execFile(
      'adb',
      [
        ...(deviceId ? ['-s', deviceId] : []),
        'shell',
        'settings',
        'get',
        'secure',
        'default_input_method',
      ],
      { timeout: IME_PROBE_TIMEOUT_MS },
    );
    return parseDefaultInputMethodPackage(stdout);
  } catch {
    return null;
  }
}

let _imePackageResolverForTest: ((deviceId: string | undefined) => Promise<string | null>) | null =
  null;

export function _setImePackageResolverForTest(
  fn: ((deviceId: string | undefined) => Promise<string | null>) | null,
): void {
  _imePackageResolverForTest = fn;
}

export function focusNextPressArgs(
  ref: string,
  nodePackageName: string | undefined,
  platform: string | undefined,
  appId: string | undefined,
  imePackage: string | null,
): string[] {
  const target = ref.startsWith('@') ? ref : `@${ref}`;
  const imeOwnedKey =
    platform === 'android' &&
    appId !== undefined &&
    imePackage !== null &&
    imePackage !== appId &&
    nodePackageName === imePackage;
  return imeOwnedKey ? ['press', target, '--include-system-ui', IME_KEY_FLAG] : ['press', target];
}

export function createDeviceFocusNextHandler(): (
  args: Record<string, never>,
) => Promise<ToolResult> {
  return withSession(async () => {
    // Single snapshot + local scan beats iterating agent-device find calls.
    // Benchmark data: 4 serial finds = 10-22s on no-keyboard case; single
    // snapshot = 3-5s on the same case. Also more reliable — one accessibility
    // query races keyboard animations less than four sequential queries.
    const snap = await fetchSnapshotNodes();
    if (!snap.ok) {
      if (snap.reason === 'runner-leak-unrecovered') {
        return runnerLeakFailResult(undefined, snap.recoveryReason);
      }
      if (snap.reason === 'empty-capture') {
        return emptyCaptureFailResult();
      }
      return failResult(
        'Snapshot unavailable — cannot look for keyboard key. Retry after device_snapshot action=open/snapshot.',
        { code: 'SNAPSHOT_UNAVAILABLE' },
      );
    }

    const { nodes, recoveredTier } = snap;
    const session = getActiveSession();
    const imePackage =
      session?.platform === 'android'
        ? await (_imePackageResolverForTest ?? resolveAndroidImePackage)(session.deviceId)
        : null;
    let lastPressFailure: ToolResult | null = null;
    for (const label of NEXT_KEY_LABELS) {
      const match = nodes.find((n) => n.label === label);
      if (!match) continue;
      const pressResult = await runNative(
        focusNextPressArgs(
          match.ref,
          match.packageName,
          session?.platform,
          session?.appId,
          imePackage,
        ),
      );
      if (pressResult.isError) {
        lastPressFailure = pressResult;
        continue; // Match found but tap failed — try next label
      }
      try {
        const envelope = JSON.parse(pressResult.content[0].text) as { ok: true; data: unknown };
        const meta: Record<string, unknown> = { keyUsed: label, ref: match.ref };
        if (recoveredTier) {
          meta.recovered = 'agent-device-runner-leak';
          meta.recoveryTier = recoveredTier;
        }
        return okResult(envelope.data, { meta });
      } catch {
        return pressResult;
      }
    }

    if (lastPressFailure) return lastPressFailure;

    return failResult(
      `No keyboard ${NEXT_KEY_LABELS.join('/')} key visible in the accessibility tree. Tried: ${NEXT_KEY_LABELS.join(', ')}`,
      {
        code: 'KEYBOARD_NEXT_NOT_FOUND',
        hint: 'Keyboard may be dismissed, or the field may be the last in the form. If an in-app "Next" button is visible, prefer device_press on the next input @ref directly.',
      },
    );
  });
}

// --- TS-side orchestrators for `find` and `scrollintoview` (GH #105 / rn-device iOS-MVP) ---
//
// These pure helpers replace what the external CLI tier used to do on iOS.
// The runner (rn-fast-runner) exposes raw `tap` / `swipe` / `snapshot` but not
// `find` or `scrollintoview` — we own that orchestration here. See spec §3.4.

/**
 * GH #105 / rn-device iOS-MVP: TypeScript implementation of `find`.
 * Used by device_find. Replaces external CLI's `find` command.
 *
 * Matches against (in priority order): exact label, exact identifier,
 * substring label, substring identifier. Returns the first match by
 * traversal order from the snapshot (depth-first).
 */
export function findInLatestSnapshot(
  nodes: FlatNode[],
  query: string,
  opts: { exact?: boolean } = {},
): FlatNode | null {
  const exact = opts.exact ?? false;
  for (const n of nodes) {
    if (n.label === query || n.identifier === query) return n;
  }
  if (exact) return null;
  for (const n of nodes) {
    if (n.label?.includes(query) || n.identifier?.includes(query)) return n;
  }
  return null;
}

interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Element fully or partially intersects the screen rect. */
export function isInViewport(element: ViewportRect, screen: ViewportRect): boolean {
  const elRight = element.x + element.width;
  const elBottom = element.y + element.height;
  const screenRight = screen.x + screen.width;
  const screenBottom = screen.y + screen.height;
  return (
    element.x < screenRight && elRight > screen.x && element.y < screenBottom && elBottom > screen.y
  );
}

/** Choose a swipe direction that should bring `element` into the screen. Returns null when already visible. */
export function decideScrollDirection(
  element: ViewportRect,
  screen: ViewportRect,
): 'up' | 'down' | 'left' | 'right' | null {
  if (isInViewport(element, screen)) return null;
  if (element.y >= screen.y + screen.height) return 'up';
  if (element.y + element.height <= screen.y) return 'down';
  if (element.x >= screen.x + screen.width) return 'left';
  if (element.x + element.width <= screen.x) return 'right';
  return null;
}
