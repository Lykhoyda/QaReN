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
  let (order, processId, observing): ([LookOnlyRead], Int32, Bool) =
    switch work {
    case .bind(let id): ([.bindProcessId, .bindState], id, false)
    case .observe(let id):
      ([.edge1Alerts, .edge1Sheets, .edge1ProcessId, .edge1State, .tree,
        .edge2Alerts, .edge2Sheets, .edge2ProcessId, .edge2State], id, true)
    }
  guard completions.count <= order.count, zip(completions, order).allSatisfy({ $0.read == $1 }) else {
    return .notAsked
  }
  var kept: [LookOnlyNode]?
  func ends(_ bind: LookOnlyOutcome, _ detail: LookOnlyDetail) -> LookOnlyOutcome {
    observing ? .observed(origin: .unknown, detail: detail, nodes: nil) : bind
  }
  let gone = ends(.pending(.notRunning), .processChanged)
  for (position, completion) in completions.enumerated() {
    let outcome: LookOnlyOutcome?
    switch (completion.read, completion.result) {
    case (.bindProcessId, .processId(let id)), (.edge1ProcessId, .processId(let id)),
      (.edge2ProcessId, .processId(let id)):
      outcome = id <= 0 ? gone : id == processId ? nil : ends(.pending(.processMismatch), .processChanged)
    case (.bindState, .state(.behind)), (.edge1State, .state(.behind)), (.edge2State, .state(.behind)):
      outcome = ends(.bound, .notForeground)
    case (.bindState, .state(.front)), (.edge1State, .state(.front)), (.edge2State, .state(.front)):
      outcome = observing ? nil : .bound
    case (.bindProcessId, .noProcess), (.edge1ProcessId, .noProcess), (.edge2ProcessId, .noProcess),
      (.bindState, .state), (.edge1State, .state), (.edge2State, .state):
      outcome = gone
    case (.edge1Alerts, .count(let count)), (.edge1Sheets, .count(let count)), (.edge2Alerts, .count(let count)),
      (.edge2Sheets, .count(let count)):
      outcome = count > 0 ? .observed(origin: .systemAlert, detail: .none, nodes: nil) : nil
    case (.tree, .tree(let root)):
      switch lookOnlyExport(root) {
      case .nodes(let list): (kept, outcome) = (list, nil)
      case .tooManyNodes: outcome = .observed(origin: .unknown, detail: .tooManyNodes, nodes: nil)
      case .unreadable: outcome = .observed(origin: .unknown, detail: .treeUnreadable, nodes: nil)
      }
    default:
      outcome = ends(.pending(.readFailed), .readFailed)
    }
    guard let outcome else { continue }
    return position == completions.count - 1 ? .done(outcome) : .notAsked
  }
  guard completions.count == order.count else { return .read(order[completions.count]) }
  return .done(.observed(origin: .app, detail: .none, nodes: kept))
}
