import CoreGraphics
import Foundation

// GH #581: pure exact text-input resolution/classification (KeyboardGuard
// pattern — XCUI-free so the unit suite covers it directly).
enum TextInputTarget {
  static let inputTypeNames: Set<String> = [
    "TextField", "SecureTextField", "SearchField", "TextView",
  ]

  struct CandidateAttributes {
    let type: String
    let identifier: String?
    let label: String?
    let frame: CGRect
  }

  enum Resolution: Equatable {
    case unique(Int)
    case ambiguous
    case absent
  }

  static func isInputTypeName(_ type: String?) -> Bool {
    guard let type else { return false }
    return inputTypeNames.contains(type)
  }

  static func framesMatch(_ a: CGRect, _ b: CGRect, tolerance: CGFloat = 3) -> Bool {
    abs(a.midX - b.midX) <= tolerance && abs(a.midY - b.midY) <= tolerance
      && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
  }

  // Duplicate identifiers are ambiguous across ALL candidates; identifier-less
  // descriptors bind same-generation only, by unique label or frame-equality.
  static func resolve(
    candidates: [CandidateAttributes],
    descriptorType: String,
    descriptorIdentifier: String?,
    descriptorLabel: String?,
    descriptorRect: CGRect,
    sameGeneration: Bool,
    requireFrameMatch: Bool = false
  ) -> Resolution {
    if let id = descriptorIdentifier, !id.isEmpty {
      let byId = candidates.enumerated().filter { $0.element.identifier == id }
      if byId.count > 1 { return .ambiguous }
      guard let match = byId.first else { return .absent }
      guard match.element.type == descriptorType else { return .absent }
      if requireFrameMatch && !framesMatch(match.element.frame, descriptorRect) {
        return .absent
      }
      return .unique(match.offset)
    }
    guard sameGeneration else { return .absent }
    let typed = candidates.enumerated().filter { $0.element.type == descriptorType }
    if typed.isEmpty { return .absent }
    if let label = descriptorLabel, !label.isEmpty {
      let byLabel = typed.filter { $0.element.label == label }
      if byLabel.count == 1 {
        if requireFrameMatch && !framesMatch(byLabel[0].element.frame, descriptorRect) {
          return .absent
        }
        return .unique(byLabel[0].offset)
      }
      return byLabel.count > 1 ? .ambiguous : .absent
    }
    let byFrame = typed.filter { framesMatch($0.element.frame, descriptorRect) }
    if byFrame.count == 1 { return .unique(byFrame[0].offset) }
    return byFrame.isEmpty ? .absent : .ambiguous
  }

  // verifyInput re-establishment against live attributes recorded at type time
  // (post-keyboard frames); duplicate identifiers stay ambiguous here too.
  static func resolveByRecordedAttributes(
    candidates: [CandidateAttributes],
    recorded: CandidateAttributes
  ) -> Resolution {
    if let id = recorded.identifier, !id.isEmpty {
      let byId = candidates.enumerated().filter { $0.element.identifier == id }
      if byId.count > 1 { return .ambiguous }
      guard let match = byId.first else { return .absent }
      return match.element.type == recorded.type ? .unique(match.offset) : .absent
    }
    let matches = candidates.enumerated().filter {
      $0.element.identifier == nil
        && $0.element.type == recorded.type
        && $0.element.label == recorded.label
        && framesMatch($0.element.frame, recorded.frame)
    }
    if matches.count == 1 { return .unique(matches[0].offset) }
    return matches.isEmpty ? .absent : .ambiguous
  }

  static func recordedRequestAgrees(
    recorded: CandidateAttributes,
    recordedGeneration: Int,
    recordedNodeIndex: Int?,
    descriptorType: String,
    descriptorIdentifier: String?,
    descriptorGeneration: Int?,
    requestedNodeIndex: Int?
  ) -> Bool {
    guard let descriptorGeneration, let recordedNodeIndex, let requestedNodeIndex else { return false }
    return recorded.type == descriptorType
      && recorded.identifier == descriptorIdentifier
      && recordedGeneration == descriptorGeneration
      && recordedNodeIndex == requestedNodeIndex
  }

  enum VerifyVerdict: String {
    case exact
    case mismatch
    case caseNormalized = "case-normalized"
    case unreadable
    case secureMasked = "secure-masked"
    case targetLost = "target-lost"
    case ambiguous
  }

  struct VerifyObservation: Equatable {
    let rawValue: String?
    let placeholder: String?
    let verdict: VerifyVerdict
  }

  static func classifyValue(
    expected: String,
    rawValue: String?,
    placeholder: String?,
    isSecure: Bool
  ) -> VerifyVerdict {
    guard let rawValue else { return .unreadable }
    let placeholderEqual =
      placeholder != nil && !placeholder!.isEmpty && rawValue == placeholder
    if isSecure {
      if expected.isEmpty {
        if rawValue.isEmpty { return .exact }
        return placeholderEqual ? .ambiguous : .mismatch
      }
      // An empty or placeholder read, or a mask of another length, proves the value did not land.
      if rawValue.isEmpty || placeholderEqual { return .mismatch }
      let maskedLength = rawValue.allSatisfy { $0 == "\u{2022}" }
      return maskedLength && rawValue.count != expected.count && rawValue.count != expected.utf16.count
        ? .mismatch : .secureMasked
    }
    if expected.isEmpty {
      if rawValue.isEmpty { return .exact }
      return placeholderEqual ? .ambiguous : .mismatch
    }
    // A placeholder read cannot prove a typed value, even one equal to the placeholder.
    if rawValue == expected {
      return placeholderEqual ? .mismatch : .exact
    }
    // The app changed only letter case (same length, case-insensitively equal); a different letter is a mismatch.
    if !placeholderEqual,
       rawValue.count == expected.count,
       rawValue.lowercased() == expected.lowercased() {
      return .caseNormalized
    }
    return .mismatch
  }

  static func verifyObservation(
    expected: String,
    rawValue: String?,
    placeholder: String?,
    isSecure: Bool
  ) -> VerifyObservation {
    VerifyObservation(
      rawValue: rawValue,
      placeholder: placeholder,
      verdict: classifyValue(
        expected: expected,
        rawValue: rawValue,
        placeholder: placeholder,
        isSecure: isSecure
      )
    )
  }
}
