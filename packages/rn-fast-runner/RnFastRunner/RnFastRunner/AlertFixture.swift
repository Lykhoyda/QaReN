//
//  AlertFixture.swift
//  RnFastRunner
//

#if os(iOS)
import SwiftUI
import UIKit

// Test-only in-app alert in its own window, the shape of the React Native alert in the field failure.
enum AlertFixture {
  static let launchArgument = "-RnFastRunnerAlertFixture"
  static let enabled = ProcessInfo.processInfo.arguments.contains(launchArgument)
  private static var window: UIWindow?

  static func present(onResult: @escaping (String) -> Void) {
    guard let scene = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .first(where: { $0.activationState == .foregroundActive }) else { return }
    let host = UIWindow(windowScene: scene)
    host.rootViewController = UIViewController()
    host.windowLevel = .alert
    host.makeKeyAndVisible()
    window = host
    let alert = UIAlertController(title: "Discard changes?", message: nil, preferredStyle: .alert)
    for (title, style, result) in [("Keep editing", UIAlertAction.Style.cancel, "kept"), ("Discard", .destructive, "discarded")] {
      alert.addAction(UIAlertAction(title: title, style: style) { _ in
        window?.isHidden = true
        window = nil
        onResult(result)
      })
    }
    host.rootViewController?.present(alert, animated: false)
  }
}

struct AlertFixtureControls: View {
  @State private var result = "none"

  var body: some View {
    Button("Open alert fixture") { AlertFixture.present { result = $0 } }
      .accessibilityIdentifier("alert-fixture-open")
    Text(result)
      .accessibilityIdentifier("alert-fixture-result")
  }
}
#endif
