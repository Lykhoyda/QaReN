public enum LookOnlyInput: Equatable {
  case incomplete, overLimit, unauthorized, badRequest, health
  case bind(session: [UInt8], bundleId: [UInt8], processId: Int32)
  case observe(session: [UInt8], seq: Int32)
  case shutdown(session: [UInt8])
}

public func lookOnlyClassify(received: [UInt8], capability: [UInt8]) -> LookOnlyInput {
  guard let lineFeed = received.prefix(lineLimit).firstIndex(of: 0x0A) else {
    return received.count < lineLimit ? .incomplete : .overLimit
  }
  guard let fields = scanObject(received[..<lineFeed]), case .string(let given)? = fields["capability"],
    sameCapability(given, capability)
  else { return .unauthorized }
  guard case .string(let verb)? = fields["verb"] else { return .badRequest }
  func number(_ key: String) -> Int32? {
    guard case .token(let digits)? = fields[key], let first = digits.first, (0x31...0x39).contains(first)
    else { return nil }
    return Int32(String(decoding: digits, as: UTF8.self))
  }
  switch (String(decoding: verb, as: UTF8.self), fields.count, fields["session"]) {
  case ("health", 2, _):
    return .health
  case ("bind", 5, .string(let session)?):
    guard case .string(let bundleId)? = fields["bundleId"], let processId = number("processId")
    else { return .badRequest }
    return .bind(session: Array(session), bundleId: Array(bundleId), processId: processId)
  case ("observe", 4, .string(let session)?):
    return number("seq").map { .observe(session: Array(session), seq: $0) } ?? .badRequest
  case ("shutdown", 3, .string(let session)?):
    return .shutdown(session: Array(session))
  default:
    return .badRequest
  }
}

private let lineLimit = 4096

private enum Value {
  case string(ArraySlice<UInt8>)
  case token(ArraySlice<UInt8>)
}

private func scanObject(_ line: ArraySlice<UInt8>) -> [String: Value]? {
  var rest = line
  var afterSpace: ArraySlice<UInt8> { rest.drop { $0 == 0x20 || $0 == 0x09 || $0 == 0x0D } }
  func take(_ byte: UInt8) -> Bool {
    rest = afterSpace
    guard rest.first == byte else { return false }
    rest.removeFirst()
    return true
  }
  func quotedText() -> ArraySlice<UInt8>? {
    let text = rest.prefix { (0x20...0x7E).contains($0) && $0 != 0x22 && $0 != 0x5C }
    rest = rest.dropFirst(text.count)
    return rest.popFirst() == 0x22 ? text : nil
  }
  func value() -> Value? {
    if take(0x22) { return quotedText().map(Value.string) }
    let token = rest.prefix {
      (0x41...0x5A).contains($0) || (0x61...0x7A).contains($0) || (0x30...0x39).contains($0)
        || $0 == 0x2B || $0 == 0x2D || $0 == 0x2E
    }
    rest = rest.dropFirst(token.count)
    return token.isEmpty ? nil : .token(token)
  }

  var fields: [String: Value] = [:]
  guard take(0x7B) else { return nil }
  if afterSpace.first != 0x7D {
    repeat {
      guard take(0x22), let key = quotedText(), take(0x3A), let value = value(),
        fields.updateValue(value, forKey: String(decoding: key, as: UTF8.self)) == nil
      else { return nil }
    } while take(0x2C)
  }
  return take(0x7D) && afterSpace.isEmpty ? fields : nil
}

private func sameCapability(_ given: ArraySlice<UInt8>, _ expected: [UInt8]) -> Bool {
  var difference = given.count ^ expected.count
  for (left, right) in zip(given, expected) { difference |= Int(left ^ right) }
  for byte in [given.dropFirst(expected.count), expected.dropFirst(given.count)].joined() { difference |= Int(byte) }
  return difference == 0 && !expected.isEmpty
}
