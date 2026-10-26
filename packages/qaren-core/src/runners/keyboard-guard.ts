import { sleep as cancellableSleep } from '../domain/cancellation.js';
import { failResult, okResult, type ToolResult } from '../utils.js';
import type { QaDispatchContext } from '../domain/qa-dispatch.js';

export function resolveKeyboardGuard(env: NodeJS.ProcessEnv): boolean {
  const raw = (env.RN_KEYBOARD_GUARD ?? '').trim().toLowerCase();
  return !(raw === '0' || raw === 'false');
}

const GUARDED_VERBS = new Set(['tap', 'press', 'longPress']);

export function withKeyboardGuard<T extends object>(
  payload: T,
  verb: string,
  env: NodeJS.ProcessEnv,
): T & { guardKeyboard?: boolean } {
  if (!GUARDED_VERBS.has(verb)) return payload;
  return { ...payload, guardKeyboard: resolveKeyboardGuard(env) };
}

export function surfaceKeyboardGuard<T extends ToolResult>(result: T): T {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return result;

  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }
  // "never throws" contract: JSON.parse('null') / scalars survive the try
  // block but explode on property access below.
  if (envelope === null || typeof envelope !== 'object') return result;

  const data = envelope.data as Record<string, unknown> | undefined;
  const keyboardGuard = data?.keyboardGuard;
  if (typeof keyboardGuard !== 'string') return result;

  const meta = (envelope.meta as Record<string, unknown> | undefined) ?? {};
  envelope.meta = { ...meta, keyboardGuard };

  // #379: runners report the guard step's native duration (probe + dismissal)
  // as data.keyboardGuardMs; lift it into the meta.timings_ms convention.
  const keyboardGuardMs = data?.keyboardGuardMs;
  if (typeof keyboardGuardMs === 'number') {
    const timings = (meta.timings_ms as Record<string, unknown> | undefined) ?? {};
    envelope.meta = {
      ...(envelope.meta as Record<string, unknown>),
      timings_ms: { ...timings, keyboardGuard: keyboardGuardMs },
    };
  }

  return {
    ...result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
}

// #379: the iOS guard's verify-or-refuse arm. Old runner artifacts predate the
// structured `code`, so the message prefix is the compatibility match — but
// only as a prefix, to avoid snagging errors that merely mention the code.
export function isKeyboardOccludedRefusal(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return false;
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    return false;
  }
  if (envelope === null || typeof envelope !== 'object') return false;
  const { code, error } = envelope as { code?: unknown; error?: unknown };
  if (code === 'KEYBOARD_OCCLUDED' || code === 'KEYBOARD_DISMISS_FAILED') return true;
  return (
    typeof error === 'string' &&
    (error.startsWith('KEYBOARD_OCCLUDED') || error.startsWith('KEYBOARD_DISMISS_FAILED'))
  );
}

export interface KeyboardAutoHealDeps {
  /** Dismiss via the injected JS helper; resolves true when it reports dismissed. */
  dismissViaJs: () => Promise<boolean>;
  /** Refresh the snapshot/ref map — targets relayout when the keyboard lifts. */
  refreshSnapshot: () => Promise<unknown>;
  /** Re-run the original tap exactly once. */
  retryTap: () => Promise<ToolResult>;
}

export function keyboardVisibility(result: unknown): boolean | null {
  const text = (result as ToolResult | undefined)?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    const envelope = JSON.parse(text) as {
      ok?: boolean;
      data?: { keyboardVisible?: unknown; visible?: unknown };
    };
    if (envelope.ok === false) return null;
    if (typeof envelope.data?.keyboardVisible === 'boolean') {
      return envelope.data.keyboardVisible;
    }
    return typeof envelope.data?.visible === 'boolean' ? envelope.data.visible : null;
  } catch {
    return null;
  }
}

const KEYBOARD_POSTCHECK_ATTEMPTS = 5;
const KEYBOARD_POSTCHECK_DELAY_MS = 100;

/**
 * `unknown` means the producer does not report keyboard visibility at all
 * (Android runner, protocol-v1 iOS artifacts) — distinct from an observed
 * still-visible keyboard, which is the only disconfirming observation.
 */
export type KeyboardHiddenObservation = 'hidden' | 'visible' | 'unknown';

export async function waitForKeyboardHidden(
  refreshSnapshot: () => Promise<unknown>,
  sleep: (ms: number) => Promise<void> = cancellableSleep,
): Promise<KeyboardHiddenObservation> {
  let last: KeyboardHiddenObservation = 'unknown';
  for (let attempt = 0; attempt < KEYBOARD_POSTCHECK_ATTEMPTS; attempt += 1) {
    const visible = keyboardVisibility(await refreshSnapshot());
    if (visible === false) return 'hidden';
    // A producer that never emits visibility will not start on a later poll.
    if (visible === null) return 'unknown';
    last = 'visible';
    if (attempt < KEYBOARD_POSTCHECK_ATTEMPTS - 1) await sleep(KEYBOARD_POSTCHECK_DELAY_MS);
  }
  return last;
}

