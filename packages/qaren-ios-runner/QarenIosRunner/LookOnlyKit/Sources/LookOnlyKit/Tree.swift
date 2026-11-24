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
  var flat: [(node: LookOnlyRawNode, name: String, parent: Int?, silent: Bool)] = []
  func visit(_ node: LookOnlyRawNode, depth: Int, parent: Int?) -> Bool? {
    guard depth <= 200, flat.count < 5000 else { return nil }
    let position = flat.count
    let name = spelled(node.type, among: exportNames) ?? "Element"
    flat.append((node, name, parent, false))
    var silent = protectedNames.contains(name)
    for child in node.children {
      guard let below = visit(child, depth: depth + 1, parent: position) else { return nil }
      silent = silent || below
    }
    flat[position].silent = silent
    return silent
  }
  guard visit(root, depth: 0, parent: nil) != nil, flat[0].name == "Application" else { return .unreadable }

  var rows: [(hides: Bool, nearestKept: Int?)] = []
  var list: [LookOnlyNode] = []
  for (node, name, parent, silent) in flat {
    let up = parent.map { rows[$0] }
    let dropped = (up?.hides ?? false) || name == "Key"
    let label = silent || dropped ? nil : trimmed(node.label) ?? node.value.flatMap(trimmed)
    let identifier = node.identifier.isEmpty ? nil : node.identifier
    let above = up?.nearestKept
    let kept = !dropped && (parent == nil || typeKeptNames.contains(name) || label != nil || identifier != nil)
    if kept {
      list.append(
        LookOnlyNode(
          type: name, label: label, identifier: identifier, rect: node.frame, enabled: node.enabled,
          selected: node.selected, parent: above))
    }
    rows.append((dropped || protectedNames.contains(name), kept ? list.count - 1 : above))
  }
  guard list.allSatisfy({ usable($0.rect) }),
    hasArea(list[0].rect) || list.contains(where: { $0.type == "Window" && hasArea($0.rect) })
  else { return .unreadable }
  return list.count > 300 ? .tooManyNodes : .nodes(list)
}

public func lookOnlyPossible(_ nodes: [LookOnlyNode]) -> Bool {
  guard (1...300).contains(nodes.count) else { return false }
  let names = nodes.map { spelled($0.type, among: possibleNames) }
  guard names[0] == "Application", nodes[0].parent == nil else { return false }
  var path: [Int] = []
  for (position, node) in nodes.enumerated() {
    guard let name = names[position] else { return false }
    if position > 0 {
      guard let parent = node.parent, let at = path.firstIndex(of: parent),
        typeKeptNames.contains(name) || node.label != nil || node.identifier != nil
      else { return false }
      path.removeSubrange((at + 1)...)
    }
    if let label = node.label, trimmed(label).map({ $0.unicodeScalars.elementsEqual(label.unicodeScalars) }) != true {
      return false
    }
    guard node.identifier?.isEmpty != true, usable(node.rect), path.count <= 200 else { return false }
    if protectedNames.contains(name) {
      guard node.label == nil, path.allSatisfy({ nodes[$0].label == nil }) else { return false }
    } else {
      path.append(position)
    }
  }
  return hasArea(nodes[0].rect) || zip(names, nodes).contains { $0 == "Window" && hasArea($1.rect) }
}

private let snapshotNames = [
  "Application", "Window", "Button", "Cell", "StaticText", "TextField", "TextView", "SecureTextField", "Switch",
  "Slider", "Link", "Image", "NavigationBar", "TabBar", "CollectionView", "Table", "ScrollView", "SearchField",
  "Toolbar", "SegmentedControl", "Stepper", "Picker", "CheckBox", "MenuItem", "Other",
]
private let exportNames = snapshotNames + ["Keyboard", "Key"]
private let possibleNames = snapshotNames + ["Keyboard", "Element"]
private let protectedNames: Set = ["TextField", "SecureTextField", "SearchField", "TextView", "Keyboard"]
private let interactiveNames: Set = [
  "Button", "Cell", "CheckBox", "CollectionView", "Link", "MenuItem", "Picker", "SearchField", "SegmentedControl",
  "Slider", "Stepper", "Switch", "TabBar", "TextField", "SecureTextField", "TextView",
]
private let typeKeptNames = interactiveNames.union(protectedNames).union(["Window"])

private func spelled(_ type: String, among names: [String]) -> String? {
  names.first { $0.unicodeScalars.elementsEqual(type.unicodeScalars) }
}

private func trimmed(_ text: String) -> String? {
  let scalars = text.unicodeScalars
  guard let first = scalars.firstIndex(where: { !$0.properties.isWhitespace }),
    let last = scalars.lastIndex(where: { !$0.properties.isWhitespace })
  else { return nil }
  return String(scalars[first...last])
}

private func usable(_ rect: LookOnlyRect) -> Bool {
  [rect.x, rect.y, rect.width, rect.height].allSatisfy(\.isFinite) && rect.width >= 0 && rect.height >= 0
}

private func hasArea(_ rect: LookOnlyRect) -> Bool {
  usable(rect) && rect.width > 0 && rect.height > 0
}