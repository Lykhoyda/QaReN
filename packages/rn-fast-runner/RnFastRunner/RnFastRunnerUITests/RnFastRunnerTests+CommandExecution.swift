import CryptoKit
import XCTest

extension RnFastRunnerTests {
  // MARK: - Main Thread Dispatch

  private func currentUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  private func measureGesture(_ action: () -> Void) -> (gestureStartUptimeMs: Double, gestureEndUptimeMs: Double) {
    let gestureStartUptimeMs = currentUptimeMs()
    action()
    return (gestureStartUptimeMs, currentUptimeMs())
  }

  private func unsupportedResponse(for outcome: RunnerInteractionOutcome) -> Response? {
    switch outcome {
    case .performed:
      return nil
    case .unsupported(let message):
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: message)
      )
    }
  }

  private func executeFocusedType(app: XCUIApplication, text: String, replace: Bool, prepareReplacement: Bool = false, deleteCount: Int = 0) -> Response {
    guard (0...256).contains(deleteCount), prepareReplacement || deleteCount == 0 else {
      return Response(ok: false, error: ErrorPayload(code: "INVALID_ARGUMENT", message: "focused clear exceeds the 256-key budget", mutation: "none"))
    }
    var keyboardVisible = false
    withTemporaryScrollIdleTimeoutIfSupported(app) {
      keyboardVisible = app.keyboards.count > 0
    }
    switch TypingRecipe.focusedTypeDecision(textIsEmpty: text.isEmpty && !prepareReplacement, keyboardVisible: keyboardVisible) {
    case .refuseEmptyText:
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "INVALID_ARGUMENT",
          message: "focused typing appends to the focused field and cannot clear it; pass text",
          mutation: "none"
        )
      )
    case .refuseNoKeyboard:
      return Response(
        ok: false,
        error: ErrorPayload(
          code: "TEXT_TARGET_FOCUS_FAILED",
          message: "TEXT_TARGET_FOCUS_FAILED: no software keyboard is visible, so no field is proven focused; tap the field, then retry. No typing was performed.",
          mutation: "none"
        )
      )
    case .type:
      var synthesis: RunnerSynthesizedTextEntryResult?
      withTemporaryScrollIdleTimeoutIfSupported(app) {
        gesture {
          if prepareReplacement {
            synthesis = RunnerSynthesizedTextEntry.prepareReplacement(
              withApplication: app, deleteCount: UInt(deleteCount),
              endKey: XCUIKeyboardKey.end.rawValue, deleteKey: XCUIKeyboardKey.delete.rawValue
            )
          } else {
            synthesis = replace
              ? RunnerSynthesizedTextEntry.replaceText(withApplication: app, text: text)
              : RunnerSynthesizedTextEntry.synthesizeText(withApplication: app, text: text)
          }
        }
      }
      let result = synthesis!
      switch TypingRecipe.focusedTypeOutcome(
        succeeded: result.status == .succeeded,
        unavailable: result.status == .unavailable
      ) {
      case .typed(let route):
        return Response(
          ok: true,
          data: DataPayload(
            message: prepareReplacement ? "cleared" : "typed",
            typingBurst: false,
            keyboardWaitMs: 0,
            inputResolution: "focused-first-responder",
            focusTap: "none",
            textEntryRoute: route
          )
        )
      case .refuseUnavailable:
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "TEXT_SYNTHESIS_UNAVAILABLE",
            message: (result.message ?? "text synthesis is unavailable on this Xcode") + "; no typing was performed.",
            mutation: "none"
          )
        )
      case .failed:
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "TEXT_SYNTHESIS_FAILED",
            message: result.message ?? "private XCTest text synthesis failed",
            mutation: "possible"
          )
        )
      }
    }
  }

  func execute(command: Command) throws -> Response {
    if Thread.isMainThread {
      return try executeOnMainSafely(command: command)
    }
    var result: Result<Response, Error>?
    let semaphore = DispatchSemaphore(value: 0)
    DispatchQueue.main.async {
      do {
        result = .success(try self.executeOnMainSafely(command: command))
      } catch {
        result = .failure(error)
      }
      semaphore.signal()
    }
    let waitResult = semaphore.wait(timeout: .now() + mainThreadExecutionTimeout)
    if waitResult == .timedOut {
      // The queued mutation is non-cancellable. Publish the wedge off-main so
      // /health makes old and new clients reap this XCTest process.
      markRunnerWedged()
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.mainThreadExecutionTimedOut,
        userInfo: [NSLocalizedDescriptionKey: "main thread execution timed out"]
      )
    }
    switch result {
    case .success(let response):
      return response
    case .failure(let error):
      throw error
    case .none:
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.noResponseFromMainThread,
        userInfo: [NSLocalizedDescriptionKey: "no response from main thread"]
      )
    }
  }

  // MARK: - Command Handling

  private func qaReadOnlyRefusal(appNotRunning: Bool = false) -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "ACTION_CONTEXT_CHANGED", message: "QA read requires the unchanged foreground target; no recovery attempted",
      mutation: "none", reason: appNotRunning ? "app-not-running" : nil
    ))
  }

  // Reads the cached target's state only; a read never activates or relaunches the app.
  private func qaReadOnlyTargetNotRunning(command: Command) -> Bool {
    guard let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !bundleId.isEmpty, currentBundleId == bundleId, let target = currentApp else { return false }
    return target.state == .notRunning
  }

  private func qaReadOnlyTarget(command: Command) -> XCUIApplication? {
    guard [.snapshot, .verifyInput, .isScreenStatic, .interactionFrame, .findText, .readText, .screenshot, .uptime, .status].contains(command.command),
          let bundleId = command.appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !bundleId.isEmpty, currentBundleId == bundleId,
          let target = currentApp, target.state == .runningForeground, target.exists else { return nil }
    return target
  }

  private func gestureIssueResponse(_ command: Command) -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "GESTURE_ISSUE_RAISED",
      message: "GESTURE_ISSUE_RAISED: XCTest raised an issue during the \(command.command.rawValue) gesture; it may have been partly performed",
      mutation: "possible"
    ))
  }

  private func executeOnMainSafely(command: Command) throws -> Response {
#if RN_FAST_RUNNER_TEST_FAULTS
    // Deterministic, test-only wedge. The branch is compile-time absent from
    // release builds and is one-shot so recovery can lazily respawn normally.
    if !testFaultConsumed,
       command.command == .type,
       ProcessInfo.processInfo.environment["RN_FAST_RUNNER_TEST_FAULT"] == "block-main-35s" {
      testFaultConsumed = true
      Thread.sleep(forTimeInterval: 35)
    }
#endif
    var hasRetried = false
    while true {
      var response: Response?
      var swiftError: Error?
      appAlertInterruptions = 0
      gestureIssueRaised = false
      let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
        do {
          response = try self.executeOnMain(command: command)
        } catch {
          swiftError = error
        }
      })
      inGesture = false

      if let exceptionMessage {
        // XCTest aborts the gesture before synthesizing it when our monitor claimed an app alert.
        if appAlertInterruptions > 0 {
          return Self.appAlertInterruptionResponse(singleGesture: [.tap, .longPress, .drag].contains(command.command))
        }
        if gestureIssueRaised { return gestureIssueResponse(command) }
        if command.qaReadOnly == true { return qaReadOnlyRefusal() }
        if command.platformPresence == true {
          return platformPresenceFailure()
        }
        currentApp = nil
        currentBundleId = nil
        if !hasRetried, shouldRetryException(command, message: exceptionMessage) {
          NSLog(
            "RN_FAST_RUNNER_RETRY command=%@ reason=objc_exception",
            command.command.rawValue
          )
          hasRetried = true
          sleepFor(retryCooldown)
          continue
        }
        throw NSError(
          domain: RunnerErrorDomain.exception,
          code: RunnerErrorCode.objcException,
          userInfo: [NSLocalizedDescriptionKey: exceptionMessage]
        )
      }
      if let swiftError {
        if command.qaReadOnly == true { return qaReadOnlyRefusal() }
        if command.platformPresence == true {
          return platformPresenceFailure()
        }
        throw swiftError
      }
      guard let response else {
        throw NSError(
          domain: RunnerErrorDomain.general,
          code: RunnerErrorCode.commandReturnedNoResponse,
          userInfo: [NSLocalizedDescriptionKey: "command returned no response"]
        )
      }
      if response.ok, gestureIssueRaised { return gestureIssueResponse(command) }
      if command.qaReadOnly == true, !response.ok {
        return qaReadOnlyRefusal(appNotRunning: response.error?.reason == "app-not-running")
      }
      if !hasRetried, shouldRetryCommand(command), shouldRetryResponse(response) {
        NSLog(
          "RN_FAST_RUNNER_RETRY command=%@ reason=response_unavailable",
          command.command.rawValue
        )
        hasRetried = true
        currentApp = nil
        currentBundleId = nil
        sleepFor(retryCooldown)
        continue
      }
      return response
    }
  }

  private func executeOnMain(command: Command) throws -> Response {
    var readOnlyApp: XCUIApplication?
    if command.qaReadOnly == true {
      guard let target = qaReadOnlyTarget(command: command) else {
        return qaReadOnlyRefusal(appNotRunning: qaReadOnlyTargetNotRunning(command: command))
      }
      readOnlyApp = target
    }
    if command.platformPresence == true {
      // Presence adapters must omit filters; this mode always enumerates the raw app tree.
      guard command.command == .snapshot,
            let presenceBudgetMs = command.presenceBudgetMs,
            presenceBudgetMs > 0,
            presenceBudgetMs <= Int(mainThreadExecutionTimeout * 1000) - 5_000,
            command.raw != false, command.compact != true, command.interactiveOnly != true,
            command.depth == nil, command.scope == nil,
            let appId = command.appBundleId,
            !appId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return Response(ok: false, error: ErrorPayload(
          code: "INVALID_ARGUMENT",
          message: "platformPresence requires an explicit supported presenceBudgetMs, appBundleId and an unfiltered raw snapshot"
        ))
      }
      let bundleId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
      let target = currentBundleId == bundleId
        ? (currentApp ?? XCUIApplication(bundleIdentifier: bundleId))
        : XCUIApplication(bundleIdentifier: bundleId)
      currentSnapshotGeneration += 1
      // Observation must not activate or relaunch the app to manufacture presence.
      let payload = runnerPayload(
        snapshotPlatformPresence(app: target, appId: bundleId, presenceBudgetMs: presenceBudgetMs),
        appProcessIdentifier: observedProcessIdentifier(target)
      )
      retainSnapshotTargets(payload.nodes ?? [])
      needsPostSnapshotInteractionDelay = true
      return Response(ok: true, data: payload)
    }
    // Selecting or activating the app could let XCTest resolve the blocking alert first.
    if command.command == .systemAlertTap, readOnlyApp == nil {
      return systemAlertTap(label: command.text)
    }
    var activeApp = readOnlyApp ?? currentApp ?? app
    if readOnlyApp == nil, !isRunnerLifecycleCommand(command.command) {
      let normalizedBundleId = command.appBundleId?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      let requestedBundleId = (normalizedBundleId?.isEmpty == true) ? nil : normalizedBundleId
      if let bundleId = requestedBundleId {
        if currentBundleId != bundleId || currentApp == nil {
          _ = activateTarget(bundleId: bundleId, reason: "bundle_changed")
        }
      } else {
        // Do not reuse stale bundle targets when the caller does not explicitly request one.
        currentApp = nil
        currentBundleId = nil
      }

      activeApp = currentApp ?? app
      if let bundleId = requestedBundleId, targetNeedsActivation(activeApp) {
        activeApp = activateTarget(bundleId: bundleId, reason: "stale_target")
      } else if requestedBundleId == nil, targetNeedsActivation(activeApp) {
        app.activate()
        activeApp = app
      }

      // waitForExistence costs a ~1 s poll even for a present app, so check exists first.
      if !(activeApp.exists || activeApp.waitForExistence(timeout: appExistenceTimeout)) {
        if let bundleId = requestedBundleId {
          activeApp = activateTarget(bundleId: bundleId, reason: "missing_after_wait")
          guard activeApp.exists || activeApp.waitForExistence(timeout: appExistenceTimeout) else {
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
        } else {
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
        }
      }

      if isInteractionCommand(command.command) {
        if let bundleId = requestedBundleId, activeApp.state != .runningForeground {
          activeApp = activateTarget(bundleId: bundleId, reason: "interaction_foreground_guard")
        } else if requestedBundleId == nil, activeApp.state != .runningForeground {
          app.activate()
          activeApp = app
        }
        if !(activeApp.exists || activeApp.waitForExistence(timeout: 2)) {
          if let bundleId = requestedBundleId {
            return Response(ok: false, error: ErrorPayload(message: "app '\(bundleId)' is not available"))
          }
          return Response(ok: false, error: ErrorPayload(message: "runner app is not available"))
        }
        applyInteractionStabilizationIfNeeded()
      }
    }

    // GH #581: the recorded type target is only valid while nothing else can
    // change the screen — any verb outside the type/verify pair drops it, and
    // every new type attempt starts with a clean record so a failed attempt
    // can never leave an earlier field's record for verifyInput to prefer.
    switch command.command {
    case .verifyInput, .snapshot, .status, .uptime, .isScreenStatic, .screenshot:
      break
    default:
      lastExactTypeTarget = nil
    }

    switch command.command {
    case .shutdown:
      return Response(ok: true, data: DataPayload(message: "shutdown"))
    case .uptime:
      return Response(
        ok: true,
        data: DataPayload(currentUptimeMs: currentUptimeMs())
      )
    case .status:
      return Response(
        ok: false,
        error: ErrorPayload(code: "INVALID_ARGUMENT", message: "status is handled at the transport layer")
      )
    case .tap:
      if let text = command.text {
        if let element = findElement(app: activeApp, text: text) {
          var outcome = RunnerInteractionOutcome.performed
          let timing = measureGesture {
            withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
              outcome = activateElement(app: activeApp, element: element, action: "tap by text")
            }
          }
          if let response = unsupportedResponse(for: outcome) {
            return response
          }
          return Response(
            ok: true,
            data: DataPayload(
              message: "tapped",
              gestureStartUptimeMs: timing.gestureStartUptimeMs,
              gestureEndUptimeMs: timing.gestureEndUptimeMs
            )
          )
        }
        return Response(ok: false, error: ErrorPayload(message: "element not found"))
      }
      if let x = command.x, let y = command.y {
        let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
        let keyboardGuardStartMs = currentUptimeMs()
        let keyboardGuardAction = applyKeyboardGuard(
          app: activeApp,
          tapX: x,
          tapY: y,
          command: command,
          enabled: command.guardKeyboard != false
        )
        let keyboardGuardMs = currentUptimeMs() - keyboardGuardStartMs
        let keyboardGuardStatus: String
        switch keyboardGuardAction {
        case .targetStale:
          return Response(
            ok: false,
            error: ErrorPayload(
              code: "KEYBOARD_TARGET_STALE",
              message: "KEYBOARD_TARGET_STALE: the latest-snapshot keyboard target no longer uniquely matches the live keyboard; no gesture was performed. Refresh the snapshot and retry.",
              mutation: "none"
            )
          )
        case .dismissFailed:
          return Response(
            ok: false,
            error: ErrorPayload(code: "KEYBOARD_DISMISS_FAILED", message: "KEYBOARD_DISMISS_FAILED: no safe native hide/dismiss control proved the keyboard hidden; no tap or swipe was performed. The client may attempt its JS tier.", mutation: "none")
          )
        case .relayoutRequired:
          return Response(
            ok: false,
            error: ErrorPayload(code: "KEYBOARD_RELAYOUT_REQUIRED", message: "Keyboard dismissed; refresh the snapshot and re-resolve the target before one retry. No tap was performed.", mutation: "none")
          )
        case .keyboardTarget(let retained, let point):
          var activated = false
          let timing = measureGesture {
            activated = activateKeyboardTarget(
              app: activeApp,
              retained: retained,
              point: point
            )
          }
          guard activated else {
            return Response(
              ok: false,
              error: ErrorPayload(code: "KEYBOARD_TARGET_STALE", message: "KEYBOARD_TARGET_STALE: the keyboard target changed before activation; no gesture was performed.", mutation: "none")
            )
          }
          return Response(
            ok: true,
            data: DataPayload(
              message: "tapped",
              gestureStartUptimeMs: timing.gestureStartUptimeMs,
              gestureEndUptimeMs: timing.gestureEndUptimeMs,
              keyboardGuard: "keyboard_target",
              keyboardGuardMs: keyboardGuardMs
            )
          )
        case .proceed(let status):
          keyboardGuardStatus = status
        }
        let liveCheck = liveTargetCheck(app: activeApp, command: command, deadline: ProcessInfo.processInfo.systemUptime + 0.3)
        switch DispatchGuard.decide(liveHittable: liveCheck.hittable, keyboardContainsPoint: false, targetMoved: liveCheck == .moved) {
        case .moved:
          return movedDispatchResponse()
        case .occluded:
          return Response(
            ok: false,
            error: ErrorPayload(code: "FOCUS_TARGET_OCCLUDED", message: Self.occludedDispatchMessage, mutation: "none")
          )
        case .proceed:
          break
        }
        var anchor: XCUIElement?
#if !os(tvOS)
        let resolved = coordinateAnchor(app: activeApp, point: CGPoint(x: x, y: y), liveTarget: lastLiveTarget)
        if resolved.decision == .outsideAlerts { return Self.appAlertInterruptionResponse() }
        anchor = resolved.element
#endif
        var outcome = RunnerInteractionOutcome.performed
        let timing = measureGesture {
          withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
            outcome = tapAt(app: activeApp, x: x, y: y, anchor: anchor)
          }
        }
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "tapped",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight,
            keyboardGuard: keyboardGuardStatus,
            keyboardGuardMs: keyboardGuardMs,
            occlusionCheck: liveCheck.hittable == nil ? "unavailable" : "hit-tested"
          )
        )
      }
      return Response(ok: false, error: ErrorPayload(message: "tap requires text or x/y"))
    case .mouseClick:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "mouseClick requires x and y"))
      }
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      do {
        var clickError: Error?
        let timing = measureGesture {
          do {
            try mouseClickAt(app: activeApp, x: x, y: y, button: command.button ?? "primary")
          } catch {
            clickError = error
          }
        }
        if let clickError {
          throw clickError
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "clicked",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight
          )
        )
      } catch {
        return Response(ok: false, error: ErrorPayload(message: error.localizedDescription))
      }
    case .tapSeries:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "tapSeries requires x and y"))
      }
      let count = max(Int(command.count ?? 1), 1)
      let intervalMs = max(command.intervalMs ?? 0, 0)
      let doubleTap = command.doubleTap ?? false
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      if doubleTap {
        var outcome = RunnerInteractionOutcome.performed
        let timing = measureGesture {
          withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
            runSeries(count: count, pauseMs: intervalMs) { _ in
              if case .performed = outcome {
                outcome = doubleTapAt(app: activeApp, x: x, y: y)
              }
            }
          }
        }
        if let response = unsupportedResponse(for: outcome) {
          return response
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "tap series",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            x: touchFrame.x,
            y: touchFrame.y,
            referenceWidth: touchFrame.referenceWidth,
            referenceHeight: touchFrame.referenceHeight
          )
        )
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          runSeries(count: count, pauseMs: intervalMs) { _ in
            if case .performed = outcome {
              outcome = tapAt(app: activeApp, x: x, y: y)
            }
          }
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "tap series",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: touchFrame.x,
          y: touchFrame.y,
          referenceWidth: touchFrame.referenceWidth,
          referenceHeight: touchFrame.referenceHeight
        )
      )
    case .longPress:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "longPress requires x and y"))
      }
      let duration = (command.durationMs ?? 800) / 1000.0
      let touchFrame = resolvedTouchVisualizationFrame(app: activeApp, x: x, y: y)
      let keyboardGuardStartMs = currentUptimeMs()
      let keyboardGuardAction = applyKeyboardGuard(
        app: activeApp,
        tapX: x,
        tapY: y,
        command: command,
        enabled: command.guardKeyboard != false
      )
      let keyboardGuardMs = currentUptimeMs() - keyboardGuardStartMs
      let keyboardGuardStatus: String
      switch keyboardGuardAction {
      case .targetStale:
        return Response(
          ok: false,
          error: ErrorPayload(code: "KEYBOARD_TARGET_STALE", message: "KEYBOARD_TARGET_STALE: the keyboard target changed before activation; no gesture was performed.", mutation: "none")
        )
      case .dismissFailed:
        return Response(
          ok: false,
          error: ErrorPayload(code: "KEYBOARD_DISMISS_FAILED", message: "KEYBOARD_DISMISS_FAILED: no safe native hide/dismiss control proved the keyboard hidden; no long press or swipe was performed. The client may attempt its JS tier.", mutation: "none")
        )
      case .relayoutRequired:
        return Response(
          ok: false,
          error: ErrorPayload(code: "KEYBOARD_RELAYOUT_REQUIRED", message: "Keyboard dismissed; refresh the snapshot and re-resolve the target before one retry. No long press was performed.", mutation: "none")
        )
      case .keyboardTarget(let retained, let point):
        var activated = false
        let timing = measureGesture {
          activated = activateKeyboardTarget(
            app: activeApp,
            retained: retained,
            point: point,
            duration: duration
          )
        }
        guard activated else {
          return Response(
            ok: false,
            error: ErrorPayload(code: "KEYBOARD_TARGET_STALE", message: "KEYBOARD_TARGET_STALE: the keyboard target changed before activation; no gesture was performed.", mutation: "none")
          )
        }
        return Response(
          ok: true,
          data: DataPayload(
            message: "long pressed",
            gestureStartUptimeMs: timing.gestureStartUptimeMs,
            gestureEndUptimeMs: timing.gestureEndUptimeMs,
            keyboardGuard: "keyboard_target",
            keyboardGuardMs: keyboardGuardMs
          )
        )
      case .proceed(let status):
        keyboardGuardStatus = status
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          outcome = longPressAt(app: activeApp, x: x, y: y, duration: duration)
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "long pressed",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: touchFrame.x,
          y: touchFrame.y,
          referenceWidth: touchFrame.referenceWidth,
          referenceHeight: touchFrame.referenceHeight,
          keyboardGuard: keyboardGuardStatus,
          keyboardGuardMs: keyboardGuardMs
        )
      )
    case .drag:
      guard let x = command.x, let y = command.y, let x2 = command.x2, let y2 = command.y2 else {
        return Response(ok: false, error: ErrorPayload(message: "drag requires x, y, x2, and y2"))
      }
      let holdDuration = min(max((command.durationMs ?? 60) / 1000.0, 0.016), 10.0)
      let dragFrame = resolvedDragVisualizationFrame(app: activeApp, x: x, y: y, x2: x2, y2: y2)
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          outcome = dragAt(app: activeApp, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "dragged",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: dragFrame.x,
          y: dragFrame.y,
          x2: dragFrame.x2,
          y2: dragFrame.y2,
          referenceWidth: dragFrame.referenceWidth,
          referenceHeight: dragFrame.referenceHeight
        )
      )
    case .dragSeries:
      guard let x = command.x, let y = command.y, let x2 = command.x2, let y2 = command.y2 else {
        return Response(ok: false, error: ErrorPayload(message: "dragSeries requires x, y, x2, and y2"))
      }
      let count = max(Int(command.count ?? 1), 1)
      let pauseMs = max(command.pauseMs ?? 0, 0)
      let pattern = command.pattern ?? "one-way"
      if pattern != "one-way" && pattern != "ping-pong" {
        return Response(ok: false, error: ErrorPayload(message: "dragSeries pattern must be one-way or ping-pong"))
      }
      let holdDuration = min(max((command.durationMs ?? 60) / 1000.0, 0.016), 10.0)
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          runSeries(count: count, pauseMs: pauseMs) { idx in
            guard case .performed = outcome else {
              return
            }
            let reverse = pattern == "ping-pong" && (idx % 2 == 1)
            if reverse {
              outcome = dragAt(app: activeApp, x: x2, y: y2, x2: x, y2: y, holdDuration: holdDuration)
            } else {
              outcome = dragAt(app: activeApp, x: x, y: y, x2: x2, y2: y2, holdDuration: holdDuration)
            }
          }
        }
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "drag series",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      )
    case .remotePress:
      guard let button = tvRemoteButton(from: command.remoteButton) else {
        return Response(ok: false, error: ErrorPayload(message: "remotePress requires remoteButton"))
      }
      let duration = (command.durationMs ?? 0) / 1000.0
      guard pressTvRemote(button, duration: duration) else {
        return Response(
          ok: false,
          error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "remotePress is only supported on tvOS")
        )
      }
      return Response(ok: true, data: DataPayload(message: "remote pressed"))
    case .type:
      guard let text = command.text else {
        return Response(ok: false, error: ErrorPayload(message: "type requires text"))
      }
      let delaySeconds = Double(max(command.delayMs ?? 0, 0)) / 1000.0
      if command.focused == true {
        return executeFocusedType(
          app: activeApp, text: text, replace: command.clearFirst == true,
          prepareReplacement: command.prepareReplacement == true,
          deleteCount: command.replacementDeleteCount ?? 0
        )
      }
      // GH #581: one exact operation — bind the declared input (never an
      // ambient-focused substitute), skip the focus tap only when THAT input
      // is proven focused, otherwise tap the declared focus target and prove
      // the same input gained focus before any keystroke.
      let hitTestDeadline = ProcessInfo.processInfo.systemUptime + 0.3
      var resolved: TypeTargetOutcome = .failure(
        Response(ok: false, error: ErrorPayload(code: "NO_TEXT_INPUT_TARGET", message: "NO_TEXT_INPUT_TARGET: target resolution did not run", mutation: "none"))
      )
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        resolved = resolveTypeCommandTarget(app: activeApp, command: command)
      }
      if liveTargetCheck(app: activeApp, command: command, deadline: hitTestDeadline, checkHittability: false) == .moved {
        return movedDispatchResponse()
      }
      let target: XCUIElement
      let inputResolution: String
      switch resolved {
      case .failure(let response):
        return response
      case .bound(let element, _, let resolution):
        target = element
        inputResolution = resolution
      }
      var focusTap = "skipped-exact-focused"
      var alreadyFocused = false
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        alreadyFocused = isExactInputFocused(app: activeApp, element: target)
      }
      if !alreadyFocused {
        var focusPoint = CGPoint(x: command.focusX ?? 0, y: command.focusY ?? 0)
        if command.focusX == nil || command.focusY == nil {
          let frame = target.frame
          focusPoint = CGPoint(x: frame.midX, y: frame.midY)
        }
        let keyboardContainsPoint = keyboardFrameIfVisible(app: activeApp)?.contains(focusPoint) == true
        // The input's own hit test speaks for the focus point only when that point is on the input.
        let liveHittable = target.frame.contains(focusPoint) ? boundedHittable(target, deadline: hitTestDeadline) : nil
        if DispatchGuard.decide(liveHittable: liveHittable, keyboardContainsPoint: keyboardContainsPoint) == .occluded {
          return Response(
            ok: false,
            error: ErrorPayload(code: "FOCUS_TARGET_OCCLUDED", message: Self.occludedDispatchMessage, mutation: "none")
          )
        }
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          _ = tapAt(app: activeApp, x: focusPoint.x, y: focusPoint.y)
        }
        var focusProven = false
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          focusProven = waitForExactInputFocus(
            app: activeApp,
            element: target,
            timeoutMs: command.focusWaitMs ?? 1500
          )
        }
        guard focusProven else {
          return Response(
            ok: false,
            error: ErrorPayload(
              code: "TEXT_TARGET_FOCUS_FAILED",
              message: "TEXT_TARGET_FOCUS_FAILED: the bound input did not gain keyboard focus after tapping the declared focus target; no typing was performed. Increase waitForKeyboardMs or refresh the snapshot and retry.",
              mutation: "none"
            )
          )
        }
        focusTap = "performed"
      }
      // Story 10 (#391): never type into a keyboard that isn't up — iOS drops
      // keystrokes sent during keyboard appearance; best-effort because a
      // hardware-keyboard simulator may never present the software keyboard.
      var keyboardWait: (appeared: Bool, waitedMs: Int) = (false, 0)
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        keyboardWait = TypingRecipe.waitForKeyboard(
          now: { ProcessInfo.processInfo.systemUptime },
          sleep: { Thread.sleep(forTimeInterval: $0) },
          keyboardVisible: { activeApp.keyboards.count > 0 }
        )
      }
      // Re-prove focus operation-fresh after the keyboard wait — focus may
      // have moved during it, and typing must never proceed on a stale proof.
      var focusStillProven = false
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        focusStillProven = isExactInputFocused(app: activeApp, element: target)
      }
      guard focusStillProven else {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "TEXT_TARGET_FOCUS_FAILED",
            message: "TEXT_TARGET_FOCUS_FAILED: keyboard focus left the bound input before typing began; no typing was performed. Refresh the snapshot and retry.",
            mutation: "none"
          )
        )
      }
      // Empty text is an unconditional exact-target clear (GH #581); clearFirst
      // additionally clears before a non-empty retype.
      if command.clearFirst == true || text.isEmpty {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          clearTextInput(target)
        }
      }
      var usedBurst = false
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        if text.isEmpty {
          // Cleared above; nothing to type.
        } else if delaySeconds > 0 && text.count > 1 {
          // Explicit per-char pacing (--delay-ms, the corrective-retype
          // contract) wins over the two-burst recipe.
          let chunks = Array(text)
          for (index, character) in chunks.enumerated() {
            gesture { target.typeText(String(character)) }
            if index + 1 < chunks.count {
              Thread.sleep(forTimeInterval: delaySeconds)
            }
          }
        } else if let bursts = TypingRecipe.bursts(for: text) {
          // Story 10 (#391): two-burst send — first character alone, sit out
          // the post-appearance drop window, then stream the remainder.
          gesture { target.typeText(bursts.first) }
          Thread.sleep(forTimeInterval: TypingRecipe.interBurstDelay)
          gesture { target.typeText(bursts.remainder) }
          usedBurst = true
        } else {
          gesture { target.typeText(text) }
        }
      }
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        lastExactTypeTarget = RecordedExactTypeTarget(
          operationToken: command.operationToken,
          element: target,
          generation: currentSnapshotGeneration,
          nodeIndex: command.snapshotNodeIndex,
          attributes: liveAttributes(of: target)
        )
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "typed",
          typingBurst: usedBurst,
          keyboardWaitMs: keyboardWait.waitedMs,
          inputResolution: inputResolution,
          focusTap: focusTap
        )
      )
    case .verifyInput:
      guard let expected = command.text else {
        return Response(ok: false, error: ErrorPayload(code: "INVALID_ARGUMENT", message: "verifyInput requires text"))
      }
      var verifyTarget: XCUIElement?
      var lostVerdict = TextInputTarget.VerifyVerdict.targetLost
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        if let operationToken = command.operationToken {
          if let recorded = lastExactTypeTarget,
             recorded.operationToken == operationToken {
            verifyTarget = recorded.element
          }
        } else {
          let verifyDescriptor = exactInputDescriptor(from: command)
          var recordAgreesWithRequest = false
          if let recorded = lastExactTypeTarget,
             let attributes = recorded.attributes,
             let descriptor = verifyDescriptor {
            recordAgreesWithRequest = TextInputTarget.recordedRequestAgrees(
              recorded: attributes,
              recordedGeneration: recorded.generation,
              recordedNodeIndex: recorded.nodeIndex,
              descriptorType: descriptor.type,
              descriptorIdentifier: descriptor.identifier,
              descriptorGeneration: descriptor.generation,
              requestedNodeIndex: command.snapshotNodeIndex
            )
          }
          if let recorded = lastExactTypeTarget,
             let attributes = recorded.attributes,
             recorded.generation == currentSnapshotGeneration,
             recordAgreesWithRequest {
            switch resolveRecordedTextInput(app: activeApp, recorded: attributes) {
            case .bound(let element):
              verifyTarget = element
            case .ambiguous:
              lostVerdict = .ambiguous
            case .absent:
              break
            }
          }
          if verifyTarget == nil, lostVerdict == .targetLost, let descriptor = verifyDescriptor {
            let sameGeneration = descriptor.generation == currentSnapshotGeneration
            switch resolveExactTextInput(
              app: activeApp,
              descriptor: descriptor,
              sameGeneration: sameGeneration,
              requireFrameMatch: true
            ) {
            case .bound(let element):
              verifyTarget = element
            case .ambiguous:
              lostVerdict = .ambiguous
            case .absent:
              lostVerdict = .targetLost
            }
          }
        }
      }
      guard let verifyElement = verifyTarget else {
        return Response(
          ok: true,
          data: DataPayload(verifyVerdict: lostVerdict.rawValue, verifyStable: false)
        )
      }
      let isSecure = verifyElement.elementType == .secureTextField
      var verdict = TextInputTarget.VerifyVerdict.unreadable
      var stable = false
      withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
        var previous: TextInputTarget.VerifyObservation?
        for attempt in 0..<3 {
          let read = readExactInputValue(verifyElement)
          let observation = TextInputTarget.verifyObservation(
            expected: expected,
            rawValue: read.raw,
            placeholder: read.placeholder,
            isSecure: isSecure
          )
          verdict = observation.verdict
          if previous == observation {
            stable = true
            break
          }
          previous = observation
          if attempt < 2 { Thread.sleep(forTimeInterval: 0.15) }
        }
      }
      return Response(
        ok: true,
        data: DataPayload(verifyVerdict: verdict.rawValue, verifyStable: stable)
      )
    case .interactionFrame:
      let frame = resolvedTouchReferenceFrame(app: activeApp, appFrame: activeApp.frame)
      return Response(
        ok: true,
        data: DataPayload(
          x: frame.minX,
          y: frame.minY,
          referenceWidth: frame.width,
          referenceHeight: frame.height
        )
      )
    case .swipe:
      guard let direction = command.direction else {
        return Response(ok: false, error: ErrorPayload(message: "swipe requires direction"))
      }
      var executedFrame: DragVisualizationFrame?
      let timing = measureGesture {
        withTemporaryScrollIdleTimeoutIfSupported(activeApp) {
          executedFrame = swipe(
            app: activeApp,
            direction: direction
          )
        }
      }
      guard let dragFrame = executedFrame else {
        return Response(ok: false, error: ErrorPayload(message: "swipe is only supported on tvOS"))
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "swiped",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs,
          x: dragFrame.x,
          y: dragFrame.y,
          x2: dragFrame.x2,
          y2: dragFrame.y2,
          referenceWidth: dragFrame.referenceWidth,
          referenceHeight: dragFrame.referenceHeight
        )
      )
    case .findText:
      guard let text = command.text else {
        return Response(ok: false, error: ErrorPayload(message: "findText requires text"))
      }
      let found = findElement(app: activeApp, text: text) != nil
      return Response(ok: true, data: DataPayload(found: found))
    case .readText:
      guard let x = command.x, let y = command.y else {
        return Response(ok: false, error: ErrorPayload(message: "readText requires x and y"))
      }
      guard let text = readTextAt(app: activeApp, x: x, y: y) else {
        return Response(ok: false, error: ErrorPayload(message: "readText did not resolve text"))
      }
      return Response(ok: true, data: DataPayload(text: text))
    case .snapshot:
      currentSnapshotGeneration += 1
      let options = SnapshotOptions(
        interactiveOnly: command.interactiveOnly ?? false,
        compact: command.compact ?? false,
        depth: command.depth,
        scope: command.scope,
        raw: command.raw ?? false
      )
      let payload = runnerPayload(
        options.raw
          ? snapshotRaw(app: activeApp, options: options)
          : snapshotFast(app: activeApp, options: options, includeDiagnostics: command.qaReadOnly == true),
        appProcessIdentifier: observedProcessIdentifier(activeApp)
      )
      retainSnapshotTargets(payload.nodes ?? [])
      needsPostSnapshotInteractionDelay = true
      return Response(ok: true, data: payload)
    case .screenshot:
      let screenshot: XCUIScreenshot
