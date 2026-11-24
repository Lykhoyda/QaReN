public enum LookOnlyWork: Equatable { case bind(processId: Int32), observe(processId: Int32) }

public enum LookOnlyRead: Equatable {
  case bindProcessId, bindState
  case edge1Alerts, edge1Sheets, edge1ProcessId, edge1State, tree
  case edge2Alerts, edge2Sheets, edge2ProcessId, edge2State
}

public enum LookOnlyFailure: Equatable { case unavailable, missing, exception, thrown, issue }

public enum LookOnlyAppState: Equatable { case unknown, notRunning, behind, front }

public enum LookOnlyResult {
  case failed(LookOnlyFailure)
  case processId(Int32), noProcess, state(LookOnlyAppState), count(Int), tree(LookOnlyRawNode)
}

public struct LookOnlyCompletion {
  public var read: LookOnlyRead, result: LookOnlyResult

  public init(read: LookOnlyRead, result: LookOnlyResult) {
    self.read = read
    self.result = result
  }
}

public enum LookOnlyOutcome: Equatable {
  case bound, pending(LookOnlyDetail)
  case observed(origin: LookOnlyOrigin, detail: LookOnlyDetail, nodes: [LookOnlyNode]?)
}

public enum LookOnlyStep: Equatable { case read(LookOnlyRead), done(LookOnlyOutcome), notAsked }

public func lookOnlyReads(_ work: LookOnlyWork, _ completions: [LookOnlyCompletion]) -> LookOnlyStep {
  .notAsked
}
