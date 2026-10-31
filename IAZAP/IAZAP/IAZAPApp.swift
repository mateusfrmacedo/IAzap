import SwiftUI

@main
struct IAZAPApp: App {
    @NSApplicationDelegateAdaptor(IAZAPAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()
    @StateObject private var bridge = BridgeClient()

    var body: some Scene {
        WindowGroup("IAZAP") {
            ContentView()
                .environmentObject(store)
                .environmentObject(bridge)
                .frame(minWidth: 880, minHeight: 560)
                .onAppear {
                    appDelegate.bridge = bridge
                    bridge.attach(store: store)
                    Task {
                        await bridge.bootstrapOnLaunch()
                    }
                }
                .onDisappear {
                    // Keep child bridge alive while other windows/settings may still use IPC.
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

@MainActor
final class IAZAPAppDelegate: NSObject, NSApplicationDelegate {
    weak var bridge: BridgeClient?

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.disconnect()
    }
}