#if os(macOS)
      // macOS keeps the app-targeted capture behavior for window-level screenshots.
      if command.qaReadOnly != true, let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        let targetApp = XCUIApplication(bundleIdentifier: bundleId)
        targetApp.activate()
        activeApp = targetApp
        // Brief wait for the app transition animation to complete
        Thread.sleep(forTimeInterval: 0.5)
      }
      if command.fullscreen == true {
        screenshot = XCUIScreen.main.screenshot()
      } else if let bundleId = command.appBundleId, !bundleId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        screenshot = screenshotRoot(app: activeApp).screenshot()
      } else {
        screenshot = XCUIScreen.main.screenshot()
      }
#else
      screenshot = XCUIScreen.main.screenshot()
#endif
      guard let pngData = runnerPngData(for: screenshot.image) else {
        return Response(ok: false, error: ErrorPayload(message: "Failed to encode screenshot as PNG"))
      }
      let fileName = "screenshot-\(Int(Date().timeIntervalSince1970 * 1000)).png"
      let filePath = (NSTemporaryDirectory() as NSString).appendingPathComponent(fileName)
      do {
        try pngData.write(to: URL(fileURLWithPath: filePath))
      } catch {
        return Response(ok: false, error: ErrorPayload(message: "Failed to write screenshot: \(error.localizedDescription)"))
      }
