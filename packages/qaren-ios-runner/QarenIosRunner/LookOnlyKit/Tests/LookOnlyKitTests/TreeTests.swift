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

  func optionalString() throws -> String? {
    switch self {
    case .null: return nil
    case .string(let text): return text
    default: throw FixtureError(description: "not a string or null")
    }
  }

  func string() throws -> String {
    guard let text = try optionalString() else { throw FixtureError(description: "null string") }
    return text
  }

  func number() throws -> Double {
    switch self {
    case .number(let value): return value
    case .string("inf"): return .infinity
    case .string("-inf"): return -.infinity
    case .string("nan"): return .nan
    default: throw FixtureError(description: "not a number")
    }
  }

  func count() throws -> Int {
    let value = try number()
    guard let whole = Int(exactly: value), whole >= 0 else { throw FixtureError(description: "bad count") }
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
}

private struct FixtureError: Error, CustomStringConvertible {
  let description: String
}

private func numbered(_ text: String?, _ k: Int?) -> String? {
  guard let k else { return text }
  return text?.replacingOccurrences(of: "#", with: String(k))
}

private func rawNode(_ json: JSON, _ defaults: JSON, k: Int?) throws -> LookOnlyRawNode {
  func member(_ key: String) throws -> JSON { try json[key] ?? defaults.member(key) }
  let frame = try member("frame").array().map { try $0.number() }
  guard frame.count == 4 else { throw FixtureError(description: "frame needs four numbers") }
  return LookOnlyRawNode(
    type: try member("type").string(),
    label: try numbered(member("label").string(), k)!,
    identifier: try numbered(member("identifier").string(), k)!,
    value: try numbered(member("value").optionalString(), k),
    frame: LookOnlyRect(x: frame[0], y: frame[1], width: frame[2], height: frame[3]),
    enabled: try member("enabled").bool(),
    selected: try member("selected").bool(),
    children: try rawChildren(member("children").array(), defaults))
}

private func rawChildren(_ items: [JSON], _ defaults: JSON) throws -> [LookOnlyRawNode] {
  try items.flatMap { item -> [LookOnlyRawNode] in
    if let repeated = item["repeat"] {
      let of = try item.member("of")
      return try (0..<repeated.count()).map { try rawNode(of, defaults, k: $0 + 1) }
    }
    if let chained = item["chain"] {
      let length = try chained.count()
      guard length > 0 else { throw FixtureError(description: "empty chain") }
      var link = try rawNode(item.member("of"), defaults, k: nil)
      link.children = try rawChildren(item.member("then").array(), defaults)
      for _ in 1..<length { link.children = [link] }
      return [link]
    }
    return [try rawNode(item, defaults, k: nil)]
  }
}

private func listNode(_ json: JSON, k: Int?, position: Int) throws -> LookOnlyNode {
  let rect = try json.member("rect")
  let parent: Int?
  switch try json.member("parent") {
  case .null: parent = nil
  case .string("previous"): parent = position - 1
  case let other: parent = try other.count()
  }
  return LookOnlyNode(
    type: try json.member("type").string(),
    label: try numbered(json.member("label").optionalString(), k),
    identifier: try json.member("identifier").optionalString(),
    rect: LookOnlyRect(
      x: try rect.member("x").number(), y: try rect.member("y").number(),
      width: try rect.member("width").number(), height: try rect.member("height").number()),
    enabled: try json.member("enabled").bool(),
    selected: try json.member("selected").bool(),
    parent: parent)
}

private func listNodes(_ json: JSON) throws -> [LookOnlyNode] {
  if case .array(let items) = json {
    return try items.enumerated().map { try listNode($1, k: nil, position: $0) }
  }
  var list = try listNodes(json.member("prefix"))
  let of = try json.member("of")
  for k in try 1..<(json.member("repeat").count() + 1) {
    list.append(try listNode(of, k: k, position: list.count))
  }
  return list
}

private func expected(_ json: JSON) throws -> LookOnlyTree {
  switch try json.member("kind").string() {
  case "nodes": return .nodes(try listNodes(json.member("nodes")))
  case "tooManyNodes": return .tooManyNodes
  case "unreadable": return .unreadable
  case let kind: throw FixtureError(description: "unknown kind \(kind)")
  }
}

private func rawTree(_ list: [LookOnlyNode], _ position: Int = 0) -> LookOnlyRawNode {
  let node = list[position]
  return LookOnlyRawNode(
    type: node.type.unicodeScalars.elementsEqual("Element".unicodeScalars) ? "Element(77)" : node.type,
    label: node.label ?? "", identifier: node.identifier ?? "", value: nil, frame: node.rect,
    enabled: node.enabled, selected: node.selected,
    children: list.indices.filter { list[$0].parent == position }.map { rawTree(list, $0) })
}

private func loadFixture() throws -> JSON {
  let url = try XCTUnwrap(
    Bundle.module.url(forResource: "trees", withExtension: "json", subdirectory: "Fixtures"))
  return try JSONDecoder().decode(JSON.self, from: Data(contentsOf: url))
}

final class TreeTests: XCTestCase {
  func testExportCases() throws {
    let fixture = try loadFixture()
    let defaults = try fixture.member("defaults")
    var casesRun = 0
    for (offset, exportCase) in try fixture.member("export").array().enumerated() {
      let label = "E\(offset + 1) \((try? exportCase.member("name").string()) ?? "?")"
      do {
        let result = lookOnlyExport(try rawNode(exportCase.member("tree"), defaults, k: nil))
        let want = try expected(exportCase.member("expect"))
        casesRun += 1
        XCTAssertEqual(result, want, label)
        if case .nodes(let list) = result {
          XCTAssertTrue(lookOnlyPossible(list), "\(label): exported list is not possible")
        }
      } catch {
        XCTFail("\(label): \(error)")
      }
    }
    XCTAssertEqual(casesRun, 24)
  }

  func testPossibleLists() throws {
    let fixture = try loadFixture()
    var casesRun = 0
    for (offset, listCase) in try fixture.member("lists").array().enumerated() {
      let label = "L\(offset + 1) \((try? listCase.member("name").string()) ?? "?")"
      do {
        let list = try listNodes(listCase.member("nodes"))
        let breaks = try listCase.member("breaks").count()
        casesRun += 1
        XCTAssertEqual(lookOnlyPossible(list), breaks == 0, "\(label): breaks \(breaks)")
        if breaks == 0 {
          XCTAssertEqual(lookOnlyExport(rawTree(list)), .nodes(list), "\(label): rebuilt tree")
        }
      } catch {
        XCTFail("\(label): \(error)")
      }
    }
    XCTAssertEqual(casesRun, 31)
  }
}
