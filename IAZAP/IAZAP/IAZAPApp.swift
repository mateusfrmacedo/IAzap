import SwiftUI

@main
struct IAZAPApp: App {
    @StateObject private var store = AppStore()
    @StateObject private var bridge = BridgeClient()

    var body: some Scene {
        WindowGroup("IAZAP") {
            ContentView()
                .environmentObject(store)
                .environmentObject(bridge)
                .frame(minWidth: 880, minHeight: 560)
                .onAppear {
                    bridge.attach(store: store)
                }
        }
        .defaultSize(width: 980, height: 640)

        Settings {
            SettingsView()
                .environmentObject(store)
                .environmentObject(bridge)
        }
    }
}
