import { interruptible } from '../domain/cancellation.js';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';

export interface ProveTarget {
  metroPort: number;
  worktree: string;
}

export interface ProveDeps {
  evaluate(expression: string): Promise<{ value?: unknown; error?: string }>;
  fileExists?: (path: string) => boolean;
}

export type ProveOutcome =
  | { ok: true; scriptURL: string; appModules: number }
  | { ok: false; code: 'METRO_ORIGIN_MISMATCH'; message: string };

export const SCRIPT_URL_EXPRESSION = `(function () {
  function constantsOf(m) { try { return m && (typeof m.getConstants === 'function' ? m.getConstants() : m); } catch (e) { return null; } }
  try { if (typeof __turboModuleProxy === 'function') { var c = constantsOf(__turboModuleProxy('SourceCode')); if (c && c.scriptURL) return c.scriptURL; } } catch (e) {}
  try { var p = globalThis.nativeModuleProxy; if (p && p.SourceCode) { var c2 = constantsOf(p.SourceCode); if (c2 && c2.scriptURL) return c2.scriptURL; } } catch (e) {}
  return null;
})()`;

export const MODULE_NAMES_EXPRESSION = `(function () {
  var r = globalThis.__r;
  if (!r || typeof r.getModules !== 'function') return JSON.stringify({ error: 'no-registry' });
  var modules = r.getModules();
  var names = [];
  var count = 0;
  var take = function (mod) { count += 1; if (names.length < 5000 && mod && typeof mod.verboseName === 'string') names.push(mod.verboseName); };
  if (modules && typeof modules.forEach === 'function') modules.forEach(function (mod) { take(mod); });
  else if (modules && typeof modules === 'object') { for (var k in modules) take(modules[k]); }
  return JSON.stringify({ count: count, names: names });
})()`;

const APP_MODULE_SAMPLE = 50;

export function isAppModule(name: string): boolean {
  return (
    !name.startsWith('../') &&
    !name.startsWith('node_modules/') &&
    !name.includes('/node_modules/') &&
    !name.startsWith('__') &&
    /\.[cm]?[jt]sx?$/.test(name)
  );
}

function mismatch(message: string): ProveOutcome {
  return { ok: false, code: 'METRO_ORIGIN_MISMATCH', message };
}

// One live read: the client's scriptURL must point at the run's Metro port, and the
// dev module registry must name app modules that exist under the run's worktree.
export async function prove(deps: ProveDeps, target: ProveTarget): Promise<ProveOutcome> {
  const fileExists = deps.fileExists ?? existsSync;
  const scriptResult = await interruptible(() => deps.evaluate(SCRIPT_URL_EXPRESSION));
  if (scriptResult.error || typeof scriptResult.value !== 'string') {
    return mismatch(
      `the dev client exposes no scriptURL (${scriptResult.error ?? 'SourceCode unavailable'})`,
    );
  }
  const scriptURL = scriptResult.value;
  let port: number;
  let host: string;
  try {
    const url = new URL(scriptURL);
    host = url.hostname;
    port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  } catch {
    return mismatch(`scriptURL ${JSON.stringify(scriptURL)} is not a URL`);
  }
  if (port !== target.metroPort) {
    return mismatch(`scriptURL ${host}:${port} is not the run's Metro port ${target.metroPort}`);
  }
  const registry = await interruptible(() => deps.evaluate(MODULE_NAMES_EXPRESSION));
  if (registry.error || typeof registry.value !== 'string') {
    return mismatch(`the module registry could not be read (${registry.error ?? 'no value'})`);
  }
  let parsed: { error?: string; count?: number; names?: string[] };
  try {
    parsed = JSON.parse(registry.value) as typeof parsed;
  } catch {
    return mismatch('the module registry answer was not JSON');
  }
  if (parsed.error || !Array.isArray(parsed.names)) {
    return mismatch(`no dev module registry on the client (${parsed.error ?? 'unexpected shape'})`);
  }
  const appModules = parsed.names.filter(isAppModule).slice(0, APP_MODULE_SAMPLE);
  if (appModules.length === 0) {
    return mismatch(
      `the bundle registers no app modules (${parsed.count ?? 0} modules, none outside node_modules)`,
    );
  }
  const root = resolve(target.worktree);
  const missing = appModules.filter((name) => {
    const candidate = resolve(root, name);
    const contained = candidate === root || candidate.startsWith(root + sep);
    return !contained || !fileExists(candidate);
  });
  if (missing.length > 0) {
    return mismatch(
      `the bundle was built from another tree: ${missing.length} of ${appModules.length} app modules are not under ${target.worktree} (${missing.slice(0, 3).join(', ')})`,
    );
  }
  return { ok: true, scriptURL, appModules: appModules.length };
}
