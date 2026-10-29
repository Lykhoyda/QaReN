import { throwIfInputPrivacyRefused } from '../qa/inputs.js';
import { throwIfCancelled } from '../domain/cancellation.js';
import type { ToolResult } from '../utils.js';
import type { QaDispatchContext } from '../domain/qa-dispatch.js';
import type { FlatNode } from '../fast-runner-ref-map.js';
import { hashSnapshotNodes } from './settle-hash.js';
import { runIOS } from '../runners/qaren-ios-runner-client.js';
import {
  androidIsWindowUpdatingProbe,
  androidSnapshotNodesViaProbe,
  getAndroidRunnerHostPort,
  runAndroid,
} from '../runners/rn-android-runner-client.js';

export type SettleMethod = 'window-gate' | 'snapshot-eq' | 'timeout';

export interface SettleOutcome {
  settled: boolean;
  method: SettleMethod;
  ms: number;
  hierarchyChanged?: boolean;
}

export interface SettleProbes {
  isWindowUpdating?: (timeoutMs: number) => Promise<boolean | null>;
  snapshotHash: () => Promise<string | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export interface WaitForSettleOpts {
  platform: 'ios' | 'android';
  capabilities: readonly string[];
  probes: SettleProbes;
  budgetMs?: number;
  initialSnapshotHash?: string;
}

export const SETTLE_DEFAULT_BUDGET_MS = 6000;
// Hard ceiling for caller-supplied budgets (MCP args are untrusted): matches
// the slow-command timeout class. Non-finite/negative input falls back to the
// default rather than disabling or unbounding the wait.
export const SETTLE_MAX_BUDGET_MS = 30_000;
const WINDOW_GATE_TIMEOUT_MS = 100;
const WINDOW_GATE_SETTLED_SLEEP_MS = 50;
const SNAPSHOT_POLL_MAX = 10;
const SNAPSHOT_POLL_INTERVAL_MS = 200;

export function settleEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = env.RN_SETTLE?.trim().toLowerCase();
  return v !== '0' && v !== 'false';
}

export async function waitForSettle(opts: WaitForSettleOpts): Promise<SettleOutcome> {
  const { platform, capabilities, probes, initialSnapshotHash } = opts;
  const requested = opts.budgetMs;
  const budgetMs =
    typeof requested === 'number' && Number.isFinite(requested) && requested >= 0
      ? Math.min(requested, SETTLE_MAX_BUDGET_MS)
      : SETTLE_DEFAULT_BUDGET_MS;
  const start = probes.now();
  const elapsed = (): number => probes.now() - start;
  const remaining = (): number => budgetMs - elapsed();

  if (platform === 'android' && capabilities.includes('WINDOW_UPDATE') && probes.isWindowUpdating) {
    const updating = await safeProbe(() => probes.isWindowUpdating!(WINDOW_GATE_TIMEOUT_MS));
    if (updating === false) {
      // NB: false ≠ "our screen is static" — waitForWindowUpdate also returns
      // false immediately when the frontmost package differs (e.g. after a back
      // that left the app). Benign: nothing of ours left to settle.
      await probes.sleep(WINDOW_GATE_SETTLED_SLEEP_MS);
      let change = await postSettleChange(probes, initialSnapshotHash);
      // A busy JS thread can commit the effect after the 100ms gate: before
      // reporting "no change", wait once more for a window update inside the
      // remaining budget (the runner clamps the probe to 0..2000ms).
      const reprobeMs = Math.min(remaining(), 2000);
      if (change.hierarchyChanged === false && reprobeMs > 0) {
        const lateUpdate = await safeProbe(() => probes.isWindowUpdating!(reprobeMs));
        if (lateUpdate === true) {
          const late = await postSettleChange(probes, initialSnapshotHash);
          if (late.hierarchyChanged !== undefined) change = late;
        }
      }
      return { settled: true, method: 'window-gate', ms: elapsed(), ...change };
    }
    // updating or probe failure → pay for snapshot polling below
  }

  let prev: string | null = null;
  let hierarchyChanged: boolean | undefined;
  for (let i = 0; i < SNAPSHOT_POLL_MAX; i++) {
    if (remaining() <= 0) break;
    const hash = await safeProbe(() => probes.snapshotHash());
    if (typeof hash === 'string') {
      if (initialSnapshotHash !== undefined) {
        hierarchyChanged = hierarchyChanged === true || hash !== initialSnapshotHash;
      }
      if (prev !== null && hash === prev) {
        return {
          settled: true,
          method: 'snapshot-eq',
          ms: elapsed(),
          ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
        };
      }
      prev = hash;
    }
    const nap = Math.min(SNAPSHOT_POLL_INTERVAL_MS, remaining());
    if (nap > 0) await probes.sleep(nap);
  }
  return {
    settled: false,
    method: 'timeout',
    ms: elapsed(),
    ...(hierarchyChanged !== undefined ? { hierarchyChanged } : {}),
  };
}

