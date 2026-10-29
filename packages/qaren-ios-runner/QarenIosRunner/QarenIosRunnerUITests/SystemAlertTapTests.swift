import XCTest

final class SystemAlertTapTests: XCTestCase {
  func testResolvesOnlyAnExactUniqueLabel() {
    let buttons = ["Don\u{2019}t Allow", "Allow"]
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "Don\u{2019}t Allow"), .button(index: 0))
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "Allow"), .button(index: 1))
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "Don't Allow"), .notFound)
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "allow"), .notFound)
  }

  func testThreeButtonPromptsNeverMatchByPrefix() {
    let buttons = ["Allow Once", "Allow While Using App", "Don\u{2019}t Allow"]
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "Allow"), .notFound)
    XCTAssertEqual(SystemAlertTap.resolve(labels: buttons, chosen: "Allow Once"), .button(index: 0))
  }

  func testDuplicateLabelsRefuse() {
    XCTAssertEqual(SystemAlertTap.resolve(labels: ["OK", "OK"], chosen: "OK"), .ambiguous(count: 2))
  }

  func testTheTappedAlertIsClosedOnlyWhenASuccessfulReadFindsItNowhere() {
    let tapped = SystemAlertTap.Signature(title: "Notifications", buttons: ["Don\u{2019}t Allow", "Allow"])
    let next = SystemAlertTap.Signature(title: "Location", buttons: ["Allow Once", "Don\u{2019}t Allow"])
    XCTAssertTrue(SystemAlertTap.closed(tapped: tapped, observed: .modals([])))
    XCTAssertTrue(SystemAlertTap.closed(tapped: tapped, observed: .modals([next])))
    XCTAssertFalse(SystemAlertTap.closed(tapped: tapped, observed: .modals([tapped])))
    XCTAssertFalse(SystemAlertTap.closed(tapped: tapped, observed: .modals([next, tapped])))
    XCTAssertFalse(SystemAlertTap.closed(tapped: tapped, observed: .unreadable))
  }
}

final class SystemModalDiagnosticTests: XCTestCase {
  func testUnrecognisedModalEmitsOnlyStructuralFacts() throws {
    let record = SystemModalDiagnostic.make(
      recognized: false, appState: .runningForeground, alertCount: 1, sheetCount: 0,
      modals: [.init(exists: true, frameEmpty: false, centerInViewport: true,
        springboardFrameEmpty: false, descendantTypes: [.init(type: 9, count: 2)],
        hittableDescendantCount: 0)]
    )
    let encoded = try XCTUnwrap(record).encodedForTest()
    XCTAssertEqual(encoded["appState"] as? String, "runningForeground")
    XCTAssertEqual(encoded["alertCount"] as? Int, 1)
    XCTAssertEqual(Set(encoded.keys), Set(["appState", "alertCount", "sheetCount", "modals"]))
  }

  func testRecognisedOrAbsentModalEmitsNothing() {
    XCTAssertNil(SystemModalDiagnostic.make(recognized: true, appState: .runningForeground,
      alertCount: 1, sheetCount: 0, modals: []))
    XCTAssertNil(SystemModalDiagnostic.make(recognized: false, appState: .runningForeground,
      alertCount: 0, sheetCount: 0, modals: []))
  }
}

private extension SystemModalDiagnostic {
  func encodedForTest() throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any])
  }
}
