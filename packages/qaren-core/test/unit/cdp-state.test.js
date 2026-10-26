import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetState, sleep } from '../../dist/cdp/state.js';

function makeTarget() {
  const calls = [];
  const state = {
    state: 'connected',
    helpersInjected: true,
    bridgeDetected: true,
    bridgeVersion: 2,
    connectedTarget: { id: 't1' },
    logDomainEnabled: true,
    profilerAvailable: true,
    heapProfilerAvailable: true,
    scripts: new Map([['s1', { scriptId: 's1', url: 'a.js', startLine: 0, endLine: 1 }]]),
  };
  return {
    calls,
    state,
    setState: (v) => {
      calls.push(['state', v]);
      state.state = v;
    },
    setHelpersInjected: (v) => {
      calls.push(['helpers', v]);
      state.helpersInjected = v;
    },
    setBridgeDetected: (v) => {
      calls.push(['bridgeDetected', v]);
      state.bridgeDetected = v;
    },
    setBridgeVersion: (v) => {
      calls.push(['bridgeVersion', v]);
      state.bridgeVersion = v;
    },
    setConnectedTarget: (v) => {
      calls.push(['target', v]);
      state.connectedTarget = v;
    },
    setConnectedAt: (v) => {
      calls.push(['connectedAt', v]);
      state.connectedAt = v;
    },
    setLogDomainEnabled: (v) => {
      calls.push(['logDomain', v]);
      state.logDomainEnabled = v;
    },
    setProfilerAvailable: (v) => {
      calls.push(['profiler', v]);
      state.profilerAvailable = v;
    },
    setHeapProfilerAvailable: (v) => {
      calls.push(['heapProfiler', v]);
      state.heapProfilerAvailable = v;
    },
    clearScripts: () => {
      calls.push(['clearScripts']);
      state.scripts.clear();
    },
  };
}

test('resetState sets state to disconnected', () => {
  const t = makeTarget();
  resetState(t);
  assert.equal(t.state.state, 'disconnected');
});

test('resetState clears all capability flags', () => {
  const t = makeTarget();
  resetState(t);
  assert.equal(t.state.helpersInjected, false);
  assert.equal(t.state.bridgeDetected, false);
  assert.equal(t.state.bridgeVersion, null);
  assert.equal(t.state.logDomainEnabled, false);
  assert.equal(t.state.profilerAvailable, false);
  assert.equal(t.state.heapProfilerAvailable, false);
});

test('resetState nulls connectedTarget', () => {
  const t = makeTarget();
  resetState(t);
  assert.equal(t.state.connectedTarget, null);
});

test('resetState clears the scripts map', () => {
  const t = makeTarget();
  resetState(t);
  assert.equal(t.state.scripts.size, 0);
});

test('resetState calls every setter exactly once', () => {
  const t = makeTarget();
  resetState(t);
  const names = t.calls.map((c) => c[0]);
  assert.deepEqual(names, [
    'state',
    'helpers',
    'bridgeDetected',
    'bridgeVersion',
    'target',
    'connectedAt',
    'logDomain',
    'profiler',
    'heapProfiler',
    'clearScripts',
  ]);
});

test('sleep resolves after approximately the given delay', async () => {
  const start = Date.now();
  await sleep(30);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 25, `expected >= 25ms, got ${elapsed}ms`);
  assert.ok(elapsed < 200, `expected < 200ms, got ${elapsed}ms`);
});
