import Foundation
import Darwin

@main
struct BootstrapSmoke {
    static func main() {
        Task { @MainActor in await run(); exit(0) }
        dispatchMain()
    }
    @MainActor static func run() async {
        defer {
            if let id = Bundle.main.bundleIdentifier, id.hasPrefix("app.iazap.smoke-test.") {
                UserDefaults.standard.removePersistentDomain(forName: id)
            }
        }
        let bridge = BridgeClient()
        let store = AppStore()
        let expectsEnabled = ProcessInfo.processInfo.environment["IAZAP_TEST_RECOVERY"] == "1"
            || ProcessInfo.processInfo.environment["IAZAP_TEST_HANG"] == "1"
        store.autoReplyEnabled = expectsEnabled
        let testApple = ProcessInfo.processInfo.environment["IAZAP_TEST_APPLE"] == "1"
        store.preferredModelId = testApple ? "apple-intelligence" : AppStore.defaultModelId
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
        if testApple {
            guard bridge.modelStatus.modelId == "apple-intelligence",
                  bridge.modelStatus.backend == "apple", bridge.modelStatus.state == .ready,
                  store.preferredModelId == "apple-intelligence" else {
                print("FAIL: saved Apple model lost during bootstrap: \(bridge.modelStatus)")
                bridge.disconnect()
                exit(1)
            }
            print("PASS: saved Apple preference survives initial bridge defaults; native model ready")
        }
        print("PASS: cold bootstrap, managed Node, custom socket, authenticated IPC, stub chats")
        let testHang = ProcessInfo.processInfo.environment["IAZAP_TEST_HANG"] == "1"
        let testRecovery = ProcessInfo.processInfo.environment["IAZAP_TEST_RECOVERY"] == "1" || testHang
        if testRecovery {
            let before = childPID()
            guard before > 0 else { print("FAIL: managed child not found"); exit(1) }
            kill(before, testHang ? SIGSTOP : SIGKILL)
            let deadline = Date().addingTimeInterval(testHang ? 60 : 25)
            var recovered = false
            while Date() < deadline {
                try? await Task.sleep(nanoseconds: 250_000_000)
                if bridge.isConnected, bridge.bridgeProcessRunning, childPID() != before, childPID() > 0 {
                    recovered = true
                    break
                }
            }
            guard recovered else { kill(before, SIGKILL); print("FAIL: bridge did not recover after failure"); bridge.disconnect(); exit(1) }
            guard bridge.pipelineStatus.enabled == expectsEnabled, store.autoReplyEnabled == expectsEnabled else {
                print("FAIL: recovery lost auto-reply preference"); bridge.disconnect(); exit(1)
            }
            if testApple {
                guard bridge.modelStatus.modelId == "apple-intelligence", store.preferredModelId == "apple-intelligence" else {
                    print("FAIL: recovery lost selected model"); bridge.disconnect(); exit(1)
                }
            }
            print(testHang ? "PASS: recovered IPC and replaced an unresponsive managed bridge" : "PASS: automatically recovered IPC and restarted the crashed managed bridge")
        }
        bridge.disconnect()
        try? await Task.sleep(nanoseconds: testRecovery ? 3_000_000_000 : 500_000_000)
        guard !bridge.isConnected, !bridge.bridgeProcessRunning else { exit(1) }
        print("PASS: disconnect")
    }
    static func childPID() -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        process.arguments = ["-P", String(ProcessInfo.processInfo.processIdentifier)]
        let pipe = Pipe()
        process.standardOutput = pipe
        do { try process.run() } catch { return 0 }
        let output = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: output, encoding: .utf8)?.split(whereSeparator: { $0.isWhitespace })
            .compactMap { Int32($0) }.first(where: { $0 != process.processIdentifier }) ?? 0
    }

}
