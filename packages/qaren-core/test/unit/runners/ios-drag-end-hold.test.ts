import '../../helpers/private-tmp.ts';
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

type Step = {
  x: number;
  y: number;
  x2: number;
  y2: number;
  holdDuration: number;
  endHold: number | null;
};
type Press = {
  from: number[];
  to: number[];
  holdBefore: number;
  held: boolean;
  endHold: number | null;
  velocity: number | null;
};
type Run = { name: string; ok: boolean; steps: Step[]; presses: Press[] };
type Results = {
  runs: Run[];
  holds: Record<string, number | null>;
  plainDrag: Record<string, unknown>;
  capabilities: string[];
};

// Runs the production drag and drag-series execution through a harness whose last step before XCTest
// records the value it receives; a second pass keeps the default step and records the XCTest call form.
function runHarness(): Results | undefined {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return undefined;
  assert.equal(available.status, 0, available.stderr);
  const models = read('QarenIosRunnerTests+Models.swift');
  const execution = read('QarenIosRunnerTests+CommandExecution.swift');
  const interaction = read('QarenIosRunnerTests+Interaction.swift');
  const transport = read('QarenIosRunnerTests+Transport.swift');
  const result = spawnSync('swift', ['-D', 'RN_FAST_RUNNER_TEST_FAULTS', '-'], {
    encoding: 'utf8',
    timeout: 120_000,
    input: `
import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
${section(models, 'enum CommandType:', 'struct Response:')}
${section(models, 'struct SnapshotRect:', 'struct SnapshotNode:')}
struct ErrorPayload { var code: String? = nil; let message: String; var mutation: String? = nil }
struct DataPayload {
  var message: String? = nil
  var gestureStartUptimeMs: Double? = nil
  var gestureEndUptimeMs: Double? = nil
  var x: Double? = nil; var y: Double? = nil; var x2: Double? = nil; var y2: Double? = nil
  var referenceWidth: Double? = nil; var referenceHeight: Double? = nil
}
struct Response { let ok: Bool; var data: DataPayload? = nil; var error: ErrorPayload? = nil }
struct QuiescenceStatus { var capabilities: [String] = []; static func current() -> Self { Self() } }
let capabilities = ${section(transport, 'QuiescenceStatus.current().capabilities', ',\n            commands:')}
enum RunnerInteractionOutcome { case performed; case unsupported(String) }
${section(interaction, 'enum TvRemoteButton {', 'extension QarenIosRunnerTests {')}
struct XCUIGestureVelocity: Equatable {
  let rawValue: Double
  static let \`default\` = XCUIGestureVelocity(rawValue: -10)
  static let slow = XCUIGestureVelocity(rawValue: -20)
}
final class XCUIApplication {}
var presses: [[String: Any]] = []
func optional(_ value: TimeInterval?) -> Any { value.map { $0 as Any } ?? NSNull() }
struct XCUICoordinate {
  let x: Double
  let y: Double
  func press(forDuration duration: TimeInterval, thenDragTo other: XCUICoordinate) {
    presses.append(["from": [x, y], "to": [other.x, other.y], "holdBefore": duration, "held": false, "endHold": NSNull(), "velocity": NSNull()])
  }
  func press(forDuration duration: TimeInterval, thenDragTo other: XCUICoordinate, withVelocity velocity: XCUIGestureVelocity, thenHoldForDuration hold: TimeInterval) {
    presses.append(["from": [x, y], "to": [other.x, other.y], "holdBefore": duration, "held": true, "endHold": hold, "velocity": velocity.rawValue])
  }
}
final class Harness {
  let app = XCUIApplication()
  var coordinateDragStep: ((CoordinateDrag) -> Void)?
  struct DragVisualizationFrame { let x: Double; let y: Double; let x2: Double; let y2: Double; let referenceWidth: Double; let referenceHeight: Double }
  func resolvedDragVisualizationFrame(app: XCUIApplication, x: Double, y: Double, x2: Double, y2: Double) -> DragVisualizationFrame {
    DragVisualizationFrame(x: x, y: y, x2: x2, y2: y2, referenceWidth: 402, referenceHeight: 874)
  }
  func measureGesture(_ action: () -> Void) -> (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double) { action(); return (0, 0) }
  func withTemporaryScrollIdleTimeoutIfSupported(_ app: XCUIApplication, _ operation: () -> Void) { operation() }
  func pressTvRemote(_ button: TvRemoteButton, duration: TimeInterval = 0) -> Bool { false }
  func interactionCoordinate(app: XCUIApplication, x: Double, y: Double) -> XCUICoordinate { XCUICoordinate(x: x, y: y) }
  func gesture(_ body: () -> Void) { body() }
${section(execution, '  private func unsupportedResponse(', '  private func executeFocusedType(')}
${section(interaction, '  func dragAt(', '  func resolvedTouchVisualizationFrame(')}
${section(interaction, '  func runSeries(', '  func swipe(app:')}
${section(interaction, '  private func performCoordinateDrag(', '#if !os(tvOS)\n  private func interactionCoordinate(')}
  func execute(_ command: Command) -> Response {
    let activeApp = app
    switch command.command {
${section(execution, '    case .drag:', '    case .remotePress:')}
    default:
      preconditionFailure("not a drag command")
    }
  }
}
func command(_ json: String) -> Command { try! JSONDecoder().decode(Command.self, from: Data(json.utf8)) }
func step(_ drag: CoordinateDrag) -> [String: Any] {
  ["x": drag.x, "y": drag.y, "x2": drag.x2, "y2": drag.y2, "holdDuration": drag.holdDuration, "endHold": optional(drag.endHold)]
}
var runs: [[String: Any]] = []
func serve(_ name: String, _ json: String) {
  for replaced in [true, false] {
    let harness = Harness()
    var steps: [[String: Any]] = []
    if replaced { harness.coordinateDragStep = { steps.append(step($0)) } }
    presses = []
    let response = harness.execute(command(json))
    runs.append(["name": "\\(name)\\(replaced ? "" : " (default step)")", "ok": response.ok, "steps": steps, "presses": presses])
  }
}
let drag = "\\"command\\":\\"drag\\",\\"x\\":201,\\"y\\":738,\\"x2\\":201,\\"y2\\":556,\\"durationMs\\":300"
serve("drag", "{\\(drag)}")
for ms in ["0", "100", "250", "5000"] { serve("drag \\(ms)", "{\\(drag),\\"endHoldMs\\":\\(ms)}") }
serve("short 250", "{\\"command\\":\\"drag\\",\\"x\\":201,\\"y\\":600,\\"x2\\":201,\\"y2\\":552,\\"durationMs\\":300,\\"endHoldMs\\":250}")
serve("long 250", "{\\"command\\":\\"drag\\",\\"x\\":201,\\"y\\":850,\\"x2\\":201,\\"y2\\":50,\\"durationMs\\":300,\\"endHoldMs\\":250}")
for pattern in ["one-way", "ping-pong"] {
  serve("series \\(pattern)", "{\\"command\\":\\"dragSeries\\",\\"x\\":201,\\"y\\":738,\\"x2\\":201,\\"y2\\":556,\\"durationMs\\":300,\\"count\\":2,\\"pattern\\":\\"\\(pattern)\\",\\"endHoldMs\\":250}")
}
var holds: [String: Any] = [:]
holds["drag"] = optional(command("{\\(drag)}").dragEndHold)
for ms in ["0", "100", "250", "5000"] { holds["drag \\(ms)"] = optional(command("{\\(drag),\\"endHoldMs\\":\\(ms)}").dragEndHold) }
for other in ["dragSeries", "tap", "pinch"] { holds[other] = optional(command("{\\"command\\":\\"\\(other)\\",\\"endHoldMs\\":250}").dragEndHold) }
let plain = command("{\\(drag)}")
let plainDrag: [String: Any] = [
  "command": plain.command.rawValue, "x": plain.x as Any, "y": plain.y as Any, "x2": plain.x2 as Any,
  "y2": plain.y2 as Any, "durationMs": plain.durationMs as Any, "endHoldMs": plain.endHoldMs.map { $0 as Any } ?? NSNull(),
]
let out = try! JSONSerialization.data(withJSONObject: ["runs": runs, "holds": holds, "plainDrag": plainDrag, "capabilities": capabilities], options: [.sortedKeys])
print(String(decoding: out, as: UTF8.self))
`,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Results;
}

let cached: Results | undefined | null = null;
const results = () => (cached === null ? (cached = runHarness()) : cached);

const at = (endHold: number | null) => ({
  x: 201,
  y: 738,
  x2: 201,
  y2: 556,
  holdDuration: 0.3,
  endHold,
});

test('U1 a drag reaches the last step before XCTest with the end hold its command asks, capped at 2 s', (t) => {
  const r = results();
  if (!r) return t.skip('Swift toolchain unavailable');
  const run = (name: string) => r.runs.find((entry) => entry.name === name)!;
  for (const [name, endHold] of [
    ['drag', null],
    ['drag 0', null],
    ['drag 100', 0.1],
    ['drag 250', 0.25],
    ['drag 5000', 2],
  ] as const) {
    assert.equal(run(name).ok, true, name);
    assert.deepEqual(run(name).steps, [at(endHold)], name);
    assert.deepEqual(
      run(`${name} (default step)`).presses,
      [
        {
          from: [201, 738],
          to: [201, 556],
          holdBefore: 0.3,
          held: endHold !== null,
          endHold,
          velocity: endHold === null ? null : 100,
        },
      ],
      `${name} (default step)`,
    );
  }
});

// XCTest builds one touch from this call: down, still for holdBefore, a straight move at the
// velocity in points per second, still for endHold, then lift. The lift carries the move's speed.
test('U4 a drag that ends at rest travels slowly in the one touch that holds, and lifts within 5 s', (t) => {
  const r = results();
  if (!r) return t.skip('Swift toolchain unavailable');
  const run = (name: string) => r.runs.find((entry) => entry.name === `${name} (default step)`)!;
  for (const [name, length, velocity, endHold] of [
    ['drag 100', 182, 100, 0.1],
    ['drag 250', 182, 100, 0.25],
    ['drag 5000', 182, 100, 2],
    ['short 250', 48, 100, 0.25],
    ['long 250', 800, 200, 0.25],
  ] as const) {
    const presses = run(name).presses;
    assert.equal(presses.length, 1, name);
    const [press] = presses;
    assert.equal(press.held, true, name);
    assert.equal(press.velocity, velocity, name);
    assert.equal(press.endHold, endHold, name);
    const travel = Math.hypot(press.to[0] - press.from[0], press.to[1] - press.from[1]);
    assert.equal(travel, length, name);
    assert.ok(travel / velocity <= 4, `${name} travels ${travel / velocity}s`);
    assert.ok(press.holdBefore + travel / velocity + endHold <= 5, `${name} lifts late`);
  }
});

test('U2 every stroke of a drag series reaches the last step with no end hold', (t) => {
  const r = results();
  if (!r) return t.skip('Swift toolchain unavailable');
  const run = (name: string) => r.runs.find((entry) => entry.name === name)!;
  const back = { ...at(null), x: 201, y: 556, x2: 201, y2: 738 };
  assert.deepEqual(run('series one-way').steps, [at(null), at(null)]);
  assert.deepEqual(run('series ping-pong').steps, [at(null), back]);
  for (const pattern of ['one-way', 'ping-pong'])
    assert.ok(
      run(`series ${pattern} (default step)`).presses.every((press) => !press.held),
      pattern,
    );
});

test('U3 the hold function, a drag without the field, and the advertised capability', (t) => {
  const r = results();
  if (!r) return t.skip('Swift toolchain unavailable');
  assert.deepEqual(r.holds, {
    drag: null,
    'drag 0': null,
    'drag 100': 0.1,
    'drag 250': 0.25,
    'drag 5000': 2,
    dragSeries: null,
    tap: null,
    pinch: null,
  });
  assert.deepEqual(r.plainDrag, {
    command: 'drag',
    x: 201,
    y: 738,
    x2: 201,
    y2: 556,
    durationMs: 300,
    endHoldMs: null,
  });
  assert.ok(r.capabilities.includes('DRAG_END_HOLD_V1'));
});
