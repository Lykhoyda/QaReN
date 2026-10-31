import XCTest

// GH #581: pure-logic coverage for exact text-input resolution and the
// secret-free verify classifier.
final class TextInputTargetTests: XCTestCase {
  private func candidate(
    type: String = "TextField",
    identifier: String? = nil,
    label: String? = nil,
    frame: CGRect = CGRect(x: 0, y: 100, width: 300, height: 44)
  ) -> TextInputTarget.CandidateAttributes {
    TextInputTarget.CandidateAttributes(
      type: type, identifier: identifier, label: label, frame: frame
    )
  }

  private let rect = CGRect(x: 0, y: 100, width: 300, height: 44)

  func testUniqueIdentifierBinds() {
    let result = TextInputTarget.resolve(
      candidates: [candidate(identifier: "email"), candidate(identifier: "password", frame: CGRect(x: 0, y: 200, width: 300, height: 44))],
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .unique(0))
  }

  func testDuplicateIdentifiersAreAmbiguousEvenAcrossTypes() {
    let result = TextInputTarget.resolve(
      candidates: [candidate(identifier: "dob"), candidate(type: "TextView", identifier: "dob")],
      descriptorType: "TextField",
      descriptorIdentifier: "dob",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .ambiguous)
  }

  func testIdentifierMatchWithWrongTypeIsAbsent() {
    let result = TextInputTarget.resolve(
      candidates: [candidate(type: "TextView", identifier: "notes")],
      descriptorType: "TextField",
      descriptorIdentifier: "notes",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .absent)
  }

  func testVerificationIdentifierRequiresDescriptorFrame() {
    let moved = TextInputTarget.resolve(
      candidates: [
        candidate(identifier: "email", frame: CGRect(x: 0, y: 400, width: 300, height: 44))
      ],
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true,
      requireFrameMatch: true
    )
    let same = TextInputTarget.resolve(
      candidates: [candidate(identifier: "email", frame: rect)],
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true,
      requireFrameMatch: true
    )
    XCTAssertEqual(moved, .absent)
    XCTAssertEqual(same, .unique(0))
  }

  func testRequiredLabelFrameRejectsMovedReplacement() {
    let result = TextInputTarget.resolve(
      candidates: [
        candidate(label: "Email", frame: CGRect(x: 0, y: 400, width: 300, height: 44))
      ],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: "Email",
      descriptorRect: rect,
      sameGeneration: true,
      requireFrameMatch: true
    )
    XCTAssertEqual(result, .absent)
  }

  func testSoleSameTypeFieldDoesNotBindWithoutIdentityProof() {
    // An old Email descriptor must not rebind to the lone remaining field
    // whose frame moved elsewhere.
    let result = TextInputTarget.resolve(
      candidates: [candidate(frame: CGRect(x: 0, y: 400, width: 300, height: 44))],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .absent)
  }

  func testIdentifierLessBindsByFrameEqualityWithinGeneration() {
    let result = TextInputTarget.resolve(
      candidates: [
        candidate(frame: rect),
        candidate(frame: CGRect(x: 0, y: 200, width: 300, height: 44)),
      ],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .unique(0))
  }

  func testCrossGenerationRequiresIdentifier() {
    let byFrame = TextInputTarget.resolve(
      candidates: [candidate(frame: rect)],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: false
    )
    XCTAssertEqual(byFrame, .absent)
    let byId = TextInputTarget.resolve(
      candidates: [candidate(identifier: "email")],
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorLabel: nil,
      descriptorRect: rect,
      sameGeneration: false
    )
    XCTAssertEqual(byId, .unique(0))
  }

  func testDuplicateLabelsAreAmbiguous() {
    let result = TextInputTarget.resolve(
      candidates: [
        candidate(label: "Email", frame: CGRect(x: 0, y: 500, width: 300, height: 44)),
        candidate(label: "Email", frame: CGRect(x: 0, y: 560, width: 300, height: 44)),
      ],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: "Email",
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .ambiguous)
  }

