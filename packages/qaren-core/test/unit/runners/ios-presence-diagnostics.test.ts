import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const native = new URL(
  '../../../../qaren-ios-runner/QarenIosRunner/QarenIosRunnerUITests/',
  import.meta.url,
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}

test('Swift presence diagnostics preserve read behavior and latch the first deadline', (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const models = readFileSync(new URL('QarenIosRunnerTests+Models.swift', native), 'utf8');
  const snapshot = readFileSync(new URL('QarenIosRunnerTests+Snapshot.swift', native), 'utf8');
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
${section(models, 'struct PlatformPresenceCapture:', 'struct PlatformPresenceObservation:')}
${section(snapshot, 'final class PresenceCaptureTiming', 'func makePlatformPresencePayload(')}
// Only the exception boundary is substituted; XCTest/ObjC unwinding needs native runtime tests.
enum RunnerObjCExceptionCatcher {
  static func catchException(_ read: () -> Void) -> String? { read(); return nil }
}
final class Harness {
${section(snapshot, '  private func presenceRead<', '  private func presenceAppIsEligible(')}
  func run() throws {
    var now = 0.0
    var reads = 0
    let timing = PresenceCaptureTiming(started: now, now: { now })
    now = 10
    timing.endPhase()
    timing.begin(.enumeration)
    now = 30
    timing.endPhase()
    timing.begin(.observation)
    let observed: Bool?? = presenceRead(deadline: 4_800, timing: timing, read: .observation) {
      self.presenceRead(deadline: 4_800, timing: timing, read: .firstMatch) {
        reads += 1
        now = 4_821
        return true
      }
    }
    precondition(observed == nil && reads == 1)
    timing.endPhase()
    timing.begin(.finalEligibility)
    let eligible: Bool? = presenceRead(deadline: 4_800, timing: timing, read: .appState) {
      reads += 1
      return true
    }
    precondition(eligible == nil && reads == 1)
    timing.endPhase()
    print(String(data: try JSONEncoder().encode(timing.diagnostics(complete: false)), encoding: .utf8)!)

    now = 4_800
    let before = PresenceCaptureTiming(started: 0, now: { now })
    let skipped: Bool? = presenceRead(deadline: 4_800, timing: before, read: .appState) {
      reads += 1
      return true
    }
    precondition(skipped == nil && reads == 1)
    before.endPhase()
    print(String(data: try JSONEncoder().encode(before.diagnostics(complete: false)), encoding: .utf8)!)

    now = 100
    let ordinary = PresenceCaptureTiming(started: now, now: { now })
    ordinary.endPhase()
    ordinary.begin(.observation)
    let notHittable: Bool? = presenceRead(deadline: 4_800, timing: ordinary, read: .candidateHit) {
      reads += 1
      return false
    }
    let unobservable: Double?? = presenceRead(deadline: 4_800, timing: ordinary, read: .observation) {
      reads += 1
      return nil as Double?
    }
    enum Unavailable: Error { case read }
    let unavailable: Bool? = presenceRead(deadline: 4_800, timing: ordinary, read: .candidateSnapshot) {
      reads += 1
      throw Unavailable.read
    }
    precondition(notHittable == false && unobservable != nil && unobservable! == nil)
    precondition(unavailable == nil && reads == 4)
    precondition(ordinary.diagnostics(complete: false).failure?.reason == .readUnavailable)
    now = 140
    ordinary.endPhase()
    print(String(data: try JSONEncoder().encode(ordinary.diagnostics(complete: false)), encoding: .utf8)!)
    precondition(ordinary.diagnostics(complete: true).failure == nil)

    now = 4_799
    let changed = PresenceCaptureTiming(started: now, now: { now })
    changed.begin(.revalidation)
    let revalidated: Bool? = presenceRead(deadline: 4_800, timing: changed, read: .revalidation) {
      changed.fail(.enumerationChanged)
      now = 4_801
      return false
    }
    precondition(revalidated == nil)
    changed.endPhase()
    print(String(data: try JSONEncoder().encode(changed.diagnostics(complete: false)), encoding: .utf8)!)

    let finalized = PresenceCaptureTiming(started: 0, now: { preconditionFailure("reuse ended time") })
    precondition(!finalized.deadlineReached(4_800, read: .finalization, edge: .after, phase: .finalization, at: 4_799))
    precondition(finalized.deadlineReached(4_800, read: .finalization, edge: .after, phase: .finalization, at: 4_800))
    precondition(finalized.diagnostics(complete: false).deadline?.phase == .finalization)
    precondition(finalized.diagnostics(complete: true).failure == nil)
    now = 0
    let nonnegative = PresenceCaptureTiming(started: 1, now: { now })
    nonnegative.endPhase()
    precondition(nonnegative.diagnostics(complete: true).phaseMs["initial-eligibility"] == 0)

    for invalid in [Double.nan, Double.infinity, -Double.infinity, -1.0] {
      for field in ["started", "now", "deadline"] {
        now = field == "now" ? invalid : 0
        let clock = PresenceCaptureTiming(started: field == "started" ? invalid : 0, now: { now })
        let value: Bool? = presenceRead(deadline: field == "deadline" ? invalid : 20_000, timing: clock, read: .rootSnapshot) {
          preconditionFailure("invalid clock must refuse before reading")
        }
        precondition(value == nil)
        precondition(clock.diagnostics(complete: false).failure?.reason == .readUnavailable)
        now = 100
        precondition(clock.deadlineReached(20_000, read: .finalization, edge: .after))
      }
    }

    let legacy = PlatformPresenceCapture(
      version: 2, source: "xcui-live", captureId: "test", appId: "test", generation: 1,
      startedUptimeMs: 0, endedUptimeMs: 1, enumeration: "raw-unfiltered", complete: true,
      appliedBudgetMs: 4_800
    )
    let encoded = try JSONEncoder().encode(legacy)
    let decoded = try JSONDecoder().decode(PlatformPresenceCapture.self, from: encoded)
    precondition(decoded.diagnostics == nil)
    let legacyJSON = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
    precondition(legacyJSON["diagnostics"] == nil)
  }
}
try Harness().run()
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const [overrun, before, ordinary, changed] = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(overrun, {
    phaseMs: {
      'initial-eligibility': 10,
      enumeration: 20,
      observation: 4791,
      'final-eligibility': 0,
    },
    failure: { phase: 'observation', reason: 'deadline' },
    deadline: { phase: 'observation', read: 'first-match', edge: 'after' },
  });
  assert.deepEqual(before, {
    phaseMs: { 'initial-eligibility': 4800 },
    failure: { phase: 'initial-eligibility', reason: 'deadline' },
    deadline: { phase: 'initial-eligibility', read: 'app-state', edge: 'before' },
  });
  assert.deepEqual(ordinary, {
    phaseMs: { 'initial-eligibility': 0, observation: 40 },
    failure: { phase: 'observation', reason: 'read-unavailable' },
  });
  assert.deepEqual(changed, {
    phaseMs: { revalidation: 2 },
    failure: { phase: 'revalidation', reason: 'enumeration-changed' },
    deadline: { phase: 'revalidation', read: 'revalidation', edge: 'after' },
  });
});
