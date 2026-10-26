// GH #214: cdp_network_log returned TWO entries per request — one with a
// numeric id (CDP Network domain) and one with a UUID id (injected fetch/XHR
// hook). Root cause: performSetup sends Network.enable (mode='cdp'), then
// probeNetworkDomain fires a probe fetch and watches the buffer. On RN >= 0.83
// the domain DOES deliver events, but when they don't flush within the probe
// window (false negative — documented after platform switches / reloads, GH
// #59 #9), the probe returns 'none' and the fallback injects the hook and sets
// mode='hook' WITHOUT disabling the still-enabled CDP Network domain. Both
// paths then capture every request; the getByKey dedup can't catch the dupes
// because numeric and UUID id schemes never collide.
//
// This is also the capability "desync" the reporter saw: cdp_status labels the
// mode 'hook' (networkDomain:false) while numeric CDP ids keep appearing,
// because the domain was never turned off.
//
// Fix: when setup falls back to the hook, it must Network.disable first so the
// hook is the single capture source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performSetup } from '../../dist/cdp/setup.js';
import {
  INJECTED_HELPERS,
  NETWORK_HOOK_SCRIPT,
  NETWORK_CB_BUFFERED_SCRIPT,
  REACT_READY_PROBE_JS,
} from '../../dist/injected-helpers.js';

// Minimal performSetup harness. `send` records every CDP method; `evaluate`
// answers the fixed expressions setup issues. `bufferGrowsOnProbe` controls
// whether the probe fetch appears to deliver a CDP event (true = RN<0.83-style
// real CDP, stays 'cdp'; false = false-negative / genuine fallback → 'hook').
function makeHarness({ enableThrows = false, bufferGrowsOnProbe = false } = {}) {
  const sent = [];
  const send = async (method) => {
    sent.push(method);
    if (method === 'Network.enable' && enableThrows) throw new Error('not supported');
    return {};
  };
  let size = 0;
  const evaluate = async (expr) => {
    if (expr === REACT_READY_PROBE_JS) return { value: true };
    if (expr === INJECTED_HELPERS) return { value: undefined };
    if (expr === 'typeof globalThis.__QAREN === "object"') return { value: true };
    if (expr === NETWORK_HOOK_SCRIPT || expr === NETWORK_CB_BUFFERED_SCRIPT)
      return { value: undefined };
    // probe fetch (`void fetch(...)`) — optionally simulate a delivered event.
    if (typeof expr === 'string' && expr.includes('fetch(') && bufferGrowsOnProbe) size += 1;
    return { value: undefined };
  };
  const networkManager = { size: () => size, push: () => {}, getByKey: () => undefined };
  return {
    sent,
    opts: {
      send,
      evaluate,
      setupHelpers: async () => true,
      port: 8081,
      connectedTarget: null,
      networkManager,
      getDeviceKey: () => 'k',
      setupEventHandlers: () => {},
      clearScripts: () => {},
      clearEventHandlers: () => {},
      probeWaits: [1, 1], // test seam: fast probe
    },
  };
}

test('fallback to hook disables the CDP Network domain (the #214 double-capture fix)', async () => {
  const h = makeHarness({ enableThrows: false, bufferGrowsOnProbe: false });
  const result = await performSetup(h.opts);

  assert.equal(result.networkMode, 'hook', 'false-negative probe must fall back to hook');
  assert.ok(h.sent.includes('Network.enable'), 'Network.enable was attempted');
  assert.ok(
    h.sent.includes('Network.disable'),
    `must disable the still-enabled CDP domain before hook capture — sent: ${h.sent.join(', ')}`,
  );
  // Ordering: the domain must be disabled, not re-enabled afterward.
  assert.ok(
    h.sent.lastIndexOf('Network.disable') > h.sent.lastIndexOf('Network.enable'),
    'Network.disable must come after the Network.enable it cancels',
  );
});

test('CDP mode (probe succeeds) keeps the domain — does NOT disable it', async () => {
  const h = makeHarness({ enableThrows: false, bufferGrowsOnProbe: true });
  const result = await performSetup(h.opts);

  assert.equal(result.networkMode, 'cdp', 'a delivered probe event keeps CDP mode');
  assert.ok(
    !h.sent.includes('Network.disable'),
    'must not disable the domain that is the sole capture source',
  );
});

test('Network.enable unsupported (genuine RN<0.83): reaches hook mode without crashing', async () => {
  const h = makeHarness({ enableThrows: true, bufferGrowsOnProbe: false });
  const result = await performSetup(h.opts);

  assert.equal(result.networkMode, 'hook', 'enable threw → never cdp → hook fallback');
  // The domain was never enabled, so a disable here is a harmless no-op; the
  // single-source contract is satisfied either way. No assertion on disable.
});
