import XCTest

// MARK: - Interaction Outcome

enum RunnerInteractionOutcome {
  case performed
  case unsupported(String)
}

enum KeyboardGuardAction {
  case proceed(String)
  case keyboardTarget(RetainedSnapshotTarget, CGPoint)
  case targetStale
  case dismissFailed
  case relayoutRequired
}

// MARK: - tvOS Remote Stubs
//
// The TvRemote module was intentionally dropped at import time (see
// IMPORT_NOTES.md). This plugin targets iOS Simulator and does not exercise
// tvOS code paths. The stubs below preserve the call sites in the rest of the
// imported code while always returning the "unsupported" answer; the iOS
// branches in #if !os(tvOS) blocks remain fully functional.

enum TvRemoteButton {
  case menu
  case home
  case select
  case up
  case down
  case left
  case right
}

extension RnFastRunnerTests {
  @discardableResult
  func pressTvRemote(_ button: TvRemoteButton, duration: TimeInterval = 0) -> Bool {
    return false
  }

  func tvRemoteButton(from name: String?) -> TvRemoteButton? {
    return nil
  }

  func selectFocusedTvElement(
    app: XCUIApplication,
    point: CGPoint,
    action: String
  ) -> RunnerInteractionOutcome? {
    return nil
  }

  func longSelectFocusedTvElement(
    app: XCUIApplication,
    point: CGPoint,
    duration: TimeInterval
  ) -> RunnerInteractionOutcome? {
    return nil
  }

  func resolveTvRemoteDoublePressDelay() -> TimeInterval {
    return 0
  }

  func elementHasFocus(_ element: XCUIElement) -> Bool {
    return false
  }

  func activateElement(
    app: XCUIApplication,
    element: XCUIElement,
    action: String
  ) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("\(action) is not supported on tvOS; move focus with swipe or scroll, then select the focused element")
#else
    if element.isHittable {
      element.tap()
      return .performed
    }
    let frame = element.frame
    if !frame.isEmpty {
      return tapAt(app: app, x: frame.midX, y: frame.midY)
    }
    return .unsupported("\(action) failed: element has no hittable frame")
#endif
  }
}

extension RnFastRunnerTests {
  struct TouchVisualizationFrame {
    let x: Double
    let y: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  struct DragVisualizationFrame {
    let x: Double
    let y: Double
    let x2: Double
    let y2: Double
    let referenceWidth: Double
    let referenceHeight: Double
  }

  // MARK: - Navigation Gestures

  func tapInAppBackControl(app: XCUIApplication) -> Bool {
#if os(macOS)
    if let back = macOSNavigationBackElement(app: app) {
      tapElementCenter(app: app, element: back)
      return true
    }
    return false
#elseif os(tvOS)
    _ = pressTvRemote(.menu)
    return true
#else
    let buttons = app.navigationBars.buttons.allElementsBoundByIndex
    if let back = buttons.first(where: { $0.isHittable }) {
      back.tap()
      return true
    }
    return false
#endif
  }

  func performBackGesture(app: XCUIApplication) {
    if pressTvRemote(.menu) {
      return
    }
    performCoordinateBackGesture(app: app)
  }

  private func performCoordinateBackGesture(app: XCUIApplication) {
#if !os(tvOS)
    let target = app.windows.firstMatch.exists ? app.windows.firstMatch : app
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
    start.press(forDuration: 0.05, thenDragTo: end)
#endif
  }

  func performSystemBackAction(app: XCUIApplication) -> Bool {
#if os(macOS)
    return false
#else
    if pressTvRemote(.menu) {
      return true
    }
    performBackGesture(app: app)
    return true
#endif
  }

  func performAppSwitcherGesture(app: XCUIApplication) {
    if pressTvRemote(.home) {
      sleepFor(resolveTvRemoteDoublePressDelay())
      _ = pressTvRemote(.home)
      return
    }
    performCoordinateAppSwitcherGesture(app: app)
  }

  private func performCoordinateAppSwitcherGesture(app: XCUIApplication) {
#if !os(tvOS)
    let target = app.windows.firstMatch.exists ? app.windows.firstMatch : app
    let start = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.99))
    let end = target.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.7))
    start.press(forDuration: 0.6, thenDragTo: end)
