import XCTest

final class QuiescenceBypassTests: XCTestCase {
  // MARK: - Probe decision (pure)

  func testDecideProbePrefersClassicWhenBothExist() {
    XCTAssertEqual(RNQuiescenceDecideProbe(true, true), .classic)
  }

  func testDecideProbeFallsBackToPreEvent() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, true), .preEvent)
  }

  func testDecideProbeUnavailableWhenNeitherExists() {
    XCTAssertEqual(RNQuiescenceDecideProbe(false, false), .unavailable)
  }

  // MARK: - Env parse (pure)

  func testParseBypassDefaultsOnWhenAbsent() {
    XCTAssertTrue(RNQuiescenceParseBypass(nil))
  }

  func testParseBypassStaysOnForOtherValues() {
    XCTAssertTrue(RNQuiescenceParseBypass("1"))
    XCTAssertTrue(RNQuiescenceParseBypass("true"))
    XCTAssertTrue(RNQuiescenceParseBypass("unexpected"))
  }

  func testParseBypassOptOut() {
    XCTAssertFalse(RNQuiescenceParseBypass("0"))
    XCTAssertFalse(RNQuiescenceParseBypass("false"))
    XCTAssertFalse(RNQuiescenceParseBypass(" FALSE "))
  }

  // MARK: - Live probe (drift detector)

  func testProbeResolvedAtBundleLoad() {
    // +load ran when this test bundle loaded. On every Xcode/iOS we support,
    // one of the two private selectors must resolve — if this fails, Apple
    // renamed the API and the bypass silently degraded (spec: degrade loudly).
    XCTAssertNotEqual(RNQuiescenceGetProbeResult(), .unavailable)
  }

  // MARK: - Status resolution (Task 2)

  func testResolveStatusActive() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .classic, bypassEnabled: true), .active)
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .preEvent, bypassEnabled: true), .active)
  }

  func testResolveStatusDisabledWhenOptedOut() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .classic, bypassEnabled: false), .disabled)
  }

  func testResolveStatusUnavailableTrumpsBypass() {
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .unavailable, bypassEnabled: true), .unavailable)
    XCTAssertEqual(QuiescenceStatus.resolve(probe: .unavailable, bypassEnabled: false), .unavailable)
  }

  func testStartupMarkers() {
    XCTAssertEqual(QuiescenceStatus.active.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE")
    XCTAssertEqual(QuiescenceStatus.disabled.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED")
    XCTAssertEqual(QuiescenceStatus.unavailable.startupMarker, "RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE")
  }

  func testCapabilitiesOnlyWhenActive() {
    XCTAssertEqual(QuiescenceStatus.active.capabilities, ["QUIESCENCE_BYPASS"])
    XCTAssertEqual(QuiescenceStatus.disabled.capabilities, [])
    XCTAssertEqual(QuiescenceStatus.unavailable.capabilities, [])
  }
}
