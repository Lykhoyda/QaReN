public struct LookOnlyRect: Equatable {
  public var x, y, width, height: Double

  public init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }
}

public struct LookOnlyRawNode {
  public var type: String, label: String, identifier: String, value: String?
  public var frame: LookOnlyRect, enabled: Bool, selected: Bool
  public var children: [LookOnlyRawNode]

  public init(
    type: String, label: String, identifier: String, value: String?, frame: LookOnlyRect, enabled: Bool,
    selected: Bool, children: [LookOnlyRawNode]
  ) {
    self.type = type
    self.label = label
    self.identifier = identifier
    self.value = value
    self.frame = frame
    self.enabled = enabled
    self.selected = selected
    self.children = children
  }
}

public struct LookOnlyNode: Equatable {
  public var type: String, label: String?, identifier: String?
  public var rect: LookOnlyRect, enabled: Bool, selected: Bool, parent: Int?

  public init(
    type: String, label: String?, identifier: String?, rect: LookOnlyRect, enabled: Bool, selected: Bool,
    parent: Int?
  ) {
    self.type = type
    self.label = label
    self.identifier = identifier
    self.rect = rect
    self.enabled = enabled
    self.selected = selected
    self.parent = parent
  }
}

public enum LookOnlyTree: Equatable { case nodes([LookOnlyNode]), tooManyNodes, unreadable }

public func lookOnlyExport(_ root: LookOnlyRawNode) -> LookOnlyTree {
  .unreadable
}

public func lookOnlyPossible(_ nodes: [LookOnlyNode]) -> Bool {
  false
}
