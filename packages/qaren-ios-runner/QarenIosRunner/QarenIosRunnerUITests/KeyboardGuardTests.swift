import XCTest
import CoreGraphics

final class KeyboardGuardTests: XCTestCase {
  func testProtocolV2FreshGeometryFieldsDecode() throws {
    let json = #"{"command":"tap","x":10,"y":20,"targetBounds":{"x":1,"y":2,"width":3,"height":4},"snapshotGeneration":7,"snapshotNodeIndex":12,"snapshotElementType":"Key","snapshotLabel":"Q","snapshotIdentifier":"key-q","keyboardStateAtSnapshot":true}"#
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    XCTAssertEqual(command.targetBounds?.width, 3)
    XCTAssertEqual(command.snapshotGeneration, 7)
    XCTAssertEqual(command.snapshotNodeIndex, 12)
    XCTAssertEqual(command.snapshotElementType, "Key")
    XCTAssertEqual(command.snapshotLabel, "Q")
    XCTAssertEqual(command.snapshotIdentifier, "key-q")
    XCTAssertEqual(command.keyboardStateAtSnapshot, true)
  }

  private func presenceNode(type: String = "Keyboard", frame: CGRect = CGRect(x: 0, y: 500, width: 390, height: 336)) -> SnapshotNode {
    SnapshotNode(
      index: 0, type: type, label: "Keyboard", identifier: nil, value: nil,
      rect: SnapshotRect(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height),
      enabled: false, focused: nil, hittable: false, depth: 0, parentIndex: nil,
      hiddenContentAbove: nil, hiddenContentBelow: nil
    )
  }

  private func presencePayload(nodes: [SnapshotNode], complete: Bool = true) -> DataPayload {
    makePlatformPresencePayload(
      nodes: nodes, truncated: false,
      capture: PlatformPresenceCapture(
        version: 2, source: "xcui-live", captureId: "capture", appId: "test.app", generation: 7,
        startedUptimeMs: 1_000, endedUptimeMs: 1_100, enumeration: "raw-unfiltered", complete: complete,
        appliedBudgetMs: 20_000
      )
    )
  }

  func testPresencePayloadEncodesSameCaptureKeyboardStateAndGeneration() throws {
    for visible in [true, false] {
      let payload = presencePayload(nodes: [presenceNode(type: visible ? "Keyboard" : "Other")])
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
      let capture = try XCTUnwrap(json["presenceCapture"] as? [String: Any])
      XCTAssertEqual(json["keyboardVisible"] as? Bool, visible)
      XCTAssertEqual(json["snapshotGeneration"] as? Int, 7)
      XCTAssertEqual(capture["generation"] as? Int, 7)
    }
  }

  func testSnapshotPayloadReportsOnlyAPositiveAppProcessIdentifier() throws {
    for (raw, expected) in [(4242, 4242 as Int?), (0, nil), (-1, nil), (nil, nil)] as [(Int?, Int?)] {
      let payload = runnerPayload(presencePayload(nodes: []), appProcessIdentifier: raw)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
      XCTAssertEqual(json["appProcessIdentifier"] as? Int, expected)
      XCTAssertEqual(json["appProcessIdentifier"] == nil, expected == nil)
      XCTAssertEqual(json["snapshotGeneration"] as? Int, 7)
    }
  }

  func testPresenceKeyboardStateUsesTypeAndNonemptyFrameNotLabelsOrHittability() {
    XCTAssertEqual(presencePayload(nodes: [presenceNode()]).keyboardVisible, true)
    XCTAssertEqual(presencePayload(nodes: [presenceNode(frame: .zero)]).keyboardVisible, false)
    XCTAssertEqual(presencePayload(nodes: [presenceNode(frame: .null)]).keyboardVisible, false)
    XCTAssertEqual(presencePayload(nodes: [presenceNode(type: "Key"), presenceNode(type: "Other")]).keyboardVisible, false)
    XCTAssertEqual(presencePayload(nodes: []).keyboardVisible, false)
    XCTAssertEqual(presencePayload(nodes: [presenceNode(frame: .zero), presenceNode()]).keyboardVisible, true)
  }

  func testIncompletePresenceDoesNotClaimKeyboardState() throws {
    for nodes in [[], [presenceNode()]] {
      let payload = presencePayload(nodes: nodes, complete: false)
      XCTAssertNil(payload.keyboardVisible)
      let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
      XCTAssertNil(json["keyboardVisible"])
    }
  }

