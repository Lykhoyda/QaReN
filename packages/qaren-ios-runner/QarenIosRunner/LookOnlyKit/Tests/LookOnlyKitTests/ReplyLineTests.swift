import Foundation
import LookOnlyKit
import XCTest

private enum JSON: Decodable {
  case null, bool(Bool), number(Double), string(String), array([JSON]), object([String: JSON])

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSON].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSON].self))
    }
  }

  subscript(key: String) -> JSON? {
    if case .object(let members) = self { return members[key] }
    return nil
  }

  func member(_ key: String) throws -> JSON {
    guard let value = self[key] else { throw FixtureError(description: "missing \(key)") }
    return value
  }

  func string() throws -> String {
    if case .string(let text) = self { return text }
    guard let unit = self["repeat"] else { throw FixtureError(description: "not a string") }
    return String(repeating: try unit.string(), count: try member("count").whole())
  }

  func whole() throws -> Int {
    guard case .number(let value) = self, let whole = Int(exactly: value) else {
      throw FixtureError(description: "not a whole number")
    }
    return whole
  }

  func bool() throws -> Bool {
    guard case .bool(let value) = self else { throw FixtureError(description: "not a bool") }
    return value
  }

  func array() throws -> [JSON] {
    guard case .array(let items) = self else { throw FixtureError(description: "not an array") }
    return items
  }

  func optional<T>(_ read: (JSON) throws -> T) rethrows -> T? {
    if case .null = self { return nil }
    return try read(self)
  }
}

private struct FixtureError: Error, CustomStringConvertible {
  let description: String
}

private func word<T: RawRepresentable>(_ json: JSON) throws -> T where T.RawValue == String {
  let text = try json.string()
  guard let value = T(rawValue: text) else { throw FixtureError(description: "unknown word \(text)") }
  return value
}

private func int32(_ json: JSON) throws -> Int32 {
  guard let value = Int32(exactly: try json.whole()) else { throw FixtureError(description: "not an Int32") }
  return value
}

private func rectNumber(_ json: JSON) throws -> Double {
  if case .number(let value) = json { return value }
  let hex = try json.string()
  guard hex.utf8.count == 16, let bits = UInt64(hex, radix: 16) else {
    throw FixtureError(description: "bad bit pattern \(hex)")
  }
  return Double(bitPattern: bits)
}

private func node(_ json: JSON, _ defaults: JSON) throws -> LookOnlyNode {
  func member(_ key: String) throws -> JSON { try json[key] ?? defaults.member(key) }
  let rect = try member("rect").array().map(rectNumber)
  guard rect.count == 4 else { throw FixtureError(description: "rect needs four numbers") }
  return LookOnlyNode(
    type: try member("type").string(),
    label: try member("label").optional { try $0.string() },
    identifier: try member("identifier").optional { try $0.string() },
    rect: LookOnlyRect(x: rect[0], y: rect[1], width: rect[2], height: rect[3]),
    enabled: try member("enabled").bool(),
    selected: try member("selected").bool(),
    parent: try member("parent").optional { try $0.whole() })
}

private func reply(_ json: JSON, _ defaults: JSON, _ nodeDefaults: JSON) throws -> LookOnlyReply {
  func member(_ key: String) throws -> JSON { try json[key] ?? defaults.member(key) }
  return LookOnlyReply(
    kind: try word(member("kind")),
    detail: try word(member("detail")),
    session: try member("session").string(),
    instance: try member("instance").string(),
    device: try member("device").string(),
    bundleId: try member("bundleId").string(),
    bound: try member("bound").bool(),
    processId: try member("processId").optional(int32),
    seq: try int32(member("seq")),
    origin: try member("origin").optional { try word($0) },
    nodes: try member("nodes").optional { try $0.array().map { try node($0, nodeDefaults) } })
}

private func expected(_ json: JSON) throws -> LookOnlyLine {
  switch try json.member("kind").string() {
  case "line":
    return .line(try json.member("parts").array().flatMap { try ($0["text"] ?? $0).string().utf8 })
  case "overLimit": return .overLimit
  case "notFinite": return .notFinite
  case let kind: throw FixtureError(description: "unknown kind \(kind)")
  }
}

private func brief(_ result: LookOnlyLine) -> String {
  guard case .line(let bytes) = result else { return "\(result)" }
  return "line of \(bytes.count) bytes"
}

private func firstDifference(_ got: LookOnlyLine, _ want: LookOnlyLine) -> String {
  guard case .line(let a) = got, case .line(let b) = want else { return "" }
  let at = (0..<min(a.count, b.count)).first { a[$0] != b[$0] } ?? min(a.count, b.count)
  let window = { (bytes: [UInt8]) in
    String(decoding: bytes[min(at, bytes.count)..<min(at + 60, bytes.count)], as: UTF8.self)
  }
  return ", first difference at byte \(at): got \(window(a).debugDescription), want \(window(b).debugDescription)"
}

private func loadFixture() throws -> JSON {
  let url = try XCTUnwrap(
    Bundle.module.url(forResource: "reply-lines", withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
}

final class ReplyLineTests: XCTestCase {
  func testReplyLines() throws {
    let fixture = try loadFixture()
    XCTAssertEqual(try fixture.member("limit").whole(), 1_048_576)
    let defaults = try fixture.member("defaults")
    let nodeDefaults = try fixture.member("nodeDefaults")
    var casesRun = 0
    var inputsRun = 0
    for (offset, replyCase) in try fixture.member("cases").array().enumerated() {
      let name = (try? replyCase.member("name").string()) ?? "?"
      casesRun += 1
      for input in try replyCase.member("inputs").array() {
        let label = "\(offset + 1)\((try? input.member("id").string()) ?? "?") \(name)"
        do {
          let result =
            input["unauthorized"] == nil
            ? lookOnlyReplyLine(try reply(input.member("reply"), defaults, nodeDefaults))
            : .line(lookOnlyUnauthorizedLine)
          let want = try expected(input.member("expect"))
          inputsRun += 1
          if result != want {
            XCTFail("\(label): got \(brief(result)), want \(brief(want))\(firstDifference(result, want))")
          }
        } catch {
          XCTFail("\(label): \(error)")
        }
      }
    }
    XCTAssertEqual(casesRun, 24)
    XCTAssertEqual(inputsRun, 52)
  }
}
