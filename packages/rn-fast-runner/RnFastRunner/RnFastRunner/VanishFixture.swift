//
//  VanishFixture.swift
//  RnFastRunner
//

#if os(iOS)
import SwiftUI

// Test-only field that disappears once it holds the given number of characters, like an auto-submitting code field.
enum VanishFixture {
  static let launchArgument = "-RnFastRunnerVanishFixture"
  static let length: Int? = {
    let arguments = ProcessInfo.processInfo.arguments
    guard let index = arguments.firstIndex(of: launchArgument), index + 1 < arguments.count else { return nil }
    return Int(arguments[index + 1])
  }()
}

struct VanishFixtureControls: View {
  let length: Int
  @State private var text = ""

  var body: some View {
    if text.count < length {
      TextField("Vanishing field", text: $text)
        .accessibilityIdentifier("vanish-fixture-field")
        .textFieldStyle(.roundedBorder)
    }
  }
}
#endif