async function safeProbe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    throwIfInputPrivacyRefused();
    throwIfCancelled();
    return null;
  }
}

// Only callers with a baseline pay for a hierarchy comparison; the Android gate owns late re-probes.
async function postSettleChange(
  probes: SettleProbes,
  initialSnapshotHash: string | undefined,
): Promise<{ hierarchyChanged?: boolean }> {
  if (initialSnapshotHash === undefined) return {};
  const hash = await safeProbe(() => probes.snapshotHash());
  if (typeof hash !== 'string') return {};
  return { hierarchyChanged: hash !== initialSnapshotHash };
}

function envelopeData(result: ToolResult): unknown {
  try {
    const parsed = JSON.parse(result.content[0].text) as { ok?: boolean; data?: unknown };
    return parsed.ok === false ? null : parsed.data;
  } catch {
    throwIfInputPrivacyRefused();
    throwIfCancelled();
    return null;
  }
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function buildIosProbes(bundleId?: string, _qaContext?: QaDispatchContext): SettleProbes {
  return {
    snapshotHash: async () => {
      try {
        const data = envelopeData(
          await runIOS({
            command: 'snapshot',
            advisorySnapshot: true,
            interactiveOnly: true,
            ...(bundleId ? { bundleId } : {}),
          }),
        );
        const nodes = (data as { nodes?: FlatNode[] } | null)?.nodes;
        return Array.isArray(nodes) ? hashSnapshotNodes(nodes) : null;
      } catch {
        throwIfInputPrivacyRefused();
        throwIfCancelled();
        return null;
      }
    },
    sleep: realSleep,
    now: () => Date.now(),
  };
}

export function hashAndroidAppSnapshotNodes(
  nodes: FlatNode[],
  bundleId: string | undefined,
): string | null {
  if (!bundleId) return null;
  return hashSnapshotNodes(nodes.filter((node) => node.packageName === bundleId));
}

export function buildAndroidProbes(bundleId?: string, qaContext?: QaDispatchContext): SettleProbes {
  const pinnedHostPort = getAndroidRunnerHostPort() ?? undefined;
  const qaRead = async (
    command: 'snapshot' | 'isWindowUpdating',
    timeoutMs?: number,
  ): Promise<unknown> => {
    try {
      if (pinnedHostPort === undefined || getAndroidRunnerHostPort() !== pinnedHostPort)
        qaContext!.invalidate();
      return envelopeData(
        await runAndroid({ command, bundleId, qaContext, timeoutMs, interactiveOnly: true }),
      );
    } catch {
      throwIfInputPrivacyRefused();
      throwIfCancelled();
      return null;
    }
  };
  return {
    isWindowUpdating: async (timeoutMs) => {
      if (!qaContext) return androidIsWindowUpdatingProbe(timeoutMs, bundleId, pinnedHostPort);
      const data = (await qaRead('isWindowUpdating', timeoutMs)) as { updating?: unknown } | null;
      return typeof data?.updating === 'boolean' ? data.updating : null;
    },
    snapshotHash: async () => {
      const nodes = qaContext
        ? ((await qaRead('snapshot')) as { nodes?: FlatNode[] } | null)?.nodes
        : await androidSnapshotNodesViaProbe(bundleId, pinnedHostPort);
      return nodes ? hashAndroidAppSnapshotNodes(nodes, bundleId) : null;
    },
    sleep: realSleep,
    now: () => Date.now(),
  };
}
