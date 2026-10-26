import XCTest

// GH #395: hittable = enabled ∧ non-empty frame ∧ center-in-viewport. These
// pure-logic tests pin the predicate the snapshot path emits per node.
final class SnapshotPredicatesTests: XCTestCase {
  private let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)

  func testEnabledOnScreenIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testDisabledIsNotHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertFalse(computeSnapshotHittable(enabled: false, frame: frame, viewport: viewport))
  }

  func testEmptyFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .zero, viewport: viewport))
  }

  func testNullFrameIsNotHittable() {
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: .null, viewport: viewport))
  }

  // The wizard step-2 pane sits at x=402..804 on a 402pt-wide viewport —
  // off-screen center must stay false (device-verified useful signal).
  func testCenterOutsideViewportIsNotHittable() {
    let frame = CGRect(x: 423, y: 290, width: 60, height: 39)
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testInfiniteViewportFallbackIsHittable() {
    let frame = CGRect(x: 21, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: .infinite))
  }

  // Half-open viewport bounds [min, max): a center exactly on the max edge
  // taps outside the screen, so it is deterministically not hittable.
  func testCenterOnViewportMaxEdgeIsNotHittable() {
    let frame = CGRect(x: 302, y: 791, width: 200, height: 49)
    XCTAssertFalse(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }

  func testCenterOnViewportMinEdgeIsHittable() {
    let frame = CGRect(x: -180, y: 790, width: 360, height: 49)
    XCTAssertTrue(computeSnapshotHittable(enabled: true, frame: frame, viewport: viewport))
  }
}

