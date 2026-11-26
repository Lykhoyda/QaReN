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

  func integer<T: FixedWidthInteger>(_: T.Type) throws -> T {
    guard case .number(let number) = self, let value = T(exactly: number) else {
      throw FixtureError(description: "not a \(T.self)")
    }
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

  func text() throws -> String {
    guard let unit = self["repeat"] else { return try string() }
    return String(repeating: try unit.string(), count: try member("count").integer(Int.self))
  }

  func time() throws -> Int64 {
    if case .string("max") = self { return .max }
    return try integer(Int64.self)
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

private func rawNode(_ json: JSON, _ defaults: JSON) throws -> LookOnlyRawNode {
  func member(_ key: String) throws -> JSON { try json[key] ?? defaults.member(key) }
  let frame = try member("frame").array().map { json -> Double in
    guard case .number(let value) = json else { throw FixtureError(description: "not a number") }
    return value
  }
  guard frame.count == 4 else { throw FixtureError(description: "frame needs four numbers") }
  return LookOnlyRawNode(
    type: try member("type").string(),
    label: try member("label").text(),
    identifier: try member("identifier").string(),
    value: try member("value").optional { try $0.string() },
    frame: LookOnlyRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]),
    enabled: try member("enabled").bool(),
    selected: try member("selected").bool(),
    children: try member("children").array().map { try rawNode($0, defaults) })
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
  case "tree": result = .tree(try rawNode(trees.member(value.string()), defaults))
  default: throw FixtureError(description: "unknown result \(key)")
  }
  return LookOnlyCompletion(read: try word(read, reads), result: result)
}

private func config(_ json: JSON) throws -> LookOnlyConfig {
  LookOnlyConfig(
    capability: Array(try json.member("capability").string().utf8),
    session: try json.member("session").string(),
    instance: try json.member("instance").text(),
    device: try json.member("device").string(),
    bundleId: try json.member("bundleId").string(),
    lifeMs: try json.member("lifeMs").integer(Int64.self))
}

private func event(_ json: JSON, trees: JSON, defaults: JSON) throws -> LookOnlyEvent {
  func conn() throws -> Int { try json.member("conn").integer(Int.self) }
  switch try json.member("event").string() {
  case "entered": return .entered(try config(json.member("config")), entryAt: try json.member("entryAt").time())
  case "listenerReady": return .listenerReady(port: try json.member("port").integer(UInt16.self))
  case "listenerFailed": return .listenerFailed
  case "accepted": return .accepted(conn: try conn(), loopback: try json.member("loopback").bool())
  case "received": return .received(conn: try conn(), bytes: Array(try json.member("text").text().utf8))
  case "inputEnded": return .inputEnded(conn: try conn())
  case "transportFailed": return .transportFailed(conn: try conn())
  case "readCompleted":
    return .readCompleted(
      conn: try conn(), op: try json.member("op").integer(Int.self),
      completion: try completion(json.member("completion"), trees: trees, defaults: defaults))
  case "sendFinished": return .sendFinished(conn: try conn(), ok: try json.member("ok").bool())
  case "tick": return .tick
  case "waitReturned": return .waitReturned
  case let name: throw FixtureError(description: "unknown event \(name)")
  }
}

private func effect(_ json: JSON) throws -> LookOnlyEffect {
  func number(_ key: String) throws -> Int { try json.member(key).integer(Int.self) }
  switch try json.member("effect").string() {
  case "startListener": return .startListener
  case "cancelListener": return .cancelListener
  case "logReady": return .logReady(port: try json.member("port").integer(UInt16.self))
  case "logEnded":
    let text = try json.member("reason").string()
    guard let reason = LookOnlyEndReason(rawValue: text) else {
      throw FixtureError(description: "unknown reason \(text)")
    }
    return .logEnded(reason)
  case "issueRead":
    return .issueRead(
      conn: try number("conn"), op: try number("op"), read: try word(json.member("read"), reads),
      before: try json.member("before").optional { try $0.time() })
  case "send":
    return .send(
      conn: try number("conn"), bytes: Array(try json.member("line").string().utf8),
      last: try json.member("last").bool())
  case "close": return .close(conn: try number("conn"))
  case "retire": return .retire(op: try number("op"))
  case "fulfilWaiter": return .fulfilWaiter
  case let name: throw FixtureError(description: "unknown effect \(name)")
  }
}

