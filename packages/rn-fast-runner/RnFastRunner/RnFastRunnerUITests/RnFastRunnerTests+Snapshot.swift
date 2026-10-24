import XCTest

extension RnFastRunnerTests {
  private static let collapsedTabCandidateTypes: Set<XCUIElement.ElementType> = [
    .button,
    .link,
    .menuItem,
    .other,
    .staticText
  ]
  private static let scrollContainerTypes: Set<XCUIElement.ElementType> = [
    .collectionView,
    .scrollView,
    .table
  ]

  private struct SnapshotTraversalContext {
    let queryRoot: XCUIElement
    let rootSnapshot: XCUIElementSnapshot
    let viewport: CGRect
    var viewportSource: SnapshotViewportSource? = nil
    let maxDepth: Int
  }

  private struct SnapshotEvaluation {
    let label: String
    let identifier: String
    let valueText: String?
    let hittable: Bool
    let focused: Bool
    let visible: Bool
  }

  // MARK: - Snapshot Entry

  func elementTypeName(_ type: XCUIElement.ElementType) -> String {
    snapshotTypeName(type)
  }

  func snapshotFast(app: XCUIApplication, options: SnapshotOptions, includeDiagnostics: Bool = false) -> DataPayload {
    retainedFastSnapshotOptions = nil
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }

    guard let context = makeSnapshotTraversalContext(app: app, options: options) else {
      return withSystemModalDiagnostic(DataPayload(
        nodes: [],
        truncated: false,
        keyboardVisible: isKeyboardVisible(app: app),
        snapshotGeneration: currentSnapshotGeneration
      ), app: app)
    }

    retainedFastSnapshotOptions = options
    let (nodes, truncated) = fastSnapshotNodes(context: context, options: options)

