export { HELPERS_VERSION } from './runtime/version.js';
export { INJECTED_HELPERS } from './injected-helpers.bundle.js';

export const NETWORK_HOOK_SCRIPT = `
(function() {
  if (globalThis.__QAREN_NETWORK_HOOK__) return;
  globalThis.__QAREN_NETWORK_HOOK__ = true;

  // D597: Response body cache for hook mode — enables cdp_network_body on RN < 0.83
  var bodyCache = new Map();
  var MAX_BODIES = 50;
  globalThis.__QAREN_RESPONSE_BODIES__ = bodyCache;

  var origFetch = globalThis.fetch;
  globalThis.fetch = function(url, opts) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var method = (opts && opts.method) || 'GET';
    var start = Date.now();

    if (globalThis.__QAREN_NETWORK_CB__) {
      globalThis.__QAREN_NETWORK_CB__('request', { id: id, method: method, url: String(url) });
    }

    try {
      return origFetch.apply(this, arguments).then(function(response) {
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: response.status, duration_ms: Date.now() - start
          });
        }
        // Cache cloned response body for cdp_network_body
        try {
          response.clone().text().then(function(text) {
            if (bodyCache.size >= MAX_BODIES) {
              var oldest = bodyCache.keys().next().value;
              bodyCache.delete(oldest);
            }
            bodyCache.set(id, text);
          }).catch(function() {});
        } catch(e) {}
        return response;
      }).catch(function(err) {
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: 0, duration_ms: Date.now() - start
          });
        }
        throw err;
      });
    } catch(syncErr) {
      if (globalThis.__QAREN_NETWORK_CB__) {
        globalThis.__QAREN_NETWORK_CB__('response', {
          id: id, status: 0, duration_ms: Date.now() - start
        });
      }
      throw syncErr;
    }
  };

  var OrigXHR = globalThis.XMLHttpRequest;
  if (OrigXHR) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function(method, url) {
      this.__rn_agent_method = method;
      this.__rn_agent_url = url;
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function() {
      var self = this;
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var start = Date.now();
      var reported = false;

      function reportResponse(status) {
        if (reported) return;
        reported = true;
        if (globalThis.__QAREN_NETWORK_CB__) {
          globalThis.__QAREN_NETWORK_CB__('response', {
            id: id, status: status, duration_ms: Date.now() - start
          });
        }
      }

      if (globalThis.__QAREN_NETWORK_CB__) {
        globalThis.__QAREN_NETWORK_CB__('request', {
          id: id, method: self.__rn_agent_method || 'GET', url: String(self.__rn_agent_url || '')
        });
      }

      self.addEventListener('load', function() { reportResponse(self.status); });
      self.addEventListener('error', function() { reportResponse(0); });
      self.addEventListener('abort', function() { reportResponse(0); });
      self.addEventListener('timeout', function() { reportResponse(0); });

      return origSend.apply(this, arguments);
    };
  }
})();
`;

/**
 * Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network callback.
 * Pushes entries into an in-app ring buffer instead of console.log so the
 * shared console stream (Metro logs, user DevTools) stays clean. The bridge
 * drains the buffer on demand (cdp/net-hook-drain.ts). Idempotent: preserves
 * an existing buffer so reinjection doesn't lose undrained entries.
 */
export const NETWORK_CB_BUFFERED_SCRIPT = `
(function() {
  globalThis.__QAREN_NET_BUF__ = globalThis.__QAREN_NET_BUF__ || [];
  var MAX = 100;
  globalThis.__QAREN_NETWORK_CB__ = function(type, data) {
    try {
      var buf = globalThis.__QAREN_NET_BUF__;
      if (!Array.isArray(buf)) { buf = []; globalThis.__QAREN_NET_BUF__ = buf; }
      buf.push({ t: type, d: data, ts: Date.now() });
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    } catch (e) {}
  };
})();
`;

