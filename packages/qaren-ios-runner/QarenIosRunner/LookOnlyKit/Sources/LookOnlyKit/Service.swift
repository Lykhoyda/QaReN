public struct LookOnlyConfig {
  public var capability: [UInt8], session: String, instance: String, device: String
  public var bundleId: String, lifeMs: Int64

  public init(
    capability: [UInt8], session: String, instance: String, device: String, bundleId: String, lifeMs: Int64
  ) {
    self.capability = capability
    self.session = session
    self.instance = instance
    self.device = device
    self.bundleId = bundleId
    self.lifeMs = lifeMs
  }
}

public enum LookOnlyEvent {
  case entered(LookOnlyConfig, entryAt: Int64), listenerReady(port: UInt16), listenerFailed
  case accepted(conn: Int, loopback: Bool), received(conn: Int, bytes: [UInt8])
  case inputEnded(conn: Int), transportFailed(conn: Int)
  case readCompleted(conn: Int, op: Int, completion: LookOnlyCompletion)
  case sendFinished(conn: Int, ok: Bool), tick, waitReturned
}

public enum LookOnlyEndReason: String {
  case shutdown, refused, timeout, idle, life, listenerFailed = "listener-failed", interrupted
}

public enum LookOnlyEffect: Equatable {
  case startListener, cancelListener, logReady(port: UInt16), logEnded(LookOnlyEndReason)
  case issueRead(conn: Int, op: Int, read: LookOnlyRead, before: Int64?)
  case send(conn: Int, bytes: [UInt8], last: Bool), close(conn: Int), retire(op: Int), fulfilWaiter
}

public struct LookOnlyService {
  public init() {}

  public mutating func step(_ event: LookOnlyEvent, at: Int64) -> [LookOnlyEffect] {
    []
  }
}