#if os(macOS)
      return Response(ok: true, data: DataPayload(message: filePath))
#else
      // Return path relative to app container root (tmp/ maps to NSTemporaryDirectory)
      return Response(ok: true, data: DataPayload(message: "tmp/\(fileName)"))
#endif
    case .isScreenStatic:
#if os(macOS)
      return Response(
        ok: false,
        error: ErrorPayload(code: "UNSUPPORTED_OPERATION", message: "isScreenStatic is iOS/tvOS-only"))
#else
      // Settle probe (#385): two full-screen captures ~100ms apart, compared by
      // SHA-256 on-runner so only a boolean crosses the wire (Maestro's
      // ScreenDiffHandler split).
      let first = XCUIScreen.main.screenshot()
      sleepFor(0.1)
      let second = XCUIScreen.main.screenshot()
      guard let firstPng = runnerPngData(for: first.image),
            let secondPng = runnerPngData(for: second.image) else {
        return Response(
          ok: false,
          error: ErrorPayload(message: "Failed to encode screenshots for isScreenStatic"))
      }
      let isStatic = SHA256.hash(data: firstPng) == SHA256.hash(data: secondPng)
      return Response(ok: true, data: DataPayload(message: "isScreenStatic", static: isStatic))
#endif
    case .back, .backInApp:
      if tapInAppBackControl(app: activeApp) {
        let message = command.command == .back ? "back" : "backInApp"
        return Response(ok: true, data: DataPayload(message: message))
      }
      return Response(ok: false, error: ErrorPayload(message: "in-app back control is not available"))
    case .backSystem:
      if performSystemBackAction(app: activeApp) {
        return Response(ok: true, data: DataPayload(message: "backSystem"))
      }
      return Response(ok: false, error: ErrorPayload(message: "system back is not available"))
    case .home:
      pressHomeButton()
      return Response(ok: true, data: DataPayload(message: "home"))
    case .rotate:
      guard let orientation = command.orientation?.trimmingCharacters(in: .whitespacesAndNewlines),
        !orientation.isEmpty
      else {
        return Response(ok: false, error: ErrorPayload(message: "rotate requires orientation"))
      }
      if rotateDevice(to: orientation) {
        return Response(
          ok: true,
          data: DataPayload(message: "rotate", orientation: orientation)
        )
      }
      return Response(
        ok: false,
        error: ErrorPayload(message: "unsupported rotate orientation: \(orientation)")
      )
    case .appSwitcher:
      performAppSwitcherGesture(app: activeApp)
      return Response(ok: true, data: DataPayload(message: "appSwitcher"))
    case .keyboardDismiss:
      let result = dismissKeyboard(app: activeApp)
      if result.wasVisible && !result.dismissed {
        return Response(
          ok: false,
          error: ErrorPayload(
            code: "KEYBOARD_DISMISS_FAILED",
            message: "Unable to dismiss the iOS keyboard via a safe native hide/dismiss control"
          )
        )
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "keyboardDismiss",
          visible: result.visible,
          wasVisible: result.wasVisible,
          dismissed: result.dismissed,
          via: result.via
        )
      )
    case .systemAlertTap:
      return systemAlertTap(label: command.text)
    case .pinch:
      guard let scale = command.scale, scale > 0 else {
        return Response(ok: false, error: ErrorPayload(message: "pinch requires scale > 0"))
      }
      var outcome = RunnerInteractionOutcome.performed
      let timing = measureGesture {
        outcome = pinch(app: activeApp, scale: scale, x: command.x, y: command.y)
      }
      if let response = unsupportedResponse(for: outcome) {
        return response
      }
      return Response(
        ok: true,
        data: DataPayload(
          message: "pinched",
          gestureStartUptimeMs: timing.gestureStartUptimeMs,
          gestureEndUptimeMs: timing.gestureEndUptimeMs
        )
      )
    }
  }
}
