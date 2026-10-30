import XCTest

final class CommandJournalTests: XCTestCase {
  func testRecordsAndLooksUpOutcomes() {
    let j = CommandJournal()
    j.record(commandId: "c-1", command: "tap", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-2", command: "tap", ok: false, body: Data("{\"ok\":false}".utf8))
    XCTAssertEqual(j.lookup(commandId: "c-1")?.state, "completed")
    XCTAssertEqual(j.lookup(commandId: "c-1")?.body, Data("{\"ok\":true}".utf8))
    XCTAssertEqual(j.lookup(commandId: "c-2")?.state, "failed")
    XCTAssertNil(j.lookup(commandId: "c-404"))
  }

  func testSkipsMissingIdsAndStatusCommands() {
    let j = CommandJournal()
    j.record(commandId: nil, command: "tap", ok: true, body: Data())
    j.record(commandId: "", command: "tap", ok: true, body: Data())
    j.record(commandId: "c-s", command: "status", ok: true, body: Data())
    XCTAssertNil(j.lookup(commandId: ""))
    XCTAssertNil(j.lookup(commandId: "c-s"))
  }

  func testRetainsStateButNotBodyForSnapshotScreenshotAndOversized() {
    let j = CommandJournal(capacity: 32, maxRetainedBytes: 16)
    j.record(commandId: "c-snap", command: "snapshot", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-shot", command: "screenshot", ok: true, body: Data("{\"ok\":true}".utf8))
    j.record(commandId: "c-big", command: "tap", ok: true, body: Data(repeating: 120, count: 64))
    XCTAssertEqual(j.lookup(commandId: "c-snap")?.state, "completed")
    XCTAssertNil(j.lookup(commandId: "c-snap")?.body)
    XCTAssertNil(j.lookup(commandId: "c-shot")?.body)
    XCTAssertEqual(j.lookup(commandId: "c-big")?.state, "completed")
    XCTAssertNil(j.lookup(commandId: "c-big")?.body)
  }

  func testEvictsOldestBeyondCapacity() {
    let j = CommandJournal(capacity: 3)
    for i in 1...5 { j.record(commandId: "c-\(i)", command: "tap", ok: true, body: Data("{}".utf8)) }
    XCTAssertNil(j.lookup(commandId: "c-1"))
    XCTAssertNil(j.lookup(commandId: "c-2"))
    XCTAssertEqual(j.lookup(commandId: "c-3")?.state, "completed")
    XCTAssertEqual(j.lookup(commandId: "c-5")?.state, "completed")
  }
}