#endif
  }

  func pressHomeButton() {
#if os(macOS)
    return
#else
    if pressTvRemote(.home) {
      return
    }
    XCUIDevice.shared.press(.home)
#endif
  }

  func rotateDevice(to orientationName: String) -> Bool {
#if os(macOS) || os(tvOS)
    return false
#else
    switch orientationName {
    case "portrait":
      XCUIDevice.shared.orientation = .portrait
    case "portrait-upside-down":
      XCUIDevice.shared.orientation = .portraitUpsideDown
    case "landscape-left":
      XCUIDevice.shared.orientation = .landscapeLeft
    case "landscape-right":
      XCUIDevice.shared.orientation = .landscapeRight
    default:
      return false
    }
    sleepFor(0.2)
    return true
#endif
  }

  func findElement(app: XCUIApplication, text: String) -> XCUIElement? {
    let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@ OR value CONTAINS[c] %@", text, text, text)
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }

  func readTextAt(app: XCUIApplication, x: Double, y: Double) -> String? {
    let point = CGPoint(x: x, y: y)
    let candidates = app.descendants(matching: .any).allElementsBoundByIndex
      .filter { element in
        element.exists && !element.frame.isEmpty && element.frame.contains(point)
      }
      .sorted { left, right in
        let leftArea = max(1, left.frame.width * left.frame.height)
        let rightArea = max(1, right.frame.width * right.frame.height)
        if leftArea != rightArea {
          return leftArea < rightArea
        }
        if left.frame.minY != right.frame.minY {
          return left.frame.minY < right.frame.minY
        }
        if left.frame.minX != right.frame.minX {
          return left.frame.minX < right.frame.minX
        }
        return left.elementType.rawValue < right.elementType.rawValue
      }

    for element in candidates where prefersExpandedTextRead(element) {
      if let text = readableText(for: element) {
        return text
      }
    }
    for element in candidates {
      if let text = readableText(for: element) {
        return text
      }
    }
    return nil
  }

  func clearTextInput(_ element: XCUIElement) {
#if !os(tvOS)
    moveCaretToEnd(element: element)
#endif
    let count = estimatedDeleteCount(for: element)
    let deletes = String(repeating: XCUIKeyboardKey.delete.rawValue, count: count)
    element.typeText(deletes)
  }

  // MARK: - Exact text-input targeting (GH #581)

  struct ExactInputDescriptor {
    let generation: Int?
    let type: String
    let identifier: String?
    let label: String?
    let rect: CGRect
  }

  enum ExactInputResolution {
    case bound(XCUIElement)
    case ambiguous
    case absent
  }

  static let exactInputElementTypes: [XCUIElement.ElementType] = [
    .textField, .secureTextField, .searchField, .textView,
  ]

  private func liveInputCandidates(app: XCUIApplication) -> [XCUIElement] {
    var candidates: [XCUIElement] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      let rawValues = Self.exactInputElementTypes.map { $0.rawValue }
      let predicate = NSPredicate(format: "elementType IN %@", rawValues)
      candidates = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
        .filter { $0.exists && !$0.frame.isEmpty }
    })
    if exceptionMessage != nil { return [] }
    return candidates
  }

  func resolveExactTextInput(
    app: XCUIApplication,
    descriptor: ExactInputDescriptor,
    sameGeneration: Bool,
    requireFrameMatch: Bool = false
  ) -> ExactInputResolution {
    let live = liveInputCandidates(app: app)
    // Fail closed if any candidate's attributes cannot be read exception-safely.
    let attributes = live.compactMap { liveAttributes(of: $0) }
    guard attributes.count == live.count else { return .absent }
    switch TextInputTarget.resolve(
      candidates: attributes,
      descriptorType: descriptor.type,
      descriptorIdentifier: descriptor.identifier,
      descriptorLabel: descriptor.label,
      descriptorRect: descriptor.rect,
      sameGeneration: sameGeneration,
      requireFrameMatch: requireFrameMatch
    ) {
    case .unique(let index):
      return .bound(live[index])
    case .ambiguous:
      return .ambiguous
    case .absent:
      return .absent
    }
  }

  func liveAttributes(of element: XCUIElement) -> TextInputTarget.CandidateAttributes? {
    var attributes: TextInputTarget.CandidateAttributes?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      attributes = TextInputTarget.CandidateAttributes(
        type: elementTypeName(element.elementType),
        identifier: identifier.isEmpty ? nil : identifier,
        label: label.isEmpty ? nil : label,
        frame: element.frame
      )
    })
    if exceptionMessage != nil { return nil }
    return attributes
  }

  func resolveRecordedTextInput(
    app: XCUIApplication,
    recorded: TextInputTarget.CandidateAttributes
  ) -> ExactInputResolution {
    let live = liveInputCandidates(app: app)
    let attributes = live.compactMap { liveAttributes(of: $0) }
    guard attributes.count == live.count else { return .absent }
    switch TextInputTarget.resolveByRecordedAttributes(candidates: attributes, recorded: recorded) {
    case .unique(let index):
      return .bound(live[index])
    case .ambiguous:
      return .ambiguous
    case .absent:
      return .absent
    }
  }

  // Operation-fresh proof that the keyboard-focused input IS the bound
  // element: type, identifier, label, and live frame midpoint must all agree.
  func isExactInputFocused(app: XCUIApplication, element: XCUIElement) -> Bool {
    guard let focused = focusedTextInput(app: app) else { return false }
    var same = false
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      guard focused.elementType == element.elementType else { return }
      guard focused.identifier == element.identifier else { return }
      guard focused.label == element.label else { return }
      same = TextInputTarget.framesMatch(focused.frame, element.frame)
    })
    if exceptionMessage != nil { return false }
    return same
  }

  // Polls the ALREADY-BOUND element handle — never rebinds to a replacement
  // that happens to match the descriptor after the tap.
  func waitForExactInputFocus(
    app: XCUIApplication,
    element: XCUIElement,
    timeoutMs: Int
  ) -> Bool {
    let deadline = ProcessInfo.processInfo.systemUptime + Double(max(timeoutMs, 0)) / 1000.0
    while true {
      if isExactInputFocused(app: app, element: element) { return true }
      if ProcessInfo.processInfo.systemUptime >= deadline { return false }
      Thread.sleep(forTimeInterval: 0.1)
    }
  }

  // Secret-free read: raw value + placeholder travel only into the in-process
  // classifier, never onto the wire.
  func readExactInputValue(_ element: XCUIElement) -> (raw: String?, placeholder: String?) {
    var raw: String?
    var placeholder: String?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      raw = element.value as? String
      placeholder = element.placeholderValue
    })
    if exceptionMessage != nil { return (nil, nil) }
    return (raw, placeholder)
  }

  func exactInputDescriptor(from command: Command) -> ExactInputDescriptor? {
    guard let type = command.snapshotElementType,
          TextInputTarget.isInputTypeName(type),
          let bounds = command.targetBounds
    else { return nil }
    return ExactInputDescriptor(
      generation: command.snapshotGeneration,
      type: type,
      identifier: command.snapshotIdentifier,
      label: command.snapshotLabel,
      rect: CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height)
    )
  }

  enum TypeTargetOutcome {
    case bound(XCUIElement, descriptor: ExactInputDescriptor?, resolution: String)
    case failure(Response)
  }

  private func noTextInputTargetResponse(_ message: String) -> Response {
    Response(
      ok: false,
      error: ErrorPayload(
        code: "NO_TEXT_INPUT_TARGET",
        message: "NO_TEXT_INPUT_TARGET: \(message)",
        mutation: "none"
      )
    )
  }

  // GH #581: the type target is exact or nothing — supplied target metadata
  // fails closed, and the pre-#581 "fall back to whatever input already had
  // focus" substitution is gone. A no-metadata, no-coordinate call may still
  // use a positively focused input (internal callers), never the whole app.
  func resolveTypeCommandTarget(app: XCUIApplication, command: Command) -> TypeTargetOutcome {
    let hasTargetMetadata =
      command.snapshotElementType != nil
      || command.targetBounds != nil
      || command.snapshotNodeIndex != nil
      || command.snapshotIdentifier != nil
      || command.snapshotLabel != nil
      || command.snapshotGeneration != nil
    if hasTargetMetadata {
      guard let descriptor = exactInputDescriptor(from: command) else {
        return .failure(noTextInputTargetResponse(
          "the supplied target metadata does not describe a recognized text input; no typing was performed"
        ))
      }
      guard let generation = descriptor.generation, generation == currentSnapshotGeneration else {
        return .failure(noTextInputTargetResponse(
          "the target descriptor is not from the runner's current snapshot generation; refresh the snapshot and rebind the input before typing"
        ))
      }
      switch resolveExactTextInput(
        app: app,
        descriptor: descriptor,
        sameGeneration: true,
        requireFrameMatch: true
      ) {
      case .bound(let element):
        return .bound(element, descriptor: descriptor, resolution: "descriptor")
      case .ambiguous:
        return .failure(noTextInputTargetResponse(
          "the target descriptor matches more than one live text input; no typing was performed"
        ))
      case .absent:
        return .failure(noTextInputTargetResponse(
          "the described text input is no longer present on screen; no typing was performed"
        ))
      }
    }
    if let x = command.x, let y = command.y {
      let outcome = strictTextInputAt(app: app, x: x, y: y)
      if let target = outcome.element {
        return .bound(target, descriptor: nil, resolution: "point")
      }
      if outcome.ambiguous {
        return .failure(noTextInputTargetResponse(
          "multiple non-nested text inputs overlap (\(Int(x)), \(Int(y))); bind the input's ref/testID and retry"
        ))
      }
      return .failure(noTextInputTargetResponse(
        "no text input exists at (\(Int(x)), \(Int(y))); typing into a previously focused field was removed — bind the input's ref/testID and retry"
      ))
    }
    var focusedTarget: XCUIElement?
    withTemporaryScrollIdleTimeoutIfSupported(app) {
      focusedTarget = focusedTextInput(app: app)
    }
    if let target = focusedTarget {
      return .bound(target, descriptor: nil, resolution: "focused")
    }
    return .failure(noTextInputTargetResponse(
      "no text input is focused and no target was provided; app-wide blind typing was removed"
    ))
  }

  // Coordinate targeting accepts only an unambiguous hit: exactly one input
  // containing the point, or a strict containment chain (compound controls
  // like SearchField wrapping its TextField) where the innermost wins.
  func strictTextInputAt(
    app: XCUIApplication,
    x: Double,
    y: Double
  ) -> (element: XCUIElement?, ambiguous: Bool) {
    let point = CGPoint(x: x, y: y)
    var containing: [XCUIElement] = []
    var frames: [CGRect] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      let rawValues = Self.exactInputElementTypes.map { $0.rawValue }
      let predicate = NSPredicate(format: "elementType IN %@", rawValues)
      let hits = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex
        .filter { element in
          guard element.exists else { return false }
          let frame = element.frame
          return !frame.isEmpty && frame.contains(point)
        }
        .sorted { left, right in
          let leftArea = max(1, left.frame.width * left.frame.height)
          let rightArea = max(1, right.frame.width * right.frame.height)
          return leftArea < rightArea
        }
      containing = hits
      frames = hits.map { $0.frame }
    })
    if exceptionMessage != nil { return (nil, false) }
    if containing.isEmpty { return (nil, false) }
    if containing.count == 1 { return (containing[0], false) }
    // Only a STRICT containment chain (compound control) may disambiguate:
    // each outer frame must contain AND be meaningfully larger than the inner —
    // equal/near-equal stacked inputs are ambiguous, never a pick.
    for index in 0..<(frames.count - 1) {
      let inner = frames[index]
      let outer = frames[index + 1]
      if TextInputTarget.framesMatch(inner, outer) { return (nil, true) }
      if !outer.insetBy(dx: -1, dy: -1).contains(inner) { return (nil, true) }
    }
    return (containing[0], false)
  }




  func focusedTextInput(app: XCUIApplication) -> XCUIElement? {
    var focused: XCUIElement?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      let candidate = app
        .descendants(matching: .any)
        .matching(NSPredicate(format: "hasKeyboardFocus == 1"))
        .firstMatch
      guard candidate.exists else { return }

      switch candidate.elementType {
      case .textField, .secureTextField, .searchField, .textView:
        focused = candidate
      default:
        return
      }
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_FOCUSED_INPUT_QUERY_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return nil
    }
    return focused
  }

  func isKeyboardVisible(app: XCUIApplication) -> Bool {
    let keyboard = app.keyboards.firstMatch
    return keyboard.exists && !keyboard.frame.isEmpty
  }

  func dismissKeyboard(app: XCUIApplication) -> (wasVisible: Bool, dismissed: Bool, visible: Bool, via: String?) {
    let wasVisible = isKeyboardVisible(app: app)
    guard wasVisible else {
      return (wasVisible: false, dismissed: false, visible: false, via: nil)
    }

#if os(tvOS)
    _ = pressTvRemote(.menu)
    sleepFor(0.2)
    let visible = isKeyboardVisible(app: app)
    return (wasVisible: true, dismissed: !visible, visible: visible, via: "native-control")
#else
    // Automatic dismissal is mutation-sensitive. Only a positively identified
    // hide/dismiss button inside the keyboard is safe; never drag through keys,
    // synthesize Return/Done, or activate an app-owned accessory toolbar.
    if tapKeyboardDismissControl(app: app) {
      sleepFor(0.2)
      if !isKeyboardVisible(app: app) {
        return (wasVisible: true, dismissed: true, visible: false, via: "native-control")
      }
    }
    return (wasVisible: true, dismissed: false, visible: true, via: nil)
#endif
  }

  func keyboardFrameIfVisible(app: XCUIApplication) -> CGRect? {
    let keyboard = app.keyboards.firstMatch
    guard keyboard.exists else { return nil }
    let frame = keyboard.frame
    return frame.isEmpty ? nil : frame
  }

  func applyKeyboardGuard(
    app: XCUIApplication,
    tapX: Double,
    tapY: Double,
    command: Command,
    enabled: Bool
  ) -> KeyboardGuardAction {
#if os(tvOS)
    return .proceed("off")
#else
    let retained = command.snapshotNodeIndex.flatMap { retainedSnapshotTargets[$0] }
    switch KeyboardGuard.validateKeyboardDescriptor(
      command: command,
      retained: retained,
      currentGeneration: currentSnapshotGeneration,
      appFrame: app.frame
    ) {
    case .stale:
      return .targetStale
    case .keyboardTarget:
      guard let retained,
            keyboardFrameIfVisible(app: app) != nil
      else { return .targetStale }
      return .keyboardTarget(retained, CGPoint(x: tapX, y: tapY))
    case .ordinary:
      break
    }
    if command.targetBounds == nil,
       let keyboardFrame = keyboardFrameIfVisible(app: app),
       keyboardFrame.contains(CGPoint(x: tapX, y: tapY)) {
      return .targetStale
    }
    guard enabled else { return .proceed("off") }

    guard let keyboardFrame = keyboardFrameIfVisible(app: app) else {
      return .proceed("no_keyboard")
    }
    let targetRect = command.targetBounds.map {
      CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height)
    }
    if targetRect == nil {
      return .proceed("not_occluded")
    }
    let targetOnScreen = targetRect.map {
      KeyboardGuard.isProvenOnScreen(appFrame: app.frame, targetRect: $0)
    } ?? false
    let fresh = targetRect != nil
      && targetOnScreen
      && command.snapshotGeneration == currentSnapshotGeneration
      && command.keyboardStateAtSnapshot == true
    if fresh,
       let targetRect,
       !KeyboardGuard.shouldDismiss(
         keyboardFrame: keyboardFrame,
         targetRect: targetRect,
         minHeight: 120
       ) {
      return .proceed("not_occluded")
    }

    let dismissal = dismissKeyboard(app: app)
    guard dismissal.dismissed && !dismissal.visible else { return .dismissFailed }
    return targetRect == nil ? .proceed("auto_dismissed") : .relayoutRequired
