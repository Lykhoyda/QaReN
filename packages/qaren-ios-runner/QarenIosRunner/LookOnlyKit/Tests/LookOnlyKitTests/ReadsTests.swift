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
    guard case .string(let text) = self else { throw FixtureError(description: "not a string") }
    return text
  }

  func optional<T>(_ read: (JSON) throws -> T) rethrows -> T? {
    if case .null = self { return nil }
    return try read(self)
  }

  func optionalString() throws -> String? { try optional { try $0.string() } }

  func number() throws -> Double {
    guard case .number(let value) = self else { throw FixtureError(description: "not a number") }
    return value
  }

  func integer<T: FixedWidthInteger>(_: T.Type) throws -> T {
    guard let value = T(exactly: try number()) else { throw FixtureError(description: "not a \(T.self)") }
    return value
  }

  func bool() throws -> Bool {
    guard case .bool(let value) = self else { throw FixtureError(description: "not a bool") }
    return value
  }

  func array() throws -> [JSON] {
    guard case .array(let items) = self else { throw FixtureError(description: "not an array") }
    return items
  }
}

private struct FixtureError: Error, CustomStringConvertible {
  let description: String
}

private func word<T>(_ json: JSON, _ words: [String: T]) throws -> T {
  let text = try json.string()
  guard let value = words[text] else { throw FixtureError(description: "unknown word \(text)") }
  return value
}

private func rawWord<T: RawRepresentable>(_ json: JSON) throws -> T where T.RawValue == String {
  let text = try json.string()
  guard let value = T(rawValue: text) else { throw FixtureError(description: "unknown word \(text)") }
  return value
}

private let reads: [String: LookOnlyRead] = [
  "bindProcessId": .bindProcessId, "bindState": .bindState,
  "edge1Alerts": .edge1Alerts, "edge1Sheets": .edge1Sheets, "edge1ProcessId": .edge1ProcessId,
  "edge1State": .edge1State, "tree": .tree,
  "edge2Alerts": .edge2Alerts, "edge2Sheets": .edge2Sheets, "edge2ProcessId": .edge2ProcessId,
  "edge2State": .edge2State,
]

private let failures: [String: LookOnlyFailure] = [
  "unavailable": .unavailable, "missing": .missing, "exception": .exception, "thrown": .thrown, "issue": .issue,
]

private let states: [String: LookOnlyAppState] = [
  "unknown": .unknown, "notRunning": .notRunning, "behind": .behind, "front": .front,
]

private func rawNode(_ json: JSON, _ defaults: JSON, k: Int?) throws -> LookOnlyRawNode {
  func member(_ key: String) throws -> JSON { try json[key] ?? defaults.member(key) }
  func numbered(_ text: String) -> String {
    guard let k else { return text }
    return text.replacingOccurrences(of: "#", with: String(k))
  }
  let frame = try member("frame").array().map { try $0.number() }
  guard frame.count == 4 else { throw FixtureError(description: "frame needs four numbers") }
  return LookOnlyRawNode(
    type: try member("type").string(),
    label: numbered(try member("label").string()),
    identifier: numbered(try member("identifier").string()),
    value: try member("value").optionalString().map(numbered),
    frame: LookOnlyRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]),
    enabled: try member("enabled").bool(),
    selected: try member("selected").bool(),
    children: try member("children").array().flatMap { child -> [LookOnlyRawNode] in
      guard let repeated = child["repeat"] else { return [try rawNode(child, defaults, k: nil)] }
      let of = try child.member("of")
      return try (0..<repeated.integer(Int.self)).map { try rawNode(of, defaults, k: $0 + 1) }
    })
}

private func work(_ json: JSON) throws -> LookOnlyWork {
  let processId = try json.member("processId").integer(Int32.self)
  switch try json.member("kind").string() {
  case "bind": return .bind(processId: processId)
  case "observe": return .observe(processId: processId)
  case let kind: throw FixtureError(description: "unknown work \(kind)")
  }
}

private func completion(_ json: JSON, trees: JSON, defaults: JSON) throws -> LookOnlyCompletion {
  guard case .object(var fields) = json, let read = fields.removeValue(forKey: "read"), fields.count == 1,
    let (key, value) = fields.first
  else { throw FixtureError(description: "a completion needs a read and one result") }
  let result: LookOnlyResult
  switch key {
  case "failed": result = .failed(try word(value, failures))
  case "noProcess":
    guard try value.bool() else { throw FixtureError(description: "noProcess must be true") }
    result = .noProcess
  case "processId": result = .processId(try value.integer(Int32.self))
  case "state": result = .state(try word(value, states))
  case "count": result = .count(try value.integer(Int.self))
  case "tree": result = .tree(try rawNode(trees.member(value.string()), defaults, k: nil))
  default: throw FixtureError(description: "unknown result \(key)")
  }
  return LookOnlyCompletion(read: try word(read, reads), result: result)
}

private func listNode(_ json: JSON) throws -> LookOnlyNode {
  let rect = try json.member("rect")
  return LookOnlyNode(
    type: try json.member("type").string(),
    label: try json.member("label").optionalString(),
    identifier: try json.member("identifier").optionalString(),
    rect: LookOnlyRect(
      x: try rect.member("x").number(), y: try rect.member("y").number(),
      width: try rect.member("width").number(), height: try rect.member("height").number()),
    enabled: try json.member("enabled").bool(),
    selected: try json.member("selected").bool(),
    parent: try json.member("parent").optional { try $0.integer(Int.self) })
}

private func outcome(_ json: JSON) throws -> LookOnlyOutcome {
  switch try json.member("kind").string() {
  case "bound": return .bound
  case "pending": return .pending(try rawWord(json.member("detail")))
  case "observed":
    return .observed(
      origin: try rawWord(json.member("origin")),
      detail: try rawWord(json.member("detail")),
      nodes: try json.member("nodes").optional { try $0.array().map(listNode) })
  case let kind: throw FixtureError(description: "unknown outcome \(kind)")
  }
}

private func expectedStep(_ json: JSON) throws -> LookOnlyStep {
  switch try json.member("step").string() {
  case "read": return .read(try word(json.member("read"), reads))
  case "done": return .done(try outcome(json.member("outcome")))
  case "notAsked": return .notAsked
  case let step: throw FixtureError(description: "unknown step \(step)")
  }
}

private func loadFixture(_ name: String) throws -> JSON {
  let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
}

final class ReadsTests: XCTestCase {
  func testReadsCases() throws {
    let fixture = try loadFixture("reads")
    let defaults = try loadFixture("trees").member("defaults")
    let trees = try fixture.member("trees")
    var casesRun = 0
    var inputsRun = 0
    for readsCase in try fixture.member("cases").array() {
      let name = (try? readsCase.member("name").string()) ?? "?"
      for input in try readsCase.member("inputs").array() {
        let label = "\(name) \((try? input.member("id").string()) ?? "?")"
        do {
          let completions = try input.member("completions").array().map {
            try completion($0, trees: trees, defaults: defaults)
          }
          let step = lookOnlyReads(try work(input.member("work")), completions)
          let want = try expectedStep(input.member("expect"))
          inputsRun += 1
          XCTAssertEqual(step, want, label)
        } catch {
          XCTFail("\(label): \(error)")
        }
      }
      casesRun += 1
    }
    XCTAssertEqual(casesRun, 8)
    XCTAssertEqual(inputsRun, 70)
  }
}
