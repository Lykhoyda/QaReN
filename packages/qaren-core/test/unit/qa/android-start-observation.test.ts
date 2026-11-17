import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../../../../../', import.meta.url));
const moduleUrl = (path: string) => new URL(`../../../dist/${path}.js`, import.meta.url).href;

test('Android admission logs an allowed opening after a failed driver read and separates a later refusal', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'qaren-start-observation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  // Native and CDP adapters are synthetic here; the real openSession/admit and log sites execute.
  const script = `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    const deviceUrl = ${JSON.stringify(moduleUrl('handlers/device-session'))};
    const discoveryUrl = ${JSON.stringify(moduleUrl('cdp/discovery'))};
    const proofUrl = ${JSON.stringify(moduleUrl('qa/prove'))};
    const driverUrl = ${JSON.stringify(moduleUrl('runners/external-runner-detect'))};
    const overlaysUrl = ${JSON.stringify(moduleUrl('handlers/dev-settings'))};
    const {okResult} = await import(${JSON.stringify(moduleUrl('utils'))});
    const {HandlerError} = await import(${JSON.stringify(moduleUrl('qa/adapt'))});
    const {CDPTargetClosedError} = await import(${JSON.stringify(moduleUrl('cdp/connect'))});
    const device = await import(deviceUrl);
    const discovery = await import(discoveryUrl);
    const proof = await import(proofUrl);
    const driver = await import(driverUrl);
    const overlays = await import(overlaysUrl);
    let opens = 0; let closes = 0; let proofs = 0; let driverReads = 0;
    mock.module(deviceUrl, {namedExports: {...device, createDeviceSnapshotHandler: () => async args => {
      if (args.action === 'open') opens++;
      else if (args.action === 'close') closes++;
      else throw new Error('unexpected snapshot');
      return okResult({});
    }}});
    mock.module(discoveryUrl, {namedExports: {...discovery, waitForExactPortTargets: async () => {}}});
    mock.module(proofUrl, {namedExports: {...proof, prove: async () => {
      if (++proofs === 1) throw new CDPTargetClosedError('synthetic socket loss');
      return {ok: true, scriptURL: 'http://127.0.0.1:8081/index.bundle', appModules: 3};
    }}});
    mock.module(driverUrl, {namedExports: {...driver, androidForeignDriverMessage: serial => driver.androidForeignDriverMessage(serial, async () => {
      driverReads++; throw new Error('synthetic unreadable process table');
    })}});
    mock.module(overlaysUrl, {namedExports: {...overlays, clearDevOverlays: async () => {
      process.stderr.write('SYNTHETIC_OVERLAY_PHASE\\n');
      throw new HandlerError('CORE_REFUSED', 'synthetic post-admission overlay refusal');
    }}});
    const {CDPClient} = await import(${JSON.stringify(moduleUrl('cdp-client'))});
    CDPClient.prototype.connectExact = async () => {};
    CDPClient.prototype.evaluate = async () => ({value: true});
    CDPClient.prototype.disconnect = async () => {};
    const {openSession} = await import(${JSON.stringify(moduleUrl('qa/walk'))});
    const {ObservedPrivacy} = await import(${JSON.stringify(moduleUrl('qa/privacy'))});
    const request = {runId: 'synthetic-observation', t0: Date.now(), walkBudgetMs: 8000, attachBudgetMs: 8000, platform: 'android', appId: 'com.example.synthetic', target: {deviceId: 'synthetic-android', deviceName: 'Synthetic Android', metroPort: 8081, metroUrlForDevice: 'http://127.0.0.1:8081', worktree: ${JSON.stringify(root)}}};
    await assert.rejects(openSession(request, () => {}, () => {}, () => {}, new ObservedPrivacy(), undefined, () => {}, undefined, async () => 'loaded'), {code: 'CORE_REFUSED', message: 'synthetic post-admission overlay refusal'});
    assert.deepEqual({opens, closes, proofs, driverReads}, {opens: 1, closes: 1, proofs: 2, driverReads: 1});
    process.stdout.write('OBSERVATION_OK\\n');
  `;
  const child = spawnSync(
    'bash',
    [
      join(root, 'scripts/qaren-sim-sandbox.sh'),
      process.execPath,
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      cwd: root,
      env: { ...process.env, QAREN_SANDBOX_DIR: join(scratch, 'sandbox'), TYPESAFE_API_KEY: '' },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /OBSERVATION_OK/);
  const log = child.stderr;
  const driver = log.indexOf('driver check allowed the opening');
  const firstProof = log.indexOf('android start: proof starts');
  const returned = log.indexOf('android start: admission returned');
  const laterPhase = log.indexOf('SYNTHETIC_OVERLAY_PHASE');
  assert.ok(driver >= 0 && firstProof > driver && returned > firstProof && laterPhase > returned);
  assert.equal(log.match(/driver check allowed the opening/g)?.length, 1);
  assert.equal(
    log.match(/android start: proof starts/g)?.length,
    2,
    'proof can repeat without reopening',
  );
  assert.equal(log.match(/android start: target listed/g)?.length, 2);
  assert.equal(log.match(/android start: admission returned/g)?.length, 1);
  assert.doesNotMatch(log, /driver check clear/);
  const times = [
    ...log.matchAll(/android start: (?:target listed|admission returned) at (\d+) ms/g),
  ].map((match) => Number(match[1]));
  assert.equal(times.length, 3);
  assert.ok(times[2] >= times[1] && times[1] >= times[0]);
});

