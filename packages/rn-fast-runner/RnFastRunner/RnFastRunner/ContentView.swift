//
//  ContentView.swift
//  RnFastRunner
//

import SwiftUI

struct ContentView: View {
    var body: some View {
        VStack {
            Spacer()
            Text("rn-dev-agent")
                .font(.title2)
                .fontWeight(.semibold)
                .accessibilityIdentifier("runner-splash-title")
            Text("fast runner")
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.top, 4)
#if os(iOS)
            if AlertFixture.enabled {
                AlertFixtureControls()
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