#endif
  }

  static let occludedDispatchMessage =
    "FOCUS_TARGET_OCCLUDED: the focus or tap point is covered by another element (keyboard, bar or overlay); no tap or typing was performed. Scroll the target clear, then retry."

  // A blocked gesture is never synthesized, but a multi-gesture command may already have run earlier ones.
  static func appAlertInterruptionResponse(singleGesture: Bool = true) -> Response {
    let performed = singleGesture ? "no gesture was performed" : "earlier gestures of this command may have run"
    return Response(ok: false, error: ErrorPayload(
      code: "APP_ALERT_INTERRUPTION",
      message: "APP_ALERT_INTERRUPTION: an open app alert blocks the gesture point and no alert button was pressed; \(performed). Snapshot the alert and tap one of its buttons.",
      mutation: singleGesture ? "none" : "possible"
    ))
  }

  static let movedDispatchMessage =
    "TARGET_MOVED_BEFORE_DISPATCH: target moved before dispatch; no tap or typing was performed. Refresh the snapshot and retry."

  // nil when the hit test is unavailable: unresolvable, ambiguous, thrown or over budget.
  func boundedHittable(_ element: XCUIElement, deadline: Double) -> Bool? {
    DispatchGuard.hitTest(
      deadline: deadline,
      now: { ProcessInfo.processInfo.systemUptime },
      resolve: { element },
      read: { target in
        var hittable: Bool?
        let exception = RunnerObjCExceptionCatcher.catchException({ hittable = target.isHittable })
        return exception == nil ? hittable : nil
      }
    ).hittable
  }

  func liveTargetCheck(app: XCUIApplication, command: Command, deadline: Double, checkHittability: Bool = true) -> DispatchGuard.TargetCheck {
    lastMovedFrames = nil
    lastLiveTarget = nil
    guard let index = command.snapshotNodeIndex,
          let retained = retainedSnapshotTargets[index],
          retained.generation == currentSnapshotGeneration,
          command.snapshotGeneration == retained.generation
    else { return .unavailable }
    let predicate: NSPredicate
    if let identifier = retained.identifier {
      predicate = NSPredicate(format: "identifier == %@", identifier)
    } else if let label = retained.label {
      predicate = NSPredicate(format: "label == %@", label)
    } else {
      return .unavailable
    }
    let expected = CGRect(
      x: retained.rect.x, y: retained.rect.y,
      width: retained.rect.width, height: retained.rect.height
    )
    var live: CGRect?
    var liveIdentity: DispatchGuard.NodeIdentity?
    let check = DispatchGuard.hitTest(
      deadline: deadline,
      now: { ProcessInfo.processInfo.systemUptime },
      resolve: {
        var matches: [XCUIElement] = []
        let exception = RunnerObjCExceptionCatcher.catchException({
          matches = app.descendants(matching: .any).matching(predicate).allElementsBoundByIndex.filter {
            self.elementTypeName($0.elementType) == retained.type
          }
        })
        return exception == nil && matches.count == 1 ? matches[0] : nil
      },
      matchesFrame: { target in
        var matches: Bool?
        let exception = RunnerObjCExceptionCatcher.catchException({
          let frame = target.frame
          live = frame
          let owner = retained.ownerRect.map { CGRect(x: $0.x, y: $0.y, width: $0.width, height: $0.height) }
          let agree = DispatchGuard.framesAgree(retained: expected, live: frame, owner: owner)
          if agree { self.lastLiveTarget = target }
          if !agree {
            let label = target.label
            let identifier = target.identifier
            liveIdentity = DispatchGuard.NodeIdentity(
              type: self.elementTypeName(target.elementType),
              label: label.isEmpty ? nil : label,
              identifier: identifier.isEmpty ? nil : identifier
            )
          }
          matches = agree
        })
        return exception == nil ? matches : nil
      },
      checkHittability: checkHittability,
      read: { target in self.boundedHittable(target, deadline: deadline) }
    )
    if check == .moved, let live {
      lastMovedFrames = (
        expected, live,
        DispatchGuard.NodeIdentity(type: retained.type, label: retained.label, identifier: retained.identifier),
        liveIdentity
      )
    }
    return check
  }

  func movedDispatchResponse() -> Response {
    let message = lastMovedFrames.map {
      DispatchGuard.movedMessage(
        retained: $0.retained, live: $0.live,
        retainedIdentity: $0.retainedIdentity, liveIdentity: $0.liveIdentity)
    } ?? Self.movedDispatchMessage
    return Response(ok: false, error: ErrorPayload(code: "TARGET_MOVED_BEFORE_DISPATCH", message: message, mutation: "none"))
  }

  private func resolveLiveKeyboardTarget(
    app: XCUIApplication,
    retained: RetainedSnapshotTarget
  ) -> XCUIElement? {
    var candidates: [XCUIElement] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if retained.type == "Keyboard" {
        candidates = app.keyboards.allElementsBoundByIndex
      } else if retained.type == "Key" {
        candidates = app.keyboards.keys.allElementsBoundByIndex
      } else if retained.type == "Button" {
        candidates = app.keyboards.buttons.allElementsBoundByIndex
      }
    })
    guard exceptionMessage == nil else { return nil }
    let matches = candidates.filter { element in
      let exists = element.exists
      let hittable = element.isHittable
      guard exists, hittable else { return false }
      guard let snapshot = try? element.snapshot() else { return false }
      let snapshotLabel = aggregatedLabel(for: snapshot)
        ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let label = snapshotLabel.isEmpty ? nil : snapshotLabel
      let snapshotIdentifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = snapshotIdentifier.isEmpty ? nil : snapshotIdentifier
      return KeyboardGuard.matchesLiveKeyboardTarget(
        retained: retained,
        candidateType: elementTypeName(element.elementType),
        candidateLabel: label,
        candidateIdentifier: identifier,
        candidateFrame: element.frame,
        exists: exists,
        hittable: hittable
      )
    }
    return matches.count == 1 ? matches[0] : nil
  }

  func activateKeyboardTarget(
    app: XCUIApplication,
    retained: RetainedSnapshotTarget,
    point: CGPoint,
    duration: TimeInterval? = nil
  ) -> Bool {
    guard let element = resolveLiveKeyboardTarget(app: app, retained: retained) else {
      return false
    }
    let frame = element.frame
    let expectedFrame = CGRect(
      x: retained.rect.x,
      y: retained.rect.y,
      width: retained.rect.width,
      height: retained.rect.height
    )
    guard KeyboardGuard.canActivateKeyboardTarget(
      expectedFrame: expectedFrame,
      liveFrame: frame,
      keyboardFrame: keyboardFrameIfVisible(app: app),
      point: point
    ) else { return false }
    if let duration {
      element.press(forDuration: duration)
    } else {
      element.tap()
    }
    return true
  }

  private func tapKeyboardDismissControl(app: XCUIApplication) -> Bool {
#if os(tvOS)
    return false
#else
    for label in ["Hide keyboard", "Dismiss keyboard"] {
      let predicate = NSPredicate(format: "label == %@ OR identifier == %@", label, label)
      let candidates = app.keyboards.buttons.matching(predicate).allElementsBoundByIndex
      if let hittable = candidates.first(where: {
        $0.exists && $0.isHittable && KeyboardGuard.isSafeDismissControl(
          type: elementTypeName($0.elementType),
          label: $0.label.isEmpty ? nil : $0.label,
          identifier: $0.identifier.isEmpty ? nil : $0.identifier,
          insideKeyboard: true
        )
      }) {
        hittable.tap()
        return true
      }
    }
    return false
#endif
  }


  private func moveCaretToEnd(element: XCUIElement) {
#if os(tvOS)
    return
#else
    let frame = element.frame
    guard !frame.isEmpty else {
      element.tap()
      return
    }
    let origin = element.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let target = origin.withOffset(
      CGVector(dx: max(2, frame.width - 4), dy: max(2, frame.height / 2))
    )
    target.tap()
#endif
  }

  private func estimatedDeleteCount(for element: XCUIElement) -> Int {
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let base = valueText.isEmpty ? 24 : (valueText.count + 8)
    return max(24, min(120, base))
  }

  private func readableText(for element: XCUIElement) -> String? {
    let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      if !valueText.isEmpty { return valueText }
      if !label.isEmpty { return label }
      return identifier.isEmpty ? nil : identifier
    default:
      if !label.isEmpty { return label }
      if !valueText.isEmpty { return valueText }
      return identifier.isEmpty ? nil : identifier
    }
  }

  private func prefersExpandedTextRead(_ element: XCUIElement) -> Bool {
    switch element.elementType {
    case .textField, .secureTextField, .searchField, .textView:
      return true
    default:
      return false
    }
  }

  func findScopeElement(app: XCUIApplication, scope: String) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "label CONTAINS[c] %@ OR identifier CONTAINS[c] %@",
      scope,
      scope
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }

  func tapAt(app: XCUIApplication, x: Double, y: Double, anchor: XCUIElement? = nil) -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "tap") {
      return outcome
    }
    return performCoordinateTap(app: app, x: x, y: y, anchor: anchor)
  }

  func mouseClickAt(app: XCUIApplication, x: Double, y: Double, button: String) throws {
#if os(macOS)
    let coordinate = interactionCoordinate(app: app, x: x, y: y)
    switch button {
    case "primary":
      coordinate.tap()
    case "secondary":
      coordinate.rightClick()
    case "middle":
      throw NSError(
        domain: "RnFastRunner",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "middle mouse button is not supported"]
      )
    default:
      throw NSError(
        domain: "RnFastRunner",
        code: 1,
        userInfo: [NSLocalizedDescriptionKey: "unsupported mouse button: \(button)"]
      )
    }
