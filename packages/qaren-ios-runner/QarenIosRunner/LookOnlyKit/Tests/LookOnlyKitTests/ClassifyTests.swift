import Foundation
import LookOnlyKit
import XCTest

private struct Fixture: Decodable {
  let capability: String
  let cases: [FixtureCase]
}

private struct FixtureCase: Decodable {
  let name: String
  let inputs: [FixtureInput]
}

private struct FixtureInput: Decodable {
  let id: String
  let parts: [FixturePart]
  let take: Int?
  let capability: String?
  let expect: FixtureExpect
}

private struct FixturePart: Decodable {
  let text: String?
  let hex: String?
  let `repeat`: String?
  let count: Int?
  let utf16le: String?
}

private struct FixtureExpect: Decodable {
  let kind: String
  let session: String?
  let bundleId: String?
  let processId: Int32?
  let seq: Int32?
}

private struct FixtureError: Error, CustomStringConvertible {
  let description: String
}

private func ascii(_ text: String) throws -> [UInt8] {
  if let data = text.data(using: .ascii) { return Array(data) }
  throw FixtureError(description: "non-ASCII text \(text.debugDescription)")
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

private func bytes(of part: FixturePart) throws -> [UInt8] {
  switch (part.text, part.hex, part.repeat, part.count, part.utf16le) {
  case (let text?, nil, nil, nil, nil):
    return try ascii(text)
  case (nil, let hex?, nil, nil, nil):
    return try hexBytes(hex)
  case (nil, nil, let unit?, let count?, nil) where count >= 0:
    return Array(repeating: try ascii(unit), count: count).flatMap { $0 }
  case (nil, nil, nil, nil, let text?):
    return try ascii(text).flatMap { [$0, 0] }
  default:
    throw FixtureError(description: "unknown part shape")
  }
}

private func expected(_ expect: FixtureExpect) throws -> LookOnlyInput {
  switch (expect.kind, expect.session, expect.bundleId, expect.processId, expect.seq) {
  case ("incomplete", nil, nil, nil, nil): return .incomplete
  case ("overLimit", nil, nil, nil, nil): return .overLimit
  case ("unauthorized", nil, nil, nil, nil): return .unauthorized
  case ("badRequest", nil, nil, nil, nil): return .badRequest
  case ("health", nil, nil, nil, nil): return .health
  case ("bind", let session?, let bundleId?, let processId?, nil):
    return .bind(session: try ascii(session), bundleId: try ascii(bundleId), processId: processId)
  case ("observe", let session?, nil, nil, let seq?):
    return .observe(session: try ascii(session), seq: seq)
  case ("shutdown", let session?, nil, nil, nil):
    return .shutdown(session: try ascii(session))
  default:
    throw FixtureError(description: "unexpected expectation for \(expect.kind)")
  }
}

final class ClassifyTests: XCTestCase {
  func testRequestLinesFixture() throws {
    let url = try XCTUnwrap(
      Bundle.module.url(forResource: "request-lines", withExtension: "json", subdirectory: "Fixtures"))
    let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))

    var casesRun = Set<Int>()
    var inputsRun = 0
    var inputsMatched = 0
    for (offset, fixtureCase) in fixture.cases.enumerated() {
      for input in fixtureCase.inputs {
        let label = "\(offset + 1)\(input.id) \(fixtureCase.name)"
        do {
          let whole = try input.parts.flatMap(bytes(of:))
          let take = input.take ?? whole.count
          guard (0...whole.count).contains(take) else { throw FixtureError(description: "take outside input") }
          let result = lookOnlyClassify(
            received: Array(whole.prefix(take)),
            capability: try ascii(input.capability ?? fixture.capability))
          inputsRun += 1
          casesRun.insert(offset)
          let want = try expected(input.expect)
          if result == want { inputsMatched += 1 }
          XCTAssertEqual(result, want, label)
        } catch {
          XCTFail("\(label): \(error)")
        }
      }
    }

    print("LookOnlyKit fixture: \(inputsMatched) of \(inputsRun) inputs matched in \(casesRun.count) cases")
    XCTAssertEqual(casesRun.count, 24)
    XCTAssertEqual(inputsRun, 60)
  }
}
