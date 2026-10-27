import XCTest

// A UI automation issue raised while commands are served must not interrupt the runner's test.
final class IssueContainmentRegressionTest: RnFastRunnerTests {
  override func testCommand() throws {}

  // Assertions run with servingCommands off so their own failures are never contained.
  private func serve(_ json: String) throws -> Response {
    let command = try JSONDecoder().decode(Command.self, from: Data(json.utf8))
    servingCommands = true
    defer { servingCommands = false }
    return try execute(command: command)
  }

  @MainActor
  private func launchVanishFixture(length: Int) throws -> CGPoint {
#if !os(iOS)
    throw XCTSkip("the vanish fixture is iOS only")
#else
    app.launchArguments = ["-RnFastRunnerVanishFixture", String(length)]
    app.launch()
    currentApp = app
    currentBundleId = nil
    let field = app.textFields["vanish-fixture-field"]
    XCTAssertTrue(field.waitForExistence(timeout: 10), "fixture field should be shown")
    return CGPoint(x: field.frame.midX, y: field.frame.midY)
#endif
  }

  @MainActor
  func testUiAutomationIssueWhileServingIsContained() throws {
    app.launch()
    servingCommands = true
    _ = app.buttons["issue-containment-missing-element"].frame
    servingCommands = false
    XCTAssertEqual(containedIssues, 1)
    XCTAssertFalse(gestureIssueRaised, "a read outside a gesture must not taint the command")
  }

#if RN_FAST_RUNNER_TEST_FAULTS
  private func serve(_ fields: [String: Any]) throws -> Response {
    let json = try JSONSerialization.data(withJSONObject: fields)
    return try serve(String(decoding: json, as: UTF8.self))
  }

  // The fixture removes the target right before the gesture, so the tap lands on a vanished element.
  private func assertTapOnVanishedTarget(_ response: Response, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertNil(beforeNextGesture, "the tap should run through the gesture helper", file: file, line: line)
    XCTAssertFalse(response.ok, "a tap on a vanished target must not report success", file: file, line: line)
    XCTAssertNotEqual(response.data?.message, "tapped", file: file, line: line)
    XCTAssertEqual(response.error?.code, "GESTURE_ISSUE_RAISED", file: file, line: line)
    XCTAssertEqual(response.error?.mutation, "possible", file: file, line: line)
  }

