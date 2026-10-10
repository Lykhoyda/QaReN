//
//  AppAlertTapRegressionTest.swift
//  RnFastRunnerUITests
//

import XCTest

// An app alert in its own window must never be answered by XCTest's default interruption handler.
final class AppAlertTapRegressionTest: RnFastRunnerTests {
  override func testCommand() throws {}

  private func command(_ json: String) throws -> Command {
    try JSONDecoder().decode(Command.self, from: Data(json.utf8))
  }

  @MainActor
  private func presentFixtureAlert() throws -> XCUIElement {
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
    return alert
#endif
  }

  // UIKit runs an alert action's handler only after the dismissal finishes.
  private func waitForFixtureResult(_ expected: String) -> Bool {
    let changed = XCTNSPredicateExpectation(
      predicate: NSPredicate(format: "label == %@", expected),
      object: app.staticTexts["alert-fixture-result"]
    )
    return XCTWaiter.wait(for: [changed], timeout: 5) == .completed
  }

  @MainActor
  func testSnapshotTapOnDestructiveButtonFiresItsHandler() throws {
    _ = try presentFixtureAlert()
    let snapshot = try execute(command: command(#"{"command":"snapshot","compact":true}"#))
    guard let generation = snapshot.data?.snapshotGeneration,
          let discard = snapshot.data?.nodes?.first(where: { $0.type == "Button" && $0.label == "Discard" })
    else { return XCTFail("snapshot should contain the Discard button; error=\(String(describing: snapshot.error?.message))") }
    let x = discard.rect.x + discard.rect.width / 2
    let y = discard.rect.y + discard.rect.height / 2
    let response = try execute(command: command(
      #"{"command":"tap","x":\#(x),"y":\#(y),"snapshotNodeIndex":\#(discard.index),"snapshotGeneration":\#(generation)}"#
    ))
    XCTAssertTrue(response.ok, "tap should succeed; error=\(String(describing: response.error?.message))")
    XCTAssertTrue(waitForFixtureResult("discarded"), "the destructive handler should fire")
  }

  @MainActor
  func testCoordinateTapBehindAlertNeverPressesAnAlertButton() throws {
    let alert = try presentFixtureAlert()
    let tap = try execute(command: command(#"{"command":"tap","x":40,"y":120}"#))
    XCTAssertEqual(tap.error?.code, "APP_ALERT_INTERRUPTION")
    XCTAssertEqual(tap.error?.mutation, "none")
    // Other gestures reach the interruption monitor; XCTest records that it stayed unhandled.
    var press: Response?
    XCTExpectFailure("XCTest reports the claimed alert as still interrupting") {
      press = try? execute(command: command(#"{"command":"longPress","x":40,"y":120,"durationMs":100}"#))
    }
    XCTAssertEqual(press?.error?.code, "APP_ALERT_INTERRUPTION")
    XCTAssertEqual(press?.error?.mutation, "none")
    XCTAssertTrue(alert.exists, "no alert button may be pressed on the caller's behalf")
    alert.buttons["Discard"].tap()
    XCTAssertTrue(waitForFixtureResult("discarded"), "only the explicit Discard tap may answer the alert")
  }
}
