import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { nativeCapture } from '../qa/platform-presence-fixtures.ts';

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

test('actual Swift capture prepares exact raw trees inside one deadline and still revalidates strictly', async (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const source = readFileSync(new URL('RnFastRunnerTests+Snapshot.swift', native), 'utf8');
  const predicates = readFileSync(new URL('SnapshotPredicates.swift', native), 'utf8');
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
${section(models, 'struct RetainedSnapshotTarget {', 'struct RecordedExactTypeTarget')}
${models.slice(models.indexOf('struct SnapshotOptions {'))}
${section(predicates, 'func computeSnapshotHittable(', 'func snapshotTypeName(')}
${section(source, 'final class PresenceCaptureTiming', 'func makePlatformPresencePayload(')}
${source.slice(source.indexOf('func makePlatformPresencePayload('))}
enum XCUIElement {
  enum ElementType: UInt { case application = 1, window = 2, button = 9, staticText = 48, other = 82, scrollView = 44, any = 0 }
}
final class XCUIElementSnapshot {
  var sampleToken = 0
  var onChildren: () -> Void = {}
  var elementType: XCUIElement.ElementType = .button
  var identifier = "PRIVATE-identifier"
  var label = "PRIVATE-label"
  var value: Any? = "PRIVATE-value"
  var frame = CGRect(x: 10, y: 20, width: 30, height: 40)
  var isSelected = false
  var isEnabled = true
  private var childNodes: [XCUIElementSnapshot] = []
  var children: [XCUIElementSnapshot] {
    get { onChildren(); return childNodes }
    set { childNodes = newValue }
  }
}
enum Unavailable: Error { case read }
final class XCUIApplication {
  enum State { case runningForeground, runningBackground }
  var snapshots: [XCUIElementSnapshot]
  var reads = 0
  var states = 0
  var unavailableAt = 0
  var backgroundAt = 0
  var cycle = false
  var onRead: (Int) -> Void = { _ in }
  var state: State {
    states += 1
    return states == backgroundAt ? .runningBackground : .runningForeground
  }
  struct Query { let count = 0; let allElementsBoundByIndex: [XCUIElement] = [] }
  func descendants(matching: XCUIElement.ElementType) -> Query { Query() }
  let alerts = Query(), sheets = Query()
  init(_ snapshots: [XCUIElementSnapshot]) { self.snapshots = snapshots }
  func snapshot() throws -> XCUIElementSnapshot {
    reads += 1
    onRead(reads)
    if reads == unavailableAt { throw Unavailable.read }
    let index = cycle ? (reads - 1) % snapshots.count : min(reads - 1, snapshots.count - 1)
    snapshots[index].sampleToken = reads
    return snapshots[index]
  }
}
enum SnapshotViewportSource { case app }
struct SnapshotDiagnostics { let viewport: CGRect; let source: SnapshotViewportSource }
enum DispatchGuard {
  static func nearestOwner(of: Int, parentOf: (Int) -> Int?, owns: (Int) -> Bool) -> Int? { nil }
}
enum KeyboardGuard {
  static func isKeyboardOwnedButton(type: String, index: Int, parentOf: (Int) -> Int?, typeOf: (Int) -> String?) -> Bool { false }
}
struct DataPayload {
  var nodes: [SnapshotNode]? = nil
  var truncated: Bool? = nil
  var keyboardVisible: Bool? = nil
  var snapshotGeneration: Int? = nil
  var presenceCapture: PlatformPresenceCapture? = nil
  var labelProvenance: [CandidateLabelProvenance]? = nil
  var snapshotDiagnostics: SnapshotDiagnostics? = nil
}
enum RunnerObjCExceptionCatcher {
  static func catchException(_ read: () -> Void) -> String? { read(); return nil }
}
final class Harness {
  let fastSnapshotLimit = 300
  var retainedFastSnapshotOptions: SnapshotOptions?
  var maxSnapshotElements = 600
  let currentSnapshotGeneration = 7
  var now = 1000.0
  var sleeps: [Double] = []
  var retainedSnapshotTargets: [Int: RetainedSnapshotTarget] = [:]
  var observations = 0
  var observedAt: [Double] = []
  var selectedSample = 0
  var nextClockTime: Double?
  var observationMs = 0.0
  let springboard = XCUIApplication([])
  var blockingAlert: DataPayload? = nil
  func blockingSystemAlertSnapshot() -> DataPayload? { blockingAlert }
  func withSystemModalDiagnostic(_ payload: DataPayload, app: XCUIApplication) -> DataPayload { payload }
  func presenceUptimeMs() -> Double {
    if let next = nextClockTime { nextClockTime = nil; return next }
    return now
  }
  func sleepFor(_ seconds: Double) { sleeps.append(seconds * 1000); now += seconds * 1000 }
  private struct SnapshotTraversalContext {
    let queryRoot: XCUIApplication
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    var viewportSource: SnapshotViewportSource? = nil
    let maxDepth: Int
  }
${section(source, '  private struct PresenceDescriptor:', '  func platformPresenceFailure(')}
${section(source, '  private func presenceRead<', '  private func presenceLabelSource(')}
${section(source, '  private struct SnapshotEvaluation {', '  // MARK: - Snapshot Entry')}
${section(source, '  func snapshotFast(', '  func snapshotRaw(')}
${section(source, '  private func presenceLabelSource(', '  func snapshotCandidateLabelProvenance(')}
${section(source, '  private func evaluateSnapshot(', '  private func snapshotViewport(').replace('    let label = aggregatedLabel', '    if snapshot.elementType == .application { selectedSample = snapshot.sampleToken }\n    let label = aggregatedLabel')}
${section(source, '  func aggregatedLabel(', '  private func isVisibleInViewport(')}
${section(source, '  private func shouldInclude(', '  private func makeSnapshotTraversalContext(')}
${section(source, '  func retainSnapshotTargets(', '  // MARK: - Snapshot Filtering')}
  let interactiveTypes: Set<XCUIElement.ElementType> = [.button, .staticText]
  private func isScrollableContainer(_ snapshot: XCUIElementSnapshot, visible: Bool) -> Bool { snapshot.elementType == .scrollView }
  private func snapshotHasFocus(_ snapshot: XCUIElementSnapshot) -> Bool { false }
  private func isVisibleInViewport(_ rect: CGRect, _ viewport: CGRect) -> Bool { !rect.isEmpty && rect.intersects(viewport) }
  func elementTypeName(_ type: XCUIElement.ElementType) -> String { String(type.rawValue) }
  private func makeSnapshotTraversalContext(app: XCUIApplication, options: SnapshotOptions) -> SnapshotTraversalContext? {
    guard let root = try? app.snapshot() else { return nil }
    selectedSample = root.sampleToken
    return SnapshotTraversalContext(queryRoot: app, rootSnapshot: root, viewport: CGRect(x: 0, y: 0, width: 400, height: 800), maxDepth: options.depth ?? Int.max)
  }
  private func safeSnapshotElementsQuery(_ read: () -> [XCUIElement]) -> [XCUIElement] { read() }
  private func appendCollapsedTabFallbackNodes(to: inout [SnapshotNode], containerSnapshot: XCUIElementSnapshot, resolveElements: () -> [XCUIElement], depth: Int, parentIndex: Int, nodeLimit: Int, viewport: CGRect) -> Bool { false }
  var keyboardReads = 0
  func isKeyboardVisible(app: XCUIApplication) -> Bool { keyboardReads += 1; return false }
${section(source, '  func snapshotCandidateLabelProvenance(', '  private func observePresence(')}
  private func observePresence(_ descriptor: PresenceDescriptor, count: Int, app: XCUIApplication, deadline: Double, timing: PresenceCaptureTiming, unknownReason: ((PlatformPresenceObservation.UnknownReason) -> Void)? = nil) -> Double? {
    observations += 1; observedAt.append(now); now += observationMs; return now
  }
}
func tree(_ change: String = "") -> XCUIElementSnapshot {
  let root = XCUIElementSnapshot(); root.elementType = .application
  let window = XCUIElementSnapshot(); window.elementType = .window; window.frame = CGRect(x: 0, y: 0, width: 400, height: 800)
  let first = XCUIElementSnapshot()
  let second = XCUIElementSnapshot(); second.elementType = .staticText; second.identifier = "PRIVATE-second"
  let offscreen = XCUIElementSnapshot(); offscreen.elementType = .other; offscreen.identifier = ""; offscreen.label = ""; offscreen.value = nil; offscreen.frame.origin.y = -1000
  root.children = [window]; window.children = [first, second, offscreen]
  switch change {
  case "frame": first.frame.origin.x += 0.01
  case "type": first.elementType = .staticText
  case "identifier": first.identifier += " "
  case "label": first.label += " "
  case "value": first.value = "PRIVATE-value "
  case "enabled": first.isEnabled = false
  case "hierarchy": first.children = [second]; window.children = [first, offscreen]
  case "offscreen": offscreen.frame.origin.y -= 0.01
  case "invalid": offscreen.value = ["PRIVATE-invalid"]
  case "number": first.value = NSNumber(value: 1)
  case "text-number": first.value = "1"
  case "absent": first.value = nil
  case "empty": first.value = ""
  default: break
  }
  return root
}
func run(_ name: String, _ trees: [XCUIElementSnapshot], budget: Int = 20_000, cycle: Bool = false, unavailableAt: Int = 0, backgroundAt: Int = 0, limit: Int = 600, observationMs: Double = 0, overrunAt: Int = 0, readDelay: [Int: Double] = [:], traversalDelay: Double = 0, clockFault: Double? = nil, faultAt: Int = 2, completedFault: Bool = false) throws {
  let h = Harness(); h.maxSnapshotElements = limit; h.observationMs = observationMs
  let app = XCUIApplication(trees); app.cycle = cycle; app.unavailableAt = unavailableAt; app.backgroundAt = backgroundAt
  app.onRead = { read in
    h.now += readDelay[read] ?? 0
    if read == overrunAt { h.now = 1000 + Double(budget) }
    if read == faultAt && !completedFault { h.nextClockTime = clockFault }
  }
  for root in trees {
    let last = root.children[0].children.last!
    last.onChildren = {
      if app.reads == 1 { h.now += traversalDelay }
      if app.reads == faultAt && completedFault { h.nextClockTime = clockFault }
    }
  }
  let result = h.snapshotPlatformPresence(app: app, appId: "test", presenceBudgetMs: budget)
  let capture = result.presenceCapture!
  let diagnostics = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capture.diagnostics!))
  let nodes = result.nodes ?? []
  let output: [String: Any] = [
    "name": name, "complete": capture.complete, "reads": app.reads, "states": app.states,
    "observations": h.observations, "selectedSample": h.selectedSample, "sleeps": h.sleeps, "elapsed": capture.endedUptimeMs - capture.startedUptimeMs,
    "budget": capture.appliedBudgetMs, "truncated": result.truncated!, "diagnostics": diagnostics,
    "depths": nodes.map { $0.depth }, "parents": nodes.map { $0.parentIndex ?? -1 },
    "observed": nodes.filter { $0.presence?.status == .observed }.count,
    "timestamps": nodes.filter { $0.presence?.observedUptimeMs != nil }.count
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}
func candidateTree(sibling: Double, candidate: Double = 10) -> XCUIElementSnapshot {
  let root = tree()
  let container = root.children[0].children[0]
  container.elementType = .scrollView; container.identifier = "list"; container.label = ""; container.value = nil
  container.frame = CGRect(x: candidate, y: 20, width: 300, height: 400)
  let card = XCUIElementSnapshot(); card.label = "Add coverage"; card.identifier = "card"; card.value = nil
  let siblingNode = XCUIElementSnapshot(); siblingNode.elementType = .staticText
  siblingNode.label = "Other"; siblingNode.identifier = "other"; siblingNode.value = nil
  let duplicate = XCUIElementSnapshot(); duplicate.elementType = siblingNode.elementType
  duplicate.label = siblingNode.label; duplicate.identifier = siblingNode.identifier; duplicate.value = nil; duplicate.frame = siblingNode.frame
  container.children = [card]
  let empty = XCUIElementSnapshot(); empty.elementType = .other; empty.label = ""; empty.identifier = ""; empty.value = nil
  let window = root.children[0]
  window.children = [empty, container, siblingNode, duplicate]
  empty.frame.size.height = sibling
  return root
}
for unstable in [false, true] {
  let h = Harness()
  let trees = [candidateTree(sibling: 10), candidateTree(sibling: 11, candidate: unstable ? 11 : 10)]
  let app = XCUIApplication([trees[0]])
  let ordinary = h.snapshotFast(app: app, options: SnapshotOptions(interactiveOnly: true, compact: false, depth: nil, scope: nil, raw: false))
  h.retainSnapshotTargets(ordinary.nodes ?? [])
  let indices = (ordinary.nodes ?? []).filter { $0.identifier == "list" || $0.identifier == "card" }.map { $0.index }
  precondition(indices == [2, 3] && ordinary.nodes?.count == 5)
  let before = h.retainedSnapshotTargets
  app.snapshots = trees; app.reads = 0; app.cycle = true
  let result = h.snapshotCandidateLabelProvenance(app: app, indices: indices, budgetMs: 300)
  precondition(h.currentSnapshotGeneration == 7 && h.keyboardReads == 1)
  precondition(h.retainedFastSnapshotOptions != nil)
  for index in indices {
    precondition(h.retainedSnapshotTargets[index]?.index == before[index]?.index)
    precondition(h.retainedSnapshotTargets[index]?.parentIndex == before[index]?.parentIndex)
    precondition(h.retainedSnapshotTargets[index]?.rect == before[index]?.rect)
    precondition(h.retainedSnapshotTargets[index]?.generation == before[index]?.generation)
  }
  let metadata = result.labelProvenance ?? []
  let output: [String: Any] = ["name": unstable ? "candidate-unsettled" : "candidate-sibling-animation",
    "indices": metadata.map { $0.index }, "sources": metadata.map { $0.labelSource.rawValue },
    "reads": app.reads, "observations": h.observations, "elapsed": h.now - 1000,
    "hasTree": result.nodes != nil, "hasKeyboard": result.keyboardVisible != nil]
  print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
}
try run("stable", [tree()])
try run("explicit-budget", [tree()], budget: 1234)
try run("first-read-cost", [tree()], readDelay: [1: 500])
try run("first-traversal-cost", [tree()], traversalDelay: 500)
try run("slow-second-sample", [tree()], readDelay: [2: 500])
try run("slow-changed-sample", [tree(), tree("frame")], readDelay: [2: 500])
try run("unchanged-at-499", [tree()], readDelay: [5: 99])
try run("changed-at-499", (0..<4).map { _ in tree() } + [tree("frame")], readDelay: [5: 99])
try run("changed-at-500", (0..<5).map { _ in tree() } + [tree("frame")])
try run("reset-no-renewal", (0..<4).map { _ in tree() } + [tree("frame")], budget: 900, readDelay: [5: 99])
try run("deadline-at-500", [tree()], budget: 500)
for (name, time) in [("nan", Double.nan), ("infinite", Double.infinity), ("negative", -1.0), ("backward", 1000.0)] {
  try run("clock-" + name, [tree()], clockFault: time)
  try run("completed-clock-" + name, [tree()], clockFault: time, completedFault: true)
}
try run("invalid-first-completion", [tree()], clockFault: 999, faultAt: 1, completedFault: true)
for change in ["frame", "type", "identifier", "label", "value", "enabled", "hierarchy", "offscreen"] {
  try run(change, [tree(), tree(change), tree(change), tree(change)])
}
try run("nonconsecutive", [tree(), tree("frame"), tree(), tree(), tree()])
try run("value-kind", [tree("text-number"), tree("number"), tree("number"), tree("number")])
try run("absent-value", [tree("absent"), tree("empty"), tree("empty"), tree("empty")])
try run("never-stable", [tree(), tree("frame")], cycle: true)
try run("read-failure", [tree()], unavailableAt: 2)
try run("late-preparation-read-failure", [tree()], unavailableAt: 6)
try run("invalid-descriptor", [tree("invalid")])
try run("late-invalid-descriptor", (0..<5).map { _ in tree() } + [tree("invalid")])
try run("node-cap", [tree()], limit: 4)
try run("deadline-before-stable", [tree()], budget: 100)
try run("clipped-sleep", [tree()], budget: 50)
try run("late-read", [tree()], overrunAt: 2)
try run("late-qualifying-read", [tree()], overrunAt: 6)
try run("final-mismatch", (0..<6).map { _ in tree() } + [tree("frame")])
try run("final-structural-mismatch", (0..<6).map { _ in tree() } + [tree("hierarchy")])
try run("observation-budget", [tree()], observationMs: 10_000)
try run("initial-ineligible", [tree()], backgroundAt: 1)
try run("final-ineligible", [tree()], backgroundAt: 2)
do {
  let h = Harness()
  h.blockingAlert = DataPayload(nodes: [SnapshotNode(index: 0, type: "Alert", label: "PRIVATE-alert", identifier: "", value: nil,
    rect: SnapshotRect(x: 0, y: 0, width: 270, height: 150), enabled: true, focused: nil, hittable: true, depth: 0,
    parentIndex: nil, hiddenContentAbove: nil, hiddenContentBelow: nil)], truncated: false)
  let app = XCUIApplication([tree()])
  let result = h.snapshotPlatformPresence(app: app, appId: "test", presenceBudgetMs: 20_000)
  let output: [String: Any] = [
    "name": "system-alert", "nodes": result.nodes?.count ?? -1, "types": result.nodes?.map { $0.type } ?? [],
    "keyboardVisible": result.keyboardVisible as Any, "snapshotGeneration": result.snapshotGeneration as Any,
    "presenceCapture": result.presenceCapture != nil, "reads": app.reads, "states": app.states
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
  h.blockingAlert = nil
  app.snapshots = [tree(), tree("frame")]
  let after = h.snapshotPlatformPresence(app: app, appId: "test", presenceBudgetMs: 900)
  let capture = after.presenceCapture!
  let diagnostics = try JSONSerialization.jsonObject(with: JSONEncoder().encode(capture.diagnostics!))
  let settled: [String: Any] = [
    "name": "after-permission-dismissal", "complete": capture.complete,
    "reads": app.reads, "selectedSample": h.selectedSample, "observedAt": h.observedAt,
    "elapsed": capture.endedUptimeMs - capture.startedUptimeMs,
    "budget": capture.appliedBudgetMs, "diagnostics": diagnostics
  ]
  print(String(data: try JSONSerialization.data(withJSONObject: settled, options: [.sortedKeys]), encoding: .utf8)!)
}
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE-/);
  const rows = new Map(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => {
        const row = JSON.parse(line);
        return [row.name, row];
      }),
  );
  assert.deepEqual(rows.get('candidate-sibling-animation'), {
    name: 'candidate-sibling-animation',
    indices: [2, 3],
    sources: ['descendant', 'direct'],
    reads: 2,
    observations: 4,
    elapsed: 100,
    hasTree: false,
    hasKeyboard: false,
  });
  const unsettledCandidate = rows.get('candidate-unsettled');
  assert.deepEqual(unsettledCandidate.indices, []);
  assert.equal(unsettledCandidate.elapsed, 300);
  assert.equal(unsettledCandidate.hasTree, false);
  assert.equal(unsettledCandidate.hasKeyboard, false);
  rows.delete('candidate-sibling-animation');
  rows.delete('candidate-unsettled');
  assert.deepEqual(rows.get('system-alert'), {
    name: 'system-alert',
    nodes: 1,
    types: ['Alert'],
    keyboardVisible: false,
    snapshotGeneration: 7,
    presenceCapture: false,
    reads: 0,
    states: 0,
  });
  rows.delete('system-alert');
  const afterDismissal = rows.get('after-permission-dismissal');
  assert.equal(afterDismissal.complete, true);
  assert.equal(afterDismissal.reads, 8);
  assert.equal(afterDismissal.selectedSample, 7);
  assert.deepEqual(afterDismissal.observedAt, [1600, 1600]);
  assert.equal(afterDismissal.elapsed, 600);
  assert.equal(afterDismissal.budget, 900);
  assert.equal(afterDismissal.diagnostics.preparationSamples, 7);
  assert.equal(afterDismissal.diagnostics.preparationResets, 1);
  assert.equal(afterDismissal.diagnostics.preparationQuietElapsedMs, 500);
  rows.delete('after-permission-dismissal');
  assert.equal(rows.get('explicit-budget').budget, 1234);
  assert.equal(rows.get('explicit-budget').complete, true);
  for (const name of [
    'stable',
    'frame',
    'type',
    'identifier',
    'label',
    'value',
    'enabled',
    'hierarchy',
    'offscreen',
    'value-kind',
    'absent-value',
    'nonconsecutive',
  ]) {
    const row = rows.get(name);
    const samples = name === 'stable' ? 6 : name === 'nonconsecutive' ? 8 : 7;
    assert.equal(row.complete, true, name);
    assert.equal(row.reads, samples + 1, name);
    assert.equal(row.selectedSample, samples, name);
    assert.equal(row.observations, 2, name);
    assert.equal(row.observed, 2, name);
    assert.equal(row.states, 2, name);
    assert.deepEqual(row.sleeps, Array(samples - 1).fill(100), name);
    assert.equal(row.elapsed, (samples - 1) * 100, name);
    assert.equal(row.diagnostics.preparationSamples, samples, name);
    assert.equal(row.diagnostics.preparationQuietWindowMs, 500, name);
    assert.equal(row.diagnostics.preparationQuietElapsedMs, 500, name);
    assert.equal(row.diagnostics.preparationResets, samples - 6, name);
    assert.equal(row.diagnostics.phaseMs.preparation, row.elapsed, name);
    assert.equal(row.diagnostics.failure, undefined, name);
    assert.deepEqual(row.depths, name === 'hierarchy' ? [0, 1, 2, 3, 2] : [0, 1, 2, 2, 2], name);
    assert.deepEqual(row.parents, name === 'hierarchy' ? [-1, 0, 1, 2, 1] : [-1, 0, 1, 1, 1], name);
  }
  for (const [name, samples, resets, elapsed, quietElapsed] of [
    ['first-read-cost', 6, 0, 1000, 500],
    ['first-traversal-cost', 6, 0, 1000, 500],
    ['slow-second-sample', 2, 0, 600, 600],
    ['slow-changed-sample', 7, 1, 1100, 500],
    ['unchanged-at-499', 6, 0, 599, 599],
    ['changed-at-499', 10, 1, 999, 500],
    ['changed-at-500', 11, 1, 1000, 500],
  ] as const) {
    const row = rows.get(name);
    assert.equal(row.complete, true, name);
    assert.equal(row.reads, samples + 1, name);
    assert.equal(row.selectedSample, samples, name);
    assert.equal(row.observations, 2, name);
    assert.equal(row.observed, 2, name);
    assert.equal(row.timestamps, 2, name);
    assert.equal(row.elapsed, elapsed, name);
    assert.equal(row.diagnostics.phaseMs.preparation, elapsed, name);
    assert.equal(row.diagnostics.preparationSamples, samples, name);
    assert.equal(row.diagnostics.preparationResets, resets, name);
    assert.equal(row.diagnostics.preparationQuietWindowMs, 500, name);
    assert.equal(row.diagnostics.preparationQuietElapsedMs, quietElapsed, name);
  }
  for (const prefix of ['clock-', 'completed-clock-']) {
    for (const fault of ['nan', 'infinite', 'negative', 'backward']) {
      const name = prefix + fault;
      const row = rows.get(name);
      assert.equal(row.complete, false, name);
      assert.equal(row.reads, 2, name);
      assert.equal(row.observations, 0, name);
      assert.equal(row.selectedSample, 0, name);
      assert.equal(row.diagnostics.preparationQuietElapsedMs, 0, name);
      assert.deepEqual(
        row.diagnostics.failure,
        { phase: 'preparation', reason: 'read-unavailable' },
        name,
      );
    }
  }
  for (const [name, reason, reads, elapsed] of [
    ['never-stable', 'deadline', 200, 20_000],
    ['read-failure', 'read-unavailable', 2, 100],
    ['late-preparation-read-failure', 'read-unavailable', 6, 500],
    ['invalid-descriptor', 'read-unavailable', 1, 0],
    ['late-invalid-descriptor', 'read-unavailable', 6, 500],
    ['node-cap', 'node-limit', 1, 0],
    ['deadline-before-stable', 'deadline', 1, 100],
    ['clipped-sleep', 'deadline', 1, 50],
    ['late-read', 'deadline', 2, 20_000],
    ['late-qualifying-read', 'deadline', 6, 20_000],
    ['invalid-first-completion', 'read-unavailable', 1, 0],
    ['deadline-at-500', 'deadline', 5, 500],
    ['reset-no-renewal', 'deadline', 9, 900],
  ] as const) {
    const row = rows.get(name);
    assert.equal(row.complete, false, name);
    assert.equal(row.observations, 0, name);
    assert.equal(row.reads, reads, name);
    assert.equal(row.elapsed, elapsed, name);
    assert.equal(row.diagnostics.preparationSamples, reads, name);
    assert.equal(row.diagnostics.phaseMs.preparation, elapsed, name);
    assert.deepEqual(row.diagnostics.failure, { phase: 'preparation', reason }, name);
    assert.deepEqual(row.depths, [], name);
  }
  assert.equal(rows.get('node-cap').truncated, true);
  assert.deepEqual(rows.get('clipped-sleep').sleeps, [50]);
  assert.deepEqual(rows.get('reset-no-renewal').sleeps, [...Array(8).fill(100), 1]);
  assert.equal(rows.get('reset-no-renewal').diagnostics.preparationResets, 1);
  assert.equal(rows.get('reset-no-renewal').diagnostics.preparationQuietElapsedMs, 400);
  assert.deepEqual(rows.get('late-read').diagnostics.deadline, {
    phase: 'preparation',
    read: 'root-snapshot',
    edge: 'after',
  });
  const rejected = rows.get('final-mismatch');
  assert.equal(rejected.complete, false);
  assert.equal(rejected.reads, 7);
  assert.equal(rejected.observations, 2);
  assert.equal(rejected.observed, 0);
  assert.equal(rejected.timestamps, 0);
  assert.deepEqual(rejected.diagnostics.failure, {
    phase: 'revalidation',
    reason: 'enumeration-changed',
    mismatch: {
      kind: 'node',
      index: 2,
      fieldMask: 16,
      beforeType: 9,
      afterType: 9,
      geometry: {
        changedMask: 1,
        beforeFiniteMask: 15,
        afterFiniteMask: 15,
        deltaFiniteMask: 15,
        dx: 0.009999999999999787,
        dy: 0,
        dWidth: 0,
        dHeight: 0,
        beforeNull: false,
        afterNull: false,
        beforeInfinite: false,
        afterInfinite: false,
        beforeInvalidSize: false,
        afterInvalidSize: false,
      },
      ancestorTypes: [2, 1],
      ancestorsTruncated: false,
    },
  });
  const exhausted = rows.get('observation-budget');
  assert.equal(exhausted.complete, false);
  assert.equal(exhausted.elapsed, 20_500);
  assert.equal(exhausted.budget, 20_000);
  assert.equal(exhausted.reads, 6);
  assert.deepEqual(exhausted.diagnostics.failure, { phase: 'observation', reason: 'deadline' });
  const structural = rows.get('final-structural-mismatch');
  assert.equal(structural.complete, false);
  assert.equal(structural.reads, 7);
  assert.equal(structural.observations, 2);
  assert.equal(structural.observed, 0);
  assert.equal(structural.timestamps, 0);
  assert.equal(structural.diagnostics.preparationQuietElapsedMs, 500);
  assert.equal(structural.diagnostics.failure.phase, 'revalidation');
  assert.equal(structural.diagnostics.failure.reason, 'enumeration-changed');
  assert.equal(structural.diagnostics.failure.mismatch.fieldMask, 192);
  for (const [name, phase, reads, observations] of [
    ['initial-ineligible', 'initial-eligibility', 0, 0],
    ['final-ineligible', 'final-eligibility', 6, 2],
  ] as const) {
    const row = rows.get(name);
    assert.equal(row.complete, false);
    assert.equal(row.reads, reads);
    assert.equal(row.observations, observations);
    assert.deepEqual(row.diagnostics.failure, { phase, reason: 'ineligible' });
  }
  for (const [name, row] of rows) {
    const d = row.diagnostics;
    if (d.preparationSamples === undefined) continue;
    assert.equal(d.preparationQuietWindowMs, 500, name);
    assert.ok(Number.isSafeInteger(d.preparationResets), name);
    assert.ok(d.preparationResets >= 0 && d.preparationResets < d.preparationSamples, name);
    assert.ok(Number.isFinite(d.preparationQuietElapsedMs), name);
    assert.ok(d.preparationQuietElapsedMs >= 0, name);
    assert.ok(d.preparationQuietElapsedMs <= d.phaseMs.preparation, name);
    const source = nativeCapture();
    const logs: string[] = [];
    await captureScreen({
      native: async () => ({
        ...source,
        presenceCapture: { ...source.presenceCapture, complete: row.complete, diagnostics: d },
      }),
      react: async () => ({}),
      warn: (line) => logs.push(line),
    });
    assert.ok(logs.includes('presence-preparation-quiet-window-ms=500'), name);
    assert.ok(logs.includes(`presence-preparation-resets=${d.preparationResets}`), name);
    assert.ok(
      logs.includes(`presence-preparation-quiet-elapsed-ms=${d.preparationQuietElapsedMs}`),
      name,
    );
    assert.ok(!logs.join('').includes('PRIVATE-'), name);
  }
});