    return withSystemModalDiagnostic(DataPayload(
      nodes: nodes,
      truncated: truncated,
      keyboardVisible: isKeyboardVisible(app: app),
      snapshotGeneration: currentSnapshotGeneration,
      snapshotDiagnostics: includeDiagnostics ? context.viewportSource.flatMap {
        SnapshotDiagnostics(viewport: context.viewport, source: $0)
      } : nil
    ), app: app)
  }

  private func fastSnapshotNodes(
    context: SnapshotTraversalContext, options: SnapshotOptions,
    canContinue: () -> Bool = { true },
    visit: (XCUIElementSnapshot, SnapshotNode) -> Void = { _, _ in }
  ) -> ([SnapshotNode], Bool) {
    var cachedDescendantElements: [XCUIElement]?
    func collapsedTabDescendants() -> [XCUIElement] {
      if let cachedDescendantElements {
        return cachedDescendantElements
      }
      let fetched = safeSnapshotElementsQuery {
        context.queryRoot.descendants(matching: .any).allElementsBoundByIndex
      }
      cachedDescendantElements = fetched
      return fetched
    }

    var nodes: [SnapshotNode] = []
    var truncated = false
    let rootEvaluation = evaluateSnapshot(context.rootSnapshot, in: context)
    nodes.append(
      makeSnapshotNode(
        snapshot: context.rootSnapshot,
        evaluation: rootEvaluation,
        depth: 0,
        index: 0,
        parentIndex: nil
      )
    )
    visit(context.rootSnapshot, nodes[0])
    if context.maxDepth > 0 {
      let didTruncateFallback = appendCollapsedTabFallbackNodes(
        to: &nodes,
        containerSnapshot: context.rootSnapshot,
        resolveElements: collapsedTabDescendants,
        depth: 1,
        parentIndex: 0,
        nodeLimit: fastSnapshotLimit,
        viewport: context.viewport
      )
      truncated = truncated || didTruncateFallback
    }

    var seen = Set<SnapshotDedupeKey>()
    var stack: [(XCUIElementSnapshot, Int, Int, Int?)] = context.rootSnapshot.children.map {
      ($0, 1, 1, 0)
    }

    while let (snapshot, depth, visibleDepth, parentIndex) = stack.popLast() {
      if !canContinue() { return (nodes, true) }
      if nodes.count >= fastSnapshotLimit {
        truncated = true
        break
      }
      if let limit = options.depth, depth > limit { continue }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        visible: evaluation.visible
      )

      let key = snapshotDedupeKey(
        type: snapshot.elementType,
        label: evaluation.label,
        identifier: evaluation.identifier,
        value: evaluation.valueText,
        frame: snapshot.frame
      )
      let isDuplicate = seen.contains(key)
      if !isDuplicate {
        seen.insert(key)
      }

      let currentIndex = include && !isDuplicate ? nodes.count : parentIndex
      if depth < context.maxDepth {
        let nextVisibleDepth = include && !isDuplicate ? visibleDepth + 1 : visibleDepth
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, nextVisibleDepth, currentIndex))
        }
      }

      if !include || isDuplicate { continue }

      let index = nodes.count
      nodes.append(
        makeSnapshotNode(
          snapshot: snapshot,
          evaluation: evaluation,
          depth: min(context.maxDepth, visibleDepth),
          index: index,
          parentIndex: parentIndex
        )
      )
      visit(snapshot, nodes[nodes.count - 1])
      if visibleDepth < context.maxDepth {
        let didTruncateFallback = appendCollapsedTabFallbackNodes(
          to: &nodes,
          containerSnapshot: snapshot,
          resolveElements: collapsedTabDescendants,
          depth: visibleDepth + 1,
          parentIndex: index,
          nodeLimit: fastSnapshotLimit,
          viewport: context.viewport
        )
        truncated = truncated || didTruncateFallback
      }

    }

    return (nodes, truncated)
  }

  func snapshotRaw(app: XCUIApplication, options: SnapshotOptions) -> DataPayload {
    retainedFastSnapshotOptions = nil
    if let blocking = blockingSystemAlertSnapshot() {
      return blocking
    }

    guard let context = makeSnapshotTraversalContext(app: app, options: options) else {
      return withSystemModalDiagnostic(DataPayload(
        nodes: [],
        truncated: false,
        keyboardVisible: isKeyboardVisible(app: app),
        snapshotGeneration: currentSnapshotGeneration
      ), app: app)
    }

    var nodes: [SnapshotNode] = []
    var truncated = false

    func walk(_ snapshot: XCUIElementSnapshot, depth: Int, parentIndex: Int?) {
      if nodes.count >= maxSnapshotElements {
        truncated = true
        return
      }
      if let limit = options.depth, depth > limit { return }

      let evaluation = evaluateSnapshot(snapshot, in: context)
      let include = shouldInclude(
        snapshot: snapshot,
        label: evaluation.label,
        identifier: evaluation.identifier,
        valueText: evaluation.valueText,
        options: options,
        visible: evaluation.visible
      )
      let currentIndex = include ? nodes.count : parentIndex
      if include {
        nodes.append(
          makeSnapshotNode(
            snapshot: snapshot,
            evaluation: evaluation,
            depth: depth,
            index: nodes.count,
            parentIndex: parentIndex
          )
        )
      }

      let children = snapshot.children
      for child in children {
        walk(child, depth: depth + 1, parentIndex: currentIndex)
        if truncated { return }
      }
    }

    walk(context.rootSnapshot, depth: 0, parentIndex: nil)
    return withSystemModalDiagnostic(DataPayload(
      nodes: nodes,
      truncated: truncated,
      keyboardVisible: isKeyboardVisible(app: app),
      snapshotGeneration: currentSnapshotGeneration
    ), app: app)
  }

  private struct PresenceDescriptor: Equatable {
    enum Value: Equatable {
      case absent
      case text(String)
      case number(String, String)
    }

    let type: XCUIElement.ElementType
    let identifier: String
    let label: String
    let value: Value
    let frame: CGRect
    let enabled: Bool

    init?(_ snapshot: XCUIElementSnapshot) {
      type = snapshot.elementType
      identifier = snapshot.identifier
      label = snapshot.label
      frame = snapshot.frame
      enabled = snapshot.isEnabled
      if let original = snapshot.value {
        if let text = original as? String {
          value = .text(text)
        } else if let number = original as? NSNumber, number.doubleValue.isFinite {
          value = .number(String(cString: number.objCType), number.stringValue)
        } else {
          return nil
        }
      } else {
        value = .absent
      }
    }

    func changedFields(from previous: PresenceDescriptor?) -> Int {
      typealias Field = PlatformPresenceDiagnostics.Mismatch.Field
      guard let previous else { return Field.initialDescriptorUnavailable.rawValue }
      var mask = 0
      if type != previous.type { mask |= Field.type.rawValue }
      if identifier != previous.identifier { mask |= Field.identifier.rawValue }
      if label != previous.label { mask |= Field.label.rawValue }
      if value != previous.value { mask |= Field.value.rawValue }
      if frame != previous.frame { mask |= Field.frame.rawValue }
      if enabled != previous.enabled { mask |= Field.enabled.rawValue }
      return mask
    }

    func geometryDifference(from previous: PresenceDescriptor) -> PlatformPresenceDiagnostics.Mismatch.Geometry {
      let before = previous.frame
      let old = [before.origin.x, before.origin.y, before.size.width, before.size.height]
      let new = [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height]
      var result = PlatformPresenceDiagnostics.Mismatch.Geometry(
        beforeNull: before.isNull, afterNull: frame.isNull,
        beforeInfinite: before.isInfinite, afterInfinite: frame.isInfinite,
        beforeInvalidSize: !old[2].isFinite || !old[3].isFinite || old[2] < 0 || old[3] < 0,
        afterInvalidSize: !new[2].isFinite || !new[3].isFinite || new[2] < 0 || new[3] < 0
      )
      var deltas: [Double?] = Array(repeating: nil, count: 4)
      for index in 0..<4 {
        let bit = 1 << index
        if old[index] != new[index] { result.changedMask |= bit }
        if old[index].isFinite { result.beforeFiniteMask |= bit }
        if new[index].isFinite { result.afterFiniteMask |= bit }
        let delta = new[index] - old[index]
        if old[index].isFinite && new[index].isFinite && delta.isFinite {
          result.deltaFiniteMask |= bit
          deltas[index] = Double(delta)
        }
      }
      result.dx = deltas[0]
      result.dy = deltas[1]
      result.dWidth = deltas[2]
      result.dHeight = deltas[3]
      return result
    }
  }

  private struct PresenceEntry: Equatable {
    let descriptor: PresenceDescriptor
    let depth: Int
    let parentIndex: Int?
  }

  func platformPresenceFailure() -> Response {
    Response(ok: false, error: ErrorPayload(
      code: "PLATFORM_PRESENCE_FAILED", message: "native platform presence capture failed"
    ))
  }

  private func presenceUptimeMs() -> Double {
    ProcessInfo.processInfo.systemUptime * 1000
  }

  private func presenceRead<T>(
    deadline: Double? = nil, timing: PresenceCaptureTiming, read kind: PlatformPresenceDiagnostics.Read,
    _ read: () throws -> T
  ) -> T? {
    if let deadline, timing.deadlineReached(deadline, read: kind, edge: .before) { return nil }
    var result: T?
    let exception = RunnerObjCExceptionCatcher.catchException({
      result = try? read()
    })
    guard exception == nil else { return nil }
    if let deadline, timing.deadlineReached(deadline, read: kind, edge: .after) { return nil }
    return result
  }

  private func presenceAppIsEligible(
    _ app: XCUIApplication, deadline: Double, timing: PresenceCaptureTiming
  ) -> Bool? {
    guard let state = presenceRead(deadline: deadline, timing: timing, read: .appState, { app.state }) else {
      timing.fail(.readUnavailable)
      return nil
    }
    guard state == .runningForeground else {
      timing.fail(.ineligible)
      return false
    }
    #if !os(macOS)
      guard let alerts = presenceRead(deadline: deadline, timing: timing, read: .alerts, { self.springboard.alerts.count }),
            let sheets = presenceRead(deadline: deadline, timing: timing, read: .sheets, { self.springboard.sheets.count }) else {
        timing.fail(.readUnavailable)
        return nil
      }
      if alerts != 0 || sheets != 0 { timing.fail(.ineligible) }
      return alerts == 0 && sheets == 0
    #else
      return true
    #endif
  }

  private func preparePresenceEnumeration(
    app: XCUIApplication, deadline: Double, timing: PresenceCaptureTiming, truncated: inout Bool
  ) -> [(snapshot: XCUIElementSnapshot, entry: PresenceEntry)]? {
    let quietWindowMs = 500.0
    timing.preparationStarted(quietWindowMs: quietWindowMs)
    var previous: [PresenceEntry]?
    var quietStarted: Double?
    while true {
      guard let root = presenceRead(deadline: deadline, timing: timing, read: .rootSnapshot, {
        timing.preparationSampleStarted()
        return try app.snapshot()
      }) else {
        timing.fail(.readUnavailable)
        return nil
      }
      var sample: [(snapshot: XCUIElementSnapshot, entry: PresenceEntry)] = []
      var stack: [(XCUIElementSnapshot, Int, Int?)] = [(root, 0, nil)]
      while let (snapshot, depth, parentIndex) = stack.popLast() {
        guard !timing.deadlineReached(deadline, read: .enumeration, edge: .before) else { return nil }
        guard sample.count < maxSnapshotElements else {
          truncated = true
          timing.fail(.nodeLimit)
          return nil
        }
        guard let descriptor = PresenceDescriptor(snapshot) else {
          timing.fail(.readUnavailable)
          return nil
        }
        let index = sample.count
        sample.append((snapshot, PresenceEntry(descriptor: descriptor, depth: depth, parentIndex: parentIndex)))
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, index))
        }
      }
      let entries = sample.map { $0.entry }
      let stable = previous == entries
      let completed = presenceUptimeMs()
      guard !timing.deadlineReached(deadline, read: .enumeration, edge: .after, at: completed) else { return nil }
      if !stable { quietStarted = completed }
      let quietElapsedMs = completed - (quietStarted ?? completed)
      timing.preparationSampleCompleted(reset: previous != nil && !stable, quietElapsedMs: quietElapsedMs)
      if stable && quietElapsedMs >= quietWindowMs { return sample }
      previous = entries
      let polling = presenceUptimeMs()
      guard !timing.deadlineReached(deadline, read: .preparationPoll, edge: .before, at: polling) else { return nil }
      sleepFor(min(0.1, (deadline - polling) / 1000))
      guard !timing.deadlineReached(deadline, read: .preparationPoll, edge: .after) else { return nil }
    }
  }

  private func presenceLabelSource(_ snapshot: XCUIElementSnapshot) -> PlatformPresenceObservation.LabelSource {
    if !snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .direct }
    if snapshotValueText(snapshot) != nil { return .value }
    return aggregatedLabel(for: snapshot) == nil ? .none : .descendant
  }

  func snapshotCandidateLabelProvenance(app: XCUIApplication, indices: [Int], budgetMs: Int) -> DataPayload {
    var result = DataPayload()
    var diagnostic = CandidateLabelProvenanceDiagnostics()
    let started = presenceUptimeMs()
    let deadline = started + Double(budgetMs)
    func finish(_ outcome: String) -> DataPayload {
      diagnostic.deadlineExpired = presenceUptimeMs() >= deadline
      diagnostic.outcome = diagnostic.deadlineExpired ? "deadline" : outcome
      var payload = result
      payload.labelProvenanceDiagnostics = diagnostic
      if diagnostic.deadlineExpired { payload.labelProvenance = nil }
      return payload
    }
    guard let options = retainedFastSnapshotOptions,
          !indices.isEmpty, indices.count <= 64, Set(indices).count == indices.count,
          indices.allSatisfy({ retainedSnapshotTargets[$0]?.generation == currentSnapshotGeneration }) else {
      return finish("baseline-unavailable")
    }
    let timing = PresenceCaptureTiming(started: started, now: presenceUptimeMs)
    var previous: [PresenceEntry]?
    var previousSources: [PlatformPresenceObservation.LabelSource]?
    var failure = "unavailable"
    while !timing.deadlineReached(deadline, read: .preparationPoll, edge: .before) {
      guard presenceAppIsEligible(app, deadline: deadline, timing: timing) == true else { return finish("ineligible") }
      guard let context = presenceRead(deadline: deadline, timing: timing, read: .rootSnapshot, {
        self.makeSnapshotTraversalContext(app: app, options: options)
      }) ?? nil else { return finish("read-unavailable") }
      diagnostic.sampleCount += 1
      var selected: [Int: (XCUIElementSnapshot, PresenceEntry)] = [:]
      var count = 1
      let (_, truncated) = fastSnapshotNodes(context: context, options: options, canContinue: {
        count += 1
        return count <= self.maxSnapshotElements
          && !timing.deadlineReached(deadline, read: .enumeration, edge: .before)
      }, visit: { snapshot, node in
        if indices.contains(node.index), let descriptor = PresenceDescriptor(snapshot) {
          selected[node.index] = (snapshot, PresenceEntry(
            descriptor: descriptor, depth: node.depth, parentIndex: node.parentIndex
          ))
        }
      })
      guard !truncated else { return finish("enumeration-incomplete") }
      var entries: [PresenceEntry] = []
      var sources: [PlatformPresenceObservation.LabelSource] = []
      for index in indices {
        guard let (snapshot, entry) = selected[index], let target = retainedSnapshotTargets[index] else {
          diagnostic.nodeIndex = index; failure = "baseline-unavailable"
          break
        }
        var mask = 0
        if target.type != elementTypeName(snapshot.elementType) { mask |= 1 }
        let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        if target.identifier != (identifier.isEmpty ? nil : identifier) { mask |= 2 }
        if target.label != aggregatedLabel(for: snapshot) { mask |= 4 }
        if target.rect != snapshotRect(from: snapshot.frame) { mask |= 16 }
        if target.parentIndex != entry.parentIndex { mask |= 128 }
        if mask != 0 {
          diagnostic.nodeIndex = index; diagnostic.fieldMask = mask; failure = "identity-mismatch"
          break
        }
        var unknown: PlatformPresenceObservation.UnknownReason?
        guard observePresence(entry.descriptor, count: 1, app: app, deadline: deadline, timing: timing,
          unknownReason: { unknown = $0 }) != nil else {
          diagnostic.nodeIndex = index; failure = unknown?.rawValue ?? "observation-unavailable"
          break
        }
        entries.append(entry)
        sources.append(presenceLabelSource(snapshot))
      }
      guard presenceAppIsEligible(app, deadline: deadline, timing: timing) == true else { return finish("ineligible") }
      guard !timing.deadlineReached(deadline, read: .finalization, edge: .after) else { return finish(failure) }
      var stable = entries.count == indices.count && previous?.count == entries.count
      if stable, let previous, let previousSources {
        for offset in entries.indices {
          let entry = entries[offset], prior = previous[offset]
          var mask = entry.descriptor.changedFields(from: prior.descriptor)
          if entry.depth != prior.depth { mask |= 64 }
          if entry.parentIndex != prior.parentIndex { mask |= 128 }
          if sources[offset] != previousSources[offset] { mask |= 256 }
          if mask != 0 { diagnostic.nodeIndex = indices[offset]; diagnostic.fieldMask = mask }
          if entry.descriptor.frame != prior.descriptor.frame || entry.parentIndex != prior.parentIndex
            || sources[offset] != previousSources[offset] { stable = false }
        }
      }
      if stable {
        result.labelProvenance = zip(indices, sources).map { CandidateLabelProvenance(index: $0.0, labelSource: $0.1) }
        return finish("available")
      }
      previous = entries.count == indices.count ? entries : nil
      previousSources = entries.count == indices.count ? sources : nil
      let remaining = deadline - presenceUptimeMs()
      if remaining <= 0 { return finish(failure) }
      sleepFor(min(0.1, remaining / 1000))
    }
    return finish(failure)
  }

  func snapshotPlatformPresence(app: XCUIApplication, appId: String, presenceBudgetMs: Int) -> DataPayload {
    retainedFastSnapshotOptions = nil
    // A recognised SpringBoard alert is the observation in every snapshot flavour; it has no Keyboard node.
    if let blocking = blockingSystemAlertSnapshot() {
      return DataPayload(nodes: blocking.nodes, truncated: false, keyboardVisible: false,
        snapshotGeneration: currentSnapshotGeneration)
    }
    let started = presenceUptimeMs()
    let deadline = started + Double(presenceBudgetMs)
    let timing = PresenceCaptureTiming(started: started, now: presenceUptimeMs)
    let captureId = UUID().uuidString
    let generation = currentSnapshotGeneration
    var nodes: [SnapshotNode] = []
    var descriptors: [PresenceDescriptor?] = []
    var truncated = false
    var complete = false
    var viewport = CGRect.infinite

    let enumerated = presenceRead(timing: timing, read: .enumeration) { () -> Bool in
      guard self.presenceAppIsEligible(app, deadline: deadline, timing: timing) == true else { return false }
      timing.endPhase()
      timing.begin(.preparation)
      guard let sample = self.preparePresenceEnumeration(
        app: app, deadline: deadline, timing: timing, truncated: &truncated
      ), let root = sample.first?.snapshot else { return false }
      timing.endPhase()
      timing.begin(.enumeration)
      let windowFrame = root.children.first {
        $0.elementType == .window && !$0.frame.isNull && !$0.frame.isEmpty
      }?.frame
      let appFrame = root.frame
      viewport = windowFrame ?? (appFrame.isNull || appFrame.isEmpty ? .infinite : appFrame)
      let context = SnapshotTraversalContext(
        queryRoot: app, rootSnapshot: root, viewport: viewport, maxDepth: Int.max
      )
      for (snapshot, entry) in sample {
        guard !timing.deadlineReached(deadline, read: .enumeration, edge: .before) else { return false }
        var node = self.makeSnapshotNode(
          snapshot: snapshot, evaluation: self.evaluateSnapshot(snapshot, in: context),
          depth: entry.depth, index: nodes.count, parentIndex: entry.parentIndex
        )
        node.presence = PlatformPresenceObservation(
          captureId: captureId, generation: generation, nodeIndex: node.index,
          status: .unknown, labelSource: self.presenceLabelSource(snapshot)
        )
        nodes.append(node)
        descriptors.append(entry.descriptor)
      }
      return !timing.deadlineReached(deadline, read: .enumeration, edge: .after)
    }
    timing.endPhase()
    if let enumerated {
      complete = enumerated
    } else {
      timing.fail(.readUnavailable)
      nodes.removeAll()
      descriptors.removeAll()
    }

    // A capped tree cannot establish descriptor uniqueness in the whole raw snapshot.
    if complete {
      timing.begin(.observation)
      var handled = Set<Int>()
      for index in nodes.indices where !handled.contains(index) {
        if timing.deadlineReached(deadline, read: .observationLoop, edge: .before) { break }
        // Observe association anchors; skip inert or clipped nodes.
        let labelSource = nodes[index].presence?.labelSource
        guard nodes[index].depth > 0,
              let descriptor = descriptors[index],
              labelSource != .descendant || !descriptor.identifier.isEmpty,
              !(labelSource == PlatformPresenceObservation.LabelSource.none
                && descriptor.identifier.isEmpty
                && descriptor.type == .other),
              descriptor.type != .application, descriptor.type != .window else { continue }
        guard !descriptor.frame.isEmpty else {
          nodes[index].presence?.unknownReason = .emptyFrame
          continue
        }
        guard presenceClip(index, nodes: nodes, descriptors: descriptors, viewport: viewport)
          .intersects(descriptor.frame) else {
          nodes[index].presence?.unknownReason = .clipped
          continue
        }
        let group = descriptors.indices.filter { descriptors[$0] == descriptor }
        guard group.count == 1 || isNestedTextChain(group, nodes: nodes) else {
          nodes[index].presence?.unknownReason = .ambiguousDescriptor
          continue
        }
        handled.formUnion(group)
        var unknownReason: PlatformPresenceObservation.UnknownReason?
        let observation = presenceRead(deadline: deadline, timing: timing, read: .observation) {
          self.observePresence(
            descriptor, count: group.count,
            app: app, deadline: deadline, timing: timing, unknownReason: { unknownReason = $0 }
          )
        }
        if let observed = observation ?? nil {
          for member in group {
            nodes[member].presence?.status = .observed
            nodes[member].presence?.observedUptimeMs = observed
            nodes[member].presence?.unknownReason = nil
          }
        } else {
          for member in group {
            nodes[member].presence?.unknownReason = observation == nil ? .readUnavailable : unknownReason
          }
        }
      }
      timing.endPhase()
      timing.begin(.finalEligibility)
      complete = presenceAppIsEligible(app, deadline: deadline, timing: timing) == true
      timing.endPhase()
      if complete {
        timing.begin(.revalidation)
        complete = presenceEnumerationIsUnchanged(
          app: app, nodes: nodes, descriptors: descriptors, deadline: deadline, timing: timing
        )
        timing.endPhase()
      }
    }
    let ended = presenceUptimeMs()
    complete = complete && !timing.deadlineReached(
      deadline, read: .finalization, edge: .after, phase: .finalization, at: ended
    )
    if !complete {
      for index in nodes.indices {
        nodes[index].presence?.status = .unknown
        nodes[index].presence?.observedUptimeMs = nil
      }
    }
    var payload = makePlatformPresencePayload(
      nodes: nodes, truncated: truncated,
      capture: PlatformPresenceCapture(
        version: 2, source: "xcui-live", captureId: captureId, appId: appId,
        generation: generation, startedUptimeMs: started, endedUptimeMs: ended,
        enumeration: "raw-unfiltered", complete: complete, appliedBudgetMs: presenceBudgetMs,
        diagnostics: timing.diagnostics(complete: complete)
      )
    )
    if !complete, blockingSystemAlertSnapshot() == nil {
      payload = withSystemModalDiagnostic(payload, app: app)
    }
    return payload
  }

  private func presenceEnumerationIsUnchanged(
    app: XCUIApplication, nodes: [SnapshotNode], descriptors: [PresenceDescriptor?], deadline: Double,
    timing: PresenceCaptureTiming
  ) -> Bool {
    guard nodes.count == descriptors.count else {
      timing.fail(.enumerationChanged, mismatch: .init(kind: .descriptorCount))
      return false
    }
    let unchanged = presenceRead(deadline: deadline, timing: timing, read: .revalidation) {
      let root = try app.snapshot()
      var stack: [(XCUIElementSnapshot, Int, Int?)] = [(root, 0, nil)]
      var index = 0
      while let (snapshot, depth, parentIndex) = stack.popLast() {
        guard !timing.deadlineReached(deadline, read: .revalidation, edge: .before) else { return false }
        guard index < self.maxSnapshotElements else {
          timing.fail(.nodeLimit)
          return false
        }
        guard index < nodes.count else {
          timing.fail(.enumerationChanged, mismatch: .init(kind: .addedNode, index: index))
          return false
        }
        guard let descriptor = PresenceDescriptor(snapshot) else {
          timing.fail(.readUnavailable)
          return false
        }
        guard descriptors[index] == descriptor,
              nodes[index].depth == depth, nodes[index].parentIndex == parentIndex else {
          typealias Field = PlatformPresenceDiagnostics.Mismatch.Field
          var mask = descriptor.changedFields(from: descriptors[index])
          if nodes[index].depth != depth { mask |= Field.depth.rawValue }
          if nodes[index].parentIndex != parentIndex { mask |= Field.parentIndex.rawValue }
          let ancestors = self.presenceMismatchAncestors(index, nodes: nodes, descriptors: descriptors)
          timing.fail(.enumerationChanged, mismatch: .init(
            kind: .node, index: index, fieldMask: mask,
            beforeType: descriptors[index]?.type.rawValue, afterType: descriptor.type.rawValue,
            geometry: descriptors[index].map { descriptor.geometryDifference(from: $0) },
            ancestorTypes: ancestors.types, ancestorsTruncated: ancestors.truncated
          ))
          return false
        }
        for child in snapshot.children.reversed() {
          stack.append((child, depth + 1, index))
        }
        index += 1
      }
      if index != nodes.count {
        timing.fail(.enumerationChanged, mismatch: .init(
          kind: .missingNode, index: index, beforeType: descriptors[index]?.type.rawValue
        ))
      }
      return index == nodes.count
    }
    if unchanged == nil { timing.fail(.readUnavailable) }
    return unchanged == true
  }

  private func presenceMismatchAncestors(
    _ index: Int, nodes: [SnapshotNode], descriptors: [PresenceDescriptor?]
  ) -> (types: [UInt], truncated: Bool) {
    var types: [UInt] = []
    var child = index
    var parent = nodes[index].parentIndex
    while let ancestor = parent {
      guard types.count < 16, ancestor >= 0, ancestor < child,
            let descriptor = descriptors[ancestor] else { return (types, true) }
      types.append(descriptor.type.rawValue)
      child = ancestor
      parent = nodes[ancestor].parentIndex
    }
    return (types, false)
  }

  private func presenceClip(
    _ index: Int, nodes: [SnapshotNode], descriptors: [PresenceDescriptor?], viewport: CGRect
  ) -> CGRect {
    var clip = viewport
    var parent = nodes[index].parentIndex
    while let current = parent {
      if let frame = descriptors[current]?.frame, descriptors[current]?.type == .scrollView {
        clip = clip.intersection(frame)
      }
      parent = nodes[current].parentIndex
    }
    return clip
  }

  // XCUI reports a React Native text as a text holding an identical text; the chain is one element.
  // Members must also agree on every fact the consumer compares before merging them.
  private func isNestedTextChain(_ group: [Int], nodes: [SnapshotNode]) -> Bool {
    zip(group, group.dropFirst()).allSatisfy { parent, child in
      nodes[child].parentIndex == parent && nodes[child].type == "StaticText"
        && nodes[child].hittable == nodes[parent].hittable
        && nodes[child].presence?.labelSource == nodes[parent].presence?.labelSource
    }
  }

  // Attribute hits only after full live descriptor and group-count checks, then recheck the hit element.
  private func observePresence(
    _ descriptor: PresenceDescriptor, count: Int,
    app: XCUIApplication, deadline: Double, timing: PresenceCaptureTiming,
    unknownReason: ((PlatformPresenceObservation.UnknownReason) -> Void)? = nil
  ) -> Double? {
    // Callers never pass application or window descriptors, so the app root cannot be a match.
    let query = app.descendants(matching: descriptor.type)
      .matching(NSPredicate(format: "identifier == %@ AND label == %@", descriptor.identifier, descriptor.label))
    guard let elements = presenceRead(deadline: deadline, timing: timing, read: .allMatches, { query.allElementsBoundByAccessibilityElement })
    else { unknownReason?(.readUnavailable); return nil }
    var matches: [XCUIElement] = []
    for element in elements {
      guard let snapshot = presenceRead(deadline: deadline, timing: timing, read: .candidateSnapshot, { try element.snapshot() })
      else { unknownReason?(.readUnavailable); return nil }
      if PresenceDescriptor(snapshot) == descriptor { matches.append(element) }
    }
    guard matches.count == count else { unknownReason?(.matchCountMismatch); return nil }
    var readUnavailable = false
    for element in matches {
      let hittable = presenceRead(deadline: deadline, timing: timing, read: .candidateHit, { element.isHittable })
      if hittable == nil { readUnavailable = true }
      guard hittable == true else { continue }
      let observed = presenceUptimeMs()
      guard let after = presenceRead(deadline: deadline, timing: timing, read: .postHitSnapshot, { try element.snapshot() })
      else { unknownReason?(.readUnavailable); return nil }
      guard PresenceDescriptor(after) == descriptor else { unknownReason?(.postHitMismatch); return nil }
      return observed
    }
    unknownReason?(readUnavailable ? .readUnavailable : .notHittable)
    return nil
  }

  func retainSnapshotTargets(_ nodes: [SnapshotNode]) {
    let byIndex = Dictionary(nodes.map { ($0.index, $0) }, uniquingKeysWith: { first, _ in first })
    retainedSnapshotTargets = Dictionary(uniqueKeysWithValues: nodes.map { node in
      let owner = node.identifier == nil && node.label != nil
        ? DispatchGuard.nearestOwner(
          of: node.index,
          parentOf: { byIndex[$0]?.parentIndex },
          owns: { byIndex[$0]?.type == node.type && byIndex[$0]?.label == node.label }
        ).flatMap { byIndex[$0]?.rect }
        : nil
      return (
        node.index,
        RetainedSnapshotTarget(
          generation: currentSnapshotGeneration,
          index: node.index,
          type: node.type,
          label: node.label,
          identifier: node.identifier,
          rect: node.rect,
          ownerRect: owner,
          keyboardOwned: KeyboardGuard.isKeyboardOwnedButton(
            type: node.type,
            index: node.index,
            parentOf: { byIndex[$0]?.parentIndex },
            typeOf: { byIndex[$0]?.type }
          ),
          parentIndex: node.parentIndex
        )
      )
    })
  }

  func snapshotRect(from frame: CGRect) -> SnapshotRect {
    return SnapshotRect(
      x: Double(frame.origin.x),
      y: Double(frame.origin.y),
      width: Double(frame.size.width),
      height: Double(frame.size.height)
    )
  }

  // MARK: - Snapshot Filtering

  private func shouldInclude(
    snapshot: XCUIElementSnapshot,
    label: String,
    identifier: String,
    valueText: String?,
    options: SnapshotOptions,
    visible: Bool
  ) -> Bool {
    let type = snapshot.elementType
    return shouldIncludeSnapshotNode(
      type: type,
      hasContent: !label.isEmpty || !identifier.isEmpty || (valueText != nil),
      isScrollableContainer: isScrollableContainer(snapshot, visible: visible),
      isInteractiveType: interactiveTypes.contains(type),
      visible: visible,
      compact: options.compact,
      interactiveOnly: options.interactiveOnly
    )
  }

  private func makeSnapshotTraversalContext(
    app: XCUIApplication,
    options: SnapshotOptions
  ) -> SnapshotTraversalContext? {
    let viewport = snapshotViewport(app: app)
    let queryRoot = options.scope.flatMap { findScopeElement(app: app, scope: $0) } ?? app

    let rootSnapshot: XCUIElementSnapshot
    do {
      rootSnapshot = try queryRoot.snapshot()
    } catch {
      return nil
    }

    return SnapshotTraversalContext(
      queryRoot: queryRoot,
      rootSnapshot: rootSnapshot,
      viewport: viewport.frame,
      viewportSource: viewport.source,
      maxDepth: options.depth ?? Int.max
    )
  }

  private func evaluateSnapshot(
    _ snapshot: XCUIElementSnapshot,
    in context: SnapshotTraversalContext
  ) -> SnapshotEvaluation {
    let label = aggregatedLabel(for: snapshot) ?? snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let identifier = snapshot.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
    let valueText = snapshotValueText(snapshot)
    return SnapshotEvaluation(
      label: label,
      identifier: identifier,
      valueText: valueText,
      hittable: computeSnapshotHittable(
        enabled: snapshot.isEnabled,
        frame: snapshot.frame,
        viewport: context.viewport
      ),
      focused: snapshotHasFocus(snapshot),
      visible: isVisibleInViewport(snapshot.frame, context.viewport)
    )
  }

  private func makeSnapshotNode(
    snapshot: XCUIElementSnapshot,
    evaluation: SnapshotEvaluation,
    depth: Int,
    index: Int,
    parentIndex: Int?
  ) -> SnapshotNode {
    return SnapshotNode(
      index: index,
      type: elementTypeName(snapshot.elementType),
      label: evaluation.label.isEmpty ? nil : evaluation.label,
      identifier: evaluation.identifier.isEmpty ? nil : evaluation.identifier,
      value: evaluation.valueText,
      rect: snapshotRect(from: snapshot.frame),
      enabled: snapshot.isEnabled,
      focused: evaluation.focused ? true : nil,
      hittable: evaluation.hittable,
      depth: depth,
      parentIndex: parentIndex,
      hiddenContentAbove: nil,
      hiddenContentBelow: nil,
      selected: snapshot.isSelected ? true : nil
    )
  }

  private func snapshotValueText(_ snapshot: XCUIElementSnapshot) -> String? {
    guard let value = snapshot.value else { return nil }
    let text = String(describing: value).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func snapshotViewport(app: XCUIApplication) -> (frame: CGRect, source: SnapshotViewportSource) {
    let windows = app.windows.allElementsBoundByIndex
    if let window = windows.first(where: { $0.exists && !$0.frame.isNull && !$0.frame.isEmpty }) {
      return (window.frame, .firstNonemptyWindow)
    }
    let appFrame = app.frame
    if !appFrame.isNull && !appFrame.isEmpty {
      return (appFrame, .app)
    }
    return (.infinite, .unbounded)
  }

  func aggregatedLabel(for snapshot: XCUIElementSnapshot, depth: Int = 0) -> String? {
    if depth > 4 { return nil }
    let text = snapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty { return text }
    if let valueText = snapshotValueText(snapshot) { return valueText }
    for child in snapshot.children {
      if let childLabel = aggregatedLabel(for: child, depth: depth + 1) {
        return childLabel
      }
    }
    return nil
  }

  private func isVisibleInViewport(_ rect: CGRect, _ viewport: CGRect) -> Bool {
    if rect.isNull || rect.isEmpty { return false }
    return rect.intersects(viewport)
  }

  private func appendCollapsedTabFallbackNodes(
    to nodes: inout [SnapshotNode],
    containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    depth: Int,
    parentIndex: Int,
    nodeLimit: Int,
    viewport: CGRect
  ) -> Bool {
    let fallbackNodes = collapsedTabFallbackNodes(
      for: containerSnapshot,
      resolveElements: resolveElements,
      startingIndex: nodes.count,
      depth: depth,
      parentIndex: parentIndex,
      viewport: viewport
    )
    if fallbackNodes.isEmpty { return false }
    let remaining = max(0, nodeLimit - nodes.count)
    if remaining == 0 { return true }
    nodes.append(contentsOf: fallbackNodes.prefix(remaining))
    return fallbackNodes.count > remaining
  }

  private func collapsedTabFallbackNodes(
    for containerSnapshot: XCUIElementSnapshot,
    resolveElements: () -> [XCUIElement],
    startingIndex: Int,
    depth: Int,
    parentIndex: Int,
    viewport: CGRect
  ) -> [SnapshotNode] {
    if !containerSnapshot.children.isEmpty { return [] }
    guard shouldExpandCollapsedTabContainer(containerSnapshot) else { return [] }
    let containerFrame = containerSnapshot.frame
    if containerFrame.isNull || containerFrame.isEmpty { return [] }

    // Collapsed tab containers should be rare, so a full descendant scan is acceptable once per
    // snapshot as a fallback for XCTest omitting the tab children from the snapshot tree.
    let elements = resolveElements()
    let candidates = elements.compactMap { element in
      collapsedTabCandidateNode(
        element: element,
        containerSnapshot: containerSnapshot,
        containerFrame: containerFrame,
        viewport: viewport
      )
    }
    .sorted { left, right in
      if left.rect.x != right.rect.x {
        return left.rect.x < right.rect.x
      }
      return left.rect.y < right.rect.y
    }

    if candidates.count < 2 { return [] }
    let rowMidpoints = candidates.map { $0.rect.y + ($0.rect.height / 2) }
    let rowSpread = (rowMidpoints.max() ?? 0) - (rowMidpoints.min() ?? 0)
    // Allow modest vertical jitter and short two-row wraps while still rejecting unrelated controls.
    if rowSpread > max(24.0, Double(containerFrame.height) * 0.6) { return [] }

    var seen = Set<String>()
    let uniqueCandidates = candidates.filter { node in
      let key = "\(node.type)-\(node.label ?? "")-\(node.identifier ?? "")-\(node.value ?? "")-\(node.rect.x)-\(node.rect.y)-\(node.rect.width)-\(node.rect.height)"
      if seen.contains(key) { return false }
      seen.insert(key)
      return true
    }
    if uniqueCandidates.count < 2 { return [] }

    return uniqueCandidates.enumerated().map { offset, node in
      SnapshotNode(
        index: startingIndex + offset,
        type: node.type,
        label: node.label,
        identifier: node.identifier,
        value: node.value,
        rect: node.rect,
        enabled: node.enabled,
        focused: node.focused,
        hittable: node.hittable,
        depth: depth,
        parentIndex: parentIndex,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    }
  }

  private func collapsedTabCandidateNode(
    element: XCUIElement,
    containerSnapshot: XCUIElementSnapshot,
    containerFrame: CGRect,
    viewport: CGRect
  ) -> SnapshotNode? {
    var node: SnapshotNode?
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      if !element.exists { return }
      let elementType = element.elementType
      if !Self.collapsedTabCandidateTypes.contains(elementType) { return }
      let frame = element.frame
      if frame.isNull || frame.isEmpty { return }
      if frame.equalTo(containerFrame) { return }
      let area = max(CGFloat(1), frame.width * frame.height)
      let containerArea = max(CGFloat(1), containerFrame.width * containerFrame.height)
      if area >= containerArea * 0.9 { return }
      let center = CGPoint(x: frame.midX, y: frame.midY)
      if !containerFrame.contains(center) { return }

      let label = element.label.trimmingCharacters(in: .whitespacesAndNewlines)
      let identifier = element.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
      let valueText = snapshotValueText(element)
      let hasContent = !label.isEmpty || !identifier.isEmpty || valueText != nil
      if !hasContent { return }
      if sameSemanticElement(
        containerSnapshot: containerSnapshot,
        elementType: elementType,
        label: label,
        identifier: identifier
      ) {
        return
      }

      node = SnapshotNode(
        index: 0,
        type: elementTypeName(elementType),
        label: label.isEmpty ? nil : label,
        identifier: identifier.isEmpty ? nil : identifier,
        value: valueText,
        rect: snapshotRect(from: frame),
        enabled: element.isEnabled,
        focused: elementHasFocus(element) ? true : nil,
        hittable: computeSnapshotHittable(
          enabled: element.isEnabled,
          frame: frame,
          viewport: viewport
        ),
        depth: 0,
        parentIndex: nil,
        hiddenContentAbove: nil,
        hiddenContentBelow: nil
      )
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_SNAPSHOT_TAB_FALLBACK_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return nil
    }
    return node
  }

  private func snapshotHasFocus(_ snapshot: XCUIElementSnapshot) -> Bool {
    var focused = false
    _ = RunnerObjCExceptionCatcher.catchException({
      // `as?` not `as!` — a force-cast failure is a fatal Swift trap that the
      // Obj-C exception catcher cannot intercept.
      if let obj = snapshot as? NSObject, let value = obj.value(forKey: "hasFocus") as? Bool {
        focused = value
      }
    })
    return focused
  }

  private func shouldExpandCollapsedTabContainer(_ snapshot: XCUIElementSnapshot) -> Bool {
    let frame = snapshot.frame
    if frame.isNull || frame.isEmpty { return false }
    if frame.width < max(CGFloat(160), frame.height * 1.75) { return false }
    switch snapshot.elementType {
    case .tabBar, .segmentedControl, .slider:
      return true
    default:
      return false
    }
  }

  private func snapshotValueText(_ element: XCUIElement) -> String? {
    let text = String(describing: element.value ?? "")
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return text.isEmpty ? nil : text
  }

  private func sameSemanticElement(
    containerSnapshot: XCUIElementSnapshot,
    elementType: XCUIElement.ElementType,
    label: String,
    identifier: String
  ) -> Bool {
    if containerSnapshot.elementType != elementType { return false }
    let containerLabel = containerSnapshot.label.trimmingCharacters(in: .whitespacesAndNewlines)
    let containerIdentifier = containerSnapshot.identifier
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return containerLabel == label && containerIdentifier == identifier
  }

  private func safeSnapshotElementsQuery(_ fetch: () -> [XCUIElement]) -> [XCUIElement] {
    var elements: [XCUIElement] = []
    let exceptionMessage = RunnerObjCExceptionCatcher.catchException({
      elements = fetch()
    })
    if let exceptionMessage {
      NSLog(
        "RN_FAST_RUNNER_SNAPSHOT_QUERY_IGNORED_EXCEPTION=%@",
        exceptionMessage
      )
      return []
    }
    return elements
  }

  private func isScrollableContainer(_ snapshot: XCUIElementSnapshot, visible: Bool) -> Bool {
    if !visible { return false }
    if !Self.scrollContainerTypes.contains(snapshot.elementType) { return false }
    return !snapshot.children.isEmpty
  }
}