#elseif os(tvOS)
    throw NSError(
      domain: "RnFastRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "mouseClick is not supported on tvOS"]
    )
#else
    throw NSError(
      domain: "RnFastRunner",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "mouseClick is only supported on macOS"]
    )
#endif
  }

  func doubleTapAt(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
    if let outcome = selectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), action: "double tap") {
      guard case .performed = outcome else { return outcome }
      sleepFor(0.1)
      _ = pressTvRemote(.select)
      return .performed
    }
    return performCoordinateDoubleTap(app: app, x: x, y: y)
  }

  func longPressAt(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) -> RunnerInteractionOutcome {
    if let outcome = longSelectFocusedTvElement(app: app, point: CGPoint(x: x, y: y), duration: duration) {
      return outcome
    }
    return performCoordinateLongPress(app: app, x: x, y: y, duration: duration)
  }

  func dragAt(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) -> RunnerInteractionOutcome {
    // tvOS has no coordinate drag. Preserve the direction as a focus move.
    let dx = x2 - x
    let dy = y2 - y
    let button: TvRemoteButton = abs(dx) > abs(dy)
      ? (dx > 0 ? .right : .left)
      : (dy > 0 ? .down : .up)
    if pressTvRemote(button) {
      return .performed
    }
    return performCoordinateDrag(app: app, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
  }

  func resolvedTouchVisualizationFrame(app: XCUIApplication, x: Double, y: Double) -> TouchVisualizationFrame {
    let appFrame = app.frame
    let referenceFrame = resolvedTouchReferenceFrame(app: app, appFrame: appFrame)
    let originX = appFrame.isEmpty ? referenceFrame.minX : appFrame.minX
    let originY = appFrame.isEmpty ? referenceFrame.minY : appFrame.minY
    return TouchVisualizationFrame(
      x: originX + x,
      y: originY + y,
      referenceWidth: referenceFrame.width,
      referenceHeight: referenceFrame.height
    )
  }

  func resolvedDragVisualizationFrame(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double
  ) -> DragVisualizationFrame {
    let start = resolvedTouchVisualizationFrame(app: app, x: x, y: y)
    let end = resolvedTouchVisualizationFrame(app: app, x: x2, y: y2)
    return DragVisualizationFrame(
      x: start.x,
      y: start.y,
      x2: end.x,
      y2: end.y,
      referenceWidth: start.referenceWidth,
      referenceHeight: start.referenceHeight
    )
  }

  func resolvedTouchReferenceFrame(app: XCUIApplication, appFrame: CGRect) -> CGRect {
    let window = app.windows.firstMatch
    let windowFrame = window.frame
    if window.exists && !windowFrame.isEmpty {
      return windowFrame
    }
    if !appFrame.isEmpty {
      return appFrame
    }
    return CGRect(x: 0, y: 0, width: 0, height: 0)
  }

  func runSeries(count: Int, pauseMs: Double, operation: (Int) -> Void) {
    let total = max(count, 1)
    let pause = max(pauseMs, 0)
    for idx in 0..<total {
      operation(idx)
      if idx < total - 1 && pause > 0 {
        Thread.sleep(forTimeInterval: pause / 1000.0)
      }
    }
  }

  func swipe(app: XCUIApplication, direction: String) -> DragVisualizationFrame? {
    if performTvRemoteSwipeIfAvailable(direction: direction) {
      let frame = resolvedTouchReferenceFrame(app: app, appFrame: app.frame)
      let midX = frame.midX
      let midY = frame.midY
      return DragVisualizationFrame(
        x: midX,
        y: midY,
        x2: midX,
        y2: midY,
        referenceWidth: frame.width,
        referenceHeight: frame.height
      )
    }
    return nil
  }

  private func performTvRemoteSwipeIfAvailable(direction: String) -> Bool {
    switch direction {
    case "up":
      return pressTvRemote(.up)
    case "down":
      return pressTvRemote(.down)
    case "left":
      return pressTvRemote(.left)
    case "right":
      return pressTvRemote(.right)
    default:
      return false
    }
  }

  func pinch(app: XCUIApplication, scale: Double, x: Double?, y: Double?) -> RunnerInteractionOutcome {
    return performCoordinatePinch(app: app, scale: scale, x: x, y: y)
  }

  private func performCoordinatePinch(app: XCUIApplication, scale: Double, x: Double?, y: Double?) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("pinch is not supported on tvOS")
#else
    let target = app.windows.firstMatch.exists ? app.windows.firstMatch : app

    // Use double-tap + drag gesture for reliable map zoom
    // Zoom in (scale > 1): tap then drag UP
    // Zoom out (scale < 1): tap then drag DOWN

    // Determine center point (use provided x/y or screen center)
    let centerX = x.map { $0 / target.frame.width } ?? 0.5
    let centerY = y.map { $0 / target.frame.height } ?? 0.5
    let center = target.coordinate(withNormalizedOffset: CGVector(dx: centerX, dy: centerY))

    // Calculate drag distance based on scale (clamped to reasonable range)
    // Larger scale = more drag distance
    let dragAmount: CGFloat
    if scale > 1.0 {
      // Zoom in: drag up (negative Y direction in normalized coords)
      dragAmount = min(0.4, CGFloat(scale - 1.0) * 0.2)
    } else {
      // Zoom out: drag down (positive Y direction)
      dragAmount = min(0.4, CGFloat(1.0 - scale) * 0.4)
    }

    let endY = scale > 1.0 ? (centerY - Double(dragAmount)) : (centerY + Double(dragAmount))
    let endPoint = target.coordinate(withNormalizedOffset: CGVector(dx: centerX, dy: max(0.1, min(0.9, endY))))

    // Tap first (first tap of double-tap)
    center.tap()

    // Immediately press and drag (second tap + drag)
    center.press(forDuration: 0.05, thenDragTo: endPoint)
    return .performed
#endif
  }

  private func interactionRoot(app: XCUIApplication) -> XCUIElement {
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isEmpty }) {
      return window
    }
    return app
  }

  private func performCoordinateTap(app: XCUIApplication, x: Double, y: Double, anchor: XCUIElement?) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("coordinate tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element")