  func testLabelTierRequiresUniqueMatch() {
    let result = TextInputTarget.resolve(
      candidates: [
        candidate(label: "Email", frame: CGRect(x: 0, y: 500, width: 300, height: 44)),
        candidate(label: "Password", frame: CGRect(x: 0, y: 560, width: 300, height: 44)),
      ],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: "Email",
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(result, .unique(0))
    let contradicted = TextInputTarget.resolve(
      candidates: [candidate(label: "Password", frame: rect)],
      descriptorType: "TextField",
      descriptorIdentifier: nil,
      descriptorLabel: "Email",
      descriptorRect: rect,
      sameGeneration: true
    )
    XCTAssertEqual(contradicted, .absent)
  }

  func testRecordedAttributesEnforceIdentifierCardinality() {
    let recorded = candidate(identifier: "email")
    let duplicated = TextInputTarget.resolveByRecordedAttributes(
      candidates: [candidate(identifier: "email"), candidate(type: "TextView", identifier: "email")],
      recorded: recorded
    )
    XCTAssertEqual(duplicated, .ambiguous)
    let unique = TextInputTarget.resolveByRecordedAttributes(
      candidates: [candidate(identifier: "email")],
      recorded: recorded
    )
    XCTAssertEqual(unique, .unique(0))
  }

  func testRecordedIdentifierLessRequiresFullAgreement() {
    let recorded = candidate(label: "Notes", frame: rect)
    let moved = TextInputTarget.resolveByRecordedAttributes(
      candidates: [candidate(label: "Notes", frame: CGRect(x: 0, y: 400, width: 300, height: 44))],
      recorded: recorded
    )
    XCTAssertEqual(moved, .absent)
    let same = TextInputTarget.resolveByRecordedAttributes(
      candidates: [candidate(label: "Notes", frame: rect)],
      recorded: recorded
    )
    XCTAssertEqual(same, .unique(0))
  }

  func testRecordedRequestRequiresExactNodeAndDescriptorAgreement() {
    let recorded = candidate(identifier: "email")
    XCTAssertTrue(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: 12,
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorGeneration: 7,
      requestedNodeIndex: 12
    ))
    XCTAssertFalse(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: nil,
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorGeneration: 7,
      requestedNodeIndex: 12
    ))
    XCTAssertFalse(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: 12,
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorGeneration: 7,
      requestedNodeIndex: nil
    ))
    XCTAssertFalse(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: 12,
      descriptorType: "TextView",
      descriptorIdentifier: "email",
      descriptorGeneration: 7,
      requestedNodeIndex: 12
    ))
    XCTAssertFalse(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: 12,
      descriptorType: "TextField",
      descriptorIdentifier: "other",
      descriptorGeneration: 7,
      requestedNodeIndex: 12
    ))
    XCTAssertFalse(TextInputTarget.recordedRequestAgrees(
      recorded: recorded,
      recordedGeneration: 7,
      recordedNodeIndex: 12,
      descriptorType: "TextField",
      descriptorIdentifier: "email",
      descriptorGeneration: 8,
      requestedNodeIndex: 12
    ))
  }

  func testClassifyExactAndMismatch() {
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "hello", rawValue: "hello", placeholder: nil, isSecure: false),
      .exact
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "hello", rawValue: "world", placeholder: nil, isSecure: false),
      .mismatch
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "hello", rawValue: nil, placeholder: nil, isSecure: false),
      .unreadable
    )
  }

  // A field that only changed letter case is reported as such, never as exact and never as a mismatch.
  func testCaseOnlyDifferenceIsCaseNormalized() {
    let classify = { (raw: String, placeholder: String?) in
      TextInputTarget.classifyValue(expected: "Hello Ada", rawValue: raw, placeholder: placeholder, isSecure: false)
    }
    XCTAssertEqual(classify("HELLO ADA", nil), .caseNormalized)
    XCTAssertEqual(classify("hello ada", nil), .caseNormalized)
    XCTAssertEqual(classify("HELLO ADX", nil), .mismatch)
    XCTAssertEqual(classify("HELLO AD", nil), .mismatch)
    XCTAssertEqual(classify("HELLO ADA", "HELLO ADA"), .mismatch)
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "stra\u{00DF}e", rawValue: "STRASSE", placeholder: nil, isSecure: false),
      .mismatch
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "Hello", rawValue: "HELLO", placeholder: nil, isSecure: true),
      .secureMasked
    )
  }

  func testSecureFieldsNeverProveContent() {
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "value-a", rawValue: "•••••••", placeholder: nil, isSecure: true),
      .secureMasked
    )
    // Even a coincidentally equal read is masked, not proof.
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "•••••••", rawValue: "•••••••", placeholder: nil, isSecure: true),
      .secureMasked
    )
  }

  func testSecureReadsThatProveTheValueDidNotLand() {
    for raw in ["", "Password"] {
      XCTAssertEqual(
        TextInputTarget.classifyValue(expected: "value-a", rawValue: raw, placeholder: "Password", isSecure: true),
        .mismatch,
        raw
      )
    }
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "value-a", rawValue: "•••", placeholder: nil, isSecure: true),
      .mismatch
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "pässwörd👍🏽", rawValue: "••••", placeholder: nil, isSecure: true),
      .mismatch
    )
  }

  func testUnicodeMaskLengthsMustMatchAPlausibleRepresentation() {
    for length in [4, 5, 6, 7] {
      XCTAssertEqual(
        TextInputTarget.classifyValue(expected: "pass👍", rawValue: String(repeating: "•", count: length), placeholder: nil, isSecure: true),
        length == 5 || length == 6 ? .secureMasked : .mismatch
      )
    }
  }

  func testEmptyClearVerification() {
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "", rawValue: "", placeholder: nil, isSecure: false),
      .exact
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "", rawValue: "leftover", placeholder: nil, isSecure: false),
      .mismatch
    )
    // A placeholder-equal read cannot distinguish empty from text==placeholder.
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "", rawValue: "Enter name", placeholder: "Enter name", isSecure: false),
      .ambiguous
    )
    XCTAssertEqual(
      TextInputTarget.classifyValue(expected: "", rawValue: "", placeholder: "Enter name", isSecure: true),
      .exact
    )
  }

  func testPlaceholderOrEmptyReadNeverProvesATypedValue() {
    for raw in ["Enter name", ""] {
      XCTAssertEqual(
        TextInputTarget.classifyValue(expected: "Enter name", rawValue: raw, placeholder: "Enter name", isSecure: false),
        .mismatch,
        raw
      )
    }
  }

  func testVerifyObservationIncludesPlaceholderAndVerdict() {
    let ambiguous = TextInputTarget.verifyObservation(
      expected: "Search",
      rawValue: "Search",
      placeholder: "Search",
      isSecure: false
    )
    let exact = TextInputTarget.verifyObservation(
      expected: "Search",
      rawValue: "Search",
      placeholder: nil,
      isSecure: false
    )
    XCTAssertNotEqual(ambiguous, exact)
    XCTAssertEqual(exact, TextInputTarget.verifyObservation(
      expected: "Search",
      rawValue: "Search",
      placeholder: nil,
      isSecure: false
    ))
  }

  func testInputTypeRecognition() {
    XCTAssertTrue(TextInputTarget.isInputTypeName("TextField"))
    XCTAssertTrue(TextInputTarget.isInputTypeName("TextView"))
    XCTAssertTrue(TextInputTarget.isInputTypeName("SearchField"))
    XCTAssertTrue(TextInputTarget.isInputTypeName("SecureTextField"))
    XCTAssertFalse(TextInputTarget.isInputTypeName("Button"))
    XCTAssertFalse(TextInputTarget.isInputTypeName("Other"))
    XCTAssertFalse(TextInputTarget.isInputTypeName(nil))
  }
}
