import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// The session adapter is synthetic; the real entry orchestration, walker and wire execute.
const walk = new URL('../../../dist/qa/walk.js', import.meta.url).href;
const planModule = new URL('../../../dist/qa/plan.js', import.meta.url).href;
const privacyModule = new URL('../../../dist/qa/privacy.js', import.meta.url).href;
const inputModule = new URL('../../../dist/qa/inputs.js', import.meta.url).href;
const captureModule = new URL('../../../dist/qa/private-input.js', import.meta.url).href;
const continuityModule = new URL('../../../dist/qa/capture.js', import.meta.url).href;
const utilsModule = new URL('../../../dist/utils.js', import.meta.url).href;
const screenModule = new URL('../../../dist/qa/screen.js', import.meta.url).href;
const fixtures = new URL('./judgment-fixtures.ts', import.meta.url).href;

function entry(kind: string, root: string) {
  const script = `
    import { mainRequest } from ${JSON.stringify(walk)};
    import { parsePlan, preparePlan } from ${JSON.stringify(planModule)};
    import { ObservedPrivacy } from ${JSON.stringify(privacyModule)};
    import { RunInputs, withInputs } from ${JSON.stringify(inputModule)};
    import { NativeSnapshotIncomplete, ReactCaptureIncomplete, applyNativePrivateInputs } from ${JSON.stringify(captureModule)};
    import { postAdmissionSnapshots } from ${JSON.stringify(continuityModule)};
    import { okResult } from ${JSON.stringify(utilsModule)};
    import { join } from ${JSON.stringify(screenModule)};
    import { element, screen, walker, scriptedJudge } from ${JSON.stringify(fixtures)};
    const kind = ${JSON.stringify(kind)};
    const root = ${JSON.stringify(root)};
    const privacy = new ObservedPrivacy();
    const inputs = new RunInputs(kind === 'secret' ? { FIXTURE: 'synthetic-private' } : {}, kind === 'secret' ? ['FIXTURE'] : [], privacy);
    if (kind === 'concealed') privacy.concealFallback('synthetic-private');
    if (kind === 'code') {
      privacy.didFill('4829');
      privacy.observe(join(Array.from('4829', (label, i) => ({ ref: '@box' + i, type: 'StaticText', label, rect: { x: i * 48, y: 100, width: 42, height: 42 } })), []));
    }
    let before = screen([element('@tab', 'Policies', { selected: true })]);
    if (kind === 'secure') {
      const nodes = [{ ref: '@password', type: 'SecureTextField' }];
      const captured = applyNativePrivateInputs(join(nodes, []), nodes);
      captured.elements.push(...before.elements);
      captured.visibleText.push(...before.visibleText);
      captured.coverage = { native: 'complete', react: 'complete' };
      captured.captureCoverage = { native: 'complete', react: 'complete' };
      before = captured;
    }
    const after = screen([element('@other', 'Claims', { selected: true }), element('@footer', 'Footer')]);
    const f = walker([], scriptedJudge(() => { throw new Error('unexpected model call'); }));
    let moved = false;
    f.deps.privacy = privacy;
    f.deps.videoPolicy = 'non-strict';
    f.deps.scroll = async () => { moved = true; return { ok: true, proven: false }; };
    f.deps.captureScreen = async () => {
      if (moved && kind === 'capture-native') throw new NativeSnapshotIncomplete(0, ['synthetic']);
      if (moved && kind === 'capture-react') throw new ReactCaptureIncomplete('deadline');
      return moved ? after : before;
    };
    const plan = '1. Scroll down until "Footer"';
    const lease = 'synthetic-lease';
    const request = { runId: 'synthetic-refusal', t0: Date.now(), walkBudgetMs: 10000, attachBudgetMs: 10000, plan, prepared: preparePlan(plan, parsePlan(plan).blocks), platform: 'ios', appId: 'com.example.synthetic', appRoot: root, runDir: root, lease, videoPolicy: 'non-strict', target: { deviceId: 'synthetic', deviceName: 'Synthetic', metroPort: 8081, metroUrlForDevice: 'http://127.0.0.1:8081', worktree: root, ...(kind === 'warm' ? { warmLane: true } : {}) } };
    if (kind !== 'lease') process.env.QAREN_DEVICE_LEASE = lease;
    else delete process.env.QAREN_DEVICE_LEASE;
    if (kind === 'plan') delete request.prepared;
    await withInputs(inputs, () => mainRequest(request, privacy, process.ppid, undefined, async (_request, row) => {
      if (kind === 'open') throw new Error('synthetic session refusal');
      if (kind === 'outer-error') {
        const observations = [okResult({ appProcessIdentifier: 41, nodes: [] }, { meta: { foregroundSurface: 'app' } }), okResult({ nodes: [] }, { meta: { recovered: true } })];
        const snapshots = postAdmissionSnapshots(async () => observations.shift(), request.appId);
        await snapshots.snapshot({});
        snapshots.admit();
        await snapshots.snapshot({});
        f.deps.publicationInterrupted = snapshots.interrupted;
        f.deps.continuityEvents = snapshots.events;
        f.deps.continuityEventsDropped = snapshots.dropped;
        privacy.classify = () => { throw new Error('synthetic outer error'); };
      }
      f.deps.row = row;
      if (kind === 'warm') f.deps.captureScreen = async () => ({ front: 'unknown', elements: [], visibleText: [], coverage: { native: 'complete', react: 'complete' } });
      if (kind === 'cancel-open') process.emit('SIGTERM');
      return { deps: f.deps, admittedAtMs: request.t0, close: async () => {} };
    }));
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, TYPESAFE_API_KEY: '', QAREN_INPUT_FIXTURE: '' },
  });
}

for (const kind of [
  'ordinary',
  'secret',
  'secure',
  'concealed',
  'code',
  'capture-native',
  'capture-react',
  'lease',
  'plan',
  'open',
  'warm',
  'cancel-open',
]) {
  test(`walk entry persists refusal video verdicts: ${kind}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'qaren-refused-video-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = entry(kind, root);
    assert.equal(child.status, 4, child.stderr + child.stdout);
    const envelopes = child.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const result = envelopes.at(-1).payload;
    assert.equal(result.verdict, 'REFUSED');
    const admitted = !['lease', 'plan', 'open', 'warm', 'cancel-open'].includes(kind);
    assert.equal(
      envelopes.some((e) => e.type === 'admitted'),
      admitted,
    );
    if (!admitted || kind.startsWith('capture-')) {
      assert.equal(result.videoPublication, 'unknown');
      assert.equal(Object.hasOwn(result, 'nonStrictPublication'), false);
      if (admitted) assert.equal(result.code, 'PRIVATE_INPUT_CAPTURE_UNKNOWN');
    } else {
      assert.equal(result.code, 'SCROLL_NAVIGATED');
      assert.equal(
        result.nonStrictPublication,
        kind === 'ordinary' ? 'eligible' : 'withheld-secret',
      );
      assert.equal(
        result.videoPublication,
        kind === 'ordinary' ? 'eligible' : kind === 'secret' ? 'withheld-fill' : 'withheld-privacy',
      );
    }
    assert.ok(!child.stdout.includes('synthetic-private'));
  });
}

test('walk entry finalizes pending continuity evidence on an outer walk error', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'qaren-continuity-error-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = entry('outer-error', root);
  const envelopes = child.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const result = envelopes.at(-1).payload;
  assert.equal(child.status, 1, child.stderr + child.stdout);
  assert.equal(result.publicationInterrupted, true);
  assert.equal(result.continuityEventsDropped, 0);
  assert.equal(result.continuityEvents.length, 1);
  assert.equal(result.continuityEvents[0].signal, 'runner-recovery');
  assert.equal(result.continuityEvents[0].counted, true);
  assert.equal(result.continuityEvents[0].detail.unresolved, true);
  assert.ok(result.continuityEvents[0].atMs >= result.admittedAtMs);
});