final class PresenceCaptureTiming {
  private let now: () -> Double
  private var lastCheckedTime: Double
  private var invalidClock = false
  private var phase: PlatformPresenceDiagnostics.Phase = .initialEligibility
  private var phaseStarted: Double?
  private var recorded = PlatformPresenceDiagnostics(phaseMs: [:])

  init(started: Double, now: @escaping () -> Double) {
    self.now = now
    lastCheckedTime = started
    phaseStarted = started
  }

  func begin(_ phase: PlatformPresenceDiagnostics.Phase) {
    self.phase = phase
    phaseStarted = now()
  }

  func preparationStarted(quietWindowMs: Double) {
    recorded.preparationSamples = 0
    recorded.preparationResets = 0
    recorded.preparationQuietWindowMs = quietWindowMs
    recorded.preparationQuietElapsedMs = 0
  }

  func preparationSampleStarted() {
    recorded.preparationSamples = (recorded.preparationSamples ?? 0) + 1
  }

  func preparationSampleCompleted(reset: Bool, quietElapsedMs: Double) {
    if reset { recorded.preparationResets = (recorded.preparationResets ?? 0) + 1 }
    recorded.preparationQuietElapsedMs = quietElapsedMs
  }

  func endPhase() {
    guard let started = phaseStarted else { return }
    let elapsed = now() - started
    if elapsed.isFinite { recorded.phaseMs[phase.rawValue] = max(0, elapsed) }
    phaseStarted = nil
  }

