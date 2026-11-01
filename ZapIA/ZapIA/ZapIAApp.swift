import SwiftUI

@main
struct ZapIAApp: App {
    @NSApplicationDelegateAdaptor(ZapIAAppDelegate.self) private var appDelegate
    @StateObject private var store = AppStore()
    @StateObject private var bridge = BridgeClient()

    var body: some Scene {
        WindowGroup("ZapIA") {
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
final class ZapIAAppDelegate: NSObject, NSApplicationDelegate {
    weak var bridge: BridgeClient?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(didWake),
            name: NSWorkspace.didWakeNotification, object: nil)
    }

    @objc private func didWake(_ notification: Notification) {
        Task { await bridge?.recoverAfterWake() }
    }

    func applicationWillTerminate(_ notification: Notification) {
        bridge?.disconnect()
    }
}
