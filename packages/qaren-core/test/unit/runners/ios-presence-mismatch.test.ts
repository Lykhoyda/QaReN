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

test('production Swift revalidation reports only its first raw descriptor or hierarchy mismatch', async (t) => {
  const available = spawnSync('swift', ['--version'], { encoding: 'utf8' });
  if (available.error && 'code' in available.error && available.error.code === 'ENOENT')
    return t.skip('Swift toolchain unavailable');
  assert.equal(available.status, 0, available.stderr);
  const models = readFileSync(new URL('RnFastRunnerTests+Models.swift', native), 'utf8');
  const snapshot = readFileSync(new URL('RnFastRunnerTests+Snapshot.swift', native), 'utf8');
  const result = spawnSync('swift', ['-'], {
    encoding: 'utf8',
    timeout: 90_000,
    input: `
import Foundation
#if canImport(CoreGraphics)
import CoreGraphics
#endif
${section(models, 'struct PlatformPresenceCapture:', 'struct PlatformPresenceObservation:')}
${section(snapshot, 'final class PresenceCaptureTiming', 'func makePlatformPresencePayload(')}
enum XCUIElement {
  enum ElementType: UInt { case application = 1, button = 9, staticText = 48, other = 82 }
}
final class XCUIElementSnapshot {
  var elementType: XCUIElement.ElementType = .button
  var identifier = "PRIVATE-identifier"
  var label = "PRIVATE-label"
  var value: Any? = "PRIVATE-value"
  var frame = CGRect(x: 10, y: 20, width: 30, height: 40)
  var isEnabled = true
  var descendants: [XCUIElementSnapshot] = []
  var forbidChildren = false
  var children: [XCUIElementSnapshot] {
    precondition(!forbidChildren, "must exit at the first mismatch")
    return descendants
  }
}
enum Unavailable: Error { case read }
final class XCUIApplication {
  let root: XCUIElementSnapshot
  var reads = 0
  var fail = false
  var onRead: () -> Void = {}
  init(_ root: XCUIElementSnapshot) { self.root = root }
  func snapshot() throws -> XCUIElementSnapshot {
    reads += 1
    onRead()
    if fail { throw Unavailable.read }
    return root
  }
}
struct SnapshotNode { let depth: Int; let parentIndex: Int? }
enum RunnerObjCExceptionCatcher {
  static func catchException(_ read: () -> Void) -> String? { read(); return nil }
}
final class Harness {
  var maxSnapshotElements = 600
${section(snapshot, '  private struct PresenceDescriptor:', '  func platformPresenceFailure(')}
${section(snapshot, '  private func presenceRead<', '  private func presenceAppIsEligible(')}
${section(snapshot, '  private func presenceEnumerationIsUnchanged(', '  private func presenceClip(')}
  func run(
    _ name: String, before: [XCUIElementSnapshot], after: XCUIElementSnapshot,
    nodes: [SnapshotNode]? = nil, dropDescriptor: Bool = false,
    deadline: Double = 100, failRead: Bool = false, overrun: Bool = false,
    priorFailure: Bool = false
  ) throws {
    var now = 0.0
    let timing = PresenceCaptureTiming(started: now, now: { now })
    timing.begin(.revalidation)
    if priorFailure { timing.fail(.ineligible) }
    let app = XCUIApplication(after)
    app.fail = failRead
    if overrun { app.onRead = { now = 101 } }
    var descriptors = before.map { PresenceDescriptor($0) }
    if dropDescriptor { descriptors.removeLast() }
    let unchanged = presenceEnumerationIsUnchanged(
      app: app,
      nodes: nodes ?? before.indices.map { SnapshotNode(depth: $0 == 0 ? 0 : 1, parentIndex: $0 == 0 ? nil : 0) },
      descriptors: descriptors, deadline: deadline, timing: timing
    )
    timing.endPhase()
    if !unchanged { timing.fail(.readUnavailable) }
    let encoded = try JSONEncoder().encode(timing.diagnostics(complete: unchanged))
    let diagnostic = try JSONSerialization.jsonObject(with: encoded)
    let output: [String: Any] = ["name": name, "unchanged": unchanged, "reads": app.reads, "diagnostics": diagnostic]
    print(String(data: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), encoding: .utf8)!)
  }
}
func root(_ children: [XCUIElementSnapshot]) -> XCUIElementSnapshot {
  let result = XCUIElementSnapshot(); result.elementType = .application; result.descendants = children
  return result
}
let h = Harness()
let old = XCUIElementSnapshot()
let base = [root([old]), old]
try h.run("equal", before: base, after: root([XCUIElementSnapshot()]))
for field in ["type", "identifier", "label", "value", "frame", "enabled", "all"] {
  let changed = XCUIElementSnapshot()
  if field == "type" || field == "all" { changed.elementType = .staticText }
  if field == "identifier" || field == "all" { changed.identifier += " " }
  if field == "label" || field == "all" { changed.label += " " }
  if field == "value" || field == "all" { changed.value = "PRIVATE-value " }
  if field == "frame" || field == "all" { changed.frame.origin.x += 0.01 }
  if field == "enabled" || field == "all" { changed.isEnabled = false }
  changed.forbidChildren = true
  try h.run(field, before: base, after: root([changed]))
}
for (name, beforeValue, afterValue) in [
  ("absent-value", nil, "" as Any?),
  ("value-kind", "1" as Any?, NSNumber(value: 1) as Any?),
  ("number-kind", NSNumber(value: true) as Any?, NSNumber(value: Int32(1)) as Any?),
  ("initial-unavailable", ["PRIVATE-value"] as Any?, "PRIVATE-value" as Any?)
] {
  let before = XCUIElementSnapshot(); before.value = beforeValue
  let after = XCUIElementSnapshot(); after.value = afterValue
  try h.run(name, before: [root([before]), before], after: root([after]))
}
let offscreenBefore = XCUIElementSnapshot()
offscreenBefore.elementType = .other; offscreenBefore.label = ""; offscreenBefore.identifier = ""
offscreenBefore.frame.origin.y = -1000
let offscreenAfter = XCUIElementSnapshot()
offscreenAfter.elementType = .other; offscreenAfter.label = ""; offscreenAfter.identifier = ""
offscreenAfter.frame.origin.y = -1000.01
try h.run("offscreen", before: [root([offscreenBefore]), offscreenBefore], after: root([offscreenAfter]))
let mismatch = XCUIElementSnapshot(); mismatch.label += " "
mismatch.forbidChildren = true
let later = XCUIElementSnapshot(); later.forbidChildren = true
try h.run("first-only", before: [root([old, old]), old, old], after: root([mismatch, later]))
try h.run("depth", before: base, after: root([old]), nodes: [SnapshotNode(depth: 0, parentIndex: nil), SnapshotNode(depth: 2, parentIndex: 0)])
try h.run("parent", before: base, after: root([old]), nodes: [SnapshotNode(depth: 0, parentIndex: nil), SnapshotNode(depth: 1, parentIndex: nil)])
let other = XCUIElementSnapshot(); other.elementType = .staticText
try h.run("reordered", before: [root([old, other]), old, other], after: root([other, old]))
try h.run("added", before: base, after: root([old, old]))
try h.run("missing", before: base, after: root([]))
try h.run("descriptor-count", before: base, after: root([old]), dropDescriptor: true)
let unsupported = XCUIElementSnapshot(); unsupported.value = ["PRIVATE-value"]
try h.run("unavailable", before: base, after: root([unsupported]))
try h.run("throw", before: base, after: root([old]), failRead: true)
try h.run("deadline-before", before: base, after: root([old]), deadline: 0)
try h.run("deadline-during", before: base, after: root([mismatch]), overrun: true)
try h.run("first-failure", before: base, after: root([mismatch]), priorFailure: true)
for name in ["signed", "ulp", "nan-before", "infinity-after", "overflow", "negative-size", "invalid-size-before", "zero-area", "null-before", "null-after", "infinite-before", "infinite-after"] {
  let before = XCUIElementSnapshot(), after = XCUIElementSnapshot()
  switch name {
  case "signed": after.frame = CGRect(x: 10.125, y: 19.75, width: 30.5, height: 39)
  case "ulp": after.frame.origin.x = after.frame.origin.x.nextUp
  case "nan-before": before.frame.origin.x = .nan
  case "infinity-after": after.frame.origin.y = .infinity
  case "overflow": before.frame.origin.x = -CGFloat.greatestFiniteMagnitude; after.frame.origin.x = CGFloat.greatestFiniteMagnitude
  case "negative-size": after.frame.size.width = -30
  case "invalid-size-before": before.frame.size.height = .nan
  case "zero-area": before.frame.size = .zero; after.frame = before.frame; after.frame.origin.x += 1
  case "null-before": before.frame = .null
  case "null-after": after.frame = .null
  case "infinite-before": before.frame = .infinite
  case "infinite-after": after.frame = .infinite
  default: break
  }
  after.forbidChildren = true
  try h.run(name, before: [root([before]), before], after: root([after]))
}
for depth in [16, 17] {
  let before = (0...depth).map { _ in XCUIElementSnapshot() }
  let after = (0...depth).map { _ in XCUIElementSnapshot() }
  for index in 0...depth {
    let type: XCUIElement.ElementType = index == 0 ? .application : .other
    before[index].elementType = type; after[index].elementType = type
    before[index].forbidChildren = true
    if index < depth { after[index].descendants = [after[index + 1]] }
  }
  after[depth].frame.origin.x += 0.125; after[depth].forbidChildren = true
  try h.run("ancestors-" + String(depth), before: before, after: after[0], nodes: (0...depth).map { SnapshotNode(depth: $0, parentIndex: $0 == 0 ? nil : $0 - 1) })
}
for parent in [-1, 1, 600] {
  try h.run("invalid-parent-" + String(parent), before: base, after: root([old]), nodes: [SnapshotNode(depth: 0, parentIndex: nil), SnapshotNode(depth: 1, parentIndex: parent)])
}
h.maxSnapshotElements = 1
try h.run("node-limit", before: base, after: root([old]))
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
  assert.equal(rows.get('equal').unchanged, true);
  assert.equal(rows.get('equal').diagnostics.failure, undefined);
  const changed = (name: string, mismatch: object) => {
    const row = rows.get(name);
    assert.equal(row.unchanged, false, name);
    const { geometry, ancestorTypes, ancestorsTruncated, ...original } =
      row.diagnostics.failure.mismatch;
    if (original.kind !== 'node') {
      assert.equal(geometry, undefined);
      assert.equal(ancestorTypes, undefined);
      assert.equal(ancestorsTruncated, undefined);
    }
    assert.deepEqual(
      { ...row.diagnostics.failure, mismatch: original },
      {
        phase: 'revalidation',
        reason: 'enumeration-changed',
        mismatch,
      },
      name,
    );
  };
  for (const [name, fieldMask] of Object.entries({
    type: 1,
    identifier: 2,
    label: 4,
    value: 8,
    frame: 16,
    enabled: 32,
    depth: 64,
    parent: 128,
    all: 63,
    offscreen: 16,
    reordered: 1,
    'absent-value': 8,
    'value-kind': 8,
    'number-kind': 8,
    'first-only': 4,
  })) {
    changed(name, {
      kind: 'node',
      index: 1,
      fieldMask,
      beforeType: name === 'offscreen' ? 82 : 9,
      afterType: ['type', 'all', 'reordered'].includes(name) ? 48 : name === 'offscreen' ? 82 : 9,
    });
  }
  changed('initial-unavailable', { kind: 'node', index: 1, fieldMask: 256, afterType: 9 });
  changed('added', { kind: 'added-node', index: 2, fieldMask: 0 });
  changed('missing', { kind: 'missing-node', index: 1, fieldMask: 0, beforeType: 9 });
  changed('descriptor-count', { kind: 'descriptor-count', fieldMask: 0 });
  const geometry = (name: string) => rows.get(name).diagnostics.failure.mismatch.geometry;
  assert.deepEqual(geometry('signed'), {
    changedMask: 15,
    beforeFiniteMask: 15,
    afterFiniteMask: 15,
    deltaFiniteMask: 15,
    dx: 0.125,
    dy: -0.25,
    dWidth: 0.5,
    dHeight: -1,
    beforeNull: false,
    afterNull: false,
    beforeInfinite: false,
    afterInfinite: false,
    beforeInvalidSize: false,
    afterInvalidSize: false,
  });
  assert.equal(geometry('ulp').dx, 1.7763568394002505e-15);
  assert.equal(geometry('ulp').changedMask, 1);
  assert.equal(geometry('type').changedMask, 0);
  assert.equal(geometry('nan-before').beforeFiniteMask, 14);
  assert.equal(geometry('nan-before').deltaFiniteMask, 14);
  assert.equal(geometry('nan-before').dx, undefined);
  assert.equal(geometry('infinity-after').afterFiniteMask, 13);
  assert.equal(geometry('infinity-after').deltaFiniteMask, 13);
  assert.equal(geometry('infinity-after').dy, undefined);
  assert.equal(geometry('overflow').beforeFiniteMask, 15);
  assert.equal(geometry('overflow').afterFiniteMask, 15);
  assert.equal(geometry('overflow').deltaFiniteMask, 14);
  assert.equal(geometry('overflow').dx, undefined);
  assert.equal(geometry('negative-size').afterInvalidSize, true);
  assert.equal(geometry('negative-size').changedMask, 4);
  assert.equal(geometry('negative-size').dWidth, -60);
  assert.equal(geometry('invalid-size-before').beforeInvalidSize, true);
  assert.equal(geometry('invalid-size-before').dHeight, undefined);
  assert.equal(geometry('zero-area').beforeInvalidSize, false);
  assert.equal(geometry('zero-area').afterInvalidSize, false);
  assert.equal(geometry('null-before').beforeNull, true);
  assert.equal(geometry('null-after').afterNull, true);
  assert.equal(geometry('infinite-before').beforeInfinite, true);
  assert.equal(geometry('infinite-after').afterInfinite, true);
  assert.equal(geometry('initial-unavailable'), undefined);
  for (const [name, types, truncated] of [
    ['frame', [1], false],
    ['ancestors-16', [...Array(15).fill(82), 1], false],
    ['ancestors-17', Array(16).fill(82), true],
    ...[-1, 1, 600].map((parent) => [`invalid-parent-${parent}`, [], true]),
  ] as const) {
    const mismatch = rows.get(name).diagnostics.failure.mismatch;
    assert.deepEqual(mismatch.ancestorTypes, types, name);
    assert.equal(mismatch.ancestorsTruncated, truncated, name);
  }
  for (const [name, reason] of Object.entries({
    unavailable: 'read-unavailable',
    throw: 'read-unavailable',
    'deadline-before': 'deadline',
    'deadline-during': 'deadline',
    'first-failure': 'ineligible',
    'node-limit': 'node-limit',
  })) {
    assert.equal(rows.get(name).unchanged, false, name);
    assert.deepEqual(rows.get(name).diagnostics.failure, { phase: 'revalidation', reason }, name);
  }
  for (const [name, row] of rows) {
    assert.equal(row.reads, ['descriptor-count', 'deadline-before'].includes(name) ? 0 : 1, name);
    assert.equal(row.unchanged, name === 'equal', name);
    const detail = row.diagnostics.failure?.mismatch?.geometry;
    if (detail) {
      assert.deepEqual(
        Object.keys(detail).filter(
          (key) =>
            ![
              'changedMask',
              'beforeFiniteMask',
              'afterFiniteMask',
              'deltaFiniteMask',
              'dx',
              'dy',
              'dWidth',
              'dHeight',
              'beforeNull',
              'afterNull',
              'beforeInfinite',
              'afterInfinite',
              'beforeInvalidSize',
              'afterInvalidSize',
            ].includes(key),
        ),
        [],
      );
      for (const key of ['dx', 'dy', 'dWidth', 'dHeight'])
        assert.ok(detail[key] === undefined || Number.isFinite(detail[key]), name);
      const source = nativeCapture();
      const logs: string[] = [];
      const screen = await captureScreen({
        appId: 'com.test',
        now: () => 0,
        native: async () => ({
          ...source,
          presenceCapture: {
            ...source.presenceCapture,
            complete: false,
            diagnostics: row.diagnostics,
          },
        }),
        react: async () => ({}),
        warn: (line) => logs.push(line),
      });
      assert.equal(screen.coverage?.native, 'incomplete', name);
      const forwarded = logs.find((line) => line.startsWith('presence-mismatch='));
      assert.ok(forwarded?.includes(',geometry='), name);
      assert.deepEqual(
        JSON.parse(forwarded.split(',geometry=')[1].split(',ancestorTypes=')[0]),
        detail,
        name,
      );
      assert.ok(!logs.join('').includes('PRIVATE-'), name);
    }
  }
});
