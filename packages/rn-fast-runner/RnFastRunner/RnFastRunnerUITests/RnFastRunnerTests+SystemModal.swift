import XCTest

extension RnFastRunnerTests {
  // MARK: - Blocking System Modal Snapshot

  func blockingSystemAlertSnapshot() -> DataPayload? {
    #if os(macOS)
      return nil
    #else
    guard let modal = firstBlockingSystemModal(in: springboard) else {
      return nil
    }
    let actions = actionableElements(in: modal)
    guard !actions.isEmpty else {
      return nil
    }

    let title = preferredSystemModalTitle(modal)
    guard let modalNode = safeMakeSnapshotNode(
      element: modal,
      index: 0,
      type: "Alert",
      labelOverride: title,
      identifierOverride: modal.identifier,
      depth: 0,
      hittableOverride: true
    ) else {
      return nil
    }
    var nodes: [SnapshotNode] = [modalNode]

    for action in actions {
      guard let actionNode = safeMakeSnapshotNode(
        element: action,
        index: nodes.count,
        type: elementTypeName(action.elementType),
        depth: 1,
        hittableOverride: true
      ) else {
        continue
      }
      nodes.append(actionNode)
    }

    return DataPayload(nodes: nodes, truncated: false)
    #endif
  }

  // Taps the SpringBoard button element itself; never a coordinate through the app, never app activation.
  func systemAlertTap(label: String?) -> Response {
    #if os(macOS) || os(tvOS)
      return Response(ok: false, error: ErrorPayload(code: "UNSUPPORTED", message: "system alert taps are iOS-only", mutation: "none"))
    #else
    let refuse = { (code: String, message: String) in
      Response(ok: false, error: ErrorPayload(code: code, message: "\(code): \(message); nothing was tapped", mutation: "none"))
    }
    guard let label, !label.isEmpty else {
      return refuse("INVALID_ARGUMENT", "systemAlertTap requires the chosen button label")
    }
    // The tap changes the screen, so a recorded type target no longer holds.
    lastExactTypeTarget = nil
    guard let modal = firstBlockingSystemModal(in: springboard),
          let tapped = systemModalSignature(modal) else {
      return refuse("SYSTEM_ALERT_NOT_FOUND", "no readable blocking system alert is in front")
    }
    let actions = actionableElements(in: modal)
    let labels = actions.map { $0.label }
    let index: Int
    switch SystemAlertTap.resolve(labels: labels, chosen: label) {
    case .notFound:
      return refuse("SYSTEM_ALERT_BUTTON_NOT_FOUND", "the alert has no button with exactly that label")
    case .ambiguous(let count):
      return refuse("SYSTEM_ALERT_BUTTON_AMBIGUOUS", "the alert has \(count) buttons with that label")
    case .button(let found):
      index = found
    }
    let button = actions[index]
    let frame = button.frame
    var unchanged = false
    let revalidation = RunnerObjCExceptionCatcher.catchException({
      unchanged = button.exists && button.label == label
    })
    guard revalidation == nil, unchanged,
          let front = firstBlockingSystemModal(in: springboard),
          systemModalSignature(front) == tapped else {
      return refuse("SYSTEM_ALERT_CHANGED", "the alert or its button changed before the tap")
    }
    if let exception = RunnerObjCExceptionCatcher.catchException({ button.tap() }) {
      return Response(ok: false, error: ErrorPayload(
        code: "SYSTEM_ALERT_TAP_FAILED",
        message: "SYSTEM_ALERT_TAP_FAILED: the alert button tap raised \(exception)",
        mutation: "possible"
      ))
    }
    let deadline = ProcessInfo.processInfo.systemUptime + 2.0
    var closed = false
    repeat {
      closed = SystemAlertTap.closed(tapped: tapped, observed: observeSystemModals())
      if !closed { sleepFor(0.1) }
    } while !closed && ProcessInfo.processInfo.systemUptime < deadline
    var data = DataPayload(message: "tapped")
    data.tappedLabel = labels[index]
    data.tappedRect = SnapshotRect(
      x: Double(frame.origin.x), y: Double(frame.origin.y),
      width: Double(frame.width), height: Double(frame.height)
    )
    data.alertClosed = closed
    return Response(ok: true, data: data)
    #endif
  }

  #if !os(macOS) && !os(tvOS)
  // Unlike the safe probes, an exception here is reported, never read as an empty alert.
  private func systemModalSignature(_ modal: XCUIElement) -> SystemAlertTap.Signature? {
    var signature: SystemAlertTap.Signature?
    let exception = RunnerObjCExceptionCatcher.catchException({
      signature = SystemAlertTap.Signature(
        title: modal.label,
        buttons: modal.buttons.allElementsBoundByIndex.map { $0.label }
      )
    })
    return exception == nil ? signature : nil
  }

