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

test('the read-only Swift hit probe binds the retained generation and restores dispatch bookkeeping', (t) => {
  if (process.platform !== 'darwin') return t.skip('requires the macOS Swift toolchain');
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
struct ErrorPayload { var code: String? = nil; let message: String; var mutation: String? = nil; var reason: String? = nil }
struct DataPayload: Codable {
  var message: String? = nil
  var gestureStartUptimeMs: Double? = nil
  var gestureEndUptimeMs: Double? = nil
  var x: Double? = nil; var y: Double? = nil
  var referenceWidth: Double? = nil; var referenceHeight: Double? = nil
  var keyboardGuard: String? = nil; var keyboardGuardMs: Double? = nil
  var handledMs: Double? = nil; var liveCheckMs: Double? = nil
  var snapshotGeneration: Int? = nil; var hitProbe: String? = nil
  var occlusionCheck: String? = nil
}
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
  var focused = false
  var taps = 0
  func tap() { taps += 1; focused = true }
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
enum TypeTargetOutcome { case failure(Response); case bound(XCUIElement, Int, String) }
enum RunnerInteractionOutcome { case performed; case unsupported(String) }
enum KeyboardGuardAction {
  case targetStale, dismissFailed, relayoutRequired
  case keyboardTarget(XCUIElement, CGPoint)
  case proceed(String)
}
final class Harness {
  static let occludedDispatchMessage = "occluded"
  var resolutionDelay = 0.0
  var typed = 0
  func withTemporaryScrollIdleTimeoutIfSupported(_ app: XCUIApplication, _ operation: () -> Void) { operation() }
  func resolveTypeCommandTarget(app: XCUIApplication, command: Command) -> TypeTargetOutcome {
    Thread.sleep(forTimeInterval: resolutionDelay)
    return .bound(app.nodes[0], 0, "exact")
  }
  func isExactInputFocused(app: XCUIApplication, element: XCUIElement) -> Bool { element.focused }
  func waitForExactInputFocus(app: XCUIApplication, element: XCUIElement, timeoutMs: Int) -> Bool { element.focused }
  func keyboardFrameIfVisible(app: XCUIApplication) -> CGRect? { nil }
  func tapAt(app: XCUIApplication, x: Double, y: Double, anchor: XCUIElement? = nil) -> RunnerInteractionOutcome { preconditionFailure("strict focus must never use coordinates") }
  func findElement(app: XCUIApplication, text: String) -> XCUIElement? { app.nodes.first }
  func activateElement(app: XCUIApplication, element: XCUIElement, action: String) -> RunnerInteractionOutcome { element.tap(); return .performed }
  func resolvedTouchVisualizationFrame(app: XCUIApplication, x: Double, y: Double) -> (x: Double, y: Double, referenceWidth: Double, referenceHeight: Double) { (x, y, 400, 800) }
  func applyKeyboardGuard(app: XCUIApplication, tapX: Double, tapY: Double, command: Command, enabled: Bool) -> KeyboardGuardAction { .proceed("no_keyboard") }
  func activateKeyboardTarget(app: XCUIApplication, retained: XCUIElement, point: CGPoint) -> Bool { retained.tap(); return true }
  func coordinateAnchor(app: XCUIApplication, point: CGPoint, liveTarget: XCUIElement?) -> (decision: DispatchGuard.TapAnchor, element: XCUIElement?) { (.liveTarget, liveTarget) }
  static func appAlertInterruptionResponse() -> Response { Response(ok: false) }
${section(execution, '  private func currentUptimeMs()', '  private func executeFocusedType(')}
  func tap(_ command: Command) -> Response {
    let activeApp = currentApp!
${section(execution, '    let handlingStart = currentUptimeMs()', '    if command.command == .hitProbe')}
${section(execution, '    case .tap:', '    case .mouseClick:').slice('    case .tap:'.length)}
  }
  func gesture(_ operation: () -> Void) { operation() }
  func movedDispatchResponse() -> Response {
    Response(ok: false, error: ErrorPayload(code: "TARGET_MOVED_BEFORE_DISPATCH", message: "moved", mutation: "none"))
  }
  func executeFocusedType(app: XCUIApplication, text: String, replace: Bool, prepareReplacement: Bool, deleteCount: Int, handlingStartedAt: Double? = nil) -> Response {
    typed += 1; return Response(ok: true)
  }
  func type(_ command: Command) -> Response {
    let activeApp = currentApp!
${section(execution, '    let handlingStart = currentUptimeMs()', '    if command.command == .hitProbe')}
${section(section(execution, '    case .type:', '    case .verifyInput:'), '      guard let text = command.text else {', '      var keyboardWait:')}
    typed += 1
    return Response(ok: true)
  }
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
func typeCommand(focused: Bool = false) -> Command {
  try! decoder.decode(Command.self, from: Data("{\\"command\\":\\"type\\",\\"text\\":\\"x\\",\\"snapshotGeneration\\":7,\\"snapshotNodeIndex\\":6,\\"requireLiveHit\\":true,\\"focused\\":\\(focused)}".utf8))
}
for scenario in ["negative", "unavailable", "moved", "late", "ambiguous", "focused-mode"] {
  app.nodes = [target]; target.hit = true; target.delay = 0; target.focused = false; target.taps = 0
  target.frame.origin.y = 20; h.typed = 0; retain()
  if scenario == "negative" { target.hit = false }
  if scenario == "unavailable" { retain(nil, nil) }
  if scenario == "moved" { target.frame.origin.y = 25 }
  if scenario == "late" { target.delay = 0.32 }
  if scenario == "ambiguous" { app.nodes.append(XCUIElement()) }
  let result = h.type(typeCommand(focused: scenario == "focused-mode"))
  precondition(!result.ok, "strict focus admitted \\(scenario)")
  precondition(target.taps == 0 && h.typed == 0, "strict refusal mutated \\(scenario)")
}
app.nodes = [target]; target.hit = true; target.delay = 0; target.focused = false; target.taps = 0
h.typed = 0; h.resolutionDelay = 0.35; retain()
precondition(h.type(typeCommand()).ok, "strict focus needs a fresh post-resolution deadline")
precondition(target.taps == 1 && h.typed == 1)
h.resolutionDelay = 0; target.taps = 0; h.typed = 0; target.focused = true
precondition(h.type(typeCommand()).ok)
precondition(target.taps == 0 && h.typed == 1)
let tap = try! decoder.decode(Command.self, from: Data(#"{"command":"tap","x":40,"y":40,"snapshotGeneration":7,"snapshotNodeIndex":6,"requireLiveHit":true}"#.utf8))
let reply = h.tap(tap)
precondition(reply.ok)
let payload = reply.data!
precondition(payload.liveCheckMs! >= 0 && payload.handledMs! >= 0)
precondition(payload.handledMs! >= payload.gestureEndUptimeMs! - payload.gestureStartUptimeMs!)
let encoded = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as! [String: Any]
precondition(encoded["liveCheckMs"] != nil && encoded["handledMs"] != nil)

`,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
