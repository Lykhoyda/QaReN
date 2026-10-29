//
//  RunnerSplashContractTests.swift
//  QarenIosRunnerUITests
//
//  CI-run pin for the splash-identifier launch contract SnapshotForegroundRegressionTest's precondition depends on.
//

import XCTest

final class RunnerSplashContractTests: XCTestCase {
  @MainActor
  func testLaunchedRunnerExposesSplashIdentifier() {
    let app = XCUIApplication()
    app.launch()
    XCTAssertEqual(
      app.state,
      .runningForeground,
      "runner app should be foreground after launch"
    )
    XCTAssertTrue(
      app.staticTexts[RunnerSplashContract.titleIdentifier].waitForExistence(timeout: 10),
      "launched runner must expose splash identifier \"\(RunnerSplashContract.titleIdentifier)\""
    )
  }
}
