import { execFile as execFileCb } from '../domain/cancellation.js';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

/**
 * LIVE-VALIDATE (#191): best-known NSGlobalDomain (`-g`) keys that disable the
 * iOS predictive/autocorrect bar in the simulator. Confirm/trim on a booted sim;
 * fail-open so a wrong key is a logged no-op. KeyboardCapitalization is
 * intentionally EXCLUDED — it alters app behavior, not the predictive bar.
 */
export const IOS_KEYBOARD_PREF_KEYS: ReadonlyArray<readonly [string, string, string]> = [
  ['KeyboardAutocorrection', '-bool', 'false'],
  ['KeyboardPrediction', '-bool', 'false'],
  ['KeyboardShowPredictionBar', '-bool', 'false'],
];

export interface SuppressDeps {
  run: (args: string[]) => Promise<unknown>;
}

export interface SuppressResult {
  warnings: string[];
  skipped: boolean;
  meta: { timings_ms: Record<string, number> };
}

function defaultDeps(): SuppressDeps {
  return { run: (args) => execFile('xcrun', args, { timeout: 5_000 }) };
}

/** Best-effort, fail-open, scoped to `udid`. Never throws. */
export async function suppressIOSAutocorrect(
  udid: string,
  deps: SuppressDeps = defaultDeps(),
): Promise<SuppressResult> {
  const warnings: string[] = [];
  const timings: Record<string, number> = {};
  if (!udid) return { warnings, skipped: true, meta: { timings_ms: timings } };
  const t = Date.now();
  for (const [key, type, value] of IOS_KEYBOARD_PREF_KEYS) {
    try {
      await deps.run(['simctl', 'spawn', udid, 'defaults', 'write', '-g', key, type, value]);
    } catch (err) {
      warnings.push(
        `defaults write -g ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  timings.suppress = Date.now() - t;
  return { warnings, skipped: false, meta: { timings_ms: timings } };
}
