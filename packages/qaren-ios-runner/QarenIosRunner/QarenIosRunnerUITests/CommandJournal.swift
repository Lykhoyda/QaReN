import Foundation

// Story 14 (#407): bounded journal of recent /command outcomes so the client
// can distinguish "never executed" from "executed, response lost" after an
// ambiguous transport failure. All access happens on the runner's single
// serial dispatch queue ("qaren-ios-runner.runner"), so no locking is needed.
// Heavy payloads (snapshot nodes, screenshot base64) keep only their state —
// both verbs are read-only, so the client may safely re-send instead.
final class CommandJournal {
  struct Entry {
    let state: String
    let body: Data?
  }

  private let capacity: Int
  private let maxRetainedBytes: Int
  private var order: [String] = []
  private var entries: [String: Entry] = [:]

  init(capacity: Int = 32, maxRetainedBytes: Int = 8192) {
    self.capacity = capacity
    self.maxRetainedBytes = maxRetainedBytes
  }

  func record(commandId: String?, command: String?, ok: Bool, body: Data) {
    guard let id = commandId, !id.isEmpty, command != "status" else { return }
    let retain = command != "snapshot" && command != "screenshot" && body.count <= maxRetainedBytes
    if entries[id] == nil { order.append(id) }
    entries[id] = Entry(state: ok ? "completed" : "failed", body: retain ? body : nil)
    while order.count > capacity {
      let oldest = order.removeFirst()
      entries.removeValue(forKey: oldest)
    }
  }

  func lookup(commandId: String) -> Entry? {
    entries[commandId]
  }
}
