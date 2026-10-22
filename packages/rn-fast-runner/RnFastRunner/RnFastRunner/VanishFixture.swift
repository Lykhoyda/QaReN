//
//  VanishFixture.swift
//  RnFastRunner
//

#if os(iOS)
import SwiftUI

// Test-only field that disappears once it holds the given number of characters, like an auto-submitting code field,
// and a button; the remove control takes both away so a test can make a gesture target vanish.
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
  @State private var removed = false

  var body: some View {
    if !removed {
      if text.count < length {
        TextField("Vanishing field", text: $text)
          .accessibilityIdentifier("vanish-fixture-field")
          .textFieldStyle(.roundedBorder)
      }
      Button("Vanishing button") {}
        .accessibilityIdentifier("vanish-fixture-button")
    }
    Button("Remove vanishing controls") { removed = true }
      .accessibilityIdentifier("vanish-fixture-remove")
  }
}
#endif