  private func observeSystemModals() -> SystemAlertTap.Observation {
    var modals: [XCUIElement] = []
    let exception = RunnerObjCExceptionCatcher.catchException({
      modals = self.springboard.alerts.allElementsBoundByIndex + self.springboard.sheets.allElementsBoundByIndex
    })
    guard exception == nil else { return .unreadable }
    var signatures: [SystemAlertTap.Signature] = []
    for modal in modals {
      guard let signature = systemModalSignature(modal) else { return .unreadable }
      signatures.append(signature)
    }
    return .modals(signatures)
  }
  #endif

  private func firstBlockingSystemModal(in springboard: XCUIApplication) -> XCUIElement? {
    let disableSafeProbe = RunnerEnv.isTruthy("RN_FAST_RUNNER_DISABLE_SAFE_MODAL_PROBE")
    let queryElements: (() -> [XCUIElement]) -> [XCUIElement] = { fetch in
      if disableSafeProbe {
        return fetch()
      }
      return self.safeElementsQuery(fetch)
    }

    let alerts = queryElements {
      springboard.alerts.allElementsBoundByIndex
    }
    for alert in alerts {
      if safeIsBlockingSystemModal(alert, in: springboard) {
        return alert
      }
    }

    let sheets = queryElements {
      springboard.sheets.allElementsBoundByIndex
    }
    for sheet in sheets {
      if safeIsBlockingSystemModal(sheet, in: springboard) {
        return sheet
      }
    }

    return nil
  }

  private func safeElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    var elements: [XCUIElement] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      elements = fetch()
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_MODAL_QUERY_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return []
    }
    return elements
  }

  private func safeIsBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    var isBlocking = false
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      isBlocking = isBlockingSystemModal(element, in: springboard)
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_MODAL_CHECK_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return false
    }
    return isBlocking
  }

  private func isBlockingSystemModal(_ element: XCUIElement, in springboard: XCUIApplication) -> Bool {
    guard element.exists else { return false }
    let frame = element.frame
    if frame.isNull || frame.isEmpty { return false }

    let viewport = springboard.frame
    if viewport.isNull || viewport.isEmpty { return false }

    let center = CGPoint(x: frame.midX, y: frame.midY)
    if !viewport.contains(center) { return false }

    return true
  }

  private func actionableElements(in element: XCUIElement) -> [XCUIElement] {
    var seen = Set<String>()
    var actions: [XCUIElement] = []
    let descendants = safeElementsQuery {
      element.descendants(matching: .any).allElementsBoundByIndex
    }
    for candidate in descendants {
      if !safeIsActionableCandidate(candidate, seen: &seen) { continue }
      actions.append(candidate)
    }
    return actions
  }

  private func safeIsActionableCandidate(_ candidate: XCUIElement, seen: inout Set<String>) -> Bool {
    var include = false
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !candidate.exists || !candidate.isHittable { return }
      if !actionableTypes.contains(candidate.elementType) { return }
      let frame = candidate.frame
      if frame.isNull || frame.isEmpty { return }
      let key = "\(candidate.elementType.rawValue)-\(frame.origin.x)-\(frame.origin.y)-\(frame.size.width)-\(frame.size.height)-\(candidate.label)"
      if seen.contains(key) { return }
      seen.insert(key)
      include = true
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_MODAL_ACTION_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return false
    }
    return include
  }

  private func preferredSystemModalTitle(_ element: XCUIElement) -> String {
    let label = element.label
    if !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return label
    }
    let identifier = element.identifier
    if !identifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return identifier
    }
    return "System Alert"
  }

  private func makeSnapshotNode(
    element: XCUIElement,
    index: Int,
    type: String,
    labelOverride: String? = nil,
    identifierOverride: String? = nil,
    depth: Int,
    hittableOverride: Bool? = nil
  ) -> SnapshotNode {
    let label = (labelOverride ?? element.label).trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = (identifierOverride ?? element.identifier).trimmingCharacters(in: .whitespacesAndNewlines)
    return SnapshotNode(
      index: index,
      type: type,
      label: label.isEmpty ? nil : label,
      identifier: identifier.isEmpty ? nil : identifier,
      value: nil,
      rect: snapshotRect(from: element.frame),
      enabled: element.isEnabled,
      focused: elementHasFocus(element) ? true : nil,
      hittable: hittableOverride ?? element.isHittable,
      depth: depth,
      parentIndex: nil,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil
    )
  }

  private func safeMakeSnapshotNode(
    element: XCUIElement,
    index: Int,
    type: String,
    labelOverride: String? = nil,
    identifierOverride: String? = nil,
    depth: Int,
    hittableOverride: Bool? = nil
  ) -> SnapshotNode? {
    var node: SnapshotNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      node = makeSnapshotNode(
        element: element,
        index: index,
        type: type,
        labelOverride: labelOverride,
        identifierOverride: identifierOverride,
        depth: depth,
        hittableOverride: hittableOverride
      )
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_MODAL_NODE_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return nil
    }
    return node
  }
}