#else
    interactionCoordinate(app: app, x: x, y: y, anchor: anchor).tap()
    return .performed
#endif
  }

  private func performCoordinateDoubleTap(app: XCUIApplication, x: Double, y: Double) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("coordinate double tap is not supported on tvOS; move focus with swipe or scroll, then select the focused element")
#else
    interactionCoordinate(app: app, x: x, y: y).doubleTap()
    return .performed
#endif
  }

  private func performCoordinateLongPress(app: XCUIApplication, x: Double, y: Double, duration: TimeInterval) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("coordinate long press is not supported on tvOS; move focus with swipe or scroll, then long-select the focused element")
#else
    interactionCoordinate(app: app, x: x, y: y).press(forDuration: duration)
    return .performed
#endif
  }

  private func performCoordinateDrag(
    app: XCUIApplication,
    x: Double,
    y: Double,
    x2: Double,
    y2: Double,
    holdDuration: TimeInterval
  ) -> RunnerInteractionOutcome {
#if os(tvOS)
    return .unsupported("coordinate drag is not supported on tvOS")
#else
    let start = interactionCoordinate(app: app, x: x, y: y)
    let end = interactionCoordinate(app: app, x: x2, y: y2)
    start.press(forDuration: holdDuration, thenDragTo: end)
    return .performed
#endif
  }

