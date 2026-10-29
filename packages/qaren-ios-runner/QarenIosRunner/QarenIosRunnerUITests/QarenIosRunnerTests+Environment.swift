import Foundation

// MARK: - Environment

enum RunnerEnv {
  static func value(_ name: String) -> String? {
    if let value = ProcessInfo.processInfo.environment[name], !value.isEmpty {
      return value
    }
    for arg in CommandLine.arguments where arg.hasPrefix("\(name)=") {
      let value = String(arg.dropFirst("\(name)=".count))
      if !value.isEmpty { return value }
    }
    return nil
  }

  static func resolvePort() -> UInt16 {
    if let env = ProcessInfo.processInfo.environment["RN_FAST_RUNNER_PORT"], let port = UInt16(env) {
      return port
    }
    for arg in CommandLine.arguments {
      if arg.hasPrefix("RN_FAST_RUNNER_PORT=") {
        let value = arg.replacingOccurrences(of: "RN_FAST_RUNNER_PORT=", with: "")
        if let port = UInt16(value) { return port }
      }
    }
    return 0
  }

  static func pluginVersion() -> String? {
    if let env = ProcessInfo.processInfo.environment["RN_PLUGIN_VERSION"], !env.isEmpty {
      return env
    }
    for arg in CommandLine.arguments where arg.hasPrefix("RN_PLUGIN_VERSION=") {
      let value = String(arg.dropFirst("RN_PLUGIN_VERSION=".count))
      if !value.isEmpty { return value }
    }
    return nil
  }

  static func capability() -> String? { value("RN_RUNNER_CAPABILITY") }
  static func instanceId() -> String? { value("RN_RUNNER_INSTANCE_ID") }
  static func sessionId() -> String? { value("RN_RUNNER_SESSION_ID") }
  static func claimEpoch() -> Int? { value("RN_RUNNER_CLAIM_EPOCH").flatMap(Int.init) }
  static func deviceId() -> String? { value("RN_RUNNER_DEVICE_ID") }
  static func appId() -> String? { value("RN_RUNNER_APP_ID") }
  static func attachOnly() -> Bool { isTruthy("RN_RUNNER_ATTACH_ONLY") }

  static func isTruthy(_ name: String) -> Bool {
    guard let raw = ProcessInfo.processInfo.environment[name] else {
      return false
    }
    switch raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "1", "true", "yes", "on":
      return true
    default:
      return false
    }
  }
}
