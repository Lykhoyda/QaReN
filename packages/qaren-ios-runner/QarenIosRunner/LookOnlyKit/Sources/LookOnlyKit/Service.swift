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
  private enum Phase: Equatable { case notStarted, starting, serving, draining(LookOnlyEndReason), ended }

  private struct Working {
    var conn: Int, op: Int, work: LookOnlyWork, deadline: Int64?
    var completions: [LookOnlyCompletion] = [], issued: LookOnlyRead? = nil, peerGone = false
  }

  private enum Slot {
    case free, framing(conn: Int, bytes: [UInt8], deadline: Int64?), working(Working)
    case sending(conn: Int, deadline: Int64?)

    var conn: Int? {
      switch self {
      case .free: nil
      case .framing(let conn, _, _), .sending(let conn, _): conn
      case .working(let working): working.conn
      }
    }

    var deadline: Int64? {
      switch self {
      case .free: nil
      case .framing(_, _, let deadline), .sending(_, let deadline): deadline
      case .working(let working): working.deadline
      }
    }
  }

  private var phase = Phase.notStarted
  private var config = LookOnlyConfig(capability: [], session: "", instance: "", device: "", bundleId: "", lifeMs: 0)
  private var life: Int64?, ready: Int64?, idle: Int64?
  private var expected: Int32?, bound: Int32?, seq: Int32 = 0
  private var slot = Slot.free
  private var lastOp = 0
  private var now: Int64 = 0
  private var accepting: Int?
  private var effects: [LookOnlyEffect] = []

  public init() {}

  public mutating func step(_ event: LookOnlyEvent, at: Int64) -> [LookOnlyEffect] {
    (now, accepting) = (at, nil)
    defer { effects = [] }
    var duplicate = false
    if case .accepted(let conn, _) = event {
      duplicate = conn == slot.conn
      if !duplicate { accepting = conn }
    }
    switch (phase, event) {
    case (.notStarted, .entered(let given, let entryAt)):
      enter(given, entryAt: entryAt)
    case (.notStarted, _), (.ended, _):
      if let accepting { effects.append(.close(conn: accepting)) }
    default:
      checkDeadlines()
      if phase != .ended && !duplicate { handle(event) }
    }
    return effects
  }

  private mutating func enter(_ given: LookOnlyConfig, entryAt: Int64) {
    config = given
    (life, ready, idle) = (after(entryAt, given.lifeMs), after(entryAt, 10_000), after(entryAt, 30_000))
    if let late: LookOnlyEndReason = passed(life) ? .life : passed(ready) ? .listenerFailed : nil {
      phase = .ended
      effects += [.logEnded(late), .fulfilWaiter]
    } else {
      phase = .starting
      effects.append(.startListener)
    }
  }

  private mutating func checkDeadlines() {
    if passed(life) { return end(.life) }
    switch (phase, slot) {
    case (.starting, _) where passed(ready):
      return end(.listenerFailed)
    case (.draining(let reason), _) where passed(slot.deadline):
      return end(reason)
    case (.serving, .working(var working)) where passed(working.deadline):
      if working.peerGone { return end(.timeout) }
      effects.append(.retire(op: working.op))
      working.issued = nil
      slot = .working(working)
      let timedOut =
        switch working.work {
        case .bind: reply(.refused, .timeout)
        case .observe: reply(.observed, .timeout, origin: .unknown)
        }
      return send(timedOut, on: working.conn, ending: .timeout)
    case (.serving, _) where passed(slot.deadline):
      if let conn = slot.conn { release(conn) }
    default:
      break
    }
    if case .serving = phase, passed(idle) {
      if case .working = slot { return }
      end(.idle)
    }
  }

  private mutating func handle(_ event: LookOnlyEvent) {
    switch event {
    case .entered, .tick:
      break
    case .listenerReady(let port):
      guard phase == .starting else { return }
      phase = .serving
      effects.append(.logReady(port: port))
    case .listenerFailed:
      if phase == .starting || phase == .serving { end(.listenerFailed) }
    case .waitReturned:
      end(.interrupted)
    case .accepted(let conn, let loopback):
      guard phase == .serving, loopback, slot.conn == nil else { return effects.append(.close(conn: conn)) }
      slot = .framing(conn: conn, bytes: [], deadline: after(now, 5_000))
    case .received(let conn, let bytes):
      guard case .framing(conn, let held, let deadline) = slot else { return }
      let all = held + bytes
      slot = .framing(conn: conn, bytes: all, deadline: deadline)
      answer(lookOnlyClassify(received: all, capability: config.capability), on: conn)
    case .inputEnded(let conn):
      if case .framing(conn, _, _) = slot { release(conn) }
    case .transportFailed(let conn):
      guard slot.conn == conn else { return }
      switch (slot, phase) {
      case (.working(var working), _):
        working.peerGone = true
        slot = .working(working)
      case (.sending, .draining(let reason)):
        end(reason)
      default:
        release(conn)
      }
    case .sendFinished(let conn, _):
      guard case .sending(conn, _) = slot else { return }
      if case .draining(let reason) = phase { end(reason) } else { release(conn) }
    case .readCompleted(let conn, let op, let completion):
      guard case .working(var working) = slot, working.conn == conn, working.op == op,
        working.issued == completion.read
      else { return }
      working.completions.append(completion)
      working.issued = nil
      next(working)
    }
  }

  private mutating func answer(_ input: LookOnlyInput, on conn: Int) {
    let session = Array(config.session.utf8)
    switch input {
    case .incomplete:
      break
    case .overLimit:
      release(conn)
    case .unauthorized:
      effects.append(.send(conn: conn, bytes: lookOnlyUnauthorizedLine, last: false))
      slot = .sending(conn: conn, deadline: after(now, 2_000))
    case .badRequest:
      refuse(.badRequest, on: conn)
    case .health:
      send(reply(.health, .none), on: conn)
    case .shutdown(let given):
      if given != session { return refuse(.wrongSession, on: conn) }
      send(reply(.stopped, .none), on: conn, ending: .shutdown)
    case .bind(let given, let bundleId, let processId):
      if bound != nil { return refuse(.alreadyBound, on: conn) }
      if given != session { return refuse(.wrongSession, on: conn) }
      if bundleId != Array(config.bundleId.utf8) { return refuse(.wrongApp, on: conn) }
      if (expected ?? processId) != processId { return refuse(.wrongProcess, on: conn) }
      expected = processId
      start(.bind(processId: processId), on: conn, within: 10_000)
    case .observe(let given, let number):
      guard let bound else { return refuse(.notBound, on: conn) }
      if given != session { return refuse(.wrongSession, on: conn) }
      if Int64(number) != Int64(seq) + 1 { return refuse(.badSeq, on: conn) }
      seq = number
      start(.observe(processId: bound), on: conn, within: 20_000)
    }
  }

  private mutating func start(_ work: LookOnlyWork, on conn: Int, within milliseconds: Int64) {
    let (op, overflow) = lastOp.addingReportingOverflow(1)
    if overflow { return end(.refused) }
    lastOp = op
    next(Working(conn: conn, op: op, work: work, deadline: after(now, milliseconds)))
  }

  private mutating func next(_ working: Working) {
    var working = working
    slot = .working(working)
    let step = lookOnlyReads(working.work, working.completions)
    if working.peerGone { return release(working.conn) }
    switch step {
    case .read(let read):
      working.issued = read
      slot = .working(working)
      let before = [working.deadline, life].compactMap { $0 }.min()
      effects.append(.issueRead(conn: working.conn, op: working.op, read: read, before: before))
    case .done(.bound):
      if case .bind(let processId) = working.work { bound = processId }
      send(reply(.bound, .none), on: working.conn)
    case .done(.pending(let detail)):
      send(reply(.pending, detail), on: working.conn)
    case .done(.observed(let origin, let detail, let nodes)):
      send(reply(.observed, detail, origin: origin, nodes: nodes), on: working.conn)
    case .notAsked:
      break
    }
  }

  private mutating func refuse(_ detail: LookOnlyDetail, on conn: Int) {
    send(reply(.refused, detail), on: conn, ending: .refused)
  }

  private mutating func send(_ reply: LookOnlyReply, on conn: Int, ending reason: LookOnlyEndReason? = nil) {
    guard let bytes = line(reply) else { return end(.refused) }
    if let reason {
      phase = .draining(reason)
      effects.append(.cancelListener)
    } else {
      idle = after(now, 30_000)
    }
    effects.append(.send(conn: conn, bytes: bytes, last: reason != nil))
    slot = .sending(conn: conn, deadline: after(now, 2_000))
  }

  private func reply(
    _ kind: LookOnlyKind, _ detail: LookOnlyDetail, origin: LookOnlyOrigin? = nil, nodes: [LookOnlyNode]? = nil
  ) -> LookOnlyReply {
    LookOnlyReply(
      kind: kind, detail: detail, session: config.session, instance: config.instance, device: config.device,
      bundleId: config.bundleId, bound: bound != nil, processId: bound, seq: seq, origin: origin, nodes: nodes)
  }

  private func line(_ reply: LookOnlyReply) -> [UInt8]? {
    if case .line(let bytes) = lookOnlyReplyLine(reply) { return bytes }
    guard reply.kind == .observed else { return nil }
    var unreadable = reply
    (unreadable.detail, unreadable.origin, unreadable.nodes) = (.treeUnreadable, .unknown, nil)
    if case .line(let bytes) = lookOnlyReplyLine(unreadable) { return bytes }
    return nil
  }

  private mutating func release(_ conn: Int) {
    effects.append(.close(conn: conn))
    slot = .free
  }

  private mutating func end(_ reason: LookOnlyEndReason) {
    if case .working(let working) = slot, working.issued != nil { effects.append(.retire(op: working.op)) }
    if let conn = slot.conn { effects.append(.close(conn: conn)) }
    if let accepting { effects.append(.close(conn: accepting)) }
    if case .draining(let drained) = phase {
      effects.append(.logEnded(drained))
    } else {
      effects += [.cancelListener, .logEnded(reason)]
    }
    effects.append(.fulfilWaiter)
    (phase, slot, accepting) = (.ended, .free, nil)
  }

  private func passed(_ deadline: Int64?) -> Bool { deadline.map { now >= $0 } ?? false }

  private func after(_ time: Int64, _ milliseconds: Int64) -> Int64? {
    let (sum, overflow) = time.addingReportingOverflow(milliseconds)
    return !overflow ? sum : milliseconds < 0 ? .min : nil
  }
}
