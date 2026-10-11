import XCTest

// MARK: - Wire Models

enum CommandType: String, Codable, CaseIterable {
  case tap
  case mouseClick
  case tapSeries
  case longPress
  case interactionFrame
  case drag
  case dragSeries
  case remotePress
  case type
  case verifyInput
  case swipe
  case findText
  case readText
  case snapshot
  case screenshot
  case back
  case backInApp
  case backSystem
  case home
  case rotate
  case appSwitcher
  case keyboardDismiss
  case systemAlertTap
  case pinch
  case isScreenStatic
  case uptime
  case status
  case shutdown
}

struct Command: Codable {
  let command: CommandType
  let commandId: String?
  let appBundleId: String?
  let text: String?
  let delayMs: Int?
  let clearFirst: Bool?
  let action: String?
  let x: Double?
  let y: Double?
  let button: String?
  let remoteButton: String?
  let count: Double?
  let intervalMs: Double?
  let doubleTap: Bool?
  let pauseMs: Double?
  let pattern: String?
  let x2: Double?
  let y2: Double?
  let durationMs: Double?
  let direction: String?
  let orientation: String?
  let scale: Double?
  let interactiveOnly: Bool?
  let compact: Bool?
  let depth: Int?
  let scope: String?
  let raw: Bool?
  var platformPresence: Bool? = nil
  var qaReadOnly: Bool? = nil
  var presenceBudgetMs: Int? = nil
  let fullscreen: Bool?
  var guardKeyboard: Bool? = nil
  var targetBounds: SnapshotRect? = nil
  var snapshotGeneration: Int? = nil
  var snapshotNodeIndex: Int? = nil
  var snapshotElementType: String? = nil
  var snapshotLabel: String? = nil
  var snapshotIdentifier: String? = nil
  var keyboardStateAtSnapshot: Bool? = nil
  // GH #581: declared focus-tap point for exact `type` (wrapper center when the
  // caller targeted a `${name}-pressable`, input center otherwise) and the
  // bounded wait for focus to land after that tap.
  var focusX: Double? = nil
  var focusY: Double? = nil
  var focusWaitMs: Int? = nil
  var focused: Bool? = nil
  var operationToken: String? = nil
}

struct Response: Codable {
  let ok: Bool
  let v: Int
  let reason: String?
  let protocolVersion: Int?
  let runnerVersion: String?
  let capabilities: [String]?
  let commands: [String]?
  let instanceId: String?
  let sessionId: String?
  let claimEpoch: Int?
  let deviceId: String?
  let appId: String?
  let data: DataPayload?
  let error: ErrorPayload?

  init(
    ok: Bool,
    data: DataPayload? = nil,
    error: ErrorPayload? = nil,
    reason: String? = nil,
    protocolVersion: Int? = nil,
    runnerVersion: String? = nil,
    capabilities: [String]? = nil,
    commands: [String]? = nil,
    instanceId: String? = nil,
    sessionId: String? = nil,
    claimEpoch: Int? = nil,
    deviceId: String? = nil,
    appId: String? = nil
  ) {
    self.ok = ok
    self.v = RunnerProtocol.version
    self.reason = reason
    self.data = data
    self.error = error
    self.protocolVersion = protocolVersion
    self.runnerVersion = runnerVersion
    self.capabilities = capabilities
    self.commands = commands
    self.instanceId = instanceId
    self.sessionId = sessionId
    self.claimEpoch = claimEpoch
    self.deviceId = deviceId
    self.appId = appId
  }
}

struct DataPayload: Codable {
  let message: String?
  let text: String?
  let found: Bool?
  let items: [String]?
  let nodes: [SnapshotNode]?
  let truncated: Bool?
  let gestureStartUptimeMs: Double?
  let gestureEndUptimeMs: Double?
  let x: Double?
  let y: Double?
  let x2: Double?
  let y2: Double?
  let referenceWidth: Double?
  let referenceHeight: Double?
  let currentUptimeMs: Double?
  let visible: Bool?
  let wasVisible: Bool?
  let dismissed: Bool?
  let orientation: String?
  let keyboardGuard: String?
  let keyboardGuardMs: Double?
  let keyboardVisible: Bool?
  let snapshotGeneration: Int?
  let presenceCapture: PlatformPresenceCapture?
  let via: String?
  let `static`: Bool?
  // Story 10 (#391): typing telemetry — whether the two-burst recipe ran and
  // how long the keyboard-presence wait blocked before the first keystroke.
  let typingBurst: Bool?
  let keyboardWaitMs: Int?
  // GH #581: exact-type observation — how the input was resolved, whether the
  // focus tap ran or was skipped as already-focused, and the secret-free
  // verifyInput verdict/stability pair.
  let inputResolution: String?
  let focusTap: String?
  let verifyVerdict: String?
  let verifyStable: Bool?
  let textEntryRoute: String?
  let occlusionCheck: String?
  var appProcessIdentifier: Int? = nil
  var tappedLabel: String? = nil
  var tappedRect: SnapshotRect? = nil
  var alertClosed: Bool? = nil

