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

public let lookOnlyUnauthorizedLine: [UInt8] = Array(
  #"{"v":1,"mode":"look-only-1","kind":"refused","detail":"unauthorized"}"#.utf8) + [0x0A]

public func lookOnlyReplyLine(_ reply: LookOnlyReply) -> LookOnlyLine {
  let rects = (reply.nodes ?? []).map(\.rect)
  guard rects.allSatisfy({ [$0.x, $0.y, $0.width, $0.height].allSatisfy(\.isFinite) }) else { return .notFinite }
  var out: [UInt8] = []
  func raw(_ text: String) { out += text.utf8 }
  func string(_ text: String?) {
    guard let text else { return raw("null") }
    out.append(0x22)
    for byte in text.utf8 {
      switch byte {
      case 0x22, 0x5C: out += [0x5C, byte]
      case ..<0x20: raw("\\u00" + (byte < 0x10 ? "0" : "") + String(byte, radix: 16))
      default: out.append(byte)
      }
    }
    out.append(0x22)
  }
  func whole(_ number: (some BinaryInteger)?) { raw(number.map { "\($0)" } ?? "null") }

  raw(#"{"v":1,"mode":"look-only-1","kind":"#)
  string(reply.kind.rawValue)
  raw(#","detail":"#)
  string(reply.detail.rawValue)
  raw(#","session":"#)
  string(reply.session)
  raw(#","instance":"#)
  string(reply.instance)
  raw(#","device":"#)
  string(reply.device)
  raw(#","bundleId":"#)
  string(reply.bundleId)
  raw(#","bound":\#(reply.bound),"processId":"#)
  whole(reply.processId)
  raw(#","seq":\#(reply.seq),"origin":"#)
  string(reply.origin?.rawValue)
  raw(#","nodes":"#)
  if let nodes = reply.nodes {
    raw("[")
    for (position, node) in nodes.enumerated() {
      raw(position == 0 ? #"{"type":"# : #",{"type":"#)
      string(node.type)
      raw(#","label":"#)
      string(node.label)
      raw(#","identifier":"#)
      string(node.identifier)
      let rect = node.rect
      raw(#","rect":{"x":\#(number(rect.x)),"y":\#(number(rect.y)),"width":\#(number(rect.width)),"#)
      raw(#""height":\#(number(rect.height))},"enabled":\#(node.enabled),"selected":\#(node.selected),"parent":"#)
      whole(node.parent)
      raw("}")
    }
    raw("]")
  } else {
    raw("null")
  }
  raw("}\n")
  return out.count > 1_048_576 ? .overLimit : .line(out)
}

private func number(_ value: Double) -> String {
  let sign = value.sign == .minus ? "-" : ""
  guard value != 0 else { return sign + "0" }
  let biased = Int(value.exponentBitPattern), fraction = value.significandBitPattern
  let significand = biased == 0 ? fraction : fraction | 1 << 52
  let unitPower = max(biased, 1) - 1077
  var r = limbs(4 * significand), s = limbs(1)
  var low = limbs(biased > 1 && fraction == 0 ? 1 : 2), high = limbs(2)
  for _ in 0..<max(unitPower, 0) {
    scale(&r, 2); scale(&low, 2); scale(&high, 2)
  }
  for _ in 0..<max(-unitPower, 0) { scale(&s, 2) }

  var exponent = 0
  while order(r, s) < 0 {
    scale(&r, 10); scale(&low, 10); scale(&high, 10)
    exponent -= 1
  }
  var tenS = s
  scale(&tenS, 10)
  while order(r, tenS) >= 0 {
    s = tenS
    scale(&tenS, 10)
    exponent += 1
  }

  let even = significand & 1 == 0
  var digits: UInt64 = 0, count = 0
  while true {
    digits *= 10
    while order(r, s) >= 0 {
      subtract(&r, s)
      digits += 1
    }
    count += 1
    let below = order(r, low), above = order(sum(r, high), s)
    let lowerReadsBack = below < 0 || (even && below == 0)
    let upperReadsBack = above > 0 || (even && above == 0)
    if lowerReadsBack || upperReadsBack {
      let half = order(sum(r, r), s)
      if upperReadsBack && (!lowerReadsBack || half > 0 || (half == 0 && digits % 2 == 1)) { digits += 1 }
      break
    }
    scale(&r, 10); scale(&low, 10); scale(&high, 10)
  }

  var text = String(digits)
  let power = exponent + text.count - count
  while text.count > 1, text.last == "0" { text.removeLast() }
  let rest = text.dropFirst()
  return sign + String(text.prefix(1)) + (rest.isEmpty ? "" : "." + rest) + "e\(power)"
}

private func limbs(_ value: UInt64) -> [UInt32] {
  value >> 32 == 0 ? [UInt32(value)] : [UInt32(truncatingIfNeeded: value), UInt32(value >> 32)]
}

private func scale(_ x: inout [UInt32], _ factor: UInt64) {
  var carry: UInt64 = 0
  for i in x.indices {
    let product = UInt64(x[i]) * factor + carry
    x[i] = UInt32(truncatingIfNeeded: product)
    carry = product >> 32
  }
  if carry > 0 { x.append(UInt32(carry)) }
}

private func order(_ a: [UInt32], _ b: [UInt32]) -> Int {
  if a.count != b.count { return a.count < b.count ? -1 : 1 }
  for i in a.indices.reversed() where a[i] != b[i] { return a[i] < b[i] ? -1 : 1 }
  return 0
}

private func sum(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
  var out: [UInt32] = [], carry: UInt64 = 0
  for i in 0..<max(a.count, b.count) {
    let total = UInt64(i < a.count ? a[i] : 0) + UInt64(i < b.count ? b[i] : 0) + carry
    out.append(UInt32(truncatingIfNeeded: total))
    carry = total >> 32
  }
  if carry > 0 { out.append(1) }
  return out
}

private func subtract(_ a: inout [UInt32], _ b: [UInt32]) {
  var borrow: Int64 = 0
  for i in a.indices {
    let difference = Int64(a[i]) - Int64(i < b.count ? b[i] : 0) - borrow
    a[i] = UInt32(truncatingIfNeeded: difference)
    borrow = difference < 0 ? 1 : 0
  }
  while a.last == 0 { a.removeLast() }
}
