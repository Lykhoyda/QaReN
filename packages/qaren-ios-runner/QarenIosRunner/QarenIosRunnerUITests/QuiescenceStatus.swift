import Foundation

// GH #384 (Story 03): resolved quiescence-bypass state for this runner process.
enum QuiescenceStatus: String {
  case active
  case disabled
  case unavailable

  static func resolve(probe: RNQuiescenceProbe, bypassEnabled: Bool) -> QuiescenceStatus {
    if probe == .unavailable {
      return .unavailable
    }
    return bypassEnabled ? .active : .disabled
  }

  static func current() -> QuiescenceStatus {
    resolve(probe: RNQuiescenceGetProbeResult(), bypassEnabled: RNQuiescenceBypassEnabled())
  }

  var startupMarker: String {
    switch self {
    case .active: return "RN_FAST_RUNNER_QUIESCENCE_BYPASS_ACTIVE"
    case .disabled: return "RN_FAST_RUNNER_QUIESCENCE_BYPASS_DISABLED"
    case .unavailable: return "RN_FAST_RUNNER_QUIESCENCE_UNAVAILABLE"
    }
  }

  var capabilities: [String] {
    self == .active ? ["QUIESCENCE_BYPASS"] : []
  }
}
