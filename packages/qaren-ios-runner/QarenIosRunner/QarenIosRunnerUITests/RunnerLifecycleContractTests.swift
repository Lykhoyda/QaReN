import XCTest

final class RunnerLifecycleContractTests: XCTestCase {
  func testAttachOnlyAdmitsOnlyAnExistingTarget() {
    XCTAssertTrue(runnerAttachOnlyTargetIsRunning(.runningForeground))
    XCTAssertTrue(runnerAttachOnlyTargetIsRunning(.runningBackground))
    XCTAssertTrue(runnerAttachOnlyTargetIsRunning(.runningBackgroundSuspended))
    XCTAssertFalse(runnerAttachOnlyTargetIsRunning(.notRunning))
    XCTAssertFalse(runnerAttachOnlyTargetIsRunning(.unknown))
  }

  func testMainThreadTimeoutKeepsItsTypedRunnerError() {
    let error = NSError(
      domain: QarenIosRunnerTests.RunnerErrorDomain.general,
      code: QarenIosRunnerTests.RunnerErrorCode.mainThreadExecutionTimedOut,
      userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
    )

    let payload = runnerErrorPayload(error)

    XCTAssertEqual(payload.code, "RUNNER_TIMEOUT")
    XCTAssertEqual(payload.message, "main thread execution timed out")
  }
}
