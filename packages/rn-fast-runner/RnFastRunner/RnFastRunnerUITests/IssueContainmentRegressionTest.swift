import XCTest

// A UI automation issue raised while commands are served must not interrupt the runner's test.
final class IssueContainmentRegressionTest: RnFastRunnerTests {
  override func testCommand() throws {}

  @MainActor
  func testUiAutomationIssueWhileServingIsContained() throws {
    app.launch()
    servingCommands = true
    _ = app.buttons["issue-containment-missing-element"].frame
    servingCommands = false
    XCTAssertEqual(containedIssues, 1)
  }
}