#if !os(tvOS)
  private func interactionCoordinate(app: XCUIApplication, x: Double, y: Double, anchor: XCUIElement? = nil) -> XCUICoordinate {
    let root = anchor ?? coordinateAnchor(app: app, point: CGPoint(x: x, y: y), liveTarget: nil).element
    let origin = root.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    let rootFrame = root.frame
    let offsetX = x - Double(rootFrame.origin.x)
    let offsetY = y - Double(rootFrame.origin.y)
    return origin.withOffset(CGVector(dx: offsetX, dy: offsetY))
  }

  func coordinateAnchor(app: XCUIApplication, point: CGPoint, liveTarget: XCUIElement?) -> (decision: DispatchGuard.TapAnchor, element: XCUIElement) {
    var alerts: [XCUIElement] = []
    var alertFrames: [CGRect] = []
    var liveFrame: CGRect?
    let exception = RunnerObjCExceptionCatcher.catchException({
      alerts = app.alerts.allElementsBoundByIndex
      alertFrames = alerts.map(\.frame)
      liveFrame = liveTarget?.frame
    })
    guard exception == nil else { return (.firstWindow, interactionRoot(app: app)) }
    let decision = DispatchGuard.tapAnchor(point: point, liveTarget: liveFrame, alerts: alertFrames)
    switch decision {
    case .liveTarget: return (decision, liveTarget ?? interactionRoot(app: app))
    case .alert(let index): return (decision, alerts[index])
    case .firstWindow, .outsideAlerts: return (decision, interactionRoot(app: app))
    }
  }
#endif

  private func tapElementCenter(app: XCUIApplication, element: XCUIElement) {
    let frame = element.frame
    if !frame.isEmpty {
      _ = tapAt(app: app, x: frame.midX, y: frame.midY)
      return
    }
#if !os(tvOS)
    element.tap()
#endif
  }

  private func macOSNavigationBackElement(app: XCUIApplication) -> XCUIElement? {
    let predicate = NSPredicate(
      format: "identifier == %@ OR label == %@",
      "go back",
      "Back"
    )
    let element = app.descendants(matching: .any).matching(predicate).firstMatch
    return element.exists ? element : nil
  }
}