private func hexBytes(_ hex: String) throws -> [UInt8] {
  let digits = Array(hex.utf8)
  guard digits.count % 2 == 0 else { throw FixtureError(description: "odd hex \(hex)") }
  return try stride(from: 0, to: digits.count, by: 2).map { index in
    guard let byte = UInt8(String(decoding: digits[index..<index + 2], as: UTF8.self), radix: 16)
    else { throw FixtureError(description: "bad hex \(hex)") }
    return byte
  }
}

private func partBytes(_ part: JSON) throws -> [UInt8] {
  if let hex = part["hex"] { return try hexBytes(hex.string()) }
  if let text = part["utf16le"] { return Array(try XCTUnwrap(text.string().data(using: .utf16LittleEndian))) }
  return Array(try (part["text"]?.string() ?? part.text()).utf8)
}

private func disposition(_ kind: String, _ effects: [LookOnlyEffect]) throws -> Bool {
  func oneSend(_ sent: ArraySlice<LookOnlyEffect>, last: Bool) -> Bool {
    guard sent.count == 1, case .send(conn: 1, let bytes, last: last)? = sent.first else { return false }
    return bytes != lookOnlyUnauthorizedLine
  }
  switch kind {
  case "incomplete": return effects.isEmpty
  case "overLimit": return effects == [.close(conn: 1)]
  case "unauthorized": return effects == [.send(conn: 1, bytes: lookOnlyUnauthorizedLine, last: false)]
  case "health": return oneSend(effects[...], last: false)
  case "badRequest", "observe", "shutdown":
    return effects.first == .cancelListener && oneSend(effects.dropFirst(), last: true)
  case "bind": return effects == [.issueRead(conn: 1, op: 1, read: .bindProcessId, before: 12001)]
  default: throw FixtureError(description: "unknown kind \(kind)")
  }
}

private func loadFixture(_ name: String) throws -> JSON {
  let url = try XCTUnwrap(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
}

final class ServiceTests: XCTestCase {
  func testTimelines() throws {
    let fixture = try loadFixture("timelines")
    let defaults = try loadFixture("trees").member("defaults")
    let trees = try fixture.member("trees")
    let timelines = try fixture.member("timelines").array()
    var eventsRun = 0
    for timeline in timelines {
      let name = (try? timeline.member("name").string()) ?? "?"
      var service = LookOnlyService()
      for (position, entry) in try timeline.member("events").array().enumerated() where entry["event"] != nil {
        let label = "\(name) entry \(position + 1)"
        do {
          let given = try event(entry, trees: trees, defaults: defaults)
          let want = try entry.member("expect").array().map(effect)
          let effects = service.step(given, at: try entry.member("at").time())
          eventsRun += 1
          XCTAssertEqual(effects, want, label)
        } catch {
          XCTFail("\(label): \(error)")
        }
      }
    }
    XCTAssertEqual(timelines.count, 47)
    XCTAssertEqual(eventsRun, 393)
  }

  func testRequestLinesThroughTheService() throws {
    let fixture = try loadFixture("request-lines")
    let base = try config(loadFixture("timelines").member("config"))
    var inputsRun = 0
    for requestCase in try fixture.member("cases").array() {
      let name = (try? requestCase.member("name").string()) ?? "?"
      for input in try requestCase.member("inputs").array() {
        let label = "\(name) \((try? input.member("id").string()) ?? "?")"
        do {
          let whole = try input.member("parts").array().flatMap(partBytes)
          let take = try input["take"]?.optional { try $0.integer(Int.self) } ?? whole.count
          guard (0...whole.count).contains(take) else { throw FixtureError(description: "take outside input") }
          var config = base
          config.capability = Array(
            try (input["capability"]?.optional { try $0.string() } ?? fixture.member("capability").string()).utf8)
          var service = LookOnlyService()
          XCTAssertEqual(service.step(.entered(config, entryAt: 1000), at: 1000), [.startListener], label)
          XCTAssertEqual(service.step(.listenerReady(port: 49152), at: 1200), [.logReady(port: 49152)], label)
          XCTAssertEqual(service.step(.accepted(conn: 1, loopback: true), at: 2000), [], label)
          let effects = service.step(.received(conn: 1, bytes: Array(whole.prefix(take))), at: 2001)
          inputsRun += 1
          let kind = try input.member("expect").member("kind").string()
          XCTAssertTrue(try disposition(kind, effects), "\(label): \(kind) gave \(effects.count) effects")
        } catch {
          XCTFail("\(label): \(error)")
        }
      }
    }
    XCTAssertEqual(inputsRun, 60)
  }
}
