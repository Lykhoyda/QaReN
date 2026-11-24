public enum LookOnlyKind: String { case health, pending, bound, observed, stopped, refused }

public enum LookOnlyDetail: String {
  case none, unauthorized
  case badRequest = "bad-request", wrongSession = "wrong-session", wrongApp = "wrong-app"
  case wrongProcess = "wrong-process", alreadyBound = "already-bound", notBound = "not-bound"
  case badSeq = "bad-seq", notRunning = "not-running", processMismatch = "process-mismatch"
  case readFailed = "read-failed", processChanged = "process-changed", notForeground = "not-foreground"
  case treeUnreadable = "tree-unreadable", tooManyNodes = "too-many-nodes", timeout
}

public enum LookOnlyOrigin: String { case app, systemAlert = "system-alert", unknown }

public struct LookOnlyReply: Equatable {
  public var kind: LookOnlyKind, detail: LookOnlyDetail
  public var session: String, instance: String, device: String, bundleId: String
  public var bound: Bool, processId: Int32?, seq: Int32
  public var origin: LookOnlyOrigin?, nodes: [LookOnlyNode]?

  public init(
    kind: LookOnlyKind, detail: LookOnlyDetail, session: String, instance: String, device: String,
    bundleId: String, bound: Bool, processId: Int32?, seq: Int32, origin: LookOnlyOrigin?, nodes: [LookOnlyNode]?
  ) {
    self.kind = kind
    self.detail = detail
    self.session = session
    self.instance = instance
    self.device = device
    self.bundleId = bundleId
    self.bound = bound
    self.processId = processId
    self.seq = seq
    self.origin = origin
    self.nodes = nodes
  }
}

public enum LookOnlyLine: Equatable { case line([UInt8]), overLimit, notFinite }

public let lookOnlyUnauthorizedLine: [UInt8] = []

public func lookOnlyReplyLine(_ reply: LookOnlyReply) -> LookOnlyLine {
  .line([])
}