  func fail(
    _ reason: PlatformPresenceDiagnostics.Reason, phase: PlatformPresenceDiagnostics.Phase? = nil,
    mismatch: PlatformPresenceDiagnostics.Mismatch? = nil
  ) {
    if recorded.failure == nil {
      recorded.failure = .init(phase: phase ?? self.phase, reason: reason, mismatch: mismatch)
    }
  }

  func deadlineReached(
    _ deadline: Double, read: PlatformPresenceDiagnostics.Read, edge: PlatformPresenceDiagnostics.Edge,
    phase: PlatformPresenceDiagnostics.Phase? = nil, at time: Double? = nil
  ) -> Bool {
    let checked = time ?? now()
    guard !invalidClock, deadline.isFinite, deadline >= 0,
          lastCheckedTime.isFinite, lastCheckedTime >= 0,
          checked.isFinite, checked >= lastCheckedTime else {
      invalidClock = true
      fail(.readUnavailable, phase: phase)
      return true
    }
    lastCheckedTime = checked
    guard checked >= deadline else { return false }
    if recorded.deadline == nil {
      recorded.deadline = .init(phase: phase ?? self.phase, read: read, edge: edge)
    }
    fail(.deadline, phase: phase)
    return true
  }

  func diagnostics(complete: Bool) -> PlatformPresenceDiagnostics {
    PlatformPresenceDiagnostics(
      phaseMs: recorded.phaseMs, preparationSamples: recorded.preparationSamples,
      preparationResets: recorded.preparationResets,
      preparationQuietWindowMs: recorded.preparationQuietWindowMs,
      preparationQuietElapsedMs: recorded.preparationQuietElapsedMs,
      failure: complete ? nil : recorded.failure, deadline: recorded.deadline
    )
  }
}

func makePlatformPresencePayload(
  nodes: [SnapshotNode], truncated: Bool, capture: PlatformPresenceCapture
) -> DataPayload {
  let keyboardVisible: Bool? = capture.complete ? nodes.contains { node in
    node.type == "Keyboard" && !CGRect(
      x: node.rect.x, y: node.rect.y, width: node.rect.width, height: node.rect.height
    ).isEmpty
  } : nil
  return DataPayload(
    nodes: nodes, truncated: truncated, keyboardVisible: keyboardVisible,
    snapshotGeneration: capture.generation, presenceCapture: capture
  )
}
