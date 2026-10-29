import Foundation

// Pure decisions for tapping one SpringBoard alert button by its exact label.
enum SystemAlertTap {
  enum Resolution: Equatable {
    case button(index: Int)
    case notFound
    case ambiguous(count: Int)
  }

  struct Signature: Equatable {
    let title: String
    let buttons: [String]
  }

  static func resolve(labels: [String], chosen: String) -> Resolution {
    let matches = labels.indices.filter { labels[$0] == chosen }
    if matches.count > 1 { return .ambiguous(count: matches.count) }
    guard let index = matches.first else { return .notFound }
    return .button(index: index)
  }

  // Every SpringBoard alert and sheet as one successful read; a failed read never confirms anything.
  enum Observation: Equatable {
    case unreadable
    case modals([Signature])
  }

  static func closed(tapped: Signature, observed: Observation) -> Bool {
    guard case .modals(let modals) = observed else { return false }
    return !modals.contains(tapped)
  }
}