export interface KeyboardDismissDeps {
  nativeDismiss: () => Promise<ToolResult>;
  dismissViaJs?: () => Promise<boolean>;
  refreshSnapshot: () => Promise<unknown>;
}

function nativeDismissTiers(via: string): string[] {
  return via === 'native-control' ? ['native-control'] : [via];
}

// The runner only answers KEYBOARD_DISMISS_FAILED after running its own native
// tiers; any other error means the command never reached them.
function nativeTiersAttempted(native: ToolResult): string[] {
  if (!native.isError) return ['native-control'];
  const text = native.content?.[0]?.text ?? '';
  return text.includes('KEYBOARD_DISMISS_FAILED') ? ['native-control'] : [];
}

/** Shared standalone/batch dismissal chain with an independent hidden-state check. */
export async function dismissKeyboardWithParity(deps: KeyboardDismissDeps): Promise<ToolResult> {
  const native = await deps.nativeDismiss();
  if (!native.isError) {
    let data: { wasVisible?: unknown; dismissed?: unknown; visible?: unknown; via?: unknown } = {};
    try {
      data =
        (
          JSON.parse(native.content[0]?.text ?? '{}') as {
            data?: typeof data;
          }
        ).data ?? {};
    } catch {
      // A malformed native success cannot prove that the keyboard is hidden.
    }
    if (data.wasVisible === false && data.visible !== true) {
      return okResult({
        dismissed: false,
        keyboardGuard: 'no_keyboard',
        via: 'no_keyboard',
        attemptedTiers: [],
      });
    }
    if (data.dismissed === true && data.visible !== true) {
      const via = typeof data.via === 'string' ? data.via : 'native-control';
      // Producers that do not report keyboard visibility (Android runner,
      // protocol-v1 iOS) can only be corroborated by an independent probe;
      // absence of a visibility field is not a disconfirmation.
      const observed =
        data.visible === false ? 'hidden' : await waitForKeyboardHidden(deps.refreshSnapshot);
      if (observed !== 'visible') {
        return okResult({
          dismissed: true,
          keyboardGuard: 'auto_dismissed',
          via,
          attemptedTiers: nativeDismissTiers(via),
          visibilityProof: observed === 'hidden' ? 'observed-hidden' : 'unavailable',
        });
      }
    }
  }

  const attemptedTiers = nativeTiersAttempted(native);
  if (deps.dismissViaJs) {
    attemptedTiers.push('js');
    try {
      if (await deps.dismissViaJs()) {
        const observed = await waitForKeyboardHidden(deps.refreshSnapshot);
        if (observed !== 'visible') {
          return okResult({
            dismissed: true,
            keyboardGuard: 'auto_dismissed',
            via: 'js',
            attemptedTiers,
            visibilityProof: observed === 'hidden' ? 'observed-hidden' : 'unavailable',
          });
        }
      }
    } catch {
      // Fall through to the typed refusal; no hidden state was proven.
    }
  }
  return failResult(
    'KEYBOARD_DISMISS_FAILED: no dismissal tier proved the keyboard hidden; it was still visible or its state could not be established.',
    'KEYBOARD_DISMISS_FAILED',
    { attemptedTiers },
  );
}

/**
 * #379 KEYBOARD_OCCLUDED auto-heal (JS-first, per D1250's fill pattern).
 * Bounded by construction: retryTap is the raw tap, so a second refusal flows
 * out unhealed. The retried tap re-runs the native occlusion guard — a JS
 * dismissal that didn't actually take effect can never tap through the
 * keyboard, it just re-refuses.
 */
export async function healKeyboardOccludedTap(
  first: ToolResult,
  deps: KeyboardAutoHealDeps | null,
  qaContext?: QaDispatchContext,
): Promise<ToolResult> {
  // This repair has no retained-identity/no-invocation proof for QA.
  if (qaContext && isKeyboardOccludedRefusal(first)) qaContext.refuse('ACTION_OUTCOME_UNCERTAIN');
  if (!deps || !isKeyboardOccludedRefusal(first)) return first;
  const t0 = Date.now();
  let dismissed = false;
  try {
    dismissed = await deps.dismissViaJs();
  } catch {
    return first;
  }
  if (!dismissed) return first;
  try {
    if ((await waitForKeyboardHidden(deps.refreshSnapshot)) === 'visible') return first;
  } catch {
    return first;
  }
  const retried = await deps.retryTap();
  return tagKeyboardAutoHeal(retried, Date.now() - t0);
}

function tagKeyboardAutoHeal(result: ToolResult, healMs: number): ToolResult {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return result;
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return result;
  }
  if (envelope === null || typeof envelope !== 'object') return result;
  const meta = (envelope.meta as Record<string, unknown> | undefined) ?? {};
  envelope.meta = {
    ...meta,
    // A retry that refused again keeps its own guard status; only a served
    // tap is stamped as JS-dismissed.
    ...(result.isError ? {} : { keyboardGuard: 'auto_dismissed', via: 'js' }),
    keyboardAutoHeal: { dismissed: true, via: 'js', healMs },
  };
  return {
    ...result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
  };
}
