import CoreGraphics
import Foundation

// Occlusion is decided at dispatch by the live accessibility hit test of the one target.
enum DispatchGuard {
  enum TargetCheck: Equatable {
    case unavailable
    case moved
    case hittable(Bool)

    var hittable: Bool? {
      if case .hittable(let value) = self { return value }
      return nil
    }
  }

  static func hitTest<T>(
    deadline: Double,
    now: () -> Double,
    resolve: () -> T?,
    matchesFrame: (T) -> Bool? = { _ in true },
    checkHittability: Bool = true,
    read: (T) -> Bool?
  ) -> TargetCheck {
    guard now() < deadline, let target = resolve(), now() < deadline,
          let sameFrame = matchesFrame(target), now() <= deadline else { return .unavailable }
    if !sameFrame { return .moved }
    if !checkHittability { return .unavailable }
    let result = read(target)
    guard now() <= deadline, let result else { return .unavailable }
    return .hittable(result)
  }

  enum Decision: Equatable {
    case proceed
    case occluded
    case moved
  }

  // Proven frame movement refuses even when hittability is unavailable.
  static func decide(liveHittable: Bool?, keyboardContainsPoint: Bool, targetMoved: Bool = false) -> Decision {
    if targetMoved { return .moved }
    return keyboardContainsPoint || liveHittable == false ? .occluded : .proceed
  }

  enum TapAnchor: Equatable {
    case firstWindow
    case liveTarget
    case alert(Int)
    case outsideAlerts
  }

  // XCTest treats an app alert as an interruption unless the gesture is anchored inside it.
  static func tapAnchor(point: CGPoint, liveTarget: CGRect?, alerts: [CGRect]) -> TapAnchor {
    let visible = alerts.indices.filter { !alerts[$0].isEmpty }
    guard !visible.isEmpty else { return .firstWindow }
    let containing = visible.filter { alerts[$0].contains(point) }
    guard let topmost = containing.last else { return .outsideAlerts }
    if let liveTarget, liveTarget.contains(point), containing.contains(where: { alerts[$0].contains(liveTarget) }) {
      return .liveTarget
    }
    return .alert(topmost)
  }

  struct NodeIdentity {
    let type: String
    let label: String?
    let identifier: String?
  }

  // A label-only target retained as the label inside its control may resolve live to that control;
  // it agrees only when the live frame is the frame the owning control had in the same snapshot.
  static func framesAgree(retained: CGRect, live: CGRect, owner: CGRect?, tolerance: CGFloat = 1.0) -> Bool {
    func equal(_ a: CGRect, _ b: CGRect) -> Bool {
      abs(a.minX - b.minX) <= tolerance && abs(a.minY - b.minY) <= tolerance
        && abs(a.width - b.width) <= tolerance && abs(a.height - b.height) <= tolerance
    }
    if equal(retained, live) { return true }
    guard let owner, owner.insetBy(dx: -tolerance, dy: -tolerance).contains(retained) else { return false }
    return equal(owner, live)
  }

  // The nearest ancestor that owns the node's label (same type and label), bounded against cycles.
  static func nearestOwner(of index: Int, parentOf: (Int) -> Int?, owns: (Int) -> Bool, maxHops: Int = 64) -> Int? {
    var current = parentOf(index)
    var hops = 0
    while let candidate = current, candidate != index, hops < maxHops {
      if owns(candidate) { return candidate }
      current = parentOf(candidate)
      hops += 1
    }
    return nil
  }

  // Geometry and identity shape of both elements; label and identifier text never leave the runner (either can carry typed values).
  static func movedMessage(
    retained: CGRect,
    live: CGRect,
    retainedIdentity: NodeIdentity? = nil,
    liveIdentity: NodeIdentity? = nil,
    tolerance: CGFloat = 1.0
  ) -> String {
    func components(_ values: [CGFloat]) -> String {
      values.map { String(format: "%.1f", Double($0)) }.joined(separator: ",")
    }
    func describe(_ frame: CGRect, _ identity: NodeIdentity?) -> String {
      let geometry = components([frame.minX, frame.minY, frame.width, frame.height])
      guard let identity else { return geometry }
      let label = identity.label.map { "label \($0.count) chars" } ?? "no label"
      let id = identity.identifier == nil ? "no id" : "has id"
      return "\(geometry) (\(identity.type), \(label), \(id))"
    }
    let delta = [
      live.minX - retained.minX, live.minY - retained.minY,
      live.width - retained.width, live.height - retained.height,
    ]
    let labels = retainedIdentity != nil && liveIdentity != nil
      ? "; labels \(retainedIdentity?.label == liveIdentity?.label ? "match" : "differ")"
        + ", ids \(retainedIdentity?.identifier == liveIdentity?.identifier ? "match" : "differ")"
      : ""
    return "TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch "
      + "(retained \(describe(retained, retainedIdentity)); "
      + "live \(describe(live, liveIdentity))\(labels); "
      + "delta \(components(delta)); tolerance \(components([tolerance]))); "
      + "no tap or typing was performed. Refresh the snapshot and retry."
  }
}
