// GH #110: regression tests for the agent-device-wrapper test-seam fuse.
//
// The fuse is process-global by design (Codex review conf 90/90/95 —
// adding a reset seam would defeat the guarantee, since any code that
// could call reset is the same code that could leak the override). Each
// scenario therefore runs in a freshly-spawned Node subprocess so the
// fuse state is isolated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOD_ABS_PATH = resolve(__dirname, '../../dist/agent-device-wrapper.js');

function runScenario(scenarioCode) {
  // Use the modern dynamic-import form to avoid CJS/ESM confusion.
  const wrapped = `
    (async () => {
      try {
        const mod = await import(${JSON.stringify(MOD_ABS_PATH)});
        ${scenarioCode}
        console.log('SCENARIO_OK');
      } catch (e) {
        console.log('SCENARIO_THREW:' + (e && e.message ? e.message : String(e)));
      }
    })().catch(e => { console.log('SCENARIO_REJECTED:' + (e && e.message ? e.message : String(e))); process.exit(1); });
  `;
  const result = spawnSync('node', ['--input-type=module', '-e', wrapped], {
    encoding: 'utf-8',
    timeout: 20_000,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

test('fuse: override fn is honored when set before any production dispatch', () => {
  const { stdout } = runScenario(`
    let captured = null;
    mod._setRunAgentDeviceForTest(async (args, opts) => {
      captured = { args, opts };
      return { content: [{ type: 'text', text: '{"ok":true,"data":"stubbed"}' }] };
    });
    const r = await mod.runNative(['snapshot'], {});
    if (!r.content[0].text.includes('stubbed')) throw new Error('override not invoked');
    if (captured.args[0] !== 'snapshot') throw new Error('args not threaded through');
  `);
  assert.match(stdout, /SCENARIO_OK/, `expected SCENARIO_OK, got: ${stdout}`);
});

test('fuse: setting override to null re-enables production tier as long as fuse has not blown', () => {
  const { stdout } = runScenario(`
    let called = 0;
    mod._setRunAgentDeviceForTest(async () => { called++; return { content: [{ type: 'text', text: '{"ok":true}' }] }; });
    await mod.runNative(['snapshot'], {});
    if (called !== 1) throw new Error('override not invoked on first call');

    // Set back to null — fuse has NOT blown (no production dispatch occurred).
    mod._setRunAgentDeviceForTest(null);
    // Subsequent installs should still work
    let called2 = 0;
    mod._setRunAgentDeviceForTest(async () => { called2++; return { content: [{ type: 'text', text: '{"ok":true}' }] }; });
    await mod.runNative(['tap'], {});
    if (called2 !== 1) throw new Error('second override not invoked');
  `);
  assert.match(stdout, /SCENARIO_OK/, `expected SCENARIO_OK, got: ${stdout}`);
});

test('fuse: a production runAgentDevice call (no override) blows the fuse', () => {
  // The production tiers will fail (no booted device / fast-runner) but
  // the fuse must still be sealed regardless of the dispatch outcome.
  const { stdout } = runScenario(`
    // Direct call with no override installed → production dispatch
    // begins → fuse blows immediately (before any tier returns).
    let prodThrew = false;
    try {
      await mod.runNative(['list-devices'], { skipSession: true });
    } catch {
      prodThrew = true;
    }
    // Whether the production tier returned cleanly or threw, the fuse
    // is locked. Attempting to install an override now must throw.
    let fuseThrew = false;
    try {
      mod._setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    } catch (e) {
      fuseThrew = true;
      if (!String(e.message).includes('blown fuse')) throw new Error('wrong error: ' + e.message);
      if (!String(e.message).includes('list-devices')) throw new Error('error should mention the trigger cliArgs[0]');
    }
    if (!fuseThrew) throw new Error('expected fuse to throw on re-arm');
  `);
  assert.match(stdout, /SCENARIO_OK/, `expected SCENARIO_OK, got: ${stdout}`);
});

test('fuse: error message includes GH #110 reference and remediation hint', () => {
  const { stdout, stderr, status } = runScenario(`
    // Production tier may throw (no booted device in test env) — that's
    // fine, the fuse must still seal. Use list-devices because it dodges
    // the slow fast-runner path that snapshot would take.
    try { await mod.runNative(['list-devices'], { skipSession: true }); } catch {}
    let threw = false;
    try {
      mod._setRunAgentDeviceForTest(null);
    } catch (e) {
      threw = true;
      if (!String(e.message).includes('GH #110')) throw new Error('error must reference GH #110');
      if (!String(e.message).includes('--test-isolation=process')) throw new Error('error must include remediation hint');
      console.log('GOOD_ERROR');
    }
    if (!threw) throw new Error('expected fuse to throw on re-arm');
  `);
  assert.match(
    stdout,
    /GOOD_ERROR[\s\S]*SCENARIO_OK/,
    `expected GOOD_ERROR then SCENARIO_OK\nstdout: ${stdout}\nstderr: ${stderr}\nstatus: ${status}`,
  );
});

test('fuse: setting null to clear override does not block when fuse has NOT blown', () => {
  // Edge: install an override, run it, then clear it back to null
  // BEFORE any production dispatch. This is the normal afterEach
  // cleanup case — must not throw.
  const { stdout } = runScenario(`
    mod._setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }));
    await mod.runNative(['snapshot'], {});
    // Standard cleanup — must not throw because no production dispatch happened.
    mod._setRunAgentDeviceForTest(null);
    // Installing a new override after clean cleanup must still work.
    mod._setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: '{"ok":true,"data":"second"}' }] }));
    const r = await mod.runNative(['snapshot'], {});
    if (!r.content[0].text.includes('second')) throw new Error('second override not active');
  `);
  assert.match(stdout, /SCENARIO_OK/, `expected SCENARIO_OK, got: ${stdout}`);
});
