import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const native = new URL(
  '../../../../qaren-ios-runner/QarenIosRunner/QarenIosRunnerUITests/',
  import.meta.url,
);
const read = (name: string) => readFileSync(new URL(name, native), 'utf8');
function section(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}

test('the read-only Swift hit probe binds the retained generation and restores dispatch bookkeeping', () => {
  const interaction = read('QarenIosRunnerTests+Interaction.swift');
  const models = read('QarenIosRunnerTests+Models.swift');
  const execution = read('QarenIosRunnerTests+CommandExecution.swift');
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
import CoreGraphics
${read('DispatchGuard.swift')}
${section(models, 'enum CommandType:', 'struct Response:')}
${section(models, 'struct SnapshotRect:', 'struct SnapshotNode:')}
${section(models, 'struct RetainedSnapshotTarget', 'struct RecordedExactTypeTarget')}
struct ErrorPayload { let code: String; let message: String; let mutation: String; var reason: String? = nil }
struct DataPayload { var snapshotGeneration: Int? = nil; var hitProbe: String? = nil }
struct Response { let ok: Bool; var data: DataPayload? = nil; var error: ErrorPayload? = nil }
struct QuiescenceStatus { var capabilities: [String] = []; static func current() -> Self { Self() } }
let capabilities = ${section(read('QarenIosRunnerTests+Transport.swift'), 'QuiescenceStatus.current().capabilities', ',\n            commands:')}
precondition(capabilities.contains("LIVE_HIT_PROBE_V1"))
precondition(CommandType(rawValue: "hitProbe") != nil)
final class XCUIElement {
  var label = "Row"
  var identifier = "row"
  var elementType = "Other"
  var frame = CGRect(x: 20, y: 20, width: 300, height: 40)
  var hit = true
  var delay = 0.0
  var isHittable: Bool { Thread.sleep(forTimeInterval: delay); return hit }
}
struct FakeQuery {
  var allElementsBoundByIndex: [XCUIElement]
  func matching(_ predicate: NSPredicate) -> FakeQuery {
    FakeQuery(allElementsBoundByIndex: allElementsBoundByIndex.filter {
      predicate.evaluate(with: ["identifier": $0.identifier, "label": $0.label])
    })
  }
}
enum FakeType { case any }
enum AppState { case runningForeground, runningBackground, notRunning }
final class XCUIApplication {
  var state: AppState = .runningForeground
  var exists = true
  var nodes: [XCUIElement] = []
  func descendants(matching: FakeType) -> FakeQuery { FakeQuery(allElementsBoundByIndex: nodes) }
}
enum RunnerObjCExceptionCatcher {
  static var fail = false
  static func catchException(_ read: () -> Void) -> String? {
    if fail { return "exception" }
    read(); return nil
  }
}
final class Harness {
  var currentBundleId: String? = "dev.fixture"
  var currentApp: XCUIApplication?
  func execute(_ command: Command) -> Response { executeHitProbe(command: command) }
${section(execution, '  private func qaReadOnlyRefusal(', '  // Reads the cached')}
${section(execution, '  private func qaReadOnlyTarget(command:', '  private func gestureIssueResponse')}
${section(execution, '  private func executeHitProbe(', '  private func executeOnMain(')}
  var currentSnapshotGeneration = 7
  var retainedSnapshotTargets: [Int: RetainedSnapshotTarget] = [:]
  var lastLiveTarget: XCUIElement?
  var lastLiveCheckUnavailable: String?
  var lastMovedFrames: (retained: CGRect, live: CGRect, retainedIdentity: DispatchGuard.NodeIdentity?, liveIdentity: DispatchGuard.NodeIdentity?)?
  func elementTypeName(_ type: String) -> String { type }
${section(interaction, '  func boundedHittable(', '  func movedDispatchResponse()')}
}
let decoder = JSONDecoder()
func command(_ generation: Int = 7) -> Command {
  try! decoder.decode(Command.self, from: Data("{\\"command\\":\\"hitProbe\\",\\"qaReadOnly\\":true,\\"appBundleId\\":\\"dev.fixture\\",\\"snapshotGeneration\\":\\(generation),\\"snapshotNodeIndex\\":6}".utf8))
}
let h = Harness()
let app = XCUIApplication()
h.currentApp = app
let target = XCUIElement()
let old = XCUIElement()
app.nodes = [target]
func retain(_ identifier: String? = "row", _ label: String? = "Row", _ generation: Int = 7) {
  h.retainedSnapshotTargets[6] = RetainedSnapshotTarget(
    generation: generation, index: 6, type: "Other", label: label, identifier: identifier,
    rect: SnapshotRect(x: 20, y: 20, width: 300, height: 40)
  )
}
h.lastLiveTarget = old
h.lastLiveCheckUnavailable = "original"
h.lastMovedFrames = (CGRect.zero, CGRect.zero, nil, nil)
func probe(_ expected: String, _ generation: Int = 7) {
  precondition(h.readHitProbe(app: app, command: command(generation)) == expected)
  precondition(h.lastLiveTarget === old)
  precondition(h.lastLiveCheckUnavailable == "original")
  precondition(h.lastMovedFrames?.retained == CGRect.zero)
}
retain(); probe("hittable")
precondition(h.execute(command()).data?.hitProbe == "hittable")
precondition(h.lastLiveTarget === old)
var unsafe = command(); unsafe.qaReadOnly = false
precondition(!h.execute(unsafe).ok)
h.currentBundleId = "different"
precondition(!h.execute(command()).ok)
h.currentBundleId = "dev.fixture"
app.state = .runningBackground
precondition(!h.execute(command()).ok)
app.state = .runningForeground
target.hit = false; probe("not-hittable"); target.hit = true
retain(nil); probe("hittable")
retain(nil, nil); probe("unavailable")
retain(); probe("unavailable", 6)
retain("row", "Row", 8); probe("unavailable")
retain(); app.nodes = [target, XCUIElement()]; probe("unavailable")
app.nodes = []; probe("unavailable")
app.nodes = [target]; target.frame.origin.y = 25; probe("moved")
target.frame.origin.y = 20
RunnerObjCExceptionCatcher.fail = true; probe("unavailable"); RunnerObjCExceptionCatcher.fail = false
target.delay = 0.32; probe("unavailable"); target.delay = 0
precondition(h.liveTargetCheck(app: app, command: command(), deadline: 0) == .unavailable)
`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
