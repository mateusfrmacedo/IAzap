import Foundation

@main
struct BootstrapSmoke {
    static func main() {
        Task { @MainActor in await run(); exit(0) }
        dispatchMain()
    }
    @MainActor static func run() async {
        let bridge = BridgeClient()
        let store = AppStore()
        store.autoReplyEnabled = false
        bridge.attach(store: store)
        await bridge.bootstrapOnLaunch(stubWhatsApp: true)
        guard bridge.isConnected, bridge.sessionStatus.state == .connected,
              bridge.bridgeProcessRunning, bridge.chats.count == 3 else {
            print("FAIL: connected=\(bridge.isConnected), state=\(bridge.sessionStatus.state), detail=\(bridge.statusDetail), error=\(bridge.lastError ?? "nil")")
            bridge.disconnect()
            exit(1)
        }
        if ProcessInfo.processInfo.environment["IAZAP_PACKAGED_TEST"] == "1" {
            guard bridge.bridgeDirectoryPath.hasPrefix(Bundle.main.bundleURL.path) else {
                print("FAIL: packaged app resolved external bridge: \(bridge.bridgeDirectoryPath)")
                bridge.disconnect()
                exit(1)
            }
            print("PASS: bridge resolved inside app bundle")
        }
        print("PASS: cold bootstrap, managed Node, custom socket, authenticated IPC, stub chats")
        bridge.disconnect()
        try? await Task.sleep(nanoseconds: 500_000_000)
        guard !bridge.isConnected, !bridge.bridgeProcessRunning else { exit(1) }
        print("PASS: disconnect")
    }
}
