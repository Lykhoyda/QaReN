import XCTest

final class DispatchGuardTests: XCTestCase {
  func testKeyboardOverPointOccludesWhateverTheHitTestSays() {
    for hittable in [true, false, nil] as [Bool?] {
      XCTAssertEqual(DispatchGuard.decide(liveHittable: hittable, keyboardContainsPoint: true), .occluded)
    }
  }

  func testHitTestDecidesOutsideTheKeyboard() {
    XCTAssertEqual(DispatchGuard.decide(liveHittable: true, keyboardContainsPoint: false), .proceed)
    XCTAssertEqual(DispatchGuard.decide(liveHittable: false, keyboardContainsPoint: false), .occluded)
  }

  func testTapInsideAnAppAlertAnchorsOnTheLiveTargetNotTheFirstWindow() {
    let alert = CGRect(x: 41, y: 375, width: 320, height: 152)
    let discard = CGRect(x: 205, y: 463, width: 140, height: 48)
    let point = CGPoint(x: discard.midX, y: discard.midY)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: discard, alerts: [alert]), .liveTarget)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: nil, alerts: [alert]), .alert(0))
    let behind = CGRect(x: 0, y: 440, width: 402, height: 100)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: behind, alerts: [alert]), .alert(0))
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: nil, alerts: [.zero, alert]), .alert(1))
  }

  func testTapOutsideAnOpenAppAlertIsRefusedAndWithoutOneKeepsTheFirstWindow() {
    let alert = CGRect(x: 41, y: 375, width: 320, height: 152)
    let row = CGRect(x: 0, y: 100, width: 402, height: 44)
    let point = CGPoint(x: row.midX, y: row.midY)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: row, alerts: [alert]), .outsideAlerts)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: row, alerts: []), .firstWindow)
    XCTAssertEqual(DispatchGuard.tapAnchor(point: point, liveTarget: row, alerts: [.zero]), .firstWindow)
  }

  func testUnavailableHitTestProceeds() {
    XCTAssertEqual(DispatchGuard.decide(liveHittable: nil, keyboardContainsPoint: false), .proceed)
  }
  func testResolutionAndReadShareOneDeadline() {
    for (resolutionTime, readTime, expected) in [(0.5, 0.02, nil), (0.2, 0.2, nil), (0.1, 0.02, false)] as [(Double, Double, Bool?)] {
      var time = 0.0
      var reads = 0
      let result = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { time },
        resolve: { time += resolutionTime; return 1 },
        read: { _ in reads += 1; time += readTime; return false }
      )
      XCTAssertEqual(result.hittable, expected)
      XCTAssertEqual(reads, resolutionTime >= 0.3 ? 0 : 1)
      XCTAssertEqual(DispatchGuard.decide(liveHittable: result.hittable, keyboardContainsPoint: false), expected == false ? .occluded : .proceed)
    }
  }

  func testExpiredDeadlineSkipsResolution() {
    var resolutions = 0
    let result = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { 0.5 },
      resolve: { resolutions += 1; return 1 },
      read: { _ in false }
    )
    XCTAssertNil(result.hittable)
    XCTAssertEqual(resolutions, 0)
  }

  func testMovedTargetRefusesWithoutReadingHittabilityOrDispatching() {
    for frameMatches in [false, true] {
      var reads = 0
      var taps = 0
      let check = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { 0.1 },
        resolve: { 1 },
        matchesFrame: { _ in frameMatches },
        read: { _ in reads += 1; return true }
      )
      let decision = DispatchGuard.decide(
        liveHittable: check.hittable,
        keyboardContainsPoint: false,
        targetMoved: check == .moved
      )
      if decision == .proceed { taps += 1 }
      XCTAssertEqual(decision, frameMatches ? .proceed : .moved)
      XCTAssertEqual(taps, frameMatches ? 1 : 0)
      XCTAssertEqual(reads, frameMatches ? 1 : 0)
    }
  }

  func testUnavailableFrameChecksStillProceed() {
    for mode in ["no-match", "ambiguous", "thrown", "over-budget", "generation"] {
      var time = 0.1
      let check = DispatchGuard.hitTest(
        deadline: 0.3,
        now: { time },
        resolve: { mode == "no-match" || mode == "ambiguous" || mode == "generation" ? nil : 1 },
        matchesFrame: { _ in
          if mode == "over-budget" { time = 0.4; return false }
          return nil
        },
        read: { _ in true }
      )
      XCTAssertEqual(check, .unavailable)
      XCTAssertEqual(DispatchGuard.decide(liveHittable: check.hittable, keyboardContainsPoint: false, targetMoved: check == .moved), .proceed)
    }
  }

  func testFillFrameCheckLeavesHittabilityForTheFocusPointCheck() {
    var time = 0.0
    var reads = 0
    let frameOnly = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { time },
      resolve: { time += 0.05; return 1 },
      matchesFrame: { _ in true },
      checkHittability: false,
      read: { _ in reads += 1; time += 0.2; return false }
    )
    XCTAssertEqual(frameOnly, .unavailable)
    XCTAssertEqual(reads, 0)
    time += 0.06
    let focusPoint = DispatchGuard.hitTest(
      deadline: 0.3,
      now: { time },
      resolve: { 1 },
      read: { _ in reads += 1; time += 0.1; return false }
    )
    XCTAssertEqual(reads, 1)
    XCTAssertEqual(DispatchGuard.decide(liveHittable: focusPoint.hittable, keyboardContainsPoint: false), .occluded)
    let moved = DispatchGuard.hitTest(
      deadline: 0.3, now: { 0.1 }, resolve: { 1 },
      matchesFrame: { _ in false }, checkHittability: false,
      read: { _ in XCTFail("frame-only check must not read hittability"); return true }
    )
    XCTAssertEqual(moved, .moved)
  }

  func testFramesAgreeWhenEqualAndRefuseRealMovement() {
    let frame = CGRect(x: 16, y: 742.5, width: 370, height: 48)
    XCTAssertTrue(DispatchGuard.framesAgree(retained: frame, live: frame.offsetBy(dx: 0, dy: 0.5), owner: nil))
    XCTAssertFalse(DispatchGuard.framesAgree(retained: frame, live: frame.offsetBy(dx: 0, dy: 1.5), owner: nil))
  }

  func testALabelAgreesOnlyWithTheControlThatOwnedItInTheSnapshot() {
    let label = CGRect(x: 170.3, y: 806.3, width: 61.7, height: 20)
    let control = CGRect(x: 21, y: 792.3, width: 360, height: 48)
    XCTAssertTrue(DispatchGuard.framesAgree(retained: label, live: control, owner: control))
    XCTAssertFalse(DispatchGuard.framesAgree(retained: label, live: control, owner: nil))
    XCTAssertFalse(
      DispatchGuard.framesAgree(retained: label, live: control.insetBy(dx: -8, dy: -8), owner: control))
    XCTAssertFalse(
      DispatchGuard.framesAgree(retained: label, live: control.offsetBy(dx: 0, dy: 40), owner: control))
    let elsewhere = control.offsetBy(dx: 0, dy: -200)
    XCTAssertFalse(DispatchGuard.framesAgree(retained: label, live: elsewhere, owner: elsewhere))
  }

  func testTheOwnerIsTheNearestSameTypeSameLabelAncestor() {
    // 0 window, 1 row (Other "Continue"), 2 control (Button "Continue"), 3 label (Button "Continue")
    let parent: [Int: Int] = [1: 0, 2: 1, 3: 2]
    let type = [0: "Window", 1: "Other", 2: "Button", 3: "Button"]
    let label: [Int: String] = [1: "Continue", 2: "Continue", 3: "Continue"]
    let owns = { (candidate: Int) in type[candidate] == "Button" && label[candidate] == "Continue" }
    XCTAssertEqual(DispatchGuard.nearestOwner(of: 3, parentOf: { parent[$0] }, owns: owns), 2)
    XCTAssertNil(DispatchGuard.nearestOwner(of: 2, parentOf: { parent[$0] }, owns: { _ in false }))
    let cycle: [Int: Int] = [3: 3]
    XCTAssertNil(DispatchGuard.nearestOwner(of: 3, parentOf: { cycle[$0] }, owns: { _ in false }))
  }

  func testMovedMessageNeverCarriesLabelText() {
    let message = DispatchGuard.movedMessage(
      retained: CGRect(x: 0, y: 0, width: 10, height: 10),
      live: CGRect(x: 0, y: 5, width: 10, height: 10),
      retainedIdentity: .init(type: "Button", label: "4", identifier: nil),
      liveIdentity: .init(type: "Button", label: "4821", identifier: "code-cell")
    )
    XCTAssertFalse(message.contains("4821"), message)
    XCTAssertFalse(message.contains("\"4\""), message)
    XCTAssertTrue(message.contains("(Button, label 1 chars, no id)"), message)
    XCTAssertTrue(message.contains("(Button, label 4 chars, has id)"), message)
    XCTAssertTrue(message.contains("labels differ, ids differ"), message)
    XCTAssertFalse(message.contains("code-cell"), message)
  }

  func testMovedMessageCarriesBothFramesTheDeltaAndTheTolerance() {
    let message = DispatchGuard.movedMessage(
      retained: CGRect(x: 16, y: 742.5, width: 370, height: 48),
      live: CGRect(x: 16, y: 744, width: 370, height: 48),
      retainedIdentity: .init(type: "StaticText", label: "Continue", identifier: nil),
      liveIdentity: .init(type: "Button", label: "Continue", identifier: "footer-cta")
    )
    XCTAssertTrue(message.hasPrefix("TARGET_MOVED_BEFORE_DISPATCH: "), message)
    XCTAssertTrue(message.contains("retained 16.0,742.5,370.0,48.0 (StaticText, label 8 chars, no id)"), message)
    XCTAssertTrue(message.contains("live 16.0,744.0,370.0,48.0 (Button, label 8 chars, has id)"), message)
    XCTAssertTrue(message.contains("labels match, ids differ"), message)
    XCTAssertFalse(message.contains("footer-cta"), message)
    XCTAssertFalse(message.contains("Continue"), message)
    XCTAssertTrue(message.contains("delta 0.0,1.5,0.0,0.0"), message)
    XCTAssertTrue(message.contains("tolerance 1.0"), message)
    XCTAssertTrue(message.contains("no tap or typing was performed"), message)
  }
}
