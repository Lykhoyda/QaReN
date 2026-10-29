import XCTest

// Story 10 (#391): unit coverage for the two-burst splitting and the
// keyboard-presence wait loop (injected clock — no simulator UI needed).
final class TypingRecipeTests: XCTestCase {
  func testBurstsSplitFirstCharacterFromRemainder() {
    XCTAssertEqual(
      TypingRecipe.bursts(for: "hello"),
      TypingRecipe.Bursts(first: "h", remainder: "ello")
    )
  }

  func testBurstsNilForEmptyText() {
    XCTAssertNil(TypingRecipe.bursts(for: ""))
  }

  func testBurstsNilForSingleCharacter() {
    XCTAssertNil(TypingRecipe.bursts(for: "a"))
  }

  func testBurstsNilForSingleEmojiGraphemeCluster() {
    // 👋🏽 is one Character (waving hand + skin-tone modifier) — one burst, no split.
    XCTAssertNil(TypingRecipe.bursts(for: "👋🏽"))
  }

  func testBurstsNeverSplitGraphemeClusters() {
    let bursts = TypingRecipe.bursts(for: "👋🏽 world")
    XCTAssertEqual(bursts?.first, "👋🏽")
    XCTAssertEqual(bursts?.remainder, " world")
  }

  func testBurstsHandleMixedUnicodeAcceptanceString() {
    let bursts = TypingRecipe.bursts(for: "héllo 👋🏽 世界")
    XCTAssertEqual(bursts?.first, "h")
    XCTAssertEqual(bursts?.remainder, "éllo 👋🏽 世界")
  }

  func testWaitForKeyboardReturnsImmediatelyWhenVisible() {
    var sleeps: [TimeInterval] = []
    let result = TypingRecipe.waitForKeyboard(
      now: { 0 },
      sleep: { sleeps.append($0) },
      keyboardVisible: { true }
    )
    XCTAssertTrue(result.appeared)
    XCTAssertEqual(result.waitedMs, 0)
    XCTAssertTrue(sleeps.isEmpty)
  }

  func testWaitForKeyboardPollsUntilAppearance() {
    var clock: TimeInterval = 0
    var checks = 0
    let result = TypingRecipe.waitForKeyboard(
      now: { clock },
      sleep: { clock += $0 },
      keyboardVisible: {
        checks += 1
        return checks >= 4
      }
    )
    XCTAssertTrue(result.appeared)
    XCTAssertEqual(result.waitedMs, 300)
  }

  func testFocusedTypeDecisionRefusesEmptyText() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeDecision(textIsEmpty: true, keyboardVisible: true),
      .refuseEmptyText
    )
  }

  func testFocusedTypeDecisionRefusesWhenKeyboardIsDown() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeDecision(textIsEmpty: false, keyboardVisible: false),
      .refuseNoKeyboard
    )
  }

  func testFocusedTypeDecisionTypesWhenKeyboardIsUp() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeDecision(textIsEmpty: false, keyboardVisible: true),
      .type
    )
  }

  func testFocusedTypeOutcomeTypesWhenSucceeded() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeOutcome(succeeded: true, unavailable: false),
      .typed(route: "synthesized-first-responder")
    )
  }

  func testFocusedTypeOutcomeRefusesWhenUnavailable() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeOutcome(succeeded: false, unavailable: true),
      .refuseUnavailable
    )
  }

  func testFocusedTypeOutcomeFailsOtherwise() {
    XCTAssertEqual(
      TypingRecipe.focusedTypeOutcome(succeeded: false, unavailable: false),
      .failed
    )
  }

  func testWaitForKeyboardTimesOutAndReportsElapsed() {
    var clock: TimeInterval = 0
    let result = TypingRecipe.waitForKeyboard(
      now: { clock },
      sleep: { clock += $0 },
      keyboardVisible: { false }
    )
    XCTAssertFalse(result.appeared)
    XCTAssertGreaterThanOrEqual(result.waitedMs, 1000)
  }
}