  init(
    message: String? = nil,
    text: String? = nil,
    found: Bool? = nil,
    items: [String]? = nil,
    nodes: [SnapshotNode]? = nil,
    truncated: Bool? = nil,
    gestureStartUptimeMs: Double? = nil,
    gestureEndUptimeMs: Double? = nil,
    x: Double? = nil,
    y: Double? = nil,
    x2: Double? = nil,
    y2: Double? = nil,
    referenceWidth: Double? = nil,
    referenceHeight: Double? = nil,
    currentUptimeMs: Double? = nil,
    visible: Bool? = nil,
    wasVisible: Bool? = nil,
    dismissed: Bool? = nil,
    orientation: String? = nil,
    keyboardGuard: String? = nil,
    keyboardGuardMs: Double? = nil,
    keyboardVisible: Bool? = nil,
    snapshotGeneration: Int? = nil,
    presenceCapture: PlatformPresenceCapture? = nil,
    via: String? = nil,
    `static`: Bool? = nil,
    typingBurst: Bool? = nil,
    keyboardWaitMs: Int? = nil,
    inputResolution: String? = nil,
    focusTap: String? = nil,
    verifyVerdict: String? = nil,
    verifyStable: Bool? = nil,
    textEntryRoute: String? = nil,
    occlusionCheck: String? = nil
  ) {
    self.message = message
    self.text = text
    self.found = found
    self.items = items
    self.nodes = nodes
    self.truncated = truncated
    self.gestureStartUptimeMs = gestureStartUptimeMs
    self.gestureEndUptimeMs = gestureEndUptimeMs
    self.x = x
    self.y = y
    self.x2 = x2
    self.y2 = y2
    self.referenceWidth = referenceWidth
    self.referenceHeight = referenceHeight
    self.currentUptimeMs = currentUptimeMs
    self.visible = visible
    self.wasVisible = wasVisible
    self.dismissed = dismissed
    self.orientation = orientation
    self.keyboardGuard = keyboardGuard
    self.keyboardGuardMs = keyboardGuardMs
    self.keyboardVisible = keyboardVisible
    self.snapshotGeneration = snapshotGeneration
    self.presenceCapture = presenceCapture
    self.via = via
    self.`static` = `static`
    self.typingBurst = typingBurst
    self.keyboardWaitMs = keyboardWaitMs
    self.inputResolution = inputResolution
    self.focusTap = focusTap
    self.verifyVerdict = verifyVerdict
    self.verifyStable = verifyStable
    self.textEntryRoute = textEntryRoute
    self.occlusionCheck = occlusionCheck
  }
}

struct ErrorPayload: Codable {
  let code: String?
  let message: String
  let mutation: String?
  let reason: String?

  init(code: String? = nil, message: String, mutation: String? = nil, reason: String? = nil) {
    self.code = code
    self.message = message
    self.mutation = mutation
    self.reason = reason
  }
}

func runnerErrorPayload(_ error: Error, command: String? = nil) -> ErrorPayload {
  let nativeError = error as NSError
  if nativeError.domain == RnFastRunnerTests.RunnerErrorDomain.general,
     nativeError.code == RnFastRunnerTests.RunnerErrorCode.mainThreadExecutionTimedOut
  {
    // Fixed literal (never the platform description — those embed element
    // snapshots); the wedged command may have mutated before timing out.
    return ErrorPayload(
      code: "RUNNER_TIMEOUT",
      message: "main thread execution timed out",
      mutation: "possible"
    )
  }
  // GH #581: XCTest error descriptions embed element snapshots (including
  // field values) — text-surface failures ship a fixed secret-free message.
  if command == CommandType.type.rawValue {
    return ErrorPayload(
      code: "TYPE_OPERATION_FAILED",
      message: "native type operation failed before completion; the field value is unknown — refresh and re-read before any retry",
      mutation: "possible"
    )
  }
  if command == CommandType.verifyInput.rawValue {
    // The preceding type attempt's mutation stands unverified.
    return ErrorPayload(
      code: "VERIFY_OPERATION_FAILED",
      message: "native input verification failed to execute; the fill outcome is unverified",
      mutation: "possible"
    )
  }
  return ErrorPayload(message: "\(error)")
}

struct SnapshotRect: Codable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SnapshotNode: Codable {
  let index: Int
  let type: String
  let label: String?
  let identifier: String?
  let value: String?
  let rect: SnapshotRect
  let enabled: Bool
  let focused: Bool?
  let hittable: Bool
  let depth: Int
  let parentIndex: Int?
  let hiddenContentAbove: Bool?
  let hiddenContentBelow: Bool?
  // Only true is sent: the selected trait, e.g. React Native accessibilityState.selected.
  var selected: Bool? = nil
  var presence: PlatformPresenceObservation? = nil
}

