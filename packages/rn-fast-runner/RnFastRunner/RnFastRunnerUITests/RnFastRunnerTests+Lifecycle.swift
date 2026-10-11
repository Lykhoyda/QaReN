import XCTest
#if canImport(AppKit)
import AppKit
#endif

func runnerAttachOnlyTargetIsRunning(_ state: XCUIApplication.State) -> Bool {
  switch state {
  case .runningForeground, .runningBackground, .runningBackgroundSuspended:
    return true
  case .unknown, .notRunning:
    return false
  @unknown default:
    return false
  }
}

func runnerPayload(_ payload: DataPayload, appProcessIdentifier: Int?) -> DataPayload {
  var observed = payload
  observed.appProcessIdentifier = appProcessIdentifier.flatMap { $0 > 0 ? $0 : nil }
  return observed
}

func runnerPngData(for image: RunnerImage) -> Data? {
#if canImport(UIKit)
  return image.pngData()
#elseif canImport(AppKit)
  guard let cgImage = runnerCGImage(from: image) else { return nil }
  let bitmap = NSBitmapImageRep(cgImage: cgImage)
  return bitmap.representation(using: .png, properties: [:])
#endif
}

func runnerCGImage(from image: RunnerImage) -> CGImage? {
#if canImport(UIKit)
  return image.cgImage
#elseif canImport(AppKit)
  return image.cgImage(forProposedRect: nil, context: nil, hints: nil)
#endif
}

extension RnFastRunnerTests {
  // Reads the process only; it never activates or launches the target.
  func observedProcessIdentifier(_ target: XCUIApplication) -> Int? {
    let selector = NSSelectorFromString("processID")
    guard target.responds(to: selector) else { return nil }
    return (target.value(forKey: "processID") as? NSNumber)?.intValue
  }

  func activateAttachOnlyTarget(bundleId: String) throws -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: bundleId)
    guard runnerAttachOnlyTargetIsRunning(target.state),
          let processBefore = observedProcessIdentifier(target),
          processBefore > 0
    else {
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.attachOnlyTargetUnavailable,
        userInfo: [
          NSLocalizedDescriptionKey:
            "RUNNER_OWNERSHIP_MISMATCH: attach-only target '\(bundleId)' is not running"
        ]
      )
    }
    target.activate()
    let processAfter = observedProcessIdentifier(target)
    guard runnerAttachOnlyTargetIsRunning(target.state), processAfter == processBefore else {
      if let processAfter, processAfter != processBefore, runnerAttachOnlyTargetIsRunning(target.state) {
        target.terminate()
      }
      throw NSError(
        domain: RunnerErrorDomain.general,
        code: RunnerErrorCode.attachOnlyTargetUnavailable,
        userInfo: [
          NSLocalizedDescriptionKey:
            "RUNNER_OWNERSHIP_MISMATCH: attach-only target changed during activation"
        ]
      )
    }
    return target
  }

  func screenshotRoot(app: XCUIApplication) -> XCUIElement {
#if os(macOS)
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isNull && !$0.frame.isEmpty }) {
      return window
    }
