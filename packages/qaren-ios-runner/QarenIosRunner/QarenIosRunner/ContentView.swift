//
//  ContentView.swift
//  QarenIosRunner
//

import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack {
            Spacer()
            Text("QaReN")
                .font(.title2)
                .fontWeight(.semibold)
                .accessibilityIdentifier("runner-splash-title")
            Text("iOS runner")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
#if os(iOS)
            if AlertFixture.enabled {
                AlertFixtureControls()
            }
            if let length = VanishFixture.length {
                VanishFixtureControls(length: length)
            }
#endif
            Spacer()
            Text("XCUITest bridge")
                .font(.caption)
                .foregroundStyle(.tertiary)
                .padding(.bottom, 24)
        }
        .padding()
    }
}

#Preview {
    ContentView()
}