struct PlatformPresenceCapture: Codable {
  let version: Int
  let source: String
  let captureId: String
  let appId: String
  let generation: Int
  let startedUptimeMs: Double
  let endedUptimeMs: Double
  let enumeration: String
  let complete: Bool
  let appliedBudgetMs: Int
  var diagnostics: PlatformPresenceDiagnostics? = nil
}

struct PlatformPresenceDiagnostics: Codable {
  enum Phase: String, Codable {
    case initialEligibility = "initial-eligibility"
    case preparation, enumeration, observation
    case finalEligibility = "final-eligibility"
    case revalidation, finalization
  }

  enum Reason: String, Codable {
    case deadline
    case readUnavailable = "read-unavailable"
    case ineligible
    case nodeLimit = "node-limit"
    case enumerationChanged = "enumeration-changed"
  }

  enum Read: String, Codable {
    case appState = "app-state"
    case alerts, sheets
    case rootSnapshot = "root-snapshot"
    case preparationPoll = "preparation-poll"
    case enumeration
    case observationLoop = "observation-loop"
    case observation
    case firstMatch = "first-match"
    case allMatches = "all-matches"
    case candidateSnapshot = "candidate-snapshot"
    case candidateHit = "candidate-hit"
    case postHitSnapshot = "post-hit-snapshot"
    case revalidation, finalization
  }

  enum Edge: String, Codable {
    case before, after
  }

  struct Failure: Codable {
    let phase: Phase
    let reason: Reason
    var mismatch: Mismatch? = nil
  }

  struct Mismatch: Codable {
    enum Kind: String, Codable {
      case descriptorCount = "descriptor-count"
      case addedNode = "added-node"
      case missingNode = "missing-node"
      case node
    }

    enum Field: Int {
      case type = 1, identifier = 2, label = 4, value = 8, frame = 16, enabled = 32
      case depth = 64, parentIndex = 128, initialDescriptorUnavailable = 256
    }

    struct Geometry: Codable {
      // Component masks use x=1, y=2, width=4, height=8.
      var changedMask = 0
      var beforeFiniteMask = 0
      var afterFiniteMask = 0
      var deltaFiniteMask = 0
      var dx: Double?
      var dy: Double?
      var dWidth: Double?
      var dHeight: Double?
      let beforeNull: Bool
      let afterNull: Bool
      let beforeInfinite: Bool
      let afterInfinite: Bool
      let beforeInvalidSize: Bool
      let afterInvalidSize: Bool
    }

    let kind: Kind
    var index: Int? = nil
    var fieldMask: Int = 0
    var beforeType: UInt? = nil
    var afterType: UInt? = nil
    var geometry: Geometry? = nil
    var ancestorTypes: [UInt]? = nil
    var ancestorsTruncated: Bool? = nil
  }

  struct Deadline: Codable {
    let phase: Phase
    let read: Read
    let edge: Edge
  }

  var phaseMs: [String: Double]
  var preparationSamples: Int?
  var preparationResets: Int?
  var preparationQuietWindowMs: Double?
  var preparationQuietElapsedMs: Double?
  var failure: Failure?
  var deadline: Deadline?
}

struct PlatformPresenceObservation: Codable {
  enum Status: String, Codable {
    case observed, unknown
  }

  enum LabelSource: String, Codable {
    case direct, value, descendant, none
  }

  enum UnknownReason: String, Codable {
    case emptyFrame = "empty-frame"
    case clipped
    case ambiguousDescriptor = "ambiguous-descriptor"
    case notHittable = "not-hittable"
    case readUnavailable = "read-unavailable"
    case matchCountMismatch = "match-count-mismatch"
    case postHitMismatch = "post-hit-mismatch"
  }

  let captureId: String
  let generation: Int
  let nodeIndex: Int
  var status: Status
  let labelSource: LabelSource
  var observedUptimeMs: Double? = nil
  var unknownReason: UnknownReason? = nil
}

struct RetainedSnapshotTarget {
  let generation: Int
  let index: Int
  let type: String
  let label: String?
  let identifier: String?
  let rect: SnapshotRect
  // Frame of the nearest same-type, same-label ancestor of a label-only node in the same snapshot.
  var ownerRect: SnapshotRect? = nil
  // A Button with a Keyboard ancestor in the same snapshot, such as an iOS Return key.
  var keyboardOwned: Bool = false
}

struct RecordedExactTypeTarget {
  let operationToken: String?
  let element: XCUIElement
  let generation: Int
  let nodeIndex: Int?
  let attributes: TextInputTarget.CandidateAttributes?
}

struct SnapshotOptions {
  let interactiveOnly: Bool
  let compact: Bool
  let depth: Int?
  let scope: String?
  let raw: Bool
}
