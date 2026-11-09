import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CaptureDeadline } from '../../../dist/qa/capture.js';
import { ResolutionError } from '../../../dist/qa/resolve.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan, type WalkerDeps } from '../../../dist/qa/walker.js';
import {
  completeCapture,
  controlEvidence,
  dismissCandidate,
  pressRecord,
  type InterruptionDiagnostic,
  type InterruptionProof,
  type RecoveryTarget,
} from '../../../dist/qa/recover.js';
import { behindPresentedModal, join, type Screen } from '../../../dist/qa/screen.js';
import { element, screen, scriptedJudge } from './judgment-fixtures.ts';

type Fixture = {
  mode: 'ordinary' | 'presence';
  captureCoverage: NonNullable<Screen['captureCoverage']>;
  joinArgs: {
    nodes: Parameters<typeof join>[0];
    digest: Parameters<typeof join>[1];
    front: Parameters<typeof join>[2];
    coverage: Parameters<typeof join>[3];
    reactHostEvidence: NonNullable<Parameters<typeof join>[4]>;
    nativePresence?: Parameters<typeof join>[5];
    nativeAcquisition: Parameters<typeof join>[6];
  };
};
function fixture(name: string): Fixture {
  return JSON.parse(
    readFileSync(
      new URL(`../../fixtures/ios-optin-after-tap/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
}
function captured(name: string, edit?: (fixture: Fixture) => void): Screen {
  const f = fixture(name);
  edit?.(f);
  const a = f.joinArgs;
  // Production keeps native acquisition separate from native presence. Never upgrade an ordinary read.
  return {
    ...join(
      a.nodes,
      a.digest,
      a.front,
      a.coverage,
      a.reactHostEvidence,
      a.nativePresence,
      a.nativeAcquisition,
    ),
    captureCoverage: f.captureCoverage,
  };
}
const opener = () => captured('tap');
const target = (): RecoveryTarget => ({
  phrase: 'qa-notification-pair-target',
  quoted: 'qa-notification-pair-target',
  exact: 'id',
  kind: 'press',
  line: 15,
  afterPlannedPress: true,
  pressRecord: pressRecord(
    opener(),
    opener().elements.find((e) => e.testID === 'qa-notification-pair-start'),
  ),
});
function decide(s: Screen, t = target(), proof: InterruptionProof = 'covered-target') {
  const records: InterruptionDiagnostic[] = [];
  const result = dismissCandidate(s, [t], (r) => records.push(r), proof);
  return { result, record: records.at(-1) };
}
const decline = (s: Screen) => s.elements.find((e) => e.testID === 'qa-notification-pair-decline')!;

test('retained ordinary dispatch and presence captures keep separate acquisition and control evidence', () => {
  const tap = opener();
  assert.equal(completeCapture(tap), true);
  assert.equal(tap.coverage?.native, 'unknown');
  assert.equal(controlEvidence(tap).controls, undefined);
  const s = captured('recovery');
  assert.equal(controlEvidence(s).evidence.controls, 2);
  assert.equal(s.semanticUnassociatedReact, 1);
  assert.ok(
    s.elements.filter((e) => e.ref.startsWith('react:')).every((e) => behindPresentedModal(s, e)),
  );
});
test('H2b: the ordinary dispatch record is known without proven press capabilities', () => {
  const record = target().pressRecord!;
  assert.equal(record.label, 'continue to lists');
  assert.ok(
    record.controls?.includes(JSON.stringify(['button', 'id', 'qa-notification-pair-start'])),
  );
});
test('H2/H2a: the recovery capture qualifies with both the captured and a known tap record', () => {
  for (const record of [target().pressRecord, { label: 'continue to lists', controls: [] }]) {
    const { result, record: rejected } = decide(captured('recovery'), {
      ...target(),
      pressRecord: record,
    });
    assert.ok(result && 'optIn' in result && result.optIn?.afterPlannedPress);
    assert.equal(result.label, 'Not now');
    assert.equal(rejected, undefined);
  }
});

type Fault = 'late' | 'incomplete' | 'unavailable' | 'visibility' | 'gap';
function walkCaptured(fault?: Fault) {
  let phase = 'tap';
  let clock = 0;
  let presence = 0;
  const actions: string[] = [];
  const notes: string[] = [];
  const deps: WalkerDeps = {
    judge: scriptedJudge(() => assert.fail('literal fixture steps never need a model')),
    presenceUnavailable: fault === 'unavailable',
    async captureScreen(options) {
      if (phase === 'tap') return opener();
      if (phase === 'readback') return captured('readback');
      if (phase === 'done') return captured('target-passed');
      if (!options?.platformPresence) return captured('prompt');
      presence += 1;
      if (presence === 1 && (fault === 'late' || fault === 'incomplete')) {
        if (fault === 'late') throw new CaptureDeadline();
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'incomplete fixture',
        });
      }
      if (presence > 1 && fault === 'unavailable')
        throw new ResolutionError({
          refuse: 'SCREEN_EVIDENCE_INCOMPLETE',
          reason: 'unavailable fixture',
        });
      const s = captured(presence === 1 ? 'scroll-presence' : 'recovery');
      if (presence > 1 && fault === 'visibility') decline(s).semantic!.visibility = 'unknown';
      if (presence > 1 && fault === 'gap') s.pressGapCount = 1;
      return s;
    },
    async press(ref) {
      actions.push(`press ${ref}`);
      if (phase === 'tap') phase = 'prompt';
      else if (phase === 'prompt' && ref === decline(captured('recovery')).ref) phase = 'readback';
      else if (phase === 'readback') phase = 'done';
      else assert.fail(`unexpected press ${ref}`);
      return { ok: true, proven: true, executed: true };
    },
    async scroll() {
      actions.push('scroll');
      return { ok: true, proven: true, executed: true };
    },
    async fill() {
      assert.fail('unexpected fill');
    },
    async back() {
      assert.fail('unexpected back');
    },
    async dialog() {
      assert.fail('unexpected dialog');
    },
    async hideDevMenu() {
      assert.fail('unexpected dev menu');
    },
    async screenshot(name) {
      return name;
    },
    now: () => clock,
    async sleep(ms) {
      clock += ms;
    },
    row() {},
    note: (s) => notes.push(s),
  };
  const blocks = parsePlan(
    '1. Tap "qa-notification-pair-start"\n2. Tap "qa-notification-pair-target"',
  ).blocks!;
  blocks[0].items.forEach((item, i) => {
    item.line = i + 14;
    if (item.kind === 'press') item.target.exact = 'id';
  });
  return { result: () => runPlan(blocks, deps), actions, notes };
}

test('H1: real captures decline once, prove both gone and retry line 15 without scrolling', async () => {
  const f = walkCaptured();
  const r = await f.result();
  assert.equal(r.verdict, 'PASS', JSON.stringify(r.failure));
  assert.deepEqual(f.actions, ['press @e6', 'press @e13', 'press @e8']);
  assert.equal(r.recoveries, 1);
  assert.deepEqual(r.declinedOptIns, [{ line: 15, afterPlannedPress: true }]);
  const retry = r.steps.find((row) => row.line === 15 && row.outcome === 'retry');
  assert.equal(retry?.interruption?.screenClass, 'permission-opt-in');
  assert.equal(retry?.interruption?.afterPlannedPress, true);
  assert.match(retry?.reason ?? '', /\(Not now\)/);
  assert.ok(!r.steps.some((row) => row.reason?.includes('nothing was dismissed')));
});

test('H3a: loss of any modal cover proof refuses the covered target', () => {
  for (const fault of ['missing', 'second', 'outside', 'inside']) {
    const s = captured('recovery', (f) => {
      const h = f.joinArgs.reactHostEvidence;
      const nodes = h.typography!.nodes;
      const modal = nodes.find((n) => n.hostType === 'RCTModalHostView')!;
      const targetHost = h.hosts.findIndex((host) => host.testID === 'qa-notification-pair-target');
      if (fault === 'missing') modal.hostType = 'RCTView';
      if (fault === 'second')
        nodes.find(
          (n) =>
            n.hostIndex !== modal.hostIndex && nodes.some((c) => c.parentHostIndex === n.hostIndex),
        )!.hostType = 'RCTModalHostView';
      if (fault === 'outside')
        nodes[
          h.hosts.findIndex((host) => host.testID === 'qa-notification-pair-decline')
        ].parentHostIndex = null;
      if (fault === 'inside') nodes[targetHost].parentHostIndex = modal.hostIndex;
    });
    assert.equal(decide(s).record?.veto, 'uncovered-target', fault);
    assert.equal(decide(s).result, undefined, fault);
  }
});
test('H3b: 4c refuses unproven, inside-modal and mismatched React-only controls', () => {
  for (const fault of ['inside', 'anonymous', 'refused']) {
    const s = captured('recovery');
    // Isolate 4c from the target and count gates, which have their own cover negatives above.
    s.elements.push(
      element(`react:${fault}`, 'Extra', {
        testID: fault === 'inside' ? 'qa-notification-pair-decline' : undefined,
        offscreen: true,
      }),
    );
    s.semanticUnassociatedReact = fault === 'anonymous' ? 3 : 2;
    if (fault === 'refused') s.reactHostEvidence!.typography!.complete = false;
    const r = decide(s, { ...target(), quoted: 'missing', phrase: 'missing' }, 'surface');
    assert.equal(r.result, undefined, fault);
    assert.equal(r.record?.veto, 'previous-plan-press', fault);
    assert.equal(r.record?.optInWithheld, 'react-control-in-front', fault);
  }
});
test('H4: a dispatch identity already present, unknown record or prior answer keeps the veto', () => {
  for (const ref of ['@native', 'react:old']) {
    const before = opener();
    before.elements.push(
      element(ref, 'Other', { testID: 'qa-notification-pair-decline', offscreen: true }),
    );
    const r = decide(captured('recovery'), {
      ...target(),
      pressRecord: pressRecord(
        before,
        before.elements.find((e) => e.testID === 'qa-notification-pair-start'),
      ),
    });
    assert.equal(r.result, undefined);
    assert.equal(r.record?.optInWithheld, 'same-control-before-tap');
  }
  for (const before of [
    undefined,
    { ...opener(), captureCoverage: { native: 'incomplete', react: 'complete' } } as Screen,
    screen([element('@anon', '', { label: undefined })]),
  ]) {
    const r = decide(captured('recovery'), {
      ...target(),
      pressRecord: pressRecord(before, before?.elements[0]),
    });
    assert.equal(r.record?.optInWithheld, 'tap-record-unknown');
    assert.equal(r.result, undefined);
  }
  for (const label of ['Allow', 'Skip', 'Not now']) {
    const r = decide(captured('recovery'), { ...target(), pressRecord: { label, controls: [] } });
    assert.equal(r.record?.optInWithheld, 'tap-was-answer');
    assert.equal(r.result, undefined);
  }
});
test('H5: failed reads and unproven decline evidence name the cause without a decline dispatch', async () => {
  for (const [fault, clause] of [
    ['late', /presence read for it was late or incomplete/],
    ['incomplete', /presence read for it was late or incomplete/],
    ['unavailable', /recovery could not read the screen's presence evidence/],
    ['visibility', /its visibility or press evidence could not be proven/],
    ['gap', /control evidence is incomplete or unknown/],
  ] as const) {
    const f = walkCaptured(fault);
    const r = await f.result();
    assert.equal(r.verdict, 'FAIL', fault);
    assert.ok(!f.actions.includes('press @e13'), fault);
    assert.ok(!f.actions.includes('press @e14'), fault);
    assert.match(r.failure?.seen ?? '', clause, fault);
    if (fault === 'late' || fault === 'incomplete') assert.ok(f.actions.includes('scroll'));
  }
});
test('H6: real consent capture and outside-vocabulary Close refuse without an answer', () => {
  const consent = captured('consent');
  const t = { ...target(), phrase: 'qa-consent-pair-target', quoted: 'qa-consent-pair-target' };
  const r = decide(consent, t);
  assert.equal(r.result, undefined);
  assert.equal(r.record?.veto, 'previous-plan-press');
  assert.equal(r.record?.optInWithheld, 'not-an-opt-in');
  assert.ok(consent.visibleText.includes('Privacy consent'));
  const close = screen([
    element('@title', 'Details', { kind: 'text' }),
    element('@close', 'Close'),
  ]);
  const c = decide(close, { ...target(), quoted: 'missing', phrase: 'missing' }, 'surface');
  assert.equal(c.result, undefined);
  assert.equal(c.record?.veto, 'previous-plan-press');
  assert.equal(c.record?.optInWithheld, 'not-an-opt-in');
});
