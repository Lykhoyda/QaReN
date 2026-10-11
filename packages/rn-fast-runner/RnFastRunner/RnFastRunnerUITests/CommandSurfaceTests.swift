import XCTest

// GH #418: the compiled CommandType enum IS the iOS command surface. These
// pure-logic tests pin the bridge-required verbs and the alias trap (B235).
final class CommandSurfaceTests: XCTestCase {
  func testAllCasesCoverBridgeRequiredVerbs() {
    let advertised = Set(CommandType.allCases.map(\.rawValue))
    let required: Set<String> = [
      "tap", "type", "verifyInput", "drag", "longPress", "pinch",
      "snapshot", "screenshot", "back", "keyboardDismiss",
    ]
    XCTAssertTrue(
      required.isSubset(of: advertised),
      "CommandType missing: \(required.subtracting(advertised))"
    )
  }

  // The positional alert verb tapped the last button, which is Allow on a permission prompt.
  func testPositionalAlertVerbIsGone() {
    XCTAssertNil(CommandType(rawValue: "alert"))
    XCTAssertNotNil(CommandType(rawValue: "systemAlertTap"))
  }

  func testAndroidKeyboardVerbIsNotAnIOSCase() {
    XCTAssertNil(CommandType(rawValue: "dismissKeyboard"))
    XCTAssertNil(CommandType(rawValue: "definitelyBogusVerb"))
  }

  // Story 04 (#385): the settle probe verb backs the SCREEN_STATIC capability
  // and must stay a lifecycle command (no activation preamble — it is a pure
  // screen read that always follows an already-activated mutating verb).
  // Deliberately NOT in the required set above: REQUIRED_IOS_COMMANDS mirrors
  // the bridge gate, and gating on this verb would force cold rebuilds of
  // every pre-settle artifact instead of the designed snapshot-poll degrade.
  func testSettleProbeVerbIsLifecycle() {
    guard let verb = CommandType(rawValue: "isScreenStatic") else {
      return XCTFail("CommandType missing isScreenStatic")
    }
    XCTAssertTrue(isRunnerLifecycleCommand(verb))
  }

  func testListenerFailureCannotPassViaCompletedExpectation() {
    let failure = runnerListenerWaitFailure(
      listenerError: "Address already in use",
      waitResult: .completed
    )
    XCTAssertEqual(failure, "runner listener failed to start: Address already in use")
  }

  func testHealthyListenerWaitHasNoFailure() {
    XCTAssertNil(runnerListenerWaitFailure(listenerError: nil, waitResult: .completed))
  }

  func testListenerWaitTimeoutStillFails() {
    let failure = runnerListenerWaitFailure(listenerError: nil, waitResult: .timedOut)
    XCTAssertEqual(failure, "runner wait ended with \(XCTWaiter.Result.timedOut)")
  }
}
