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
            if let id = Bundle.main.bundleIdentifier, id.hasPrefix("app.zapia.smoke-test.") {
                UserDefaults.standard.removePersistentDomain(forName: id)
            }
        }
        let bridge = BridgeClient()
        let store = AppStore()
        let expectsEnabled = ProcessInfo.processInfo.environment["ZAPIA_TEST_RECOVERY"] == "1"
            || ProcessInfo.processInfo.environment["ZAPIA_TEST_HANG"] == "1"
        store.autoReplyEnabled = expectsEnabled
        store.cooldownMs = 0
        guard AppStore().cooldownMs == 0 else {
            print("FAIL: zero cooldown was not persisted"); exit(1)
        }
        let testApple = ProcessInfo.processInfo.environment["ZAPIA_TEST_APPLE"] == "1"
        store.preferredModelId = testApple ? "apple-intelligence" : AppStore.defaultModelId
        bridge.attach(store: store)
        await bridge.bootstrapOnLaunch(stubWhatsApp: true)
        guard bridge.isConnected, bridge.sessionStatus.state == .connected,
              bridge.bridgeProcessRunning, bridge.chats.count == 3 else {
            print("FAIL: connected=\(bridge.isConnected), state=\(bridge.sessionStatus.state), detail=\(bridge.statusDetail), error=\(bridge.lastError ?? "nil")")
            bridge.disconnect()
            exit(1)
        }
        if ProcessInfo.processInfo.environment["ZAPIA_PACKAGED_TEST"] == "1" {
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
        do {
            let original = try await bridge.getAutomation()
            let legacy = Data(#"{"configuracoes":{"saudacao":"Olá, {nome}!"},"opcoes":[{"id":"info","titulo_menu":"Informações","texto_resposta":"Texto importado","ativo":true}]}"#.utf8)
            let imported = try await bridge.previewAutomationImport(legacy)
            guard imported.mode == "menu", imported.opcoes.first?.resposta == "Texto importado" else {
                print("FAIL: legacy automation preview"); bridge.disconnect(); exit(1)
            }
            let unchanged = try await bridge.getAutomation()
            guard unchanged.mode == original.mode else { print("FAIL: preview mutated settings"); exit(1) }
            let saved = try await bridge.saveAutomation(imported)
            guard saved.opcoes.first?.titulo == "Informações", saved.mode == "menu" else {
                print("FAIL: automation persistence"); bridge.disconnect(); exit(1)
            }
            _ = try await bridge.saveAutomation(original)
            print("PASS: native BotChat import preview and persisted automation via authenticated RPC")
        } catch { print("FAIL: automation RPC: \(error)"); bridge.disconnect(); exit(1) }
        let editedPrompt = "  Seu nome é Joa\u{0303}o. Você não usa emoji nas conversas!  "
        store.systemPromptPT = editedPrompt
        let applyDeadline = Date().addingTimeInterval(8)
        while !bridge.isPromptApplied(editedPrompt), Date() < applyDeadline {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        guard bridge.isPromptApplied(editedPrompt), bridge.pipelineStatus.cooldownMs == 0,
              bridge.pipelineStatus.enabled == expectsEnabled else {
            print("FAIL: prompt edit was not automatically applied or changed other settings")
            bridge.disconnect(); exit(1)
        }
        print("PASS: prompt edits auto-apply with verified active fingerprint, preserving other settings")
        let testHang = ProcessInfo.processInfo.environment["ZAPIA_TEST_HANG"] == "1"
        let testRecovery = ProcessInfo.processInfo.environment["ZAPIA_TEST_RECOVERY"] == "1" || testHang
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
            guard bridge.isPromptApplied(editedPrompt) else {
                print("FAIL: recovery lost edited prompt"); bridge.disconnect(); exit(1)
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