#endif
    return app
  }

  // MARK: - Target Activation

  func targetNeedsActivation(_ target: XCUIApplication) -> Bool {
    let state = target.state
#if os(macOS)
    if state == .unknown || state == .notRunning || state == .runningBackground {
      return true
    }
#else
    if state == .unknown || state == .notRunning || state == .runningBackground
      || state == .runningBackgroundSuspended
    {
      return true
    }
#endif
    return false
  }

  func activateTarget(bundleId: String, reason: String) -> XCUIApplication {
    let target = XCUIApplication(bundleIdentifier: bundleId)
    NSLog(
      "RN_FAST_RUNNER_ACTIVATE bundle=%@ state=%d reason=%@",
      bundleId,
      target.state.rawValue,
      reason
    )
    // activate avoids terminating and relaunching the target app
    target.activate()
    currentApp = target
    currentBundleId = bundleId
    needsFirstInteractionDelay = true
    return target
  }

  func withTemporaryScrollIdleTimeoutIfSupported(
    _ target: XCUIApplication,
    operation: () -> Void
  ) {
    let setter = NSSelectorFromString("setWaitForIdleTimeout:")
    let supportsWaitForIdleTimeout = target.responds(to: setter)
    let previous = supportsWaitForIdleTimeout
      ? (target.value(forKey: "waitForIdleTimeout") as? NSNumber)
      : nil
    if supportsWaitForIdleTimeout {
      target.setValue(resolveScrollInteractionIdleTimeout(), forKey: "waitForIdleTimeout")
    }
    defer {
      if let previous {
        target.setValue(previous.doubleValue, forKey: "waitForIdleTimeout")
      }
    }
    performWithQuiescenceSkippedIfSupported(target, operation: operation)
  }

  // Some apps never report post-gesture quiescence, even after XCTest has synthesized the event.
  private func performWithQuiescenceSkippedIfSupported(
    _ target: XCUIApplication,
    operation: () -> Void
  ) {
    let selector = NSSelectorFromString("_performWithInteractionOptions:block:")
    guard target.responds(to: selector) else {
      operation()
      return
    }
    typealias PerformWithInteractionOptions = @convention(c) (
      NSObject,
      Selector,
      UInt,
      @convention(block) () -> Void
    ) -> Void
    let implementation = target.method(for: selector)
    let performWithOptions = unsafeBitCast(
      implementation,
      to: PerformWithInteractionOptions.self
    )
    let skipPreEventQuiescence = UInt(1)
    let skipPostEventQuiescence = UInt(2)
    withoutActuallyEscaping(operation) { escapableOperation in
      let block: @convention(block) () -> Void = escapableOperation
      performWithOptions(
        target,
        selector,
        skipPreEventQuiescence | skipPostEventQuiescence,
        block
      )
    }
  }

  private func resolveScrollInteractionIdleTimeout() -> TimeInterval {
    guard
      let raw = ProcessInfo.processInfo.environment["AGENT_DEVICE_IOS_INTERACTION_IDLE_TIMEOUT"],
      !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    else {
      return scrollInteractionIdleTimeoutDefault
    }
    guard let parsed = Double(raw), parsed >= 0 else {
      return scrollInteractionIdleTimeoutDefault
    }
    return min(parsed, 30)
  }

  func shouldRetryCommand(_ command: Command) -> Bool {
    if RunnerEnv.isTruthy("RN_FAST_RUNNER_DISABLE_READONLY_RETRY") {
      return false
    }
    return isReadOnlyCommand(command)
  }

  func shouldRetryException(_ command: Command, message: String) -> Bool {
    guard shouldRetryCommand(command) else { return false }
    let normalized = message.lowercased()
    if normalized.contains("kaxerrorservernotfound") {
      return true
    }
    if normalized.contains("main thread execution timed out") {
      return true
    }
    if normalized.contains("timed out") && command.command == .snapshot {
      return true
    }
    return false
  }

  // MARK: - Command Classification

  func isReadOnlyCommand(_ command: Command) -> Bool {
    switch command.command {
    case .interactionFrame, .findText, .readText, .snapshot, .screenshot:
      return true
    default:
      return false
    }
  }

  func shouldRetryResponse(_ response: Response) -> Bool {
    guard response.ok == false else { return false }
    guard let message = response.error?.message.lowercased() else { return false }
    return message.contains("is not available")
  }

  func isInteractionCommand(_ command: CommandType) -> Bool {
    switch command {
    case
      .tap,
      .longPress,
      .drag,
      .remotePress,
      .type,
      .swipe,
      .back,
      .backInApp,
      .backSystem,
      .rotate,
      .appSwitcher,
      .keyboardDismiss,
      .pinch:
      return true
    default:
      return false
    }
  }

  // MARK: - Interaction Stabilization

  func applyInteractionStabilizationIfNeeded() {
    if needsPostSnapshotInteractionDelay {
      sleepFor(postSnapshotInteractionDelay)
      needsPostSnapshotInteractionDelay = false
    }
    if needsFirstInteractionDelay {
      sleepFor(firstInteractionAfterActivateDelay)
      needsFirstInteractionDelay = false
    }
  }

  func sleepFor(_ delay: TimeInterval) {
    guard delay > 0 else { return }
    usleep(useconds_t(delay * 1_000_000))
  }
}

// Free function (not a test-case method) so pure-logic tests can exercise the
// classification without instantiating the XCUITest harness.
func isRunnerLifecycleCommand(_ command: CommandType) -> Bool {
  switch command {
  // isScreenStatic skips activation like .screenshot: (1) it is a pure read of
  // whatever is actually on screen — if a foreign overlay/dialog is animating,
  // "not settled" is the RIGHT answer, and re-activating mid-probe would fight
  // legitimate transitions; (2) it only ever runs immediately after a mutating
  // command that DID run the activation preamble, so the target app is
  // foregrounded by construction; (3) activate() inside a 200ms poll loop would
  // dominate the probe cost and perturb the very animations being measured.
  case .shutdown, .screenshot, .isScreenStatic:
    return true
  default:
    return false
  }
}
