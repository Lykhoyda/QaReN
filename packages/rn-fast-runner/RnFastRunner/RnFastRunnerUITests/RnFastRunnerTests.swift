//
//  RnFastRunnerTests.swift
//  RnFastRunnerUITests
//
//  Created by Michał Pierzchała on 30/01/2026.
//

import XCTest
import Network
#if canImport(UIKit)
import UIKit
typealias RunnerImage = UIImage
#elseif canImport(AppKit)
import AppKit
typealias RunnerImage = NSImage
#endif

func runnerListenerWaitFailure(
  listenerError: String?,
  waitResult: XCTWaiter.Result
) -> String? {
  if let listenerError {
    return "runner listener failed to start: \(listenerError)"
  }
  if waitResult != .completed {
    return "runner wait ended with \(waitResult)"
  }
  return nil
}

class RnFastRunnerTests: XCTestCase {
  enum RunnerErrorDomain {
    static let general = "RnFastRunner"
    static let exception = "RnFastRunner.NSException"
  }

  enum RunnerErrorCode {
    static let noResponseFromMainThread = 1
    static let commandReturnedNoResponse = 2
    static let mainThreadExecutionTimedOut = 3
    static let attachOnlyTargetUnavailable = 4
    static let objcException = 1
  }

  static let springboardBundleId = "com.apple.springboard"
  var listener: NWListener?
  let commandJournal = CommandJournal()
  var doneExpectation: XCTestExpectation?
  let app = XCUIApplication()
  lazy var springboard = XCUIApplication(bundleIdentifier: Self.springboardBundleId)
  var currentApp: XCUIApplication?
  var currentBundleId: String?
  private let wedgeLock = NSLock()
  private var runnerWedged = false
  private let listenerFailureLock = NSLock()
  private var listenerStartupFailure: String?
#if RN_FAST_RUNNER_TEST_FAULTS
  var testFaultConsumed = false
#endif
  let maxRequestBytes = 2 * 1024 * 1024
  let maxSnapshotElements = 600
  let fastSnapshotLimit = 300
  let mainThreadExecutionTimeout: TimeInterval = 30
  let appExistenceTimeout: TimeInterval = 30
  let retryCooldown: TimeInterval = 0.2
  let postSnapshotInteractionDelay: TimeInterval = 0.2
  let firstInteractionAfterActivateDelay: TimeInterval = 0.25
  let scrollInteractionIdleTimeoutDefault: TimeInterval = 1.0
  var needsPostSnapshotInteractionDelay = false
  var currentSnapshotGeneration = 0
  var retainedSnapshotTargets: [Int: RetainedSnapshotTarget] = [:]
  // Set only by the latest live target check that proved movement.
  var lastMovedFrames: (
    retained: CGRect, live: CGRect,
    retainedIdentity: DispatchGuard.NodeIdentity, liveIdentity: DispatchGuard.NodeIdentity?
  )?
  // The live element the latest target check resolved with the retained frame.
  var lastLiveTarget: XCUIElement?
  var appAlertInterruptions = 0
  var lastExactTypeTarget: RecordedExactTypeTarget?
  var needsFirstInteractionDelay = false
  let interactiveTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .checkBox,
    .collectionView,
    .link,
    .menuItem,
    .picker,
    .searchField,
    .segmentedControl,
    .slider,
    .stepper,
    .switch,
    .tabBar,
    .textField,
    .secureTextField,
    .textView
  ]
  // Keep blocker actions narrow to avoid false positives from generic hittable containers.
  let actionableTypes: Set<XCUIElement.ElementType> = [
    .button,
    .cell,
    .link,
    .menuItem,
    .checkBox,
    .switch
  ]

  func markRunnerWedged() {
    wedgeLock.lock()
    runnerWedged = true
    wedgeLock.unlock()
  }

  func isRunnerWedged() -> Bool {
    wedgeLock.lock()
    defer { wedgeLock.unlock() }
    return runnerWedged
  }

  private func recordListenerStartupFailure(_ message: String) {
    listenerFailureLock.lock()
    listenerStartupFailure = message
    listenerFailureLock.unlock()
  }

  private func currentListenerStartupFailure() -> String? {
    listenerFailureLock.lock()
    defer { listenerFailureLock.unlock() }
    return listenerStartupFailure
  }

  // MARK: - XCTest Entry

  override func setUp() {
    continueAfterFailure = true
    // Claim target-app alerts untouched so XCTest's default handler never presses their cancel button.
    addUIInterruptionMonitor(withDescription: "rn-fast-runner target app alert") { [weak self] element in
      guard let self, self.isTargetAppAlert(element) else { return false }
      self.appAlertInterruptions += 1
      return true
    }
  }

  func isTargetAppAlert(_ element: XCUIElement) -> Bool {
    var owned = false
    _ = RunnerObjCExceptionCatcher.catchException({
      guard element.elementType == .alert else { return }
      let frame = element.frame
      owned = (self.currentApp ?? self.app).alerts.allElementsBoundByIndex.contains { $0.frame == frame }
    })
    return owned
  }

  @MainActor
  func testCommand() throws {
    doneExpectation = expectation(description: "rn-fast-runner command handled")
    if RunnerEnv.attachOnly() {
      guard let bundleId = RunnerEnv.appId(), !bundleId.isEmpty else {
        throw NSError(
          domain: RunnerErrorDomain.general,
          code: RunnerErrorCode.attachOnlyTargetUnavailable,
          userInfo: [
            NSLocalizedDescriptionKey:
              "RUNNER_OWNERSHIP_MISMATCH: attach-only runner target is unavailable"
          ]
        )
      }
      currentApp = try activateAttachOnlyTarget(bundleId: bundleId)
      currentBundleId = bundleId
    } else {
      app.launch()
      currentApp = app
    }
    let queue = DispatchQueue(label: "rn-fast-runner.runner")
    let desiredPort = RunnerEnv.resolvePort()
    NSLog("RN_FAST_RUNNER_DESIRED_PORT=%d", desiredPort)
    let quiescence = QuiescenceStatus.current()
    if quiescence == .active {
      let variant = RNQuiescenceGetProbeResult() == .preEvent ? "preEvent" : "classic"
      NSLog("%@=%@", quiescence.startupMarker, variant)
    } else {
      NSLog("%@", quiescence.startupMarker)
    }
    listener = try makeRunnerListener(desiredPort: desiredPort)
    listener?.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        NSLog("RN_FAST_RUNNER_LISTENER_READY")
        if let listenerPort = self?.listener?.port {
          NSLog("RN_FAST_RUNNER_PORT=%d", listenerPort.rawValue)
        } else {
          NSLog("RN_FAST_RUNNER_PORT_NOT_SET")
        }
      case .failed(let error):
        let detail = String(describing: error)
        self?.recordListenerStartupFailure(detail)
        NSLog("RN_FAST_RUNNER_LISTENER_FAILED=%@", detail)
        self?.doneExpectation?.fulfill()
      default:
        break
      }
    }
    listener?.newConnectionHandler = { [weak self] conn in
      conn.start(queue: queue)
      self?.handle(connection: conn)
    }
    listener?.start(queue: queue)

    guard let expectation = doneExpectation else {
      XCTFail("runner expectation was not initialized")
      return
    }
    NSLog("RN_FAST_RUNNER_WAITING")
    let result = XCTWaiter.wait(for: [expectation], timeout: 24 * 60 * 60)
    NSLog("RN_FAST_RUNNER_WAIT_RESULT=%@", String(describing: result))
    if let failure = runnerListenerWaitFailure(
      listenerError: currentListenerStartupFailure(),
      waitResult: result
    ) {
      XCTFail(failure)
    }
  }

  private func makeRunnerListener(desiredPort: UInt16) throws -> NWListener {
    if desiredPort > 0, let port = NWEndpoint.Port(rawValue: desiredPort) {
      #if os(macOS)
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        return try NWListener(using: parameters)
      #else
        return try NWListener(using: .tcp, on: port)
      #endif
    }
    return try NWListener(using: .tcp)
  }
}
