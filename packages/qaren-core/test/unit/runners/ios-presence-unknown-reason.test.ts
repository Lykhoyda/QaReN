import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const native = new URL(
  '../../../../rn-fast-runner/RnFastRunner/RnFastRunnerUITests/',
  import.meta.url,
);

function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}

test('production Swift unknown reasons preserve observation reads and verdicts', async (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const source = readFileSync(new URL('RnFastRunnerTests+Snapshot.swift', native), 'utf8');
  const models = readFileSync(new URL('RnFastRunnerTests+Models.swift', native), 'utf8');
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
${section(models, 'struct SnapshotRect:', 'struct RetainedSnapshotTarget')}
${section(source, 'final class PresenceCaptureTiming', 'func makePlatformPresencePayload(')}
${source.slice(source.indexOf('func makePlatformPresencePayload('))}
var reads: [String] = []
enum Unavailable: Error { case read }
enum RunnerObjCExceptionCatcher {
  static var failed = false
  static var outerFailed = false
  static var depth = 0
  static func catchException(_ read: () -> Void) -> String? {
    depth += 1
    read()
    let failure = failed || (depth == 1 && outerFailed)
    failed = false
    if depth == 1 { outerFailed = false }
    depth -= 1
    return failure ? "PRIVATE-exception" : nil
  }
}
final class XCUIElementSnapshot {
  var elementType: XCUIElement.ElementType = .staticText
  var identifier = "PRIVATE-id"
  var label = "PRIVATE-label"
  var value: Any? = "PRIVATE-value"
  var frame = CGRect(x: 10, y: 20, width: 30, height: 40)
  var isEnabled = true
  var children: [XCUIElementSnapshot] = []
}
final class XCUIElement {
  enum ElementType: UInt { case application = 1, window = 2, staticText = 48, other = 82, scrollView = 44 }
  let ordinal: Int
  var hit: Bool? = true
  var snapshots = [XCUIElementSnapshot()]
  var snapshotReads = 0
  var unavailableAt = 0
  var onHit: () -> Void = {}
  init(_ ordinal: Int) { self.ordinal = ordinal }
  var isHittable: Bool {
    reads.append("hit-\\(ordinal)")
    onHit()
    if hit == nil { RunnerObjCExceptionCatcher.failed = true }
    return hit ?? false
  }
  func snapshot() throws -> XCUIElementSnapshot {
    reads.append("snapshot-\\(ordinal)")
    snapshotReads += 1
    if snapshotReads == unavailableAt { throw Unavailable.read }
    return snapshots[min(snapshotReads - 1, snapshots.count - 1)]
  }
}
struct NSPredicate {
  init(format: String, _ arguments: CVarArg...) {}
}
final class Query {
  var elements: [XCUIElement] = []
  var unavailable = false
  var outerUnavailable = false
  var onAll: () -> Void = {}
  var count: Int { 0 }
  func matching(_ predicate: NSPredicate) -> Query {
    reads.append("matching")
    if outerUnavailable { RunnerObjCExceptionCatcher.outerFailed = true }
    return self
  }
  var firstMatch: XCUIElement { reads.append("first"); return elements[0] }
  var allElementsBoundByAccessibilityElement: [XCUIElement] {
    reads.append("all")
    if unavailable { RunnerObjCExceptionCatcher.failed = true }
    onAll()
    return elements
  }
}
final class XCUIApplication {
  enum State { case runningForeground }
  let root: XCUIElementSnapshot
  let query = Query(), alerts = Query(), sheets = Query()
  var snapshotReads = 0
  init(_ root: XCUIElementSnapshot) { self.root = root }
  var state: State { reads.append("state"); return .runningForeground }
  func descendants(matching type: XCUIElement.ElementType) -> Query {
    reads.append("descendants"); return query
  }
  func snapshot() throws -> XCUIElementSnapshot {
    reads.append("root"); snapshotReads += 1; return root
  }
}
struct DataPayload {
  var nodes: [SnapshotNode]? = nil
  var truncated: Bool? = nil
  var keyboardVisible: Bool? = nil
  var snapshotGeneration: Int? = nil
  var presenceCapture: PlatformPresenceCapture? = nil
}
final class Harness {
  var retainedFastSnapshotOptions: Int? = nil
  let maxSnapshotElements = 600
  let currentSnapshotGeneration = 7
  var now = 1000.0
  let springboard = XCUIApplication(XCUIElementSnapshot())
  func blockingSystemAlertSnapshot() -> DataPayload? { nil }
  func withSystemModalDiagnostic(_ payload: DataPayload, app: XCUIApplication) -> DataPayload { payload }
  func presenceUptimeMs() -> Double { now }
  func sleepFor(_ seconds: Double) { now += seconds * 1000 }
  private struct SnapshotTraversalContext {
    let queryRoot: XCUIApplication
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    let maxDepth: Int
  }
${section(source, '  private struct PresenceDescriptor:', '  func platformPresenceFailure(')}
${section(source, '  private func presenceRead<', '  private func presenceLabelSource(')}
  private func presenceLabelSource(_ snapshot: XCUIElementSnapshot) -> PlatformPresenceObservation.LabelSource { .direct }
  private func evaluateSnapshot(_ snapshot: XCUIElementSnapshot, in context: SnapshotTraversalContext) {}
  private func makeSnapshotNode(snapshot: XCUIElementSnapshot, evaluation: Void, depth: Int, index: Int, parentIndex: Int?) -> SnapshotNode {
    SnapshotNode(index: index, type: snapshot.elementType == .staticText ? "StaticText" : "Other",
      label: snapshot.label, identifier: snapshot.identifier, value: nil,
      rect: SnapshotRect(x: Double(snapshot.frame.origin.x), y: Double(snapshot.frame.origin.y), width: Double(snapshot.frame.width), height: Double(snapshot.frame.height)),
      enabled: snapshot.isEnabled, focused: nil, hittable: true, depth: depth, parentIndex: parentIndex,
      hiddenContentAbove: nil, hiddenContentBelow: nil)
  }
${section(source, '  func snapshotPlatformPresence(', '  func retainSnapshotTargets(')}
  func observe(_ descriptor: XCUIElementSnapshot, count: Int, app: XCUIApplication, diagnostic: Bool, deadline: Double) -> [String: Any] {
    let timing = PresenceCaptureTiming(started: now, now: { self.now })
    var reasons: [String] = []
    let stamp: Double?
    if diagnostic {
      stamp = observePresence(PresenceDescriptor(descriptor)!, count: count,
        app: app, deadline: deadline, timing: timing, unknownReason: { reasons.append($0.rawValue) })
    } else {
      stamp = observePresence(PresenceDescriptor(descriptor)!, count: count,
        app: app, deadline: deadline, timing: timing)
    }
    return ["observed": stamp != nil, "stamp": stamp ?? -1, "reasons": reasons, "reads": reads,
      "deadline": timing.diagnostics(complete: false).deadline != nil]
  }
  func observeGroups(_ groups: [(XCUIElementSnapshot, Int)], app: XCUIApplication) -> [[String: Any]] {
    let timing = PresenceCaptureTiming(started: now, now: { self.now })
    return groups.map { descriptor, count in
      var reasons: [String] = []
      let stamp = observePresence(PresenceDescriptor(descriptor)!, count: count,
        app: app, deadline: 20_000, timing: timing, unknownReason: { reasons.append($0.rawValue) })
      return ["observed": stamp != nil, "reasons": reasons]
    }
  }
}
func emit(_ value: [String: Any]) throws {
  print(String(data: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), encoding: .utf8)!)
}
for name in ["first-true", "first-false", "first-nil", "r8-transient", "r8-replaced", "all-nil", "snapshot-nil", "snapshot-mismatch", "invalid-descriptor", "count-mismatch", "false-false", "nil-false", "false-nil", "nil-true", "false-true", "true-nil", "post-nil", "post-mismatch", "deadline-before", "deadline-after"] {
  for diagnostic in [false, true] {
    reads = []
    let h = Harness(), initial = XCUIElementSnapshot()
    let app = XCUIApplication(initial)
    let a = XCUIElement(0), b = XCUIElement(1)
    app.query.elements = [a, b]
    var count = 2
    // A single node: one live element and a group of one, so only that node can be hit.
    if name.hasPrefix("first-") || name.hasPrefix("deadline-") { app.query.elements = [a]; count = 1 }
    switch name {
    case "first-false": a.hit = false
    // A is unique but occluded; B shares type, identifier and label at another frame and is hittable.
    case "r8-transient":
      count = 1; a.hit = false
      let moved = XCUIElementSnapshot(); moved.frame.origin.x += 50; b.snapshots = [moved]
      app.query.elements = [b, a]
    // Only the different-frame B exists live.
    case "r8-replaced":
      count = 1
      let moved = XCUIElementSnapshot(); moved.frame.origin.x += 50; b.snapshots = [moved]
      app.query.elements = [b]
    case "first-nil": a.hit = nil
    case "all-nil": app.query.unavailable = true
    case "snapshot-nil": a.unavailableAt = 1
    case "snapshot-mismatch": a.snapshots[0].frame.origin.x += 1
    case "invalid-descriptor": a.snapshots[0].value = ["PRIVATE-unsupported"]
    case "count-mismatch": count = 1
    case "false-false": a.hit = false; b.hit = false
    case "nil-false": a.hit = nil; b.hit = false
    case "false-nil": a.hit = false; b.hit = nil
    case "nil-true": a.hit = nil
    case "false-true": a.hit = false
    case "true-nil": b.hit = nil
    case "post-nil": a.unavailableAt = 2
    case "post-mismatch": let after = XCUIElementSnapshot(); after.frame.origin.x += 1; a.snapshots.append(after)
    case "deadline-after": a.onHit = { h.now = 20_000 }
    default: break
    }
    var result = h.observe(initial, count: count, app: app, diagnostic: diagnostic, deadline: name == "deadline-before" ? 1000 : 20_000)
    result["name"] = name; result["diagnostic"] = diagnostic
    try emit(result)
  }
}
for name in ["empty", "clipped", "ambiguous", "group-false", "group-nil", "group-true", "outer-nil", "outer-nil-after-false", "disabled-positive"] {
  reads = []
  let h = Harness(), root = XCUIElementSnapshot(), window = XCUIElementSnapshot(), first = XCUIElementSnapshot(), second = XCUIElementSnapshot()
  root.elementType = .application; window.elementType = .window
  window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
  root.children = [window]; window.children = [first]
  let app = XCUIApplication(root), live = XCUIElement(0)
  app.query.elements = [live]
  switch name {
  case "empty": first.frame = .zero
  case "clipped": first.frame.origin.y = -100
  case "ambiguous": window.children.append(second)
  case "group-false": first.children = [second]; live.hit = false
  case "group-nil": first.children = [second]; live.hit = nil
  case "group-true": first.children = [second]
  case "outer-nil": first.children = [second]; app.query.outerUnavailable = true
  case "outer-nil-after-false": first.children = [second]; app.query.outerUnavailable = true; live.hit = false
  case "disabled-positive": first.isEnabled = false
  default: break
  }
  // The general path binds every live member: a nested text chain has two, and live state mirrors the tree.
  if !first.children.isEmpty {
    let twin = XCUIElement(1)
    twin.hit = live.hit
    app.query.elements = [live, twin]
  }
  live.snapshots[0].isEnabled = first.isEnabled
  let payload = h.snapshotPlatformPresence(app: app, appId: "PRIVATE-app", presenceBudgetMs: 20_000)
  let nodes = payload.nodes!, capture = payload.presenceCapture!
  var observations: [[String: Any]] = []
  for node in nodes.dropFirst(2) {
    let p = node.presence!
    let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(p)) as! [String: Any]
    precondition(encoded["unknownReason"] as? String == p.unknownReason?.rawValue)
    observations.append(["status": p.status.rawValue, "reason": p.unknownReason?.rawValue ?? "none", "timestamp": p.observedUptimeMs != nil])
  }
  try emit(["name": name, "complete": capture.complete, "observations": observations, "reads": reads,
    "samples": capture.diagnostics!.preparationSamples!, "quietMs": capture.diagnostics!.preparationQuietElapsedMs!])
}
for scenario in ["stable", "moving", "added"] {
  reads = []
  let h = Harness(), app = XCUIApplication(XCUIElementSnapshot())
  let elements = (0..<3).map { XCUIElement($0) }
  let descriptors = elements.map { element -> XCUIElementSnapshot in
    let snapshot = XCUIElementSnapshot()
    snapshot.frame.origin.x = CGFloat(element.ordinal * 100)
    let live = XCUIElementSnapshot()
    live.frame = snapshot.frame
    element.snapshots = [live]
    return snapshot
  }
  app.query.elements = elements
  if scenario == "moving" {
    elements[0].onHit = { elements[1].snapshots[0].frame.origin.x = 200 }
    elements[2].onHit = { elements[1].snapshots[0].frame.origin.x = 100 }
  }
  if scenario == "added" {
    let added = XCUIElement(3)
    added.snapshots[0].frame = descriptors[2].frame
    elements[0].onHit = { app.query.elements.append(added) }
    elements[2].onHit = { app.query.elements = elements }
  }
  let groups = descriptors.map { ($0, 1) } + (scenario == "stable" ? [(descriptors[0], 2)] : [])
  let observed = h.observeGroups(groups, app: app)
  elements[1].snapshots[0].frame.origin.x = 100
  app.query.elements = elements
  try emit(["name": "groups-" + scenario, "results": observed, "reads": reads])
}
do {
  reads = []
  let h = Harness(), descriptor = XCUIElementSnapshot()
  let app = XCUIApplication(descriptor)
  app.query.elements = [XCUIElement(0)]
  app.query.unavailable = true
  app.query.onAll = { app.query.unavailable = false }
  let observed = h.observeGroups([(descriptor, 1), (descriptor, 1)], app: app)
  try emit(["name": "binding-unavailable", "results": observed, "reads": reads])
}
let allowed = ["empty-frame", "clipped", "ambiguous-descriptor", "not-hittable", "read-unavailable", "match-count-mismatch", "post-hit-mismatch"]
for raw in allowed {
  let reason = PlatformPresenceObservation.UnknownReason(rawValue: raw)!
  let decoded = try JSONDecoder().decode(PlatformPresenceObservation.UnknownReason.self, from: JSONEncoder().encode(reason))
  precondition(decoded == reason)
}
for raw in ["PRIVATE-label", "PRIVATE-id", "rect", "hash", "unknown", ""] {
  precondition(PlatformPresenceObservation.UnknownReason(rawValue: raw) == nil)
}
let legacy = PlatformPresenceObservation(captureId: "PRIVATE-capture", generation: 7, nodeIndex: 0, status: .unknown, labelSource: .direct)
let decoded = try JSONDecoder().decode(PlatformPresenceObservation.self, from: JSONEncoder().encode(legacy))
precondition(decoded.unknownReason == nil)
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-|identifier|label|rect|hash/i);
  const rows = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const fallback = ['descendants', 'matching', 'all', 'snapshot-0', 'snapshot-1'];
  // Every group binds all matches and checks the full descriptor live; there is no first-match read.
  const single = ['descendants', 'matching', 'all', 'snapshot-0'];
  const pair = ['descendants', 'matching', 'all', 'snapshot-0', 'snapshot-1'];
  for (const [name, reason, expectedReads] of [
    ['first-true', undefined, [...single, 'hit-0', 'snapshot-0']],
    ['first-false', 'not-hittable', [...single, 'hit-0']],
    ['first-nil', 'read-unavailable', [...single, 'hit-0']],
    [
      'r8-transient',
      'not-hittable',
      ['descendants', 'matching', 'all', 'snapshot-1', 'snapshot-0', 'hit-0'],
    ],
    ['r8-replaced', 'match-count-mismatch', ['descendants', 'matching', 'all', 'snapshot-1']],
    ['all-nil', 'read-unavailable', ['descendants', 'matching', 'all']],
    ['snapshot-nil', 'read-unavailable', fallback.slice(0, -1)],
    ['snapshot-mismatch', 'match-count-mismatch', fallback],
    ['invalid-descriptor', 'match-count-mismatch', fallback],
    ['count-mismatch', 'match-count-mismatch', fallback],
    ['false-false', 'not-hittable', [...fallback, 'hit-0', 'hit-1']],
    ['nil-false', 'read-unavailable', [...fallback, 'hit-0', 'hit-1']],
    ['false-nil', 'read-unavailable', [...fallback, 'hit-0', 'hit-1']],
    ['nil-true', undefined, [...fallback, 'hit-0', 'hit-1', 'snapshot-1']],
    ['false-true', undefined, [...fallback, 'hit-0', 'hit-1', 'snapshot-1']],
    ['true-nil', undefined, [...fallback, 'hit-0', 'snapshot-0']],
    ['post-nil', 'read-unavailable', [...fallback, 'hit-0', 'snapshot-0']],
    ['post-mismatch', 'post-hit-mismatch', [...fallback, 'hit-0', 'snapshot-0']],
    ['deadline-before', 'read-unavailable', ['descendants', 'matching']],
    ['deadline-after', 'read-unavailable', [...single, 'hit-0']],
  ] as const) {
    await t.test(name, () => {
      const on = rows.find((row) => row.name === name && row.diagnostic);
      const off = rows.find((row) => row.name === name && row.diagnostic === false);
      assert.deepEqual(on.reads, expectedReads);
      assert.deepEqual(on.reasons, reason ? [reason] : []);
      assert.deepEqual(off.reasons, []);
      assert.equal(on.observed, reason === undefined);
      assert.equal(on.stamp, reason === undefined ? 1000 : -1);
      assert.equal(on.deadline, name.startsWith('deadline-'));
      assert.deepEqual(
        { ...on, reasons: [], diagnostic: false },
        off,
        'diagnostics cannot change reads, timestamp or verdict',
      );
    });
  }
  await t.test('each fallback group re-binds and snapshots the live candidates', () => {
    const row = rows.find((row) => row.name === 'groups-stable');
    assert.deepEqual(row.results, [
      { observed: true, reasons: [] },
      { observed: true, reasons: [] },
      { observed: true, reasons: [] },
      { observed: false, reasons: ['match-count-mismatch'] },
    ]);
    assert.equal(row.reads.filter((read: string) => read === 'all').length, 4);
    assert.deepEqual(row.reads.slice(0, 6), [
      'descendants',
      'matching',
      'all',
      'snapshot-0',
      'snapshot-1',
      'snapshot-2',
    ]);
    for (const ordinal of [0, 1, 2]) {
      assert.equal(row.reads.filter((read: string) => read === `hit-${ordinal}`).length, 1);
      assert.equal(row.reads.filter((read: string) => read === `snapshot-${ordinal}`).length, 5);
    }
  });
  await t.test('fresh descriptors refuse a candidate moving into a later group', () => {
    const row = rows.find((row) => row.name === 'groups-moving');
    assert.deepEqual(row.results, [
      { observed: true, reasons: [] },
      { observed: false, reasons: ['match-count-mismatch'] },
      { observed: false, reasons: ['match-count-mismatch'] },
    ]);
    assert.equal(row.reads.filter((read: string) => read === 'all').length, 3);
    assert.deepEqual(
      row.reads.filter((read: string) => read.startsWith('hit-')),
      ['hit-0'],
    );
    for (const ordinal of [0, 1, 2]) {
      assert.equal(
        row.reads.filter((read: string) => read === `snapshot-${ordinal}`).length,
        ordinal === 0 ? 4 : 3,
      );
    }
  });
  await t.test('fresh membership refuses a transient candidate matching a later group', () => {
    const row = rows.find((row) => row.name === 'groups-added');
    assert.deepEqual(row.results, [
      { observed: true, reasons: [] },
      { observed: true, reasons: [] },
      { observed: false, reasons: ['match-count-mismatch'] },
    ]);
    const candidates = ['descendants', 'matching', 'all', 'snapshot-0', 'snapshot-1', 'snapshot-2'];
    assert.deepEqual(row.reads, [
      ...candidates,
      'hit-0',
      'snapshot-0',
      ...candidates,
      'snapshot-3',
      'hit-1',
      'snapshot-1',
      ...candidates,
      'snapshot-3',
    ]);
  });
  await t.test('a group retries binding after an unavailable read', () => {
    const row = rows.find((row) => row.name === 'binding-unavailable');
    assert.deepEqual(row.results, [
      { observed: false, reasons: ['read-unavailable'] },
      { observed: true, reasons: [] },
    ]);
    assert.equal(row.reads.filter((read: string) => read === 'all').length, 2);
    assert.deepEqual(
      row.reads.filter((read: string) => read.startsWith('hit-')),
      ['hit-0'],
    );
  });
  for (const [name, reason, count, liveReads] of [
    ['empty', 'empty-frame', 1, []],
    ['clipped', 'clipped', 1, []],
    ['ambiguous', 'ambiguous-descriptor', 2, []],
    ['group-false', 'not-hittable', 2, [...pair, 'hit-0', 'hit-1']],
    ['group-nil', 'read-unavailable', 2, [...pair, 'hit-0', 'hit-1']],
    ['group-true', 'none', 2, [...pair, 'hit-0', 'snapshot-0']],
    ['outer-nil', 'read-unavailable', 2, [...pair, 'hit-0', 'snapshot-0']],
    ['outer-nil-after-false', 'read-unavailable', 2, [...pair, 'hit-0', 'hit-1']],
    ['disabled-positive', 'none', 1, [...single, 'hit-0', 'snapshot-0']],
  ] as const) {
    await t.test(name, () => {
      const row = rows.find((row) => row.name === name);
      assert.equal(row.complete, true);
      assert.equal(row.samples, 6);
      assert.equal(row.quietMs, 500);
      assert.deepEqual(row.reads, [
        'state',
        ...Array(6).fill('root'),
        ...liveReads,
        'state',
        'root',
      ]);
      assert.deepEqual(
        row.observations,
        Array.from({ length: count }, () => ({
          status: reason === 'none' ? 'observed' : 'unknown',
          reason,
          timestamp: reason === 'none',
        })),
      );
    });
  }
});
