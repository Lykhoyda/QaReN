import Foundation

// Story 10 (#391): Maestro-derived text-input recipe. iOS drops keystrokes
// typed immediately after keyboard appearance (autocorrect warm-up,
// hardware-keyboard arbitration), so the `type` handler (a) never types before
// the keyboard is up and (b) sends the first character as its own burst, waits
// out the drop window, then streams the remainder. Pure logic lives here so
// the unit suite can cover it without a simulator UI.
enum TypingRecipe {
  /// Pause between the first-character burst and the remainder (Maestro's 500 ms).
  static let interBurstDelay: TimeInterval = 0.5
  /// Longest we wait for the keyboard before typing anyway — a simulator with a
  /// connected hardware keyboard may never present the software keyboard, so
  /// the wait is best-effort, not a gate.
  static let keyboardWaitTimeout: TimeInterval = 1.0
  static let keyboardWaitPoll: TimeInterval = 0.1

  struct Bursts: Equatable {
    let first: String
    let remainder: String
  }

  enum FocusedTypeDecision: Equatable {
    case type
    case refuseEmptyText
    case refuseNoKeyboard
  }

  enum FocusedTypeOutcome: Equatable {
    case typed(route: String)
    case refuseUnavailable
    case failed
  }

  static func focusedTypeDecision(textIsEmpty: Bool, keyboardVisible: Bool) -> FocusedTypeDecision {
    if textIsEmpty { return .refuseEmptyText }
    return keyboardVisible ? .type : .refuseNoKeyboard
  }

  static func focusedTypeOutcome(succeeded: Bool, unavailable: Bool) -> FocusedTypeOutcome {
    if succeeded { return .typed(route: "synthesized-first-responder") }
    return unavailable ? .refuseUnavailable : .failed
  }

  /// Splits text into the two-burst shape. Returns nil when there is no
  /// remainder to send (empty or single-Character text types as one burst —
  /// no pointless inter-burst pause). `String.first` is a grapheme cluster,
  /// so an emoji with modifiers is never split mid-scalar.
  static func bursts(for text: String) -> Bursts? {
    guard let first = text.first, text.count > 1 else { return nil }
    return Bursts(first: String(first), remainder: String(text.dropFirst()))
  }

  /// Polls `keyboardVisible` until it reports true or `timeout` elapses.
  /// Clock and sleep are injected so the loop is unit-testable.
  static func waitForKeyboard(
    timeout: TimeInterval = keyboardWaitTimeout,
    poll: TimeInterval = keyboardWaitPoll,
    now: () -> TimeInterval,
    sleep: (TimeInterval) -> Void,
    keyboardVisible: () -> Bool
  ) -> (appeared: Bool, waitedMs: Int) {
    let start = now()
    if keyboardVisible() { return (true, 0) }
    while true {
      let remaining = timeout - (now() - start)
      if remaining <= 0 { break }
      // Cap the nap to the remaining budget so the wait never overshoots
      // `timeout` (codex-pair M1).
      sleep(min(poll, remaining))
      if keyboardVisible() {
        return (true, elapsedMs(since: start, now: now))
      }
    }
    return (false, elapsedMs(since: start, now: now))
  }

  private static func elapsedMs(since start: TimeInterval, now: () -> TimeInterval) -> Int {
    return Int(((now() - start) * 1000).rounded())
  }
}