  private func keyboardCommand(
    type: String = "Key",
    generation: Int = 7,
    index: Int = 12,
    label: String = "Q",
    x: Int = 1,
    keyboardState: Bool = true
  ) throws -> Command {
    let json = #"{"command":"tap","x":2,"y":4,"targetBounds":{"x":\#(x),"y":2,"width":3,"height":4},"snapshotGeneration":\#(generation),"snapshotNodeIndex":\#(index),"snapshotElementType":"\#(type)","snapshotLabel":"\#(label)","keyboardStateAtSnapshot":\#(keyboardState)}"#
    return try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  private var retainedKey: RetainedSnapshotTarget {
    RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Key",
      label: "Q",
      identifier: nil,
      rect: SnapshotRect(x: 1, y: 2, width: 3, height: 4)
    )
  }

  func testExactCanonicalRunnerOwnedKeyQualifies() throws {
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(),
        retained: retainedKey,
        currentGeneration: 7,
        appFrame: CGRect(x: 0, y: 0, width: 402, height: 874)
      ),
      .keyboardTarget
    )
  }

  func testForgedStaleAndRelayoutKeyboardDescriptorsRefuse() throws {
    let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    for command in [
      try keyboardCommand(generation: 6),
      try keyboardCommand(index: 13),
      try keyboardCommand(label: "W"),
      try keyboardCommand(x: 9)
    ] {
      XCTAssertEqual(
        KeyboardGuard.validateKeyboardDescriptor(
          command: command,
          retained: retainedKey,
          currentGeneration: 7,
          appFrame: frame
        ),
        .stale
      )
    }
    let forgedRetained = RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Button",
      label: "Q",
      identifier: nil,
      rect: retainedKey.rect
    )
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(),
        retained: forgedRetained,
        currentGeneration: 7,
        appFrame: frame
      ),
      .stale
    )
  }

  func testCanonicalRetainedTargetsCannotBeDowngraded() throws {
    let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    for type in ["key", "KEY", "Button", "Other"] {
      XCTAssertEqual(
        KeyboardGuard.validateKeyboardDescriptor(
          command: try keyboardCommand(type: type),
          retained: retainedKey,
          currentGeneration: 7,
          appFrame: frame
        ),
        .stale
      )
    }
  }

  func testOrdinaryRetainedTargetsRemainOrdinary() throws {
    let retainedButton = RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Button",
      label: "Q",
      identifier: nil,
      rect: retainedKey.rect
    )
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(type: "Button"),
        retained: retainedButton,
        currentGeneration: 7,
        appFrame: CGRect(x: 0, y: 0, width: 402, height: 874)
      ),
      .ordinary
    )
  }

  private var retainedKeyboardButton: RetainedSnapshotTarget {
    RetainedSnapshotTarget(
      generation: 7,
      index: 12,
      type: "Button",
      label: "Q",
      identifier: nil,
      rect: retainedKey.rect,
      keyboardOwned: true
    )
  }

  func testKeyboardOwnedButtonQualifies() throws {
    XCTAssertEqual(
      KeyboardGuard.validateKeyboardDescriptor(
        command: try keyboardCommand(type: "Button"),
        retained: retainedKeyboardButton,
        currentGeneration: 7,
        appFrame: CGRect(x: 0, y: 0, width: 402, height: 874)
      ),
      .keyboardTarget
    )
  }

  func testKeyboardOwnedButtonForgedOrStaleDescriptorsRefuse() throws {
    let frame = CGRect(x: 0, y: 0, width: 402, height: 874)
    for command in [
      try keyboardCommand(type: "Key"),
      try keyboardCommand(type: "Button", generation: 6),
      try keyboardCommand(type: "Button", index: 13),
      try keyboardCommand(type: "Button", label: "W"),
      try keyboardCommand(type: "Button", x: 9),
      try keyboardCommand(type: "Button", keyboardState: false)
    ] {
      XCTAssertEqual(
        KeyboardGuard.validateKeyboardDescriptor(
          command: command,
          retained: retainedKeyboardButton,
          currentGeneration: 7,
          appFrame: frame
        ),
        .stale
      )
    }
  }

  func testKeyboardOwnershipFollowsAncestryNotGeometry() {
    // 0 app, 1 app window, 2 keyboard window, 3 Keyboard, 4 Other inside it.
    let parents: [Int: Int] = [1: 0, 2: 0, 3: 2, 4: 3, 5: 4, 6: 3, 7: 1, 8: 3, 9: 10, 10: 9]
    let types: [Int: String] = [
      0: "Application", 1: "Window", 2: "Window", 3: "Keyboard", 4: "Other",
      5: "Button", 6: "Button", 7: "Button", 8: "Key", 9: "Button", 10: "Other"
    ]
    func owned(_ index: Int) -> Bool {
      KeyboardGuard.isKeyboardOwnedButton(
        type: types[index] ?? "",
        index: index,
        parentOf: { parents[$0] },
        typeOf: { types[$0] }
      )
    }
    XCTAssertTrue(owned(5))
    XCTAssertTrue(owned(6))
    XCTAssertFalse(owned(7))
    XCTAssertFalse(owned(8))
    XCTAssertFalse(owned(9))
  }

  func testFinalActivationRejectsRelayoutAndKeyboardAbsence() {
    let expected = CGRect(x: 1, y: 2, width: 30, height: 40)
    let keyboard = CGRect(x: 0, y: 0, width: 100, height: 100)
    let point = CGPoint(x: 15, y: 20)
    XCTAssertTrue(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected, liveFrame: expected, keyboardFrame: keyboard, point: point
    ))
    XCTAssertFalse(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected,
      liveFrame: expected.offsetBy(dx: 4, dy: 0),
      keyboardFrame: keyboard,
      point: point
    ))
    XCTAssertFalse(KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expected, liveFrame: expected, keyboardFrame: nil, point: point
    ))
  }

  func testLiveResolutionRejectsOccludedAndChangedIdentityAtSameFrame() {
    let frame = CGRect(x: 1, y: 2, width: 3, height: 4)
    XCTAssertTrue(KeyboardGuard.matchesLiveKeyboardTarget(
      retained: retainedKey,
      candidateType: "Key",
      candidateLabel: "Q",
      candidateIdentifier: nil,
      candidateFrame: frame,
      exists: true,
      hittable: true
    ))
    XCTAssertFalse(KeyboardGuard.matchesLiveKeyboardTarget(
      retained: retainedKey,
      candidateType: "Key",
      candidateLabel: "Q",
      candidateIdentifier: nil,
      candidateFrame: frame,
      exists: true,
      hittable: false
    ))
    XCTAssertFalse(KeyboardGuard.matchesLiveKeyboardTarget(
      retained: retainedKey,
      candidateType: "Key",
      candidateLabel: "W",
      candidateIdentifier: nil,
      candidateFrame: frame,
      exists: true,
      hittable: true
    ))
  }

  func testSafeDismissControlsExcludeDoneKeysAndExternalToolbars() {
    XCTAssertTrue(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Hide keyboard", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Key", label: "Done", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Done", identifier: nil, insideKeyboard: true
    ))
    XCTAssertFalse(KeyboardGuard.isSafeDismissControl(
      type: "Button", label: "Dismiss keyboard", identifier: nil, insideKeyboard: false
    ))
  }

  func testTargetGeometryMustBeOnScreen() {
    let app = CGRect(x: 0, y: 0, width: 402, height: 874)
    XCTAssertTrue(
      KeyboardGuard.isProvenOnScreen(
        appFrame: app,
        targetRect: CGRect(x: 20, y: 550, width: 200, height: 44)
      )
    )
    XCTAssertFalse(
      KeyboardGuard.isProvenOnScreen(
        appFrame: app,
        targetRect: CGRect(x: 20, y: 918, width: 200, height: 44)
      )
    )
  }

  func testRectIntersectionUsesFreshGeometry() {
    let kb = CGRect(x: 0, y: 500, width: 400, height: 350)
    XCTAssertTrue(
      KeyboardGuard.shouldDismiss(
        keyboardFrame: kb,
        targetRect: CGRect(x: 40, y: 480, width: 120, height: 40),
        minHeight: 120
      )
    )
    XCTAssertFalse(
      KeyboardGuard.shouldDismiss(
        keyboardFrame: kb,
        targetRect: CGRect(x: 40, y: 430, width: 120, height: 40),
        minHeight: 120
      )
    )
  }

  let kb = CGRect(x: 0, y: 500, width: 390, height: 336) // docked, tall
  func testOccludedWhenPointInsideKeyboard() {
    XCTAssertTrue(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 700), minHeight: 120))
  }
  func testNotOccludedAboveKeyboard() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: kb, tapPoint: CGPoint(x: 200, y: 480), minHeight: 120))
  }
  func testAccessoryBarTooShortNotOccluded() {
    let bar = CGRect(x: 0, y: 800, width: 390, height: 44)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: bar, tapPoint: CGPoint(x: 200, y: 820), minHeight: 120))
  }
  func testEmptyFrameNeverOccludes() {
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: .zero, tapPoint: CGPoint(x: 1, y: 9999), minHeight: 120))
  }
  func testFloatingKeyboardUsesXContainment() {
    let floating = CGRect(x: 40, y: 500, width: 300, height: 300)
    XCTAssertFalse(KeyboardGuard.shouldDismiss(keyboardFrame: floating, tapPoint: CGPoint(x: 10, y: 600), minHeight: 120))
  }
  func testCommandDecodesGuardKeyboardFalse() throws {
    let json = #"{"command":"tap","x":1,"y":2,"guardKeyboard":false}"#.data(using: .utf8)!
    let cmd = try JSONDecoder().decode(Command.self, from: json)
    XCTAssertEqual(cmd.guardKeyboard, false)
  }
}