// GH #395: filtering is hittable-independent by signature — these pin the
// de-facto content/type-based rules that always-false hittable produced.
final class SnapshotInclusionTests: XCTestCase {
  private func include(
    type: XCUIElement.ElementType = .other,
    hasContent: Bool = false,
    isScrollableContainer: Bool = false,
    isInteractiveType: Bool = false,
    visible: Bool = true,
    compact: Bool = false,
    interactiveOnly: Bool = false
  ) -> Bool {
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: hasContent,
      isScrollableContainer: isScrollableContainer,
      isInteractiveType: isInteractiveType,
      visible: visible,
      compact: compact,
      interactiveOnly: interactiveOnly
    )
  }

  func testDefaultModeIncludesEverything() {
    XCTAssertTrue(include())
    XCTAssertTrue(include(type: .staticText, hasContent: false))
  }

  func testCompactExcludesContentlessOther() {
    XCTAssertFalse(include(compact: true))
  }

  func testCompactIncludesContentfulNodes() {
    XCTAssertTrue(include(hasContent: true, compact: true))
    XCTAssertTrue(include(type: .staticText, hasContent: true, compact: true))
  }

  func testCompactExcludesContentlessTypedNodes() {
    XCTAssertFalse(include(type: .image, compact: true))
  }

  func testInteractiveOnlyIncludesScrollableContainers() {
    XCTAssertTrue(include(type: .scrollView, isScrollableContainer: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesInteractiveTypes() {
    XCTAssertTrue(include(type: .button, isInteractiveType: true, interactiveOnly: true))
  }

  func testInteractiveOnlyIncludesContentfulNodes() {
    XCTAssertTrue(include(type: .staticText, hasContent: true, interactiveOnly: true))
  }

  // QA capture measures the visible screen against the window frame, so the content-less window stays.
  func testInteractiveOnlyKeepsContentlessWindow() {
    XCTAssertTrue(include(type: .window, interactiveOnly: true))
  }

  func testInteractiveOnlyExcludesContentlessNonInteractive() {
    XCTAssertFalse(include(type: .image, interactiveOnly: true))
    XCTAssertFalse(include(interactiveOnly: true))
  }

  func testDedupeKeyKeepsTwinFieldsWithDifferentValues() {
    let frame = CGRect(x: 10, y: 100, width: 300, height: 44)
    let first = snapshotDedupeKey(
      type: .textField, label: "Email", identifier: "email", value: "first@example.test", frame: frame)
    let second = snapshotDedupeKey(
      type: .textField, label: "Email", identifier: "email", value: "second@example.test", frame: frame)
    XCTAssertNotEqual(first, second)
  }

  func testDedupeKeyKeepsFieldsWithDelimiterCollisions() {
    let frame = CGRect(x: 10, y: 100, width: 300, height: 44)
    let first = snapshotDedupeKey(
      type: .textField, label: "Email", identifier: "otp", value: "prefix-654321", frame: frame)
    let second = snapshotDedupeKey(
      type: .textField, label: "Email", identifier: "otp-prefix", value: "654321", frame: frame)
    XCTAssertNotEqual(first, second)
    XCTAssertEqual(Set([first, second]).count, 2)
  }

  func testDedupeKeyStillCollapsesIdenticalNodes() {
    let frame = CGRect(x: 10, y: 100, width: 300, height: 44)
    XCTAssertEqual(
      snapshotDedupeKey(type: .textField, label: "Email", identifier: "email", value: "same", frame: frame),
      snapshotDedupeKey(type: .textField, label: "Email", identifier: "email", value: "same", frame: frame))
    XCTAssertEqual(
      snapshotDedupeKey(type: .staticText, label: "Title", identifier: "", value: nil, frame: frame),
      snapshotDedupeKey(type: .staticText, label: "Title", identifier: "", value: nil, frame: frame))
  }

  func testDedupeKeyKeepsNestedSameOriginScrollViewsOfDifferentSizes() {
    let outer = snapshotDedupeKey(
      type: .scrollView, label: "", identifier: "", value: nil,
      frame: CGRect(x: 0, y: 100, width: 402, height: 700))
    let inner = snapshotDedupeKey(
      type: .scrollView, label: "", identifier: "", value: nil,
      frame: CGRect(x: 0, y: 100, width: 402, height: 200))
    XCTAssertNotEqual(outer, inner)
    XCTAssertNotEqual(
      outer,
      snapshotDedupeKey(
        type: .scrollView, label: "", identifier: "", value: nil,
        frame: CGRect(x: 0, y: 100, width: 300, height: 700)))
  }

  func testToolbarIsNamedToolbarNotSearchField() {
    XCTAssertEqual(snapshotTypeName(.toolbar), "Toolbar")
    XCTAssertEqual(snapshotTypeName(XCUIElement.ElementType(rawValue: 24)!), "Toolbar")
    XCTAssertEqual(snapshotTypeName(.searchField), "SearchField")
    XCTAssertFalse(TextInputTarget.inputTypeNames.contains(snapshotTypeName(.toolbar)))
  }

  func testKeyboardRawTypesKeepTheirNames() {
    XCTAssertEqual(snapshotTypeName(XCUIElement.ElementType(rawValue: 19)!), "Keyboard")
    XCTAssertEqual(snapshotTypeName(XCUIElement.ElementType(rawValue: 20)!), "Key")
  }
}

final class SnapshotDiagnosticsTests: XCTestCase {
  func testViewportEncodingPreservesSourceAndActualRoundedFrame() throws {
    let diagnostic = SnapshotDiagnostics(
      viewport: CGRect(x: -12.4, y: 31.6, width: 123, height: 456),
      source: .firstNonemptyWindow
    )
    let encoded = try JSONEncoder().encode(diagnostic)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertEqual(object["v"] as? Int, 1)
    XCTAssertEqual(object["viewportSource"] as? String, "first-nonempty-window")
    XCTAssertEqual(object["viewport"] as? [Double], [-12, 32, 123, 456])
  }

  func testUnboundedIsExplicitNullAndMissingIsOmitted() throws {
    let diagnostic = SnapshotDiagnostics(viewport: .infinite, source: .unbounded)
    let encoded = try JSONEncoder().encode(diagnostic)
    let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
    XCTAssertTrue(object["viewport"] is NSNull)
    XCTAssertEqual(object["viewportSource"] as? String, "unbounded")
    let missing = try JSONSerialization.jsonObject(with: JSONEncoder().encode(DataPayload())) as? [String: Any]
    XCTAssertNil(missing?["snapshotDiagnostics"])
    XCTAssertNil(SnapshotDiagnostics(viewport: .null, source: .app))
  }
}
