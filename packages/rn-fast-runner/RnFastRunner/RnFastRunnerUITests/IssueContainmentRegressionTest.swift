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

  @MainActor
  func testTapOnVanishedElementIsAttributedToTheGesture() throws {
    app.launch()
    servingCommands = true
    let raised = gesture { app.buttons["issue-containment-missing-element"].tap() }
    servingCommands = false
    XCTAssertTrue(raised, "a tap that cannot resolve its element must report the issue")
    XCTAssertTrue(gestureIssueRaised)
  }

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
    XCTAssertGreaterThan(containedIssues, 0, "the post-type read of the vanished field should raise a contained issue")
    // status is answered by the transport, so uptime is the next command execute(command:) serves.
    let next = try serve(#"{"command":"uptime"}"#)
    XCTAssertTrue(next.ok, "the runner should keep serving after a contained issue")
  }
}