  @MainActor
  func testTapByTextOnVanishedButtonIsNotReportedTapped() throws {
    _ = try launchVanishFixture(length: 99)
    beforeNextGesture = { [app] in app.buttons["vanish-fixture-remove"].tap() }
    let response = try serve(#"{"command":"tap","text":"vanish-fixture-button"}"#)
    assertTapOnVanishedTarget(response)
  }

  @MainActor
  func testCoordinateTapOnVanishedAlertIsNotReportedTapped() throws {
#if !os(iOS)
    throw XCTSkip("the alert fixture is iOS only")
#else
    app.launchArguments = ["-RnFastRunnerAlertFixture"]
    app.launch()
    currentApp = app
    currentBundleId = nil
    app.buttons["alert-fixture-open"].tap()
    let alert = app.alerts["Discard changes?"]
    XCTAssertTrue(alert.waitForExistence(timeout: 10), "fixture alert should be presented")
    let discard = alert.buttons["Discard"].frame
    beforeNextGesture = { alert.buttons["Keep editing"].tap() }
    let response = try serve(#"{"command":"tap","x":\#(discard.midX),"y":\#(discard.midY)}"#)
    assertTapOnVanishedTarget(response)
    XCTAssertEqual(app.staticTexts["alert-fixture-result"].label, "kept", "the vanished Discard button must not be pressed")
    XCTAssertTrue(try serve(#"{"command":"uptime"}"#).ok, "the runner should keep serving after the failed tap")
#endif
  }

  @MainActor
  func testKeyboardKeyTapOnVanishedKeyboardIsNotReportedTapped() throws {
    _ = try launchVanishFixture(length: 99)
    app.textFields["vanish-fixture-field"].tap()
    guard app.keyboards.firstMatch.waitForExistence(timeout: 5) else {
      throw XCTSkip("the simulator shows no software keyboard")
    }
    let snapshot = try serve(#"{"command":"snapshot"}"#)
    guard let generation = snapshot.data?.snapshotGeneration,
          let key = snapshot.data?.nodes?.first(where: {
            $0.type == "Key" && $0.label?.count == 1 && $0.rect.width > 0 && $0.rect.height > 0
          }),
          let label = key.label
    else { return XCTFail("snapshot should contain a labelled keyboard key") }
    var fields: [String: Any] = [
      "command": "tap",
      "x": key.rect.x + key.rect.width / 2,
      "y": key.rect.y + key.rect.height / 2,
      "snapshotElementType": "Key",
      "snapshotNodeIndex": key.index,
      "snapshotGeneration": generation,
      "snapshotLabel": label,
      "keyboardStateAtSnapshot": true,
      "targetBounds": ["x": key.rect.x, "y": key.rect.y, "width": key.rect.width, "height": key.rect.height],
    ]
    if let identifier = key.identifier { fields["snapshotIdentifier"] = identifier }
    beforeNextGesture = { [app] in app.buttons["vanish-fixture-remove"].tap() }
    let response = try serve(fields)
    assertTapOnVanishedTarget(response)
  }
#endif

  @MainActor
  func testFieldVanishingDuringTypingIsNotReportedTyped() throws {
    let center = try launchVanishFixture(length: 1)
    let response = try serve(#"{"command":"type","text":"ab","delayMs":300,"x":\#(center.x),"y":\#(center.y)}"#)
    XCTAssertFalse(response.ok, "typing into a vanished field must not succeed")
    XCTAssertNotEqual(response.data?.message, "typed")
    XCTAssertEqual(response.error?.code, "GESTURE_ISSUE_RAISED")
    XCTAssertEqual(response.error?.mutation, "possible")
  }

  @MainActor
  func testFieldVanishingAfterTypingStillReportsTypedAndKeepsServing() throws {
    let center = try launchVanishFixture(length: 4)
    let response = try serve(#"{"command":"type","text":"1234","x":\#(center.x),"y":\#(center.y)}"#)
    XCTAssertTrue(response.ok, "error=\(String(describing: response.error?.message))")
    XCTAssertEqual(response.data?.message, "typed")
    XCTAssertEqual(containedIssues, 0, "the vanished field's attributes should not be read after typing")
    // status is answered by the transport, so uptime is the next command execute(command:) serves.
    let next = try serve(#"{"command":"uptime"}"#)
    XCTAssertTrue(next.ok, "the runner should keep serving after the field vanished")
  }

  @MainActor
  func testVerifyInputOfFieldVanishedAfterTypingIsUnreadableWithoutReads() throws {
    let center = try launchVanishFixture(length: 4)
    let typed = try serve(#"{"command":"type","text":"1234","x":\#(center.x),"y":\#(center.y),"operationToken":"vanish-op"}"#)
    XCTAssertTrue(typed.ok, "error=\(String(describing: typed.error?.message))")
    let started = ProcessInfo.processInfo.systemUptime
    let verify = try serve(#"{"command":"verifyInput","text":"1234","operationToken":"vanish-op"}"#)
    let elapsed = ProcessInfo.processInfo.systemUptime - started
    XCTAssertTrue(verify.ok)
    XCTAssertEqual(verify.data?.verifyVerdict, "unreadable", "a vanished field is unread, never verified or reported moved")
    XCTAssertEqual(verify.data?.verifyStable, false)
    XCTAssertEqual(containedIssues, 0, "no attribute of the vanished field should be read")
    // One failed element read costs XCTest about two seconds of retries.
    XCTAssertLessThan(elapsed, 1.5, "verifyInput should not wait on the vanished field")
  }

  @MainActor
  func testVerifyInputOfFieldThatStaysIsExactAndStable() throws {
    let center = try launchVanishFixture(length: 99)
    let typed = try serve(#"{"command":"type","text":"1234","x":\#(center.x),"y":\#(center.y),"operationToken":"stay-op"}"#)
    XCTAssertTrue(typed.ok, "error=\(String(describing: typed.error?.message))")
    let verify = try serve(#"{"command":"verifyInput","text":"1234","operationToken":"stay-op"}"#)
    XCTAssertEqual(verify.data?.verifyVerdict, "exact")
    XCTAssertEqual(verify.data?.verifyStable, true)
  }
}