// M8 + GH #597: readiness probe for waitForReact. Combine renderer IDs from
// the DevTools registry with M8's bounded numeric range so setup recognizes
// sparse/high renderers without regressing empty, malformed, or partial shims.
export const REACT_READY_PROBE_JS = `(function() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || typeof h.getFiberRoots !== 'function') return false;
  var ids = [];
  try {
    if (h.renderers && typeof h.renderers.keys === 'function') {
      var iterator = h.renderers.keys();
      var step;
      var iterations = 0;
      while (iterator && typeof iterator.next === 'function' && !(step = iterator.next()).done) {
        if (++iterations > 100) { ids = []; break; }
        if (typeof step.value === 'number' && ids.indexOf(step.value) === -1) ids.push(step.value);
      }
    }
  } catch (_) { ids = []; }
  for (var fallbackId = 1; fallbackId <= 20; fallbackId++) {
    if (ids.indexOf(fallbackId) === -1) ids.push(fallbackId);
  }
  for (var i = 0; i < ids.length; i++) {
    try {
      var r = h.getFiberRoots(ids[i]);
      if (r && r.size > 0) return true;
    } catch (_) { /* one throwing renderer must not abort the readiness scan */ }
  }
  return false;
})()`;

// B143: exported TS mirror of the in-IIFE `findAllRootFibers()` inside
// INJECTED_HELPERS. The in-IIFE copy MUST be kept in sync with this logic.
// Tests exercise this mirror; the IIFE version runs in Hermes as pure JS.
// See test/unit/component-tree-multi-renderer.test.js for the contract.
//
// GH #597: union hook.renderers with Issue #126's bounded numeric range so
// every registered root is considered without regressing partial hook shims.
// The early-exit heuristic remains for scans with no usable registry.
export interface FiberLike {
  current?: unknown;
}
export interface RendererRootsLike {
  size: number;
  values(): Iterator<{ current?: unknown } | null | undefined>;
}
export interface DevToolsHookLike {
  renderers?: { keys(): Iterator<number> } | null;
  getFiberRoots?: (rendererId: number) => RendererRootsLike | null | undefined;
}

export const MAX_RENDERER_IDS = 20;
export const MAX_REGISTERED_RENDERER_IDS = 100;
export const EARLY_EXIT_EMPTY_STREAK = 3;

export function findAllRootFibersForTest(
  hook: DevToolsHookLike | null | undefined,
): Array<{ rendererId: number; fiber: unknown }> {
  if (!hook || typeof hook.getFiberRoots !== 'function') return [];
  const out: Array<{ rendererId: number; fiber: unknown }> = [];
  let rendererIds: number[] = [];
  try {
    if (hook.renderers && typeof hook.renderers.keys === 'function') {
      const iterator = hook.renderers.keys();
      let step = iterator.next();
      let iterations = 0;
      while (!step.done) {
        if (++iterations > MAX_REGISTERED_RENDERER_IDS) {
          rendererIds = [];
          break;
        }
        const id = step.value;
        if (typeof id === 'number' && !rendererIds.includes(id)) rendererIds.push(id);
        step = iterator.next();
      }
    }
  } catch {
    rendererIds = [];
  }
  const usingRegisteredIds = rendererIds.length > 0;
  for (let fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
    if (!rendererIds.includes(fallbackId)) rendererIds.push(fallbackId);
  }
  let emptyStreak = 0;
  for (const ri of rendererIds) {
    try {
      const roots = hook.getFiberRoots(ri);
      if (roots && roots.size) {
        emptyStreak = 0;
        const it = roots.values();
        let step = it.next();
        while (!step.done) {
          const r = step.value;
          if (r && r.current) out.push({ rendererId: ri, fiber: r.current });
          step = it.next();
        }
      } else if (!usingRegisteredIds) {
        emptyStreak++;
        if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) return out;
      }
    } catch {
      if (!usingRegisteredIds) emptyStreak++;
    }
  }
  return out;
}
