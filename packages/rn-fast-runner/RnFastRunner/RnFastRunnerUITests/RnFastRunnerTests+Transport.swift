import XCTest
import Network

extension RnFastRunnerTests {
  // MARK: - Connection Lifecycle

  func handle(connection: NWConnection) {
    receiveRequest(connection: connection, buffer: Data())
  }

  // MARK: - Request Parsing

  private func receiveRequest(connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1024 * 1024) { [weak self] data, _, _, _ in
      guard let self = self, let data = data else {
        connection.cancel()
        return
      }
      if buffer.count + data.count > self.maxRequestBytes {
        let response = self.jsonResponse(
          status: 413,
          response: Response(ok: false, error: ErrorPayload(message: "request too large"))
        )
        self.sendResponse(response, over: connection) { [weak self] in
          self?.finish()
        }
        return
      }
      let combined = buffer + data
      guard combined.range(of: Data("\r\n\r\n".utf8)) != nil else {
        self.receiveRequest(connection: connection, buffer: combined)
        return
      }
      if !self.isAuthorized(combined) {
        let response = self.jsonResponse(
          status: 401,
          response: Response(
            ok: false,
            error: ErrorPayload(code: "RUNNER_OWNERSHIP_MISMATCH", message: "invalid runner capability")
          )
        )
        self.sendResponse(response, over: connection)
        return
      }
      if self.isHealthRequest(combined) {
        let wedged = self.isRunnerWedged()
        let response = self.jsonResponse(
          status: 200,
          response: Response(
            ok: !wedged,
            reason: wedged ? "wedged" : nil,
            protocolVersion: RunnerProtocol.version,
            runnerVersion: RunnerEnv.pluginVersion(),
            capabilities: QuiescenceStatus.current().capabilities
              + ["SCREEN_STATIC", "HONEST_HITTABLE", "EXACT_KEYBOARD_TARGET_GUARD", "PLATFORM_PRESENCE_V2", "QA_READ_ONLY_V1", "FILL_EVIDENCE_V1", "HIT_TESTED_DISPATCH_V1", "TARGET_FRAME_GUARD_V1", "SNAPSHOT_FIDELITY_V1", "SYSTEM_ALERT_TAP_V1"],
            commands: CommandType.allCases.map(\.rawValue),
            instanceId: RunnerEnv.instanceId(),
            sessionId: RunnerEnv.sessionId(),
            claimEpoch: RunnerEnv.claimEpoch(),
            deviceId: RunnerEnv.deviceId(),
            appId: RunnerEnv.appId()
          )
        )
        self.sendResponse(response, over: connection)
        return
      }
      switch self.parseRequest(data: combined) {
      case .body(let body):
        let result = self.handleRequestBody(body)
        self.sendResponse(result.data, over: connection) { [weak self] in
          if result.shouldFinish {
            self?.finish()
          }
        }
      case .invalid:
        let response = self.jsonResponse(
          status: 400,
          response: Response(ok: false, error: ErrorPayload(message: "invalid Content-Length"))
        )
        self.sendResponse(response, over: connection)
      case .incomplete:
        self.receiveRequest(connection: connection, buffer: combined)
      }
    }
  }

  private func sendResponse(
    _ response: Data,
    over connection: NWConnection,
    afterSend: @escaping () -> Void = {}
  ) {
    connection.send(content: response, isComplete: true, completion: .contentProcessed { error in
      if let error {
        NSLog("RN_FAST_RUNNER_SEND_FAILED=%@", String(describing: error))
      }
      connection.cancel()
      afterSend()
    })
  }

  private func isHealthRequest(_ data: Data) -> Bool {
    guard data.range(of: Data("\r\n\r\n".utf8)) != nil else { return false }
    let head = String(decoding: data.prefix(200), as: UTF8.self)
    let firstLine = head.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? head
    return firstLine.hasPrefix("GET /health")
  }

  private func isAuthorized(_ data: Data) -> Bool {
    guard let capability = RunnerEnv.capability(), !capability.isEmpty,
          let headerEnd = data.range(of: Data("\r\n\r\n".utf8))
    else {
      return false
    }
    let headers = String(decoding: data.subdata(in: 0..<headerEnd.lowerBound), as: UTF8.self)
    return headers.split(separator: "\r\n").contains { line in
      let parts = line.split(separator: ":", maxSplits: 1)
      return parts.count == 2
        && parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "authorization"
        && parts[1].trimmingCharacters(in: .whitespaces) == "Bearer \(capability)"
    }
  }

  enum ParseOutcome {
    case incomplete
    case invalid
    case body(Data)
  }

  private func parseRequest(data: Data) -> ParseOutcome {
    guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else {
      return .incomplete
    }
    let headerData = data.subdata(in: 0..<headerEnd.lowerBound)
    let bodyStart = headerEnd.upperBound
    let headers = String(decoding: headerData, as: UTF8.self)
    // Reject malformed lengths before range arithmetic.
    guard let contentLength = extractContentLength(headers: headers),
          contentLength >= 0, contentLength <= maxRequestBytes
    else {
      return .invalid
    }
    if data.count < bodyStart + contentLength {
      return .incomplete
    }
    return .body(data.subdata(in: bodyStart..<(bodyStart + contentLength)))
  }

  private func extractContentLength(headers: String) -> Int? {
    for line in headers.split(separator: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if parts.count == 2 && parts[0].lowercased() == "content-length" {
        return Int(parts[1])
      }
    }
    return nil
  }

  private func handleRequestBody(_ body: Data) -> (data: Data, shouldFinish: Bool) {
    guard let json = String(data: body, encoding: .utf8) else {
      return (
        jsonResponse(status: 400, response: Response(ok: false, error: ErrorPayload(message: "invalid json"))),
        false
      )
    }
    guard let data = json.data(using: .utf8) else {
      return (
        jsonResponse(status: 400, response: Response(ok: false, error: ErrorPayload(message: "invalid json"))),
        false
      )
    }

    struct CommandProbe: Decodable {
      let command: String
      let commandId: String?
    }
    let probe = try? JSONDecoder().decode(CommandProbe.self, from: data)

    if let probe, CommandType(rawValue: probe.command) == nil {
      // GH #418: a verb this artifact doesn't know is a typed refusal, not a
      // dataCorrupted decode error (B235). Mirrors the Android runner's shape.
      return (
        jsonResponse(status: 200, response: Response(
          ok: false,
          error: ErrorPayload(
            code: "UNSUPPORTED_COMMAND",
            message: "Unsupported iOS runner command: \(probe.command) — the runner artifact predates it; re-open the device session (device_snapshot action=open) to rebuild."
          )
        )),
        false
      )
    }

    // Story 14 (#407): outcome probe — answered from the journal, no execute().
    if probe?.command == CommandType.status.rawValue {
      return (statusResponse(commandId: probe?.commandId), false)
    }

    // Decode failures never reach execution — mutation is provably "none".
    let command: Command
    do {
      command = try JSONDecoder().decode(Command.self, from: data)
    } catch {
      let response = Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGUMENT", message: "command failed to decode", mutation: "none")
      )
      let body = encodeBody(response)
      commandJournal.record(commandId: probe?.commandId, command: probe?.command, ok: false, body: body)
      return (httpResponse(status: 400, body: String(decoding: body, as: UTF8.self)), false)
    }
    do {
      let response = try execute(command: command)
      let body = encodeBody(response)
      commandJournal.record(commandId: probe?.commandId, command: probe?.command, ok: response.ok, body: body)
      return (httpResponse(status: 200, body: String(decoding: body, as: UTF8.self)), command.command == .shutdown)
    } catch {
      let response = Response(ok: false, error: runnerErrorPayload(error, command: probe?.command))
      let body = encodeBody(response)
      commandJournal.record(commandId: probe?.commandId, command: probe?.command, ok: false, body: body)
      return (httpResponse(status: 500, body: String(decoding: body, as: UTF8.self)), false)
    }
  }

  // MARK: - Response Encoding

  private func encodeBody(_ response: Response) -> Data {
    (try? JSONEncoder().encode(response)) ?? Data("{}".utf8)
  }

  // The recorded body is spliced back verbatim as data.result — Codable models
  // cannot express "arbitrary recorded JSON", so this one response is built via
  // JSONSerialization.
  private func statusResponse(commandId: String?) -> Data {
    guard let id = commandId, !id.isEmpty else {
      return jsonResponse(status: 200, response: Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGUMENT", message: "status requires a non-blank 'commandId'")
      ))
    }
    let entry = commandJournal.lookup(commandId: id)
    var data: [String: Any] = ["commandId": id, "state": entry?.state ?? "unknown"]
    if let body = entry?.body,
       let parsed = try? JSONSerialization.jsonObject(with: body) {
      data["result"] = parsed
    }
    let payload: [String: Any] = ["ok": true, "v": RunnerProtocol.version, "data": data]
    let encoded = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8)
    return httpResponse(status: 200, body: String(decoding: encoded, as: UTF8.self))
  }

  private func jsonResponse(status: Int, response: Response) -> Data {
    let encoder = JSONEncoder()
    let body = (try? encoder.encode(response)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    return httpResponse(status: status, body: body)
  }

  private func httpResponse(status: Int, body: String) -> Data {
    let headers = [
      "HTTP/1.1 \(status) OK",
      "Content-Type: application/json",
      "Content-Length: \(body.utf8.count)",
      "Connection: close",
      "",
      body
    ].joined(separator: "\r\n")
    return Data(headers.utf8)
  }

  private func finish() {
    listener?.cancel()
    listener = nil
    doneExpectation?.fulfill()
  }
}