test('Android admission does not log an allowed opening when a foreign driver refuses it', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'qaren-start-observation-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const script = `
    import assert from 'node:assert/strict';
    import {mock} from 'node:test';
    const deviceUrl = ${JSON.stringify(moduleUrl('handlers/device-session'))};
    const discoveryUrl = ${JSON.stringify(moduleUrl('cdp/discovery'))};
    const proofUrl = ${JSON.stringify(moduleUrl('qa/prove'))};
    const driverUrl = ${JSON.stringify(moduleUrl('runners/external-runner-detect'))};
    const {okResult} = await import(${JSON.stringify(moduleUrl('utils'))});
    const device = await import(deviceUrl);
    const discovery = await import(discoveryUrl);
    const proof = await import(proofUrl);
    const driver = await import(driverUrl);
    let opens = 0; let proofs = 0;
    mock.module(deviceUrl, {namedExports: {...device, createDeviceSnapshotHandler: () => async args => {
      if (args.action === 'open') opens++;
      return okResult({});
    }}});
    mock.module(discoveryUrl, {namedExports: {...discovery, waitForExactPortTargets: async () => {}}});
    mock.module(proofUrl, {namedExports: {...proof, prove: async () => { proofs++; throw new Error('must not prove'); }}});
    mock.module(driverUrl, {namedExports: {...driver, androidForeignDriverMessage: async () => 'synthetic foreign UIAutomator driver'}});
    const {CDPClient} = await import(${JSON.stringify(moduleUrl('cdp-client'))});
    CDPClient.prototype.connectExact = async () => {};
    CDPClient.prototype.evaluate = async () => ({value: true});
    CDPClient.prototype.disconnect = async () => {};
    const {openSession} = await import(${JSON.stringify(moduleUrl('qa/walk'))});
    const {ObservedPrivacy} = await import(${JSON.stringify(moduleUrl('qa/privacy'))});
    const request = {runId: 'synthetic-foreign', t0: Date.now(), walkBudgetMs: 8000, attachBudgetMs: 8000, platform: 'android', appId: 'com.example.synthetic', target: {deviceId: 'synthetic-android', deviceName: 'Synthetic Android', metroPort: 8081, metroUrlForDevice: 'http://127.0.0.1:8081', worktree: ${JSON.stringify(root)}}};
    await assert.rejects(openSession(request, () => {}, () => {}, () => {}, new ObservedPrivacy(), undefined, () => {}, undefined, async () => 'loaded'), {code: 'BUSY_FOREIGN_FLOW'});
    assert.deepEqual({opens, proofs}, {opens: 0, proofs: 0});
    process.stdout.write('FOREIGN_OK\\n');
  `;
  const child = spawnSync(
    'bash',
    [
      join(root, 'scripts/qaren-sim-sandbox.sh'),
      process.execPath,
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      script,
    ],
    {
      cwd: root,
      env: { ...process.env, QAREN_SANDBOX_DIR: join(scratch, 'sandbox'), TYPESAFE_API_KEY: '' },
      encoding: 'utf8',
      timeout: 15_000,
    },
  );
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /FOREIGN_OK/);
  assert.match(child.stderr, /android start: debugger connect at \d+ ms/);
  assert.doesNotMatch(child.stderr, /driver check allowed the opening/);
  assert.doesNotMatch(child.stderr, /android start: proof starts/);
});
