import Foundation
import Combine
import Darwin
import CryptoKit

/// JSON-RPC client over a Unix domain socket.
///
/// Launch model (botchat-inspired):
/// 1. On app open, try the default socket + `IAZAP_TOKEN=dev-token-change-me`
/// 2. If offline, spawn Node bridge from resolved `bridge/` and reconnect
/// 3. Surface `qr.update` immediately as a large in-app QR; clear when connected
@MainActor
final class BridgeClient: ObservableObject {
    static let defaultToken = "dev-token-change-me"

    @Published var isConnected = false
    @Published var sessionStatus: SessionStatus = .disconnected
    /// Raw Baileys QR string (UI renders via CoreImage). Nil when hidden — same contract as botchat `qrCode`.
    @Published var qrPayload: String?
    /// Short status line under the connection state (botchat `detalhe`).
    @Published var statusDetail: String = "Iniciando…"
    @Published var chats: [ChatSummary] = []
    @Published var lastError: String?
    @Published var bridgeProcessRunning = false
    @Published var isBootstrapping = false
    @Published var authDirectoryPath: String = BridgeClient.defaultAuthDirectory().path
    @Published var dataDirectoryPath: String = BridgeClient.defaultDataDirectory().path
    @Published var bridgeDirectoryPath: String = ""
    @Published var pipelineStatus: PipelineStatus = .placeholder
    @Published var modelStatus: ModelStatus = .placeholder
    @Published private(set) var isApplyingPrompt = false
    @Published private(set) var promptApplyError: String?

    private weak var store: AppStore?
    private var promptSubscription: AnyCancellable?
    private var connection: NWUnixConnection?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var requestTimeouts: [Int: Task<Void, Never>] = [:]
    private var sessionToken = BridgeClient.defaultToken
    private var socketPath: String = BridgeClient.defaultSocketPath()
    private var bridgeProcess: Process?
    private var statusPollTask: Task<Void, Never>?
    private var didBootstrap = false
    private var isSyncingPreferences = false
    private var shouldMaintainConnection = false
    private var isConnecting = false
    private var isRecovering = false
    private var recoveryAttempts = 0
    private var nextRecoveryAt = Date.distantPast
    private var useStubWhatsApp = false

    func attach(store: AppStore) {
        self.store = store
        promptSubscription = store.$systemPromptPT
            .dropFirst()
            .removeDuplicates()
            .debounce(for: .milliseconds(800), scheduler: DispatchQueue.main)
            .sink { [weak self] prompt in
                Task { @MainActor in await self?.applySystemPrompt(prompt) }
            }
    }

    func isPromptApplied(_ prompt: String) -> Bool {
        let canonical = prompt.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
        let hash = SHA256.hash(data: Data(canonical.utf8)).map { String(format: "%02x", $0) }.joined()
        return pipelineStatus.systemPromptHash == hash
    }

    func applySystemPrompt(_ prompt: String) async {
        guard isConnected, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        isApplyingPrompt = true
        promptApplyError = nil
        defer { isApplyingPrompt = false }
        do {
            pipelineStatus = try await request(method: BridgeRPC.Method.pipelineConfigure,
                                               params: PromptUpdateParams(systemPrompt: prompt))
        } catch {
            promptApplyError = "Não foi possível aplicar o prompt: \(error.localizedDescription)"
            lastError = promptApplyError
        }
    }

    private struct PromptUpdateParams: Encodable {
        let systemPrompt: String
    }

    static func defaultSocketPath() -> String {
        let tmp = FileManager.default.temporaryDirectory.path
        return (tmp as NSString).appendingPathComponent("iazap-bridge.sock")
    }

    static func defaultAuthDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("IAZAP/baileys-auth", isDirectory: true)
    }

    static func defaultDataDirectory() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("IAZAP/data", isDirectory: true)
    }

    // MARK: - Bootstrap (auto-start)

    /// Called once when the window appears. Prefer attaching to a live bridge; otherwise spawn it.
    func bootstrapOnLaunch(stubWhatsApp: Bool = false) async {
        guard !didBootstrap else { return }
        didBootstrap = true
        shouldMaintainConnection = true
        useStubWhatsApp = stubWhatsApp
        startStatusPolling()
        isBootstrapping = true
        statusDetail = "Procurando bridge…"
        lastError = nil

        if let envToken = ProcessInfo.processInfo.environment["IAZAP_TOKEN"], !envToken.isEmpty {
            sessionToken = envToken
        } else {
            sessionToken = Self.defaultToken
        }
        if let envSock = ProcessInfo.processInfo.environment["IAZAP_SOCKET"], !envSock.isEmpty {
            socketPath = envSock
        } else {
            socketPath = Self.defaultSocketPath()
        }

        // Fast path: bridge already running (e.g. Terminal `npm run serve`).
        await connect(socketPath: socketPath, token: sessionToken)
        if isConnected {
            statusDetail = detailForCurrentSession()
            startStatusPolling()
            isBootstrapping = false
            return
        }

        guard shouldMaintainConnection else { isBootstrapping = false; return }
        guard let bridgeDir = BridgeLocator.resolve() else {
            statusDetail = "Bridge não encontrado. Rode ./scripts/run-mac.sh ou informe a pasta em Status."
            lastError = "Pasta bridge/ não encontrada (precisa de package.json + src/index.ts)."
            isBootstrapping = false
            return
        }

        bridgeDirectoryPath = bridgeDir.path
        BridgeLocator.remember(bridgeDir)
        statusDetail = "Iniciando bridge Node…"
        await startBridgeAndConnect(bridgeDirectory: bridgeDir, stubWhatsApp: stubWhatsApp)
        isBootstrapping = false
    }

    /// Force restart of the managed Node process + fresh connect (keeps auth unless logout).
    func restartBridge(stubWhatsApp: Bool = false) async {
        stopStatusPolling()
        disconnectIPCOnly()
        stopBridgeProcess()
        didBootstrap = false
        qrPayload = nil
        sessionStatus = .disconnected
        statusDetail = "Reiniciando bridge…"
        await bootstrapOnLaunch(stubWhatsApp: stubWhatsApp)
    }

    // MARK: - Public API

    /// Connect to an already-running bridge (typical during `npm run serve` / `dev`).
    func connect(socketPath: String? = nil, token: String? = nil) async {
        guard !isConnecting else { return }
        isConnecting = true
        defer { isConnecting = false }
        shouldMaintainConnection = true
        // Retained bridge defaults must not replace the user's saved model before sync.
        isSyncingPreferences = true
        defer { isSyncingPreferences = false }
        if let socketPath { self.socketPath = socketPath }
        if let token { self.sessionToken = token }
        lastError = nil

        do {
            disconnectIPCOnly()
            guard FileManager.default.fileExists(atPath: self.socketPath) else {
                throw BridgeClientError.notConnected
            }
            let conn = NWUnixConnection(path: self.socketPath)
            conn.onLine = { [weak self, weak conn] line in
                Task { @MainActor in
                    guard let self, let conn, self.connection === conn else { return }
                    self.handleIncomingLine(line)
                }
            }
            conn.onState = { [weak self, weak conn] ready, error in
                Task { @MainActor in
                    guard let self, let conn, self.connection === conn else { return }
                    if !ready {
                        self.isConnected = false
                        self.failPendingRequests(BridgeClientError.notConnected)
                    }
                    if let error {
                        self.lastError = error
                        self.statusDetail = "IPC offline: \(error)"
                    }
                }
            }
            self.connection = conn
            try conn.start()

            try await Task.sleep(nanoseconds: 200_000_000)

            let hello = SessionHelloParams(
                token: sessionToken,
                client: BridgeRPC.clientName,
                protocolVersion: BridgeRPC.protocolVersion
            )
            let _: HelloResult = try await request(method: BridgeRPC.Method.sessionHello, params: hello, timeoutSeconds: 3)
            isConnected = true
            recoveryAttempts = 0
            nextRecoveryAt = .distantPast
            sessionStatus = try await request(method: BridgeRPC.Method.sessionStatus, params: EmptyParams())
            statusDetail = detailForCurrentSession()
            await syncSelectionToBridge()
            await syncPipelineConfigToBridge()
            await refreshPipelineStatus()
            await refreshPipelineActivity()
            await refreshModelStatus()
            await refreshChats()
            startStatusPolling()
        } catch {
            lastError = error.localizedDescription
            if let rpcError = error as? JSONRPCErrorBody, rpcError.code == -32001 {
                shouldMaintainConnection = false
                stopStatusPolling()
                statusDetail = "Token IPC inválido. Confira a configuração do bridge."
            }
            isConnected = false
            disconnectIPCOnly()
        }
    }

    func disconnect() {
        shouldMaintainConnection = false
        stopStatusPolling()
        disconnectIPCOnly()
        stopBridgeProcess()
        statusDetail = "Parado"
    }

    /// Spawn the Node bridge as a child process, then connect.
    func startBridgeAndConnect(bridgeDirectory: URL, stubWhatsApp: Bool = false) async {
        shouldMaintainConnection = true
        useStubWhatsApp = stubWhatsApp
        startStatusPolling()
        stopBridgeProcess()
        // Keep the shared default token so out-of-box matches README / Terminal.
        if ProcessInfo.processInfo.environment["IAZAP_TOKEN"] == nil {
            sessionToken = Self.defaultToken
        }
        // Preserve IAZAP_SOCKET resolved during bootstrap.
        // Remove stale socket so the child can bind.
        try? FileManager.default.removeItem(atPath: socketPath)

        let environment = ProcessInfo.processInfo.environment
        let authURL = environment["IAZAP_AUTH"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? BridgeClient.defaultAuthDirectory()
        let dataURL = environment["IAZAP_DATA"].map { URL(fileURLWithPath: $0, isDirectory: true) }
            ?? BridgeClient.defaultDataDirectory()
        try? FileManager.default.createDirectory(at: authURL, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
        authDirectoryPath = authURL.path
        dataDirectoryPath = dataURL.path
        bridgeDirectoryPath = bridgeDirectory.path
        BridgeLocator.remember(bridgeDirectory)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        // Own Node directly so terminate() also stops the bridge, without an npm parent.
        if let bundledNode = Bundle.main.executableURL?.deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Helpers/node"),
           FileManager.default.isExecutableFile(atPath: bundledNode.path) {
            process.executableURL = bundledNode
            process.arguments = ["dist/index.js"]
        } else {
            process.arguments = ["node", "--import", "tsx", "src/index.ts"]
        }
        process.currentDirectoryURL = bridgeDirectory

        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        if let helper = Bundle.main.executableURL?.deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Helpers/iazap-apple-engine"),
           FileManager.default.isExecutableFile(atPath: helper.path) {
            env["IAZAP_APPLE_HELPER"] = helper.path
        }
        env["IAZAP_SOCKET"] = socketPath
        env["IAZAP_TOKEN"] = sessionToken
        env["IAZAP_AUTH"] = authURL.path
        env["IAZAP_DATA"] = dataURL.path
        if stubWhatsApp {
            env["IAZAP_STUB_WA"] = "1"
        } else {
            env.removeValue(forKey: "IAZAP_STUB_WA")
        }
        process.environment = env

        // A pipe without a reader fills up and freezes Node. Keep diagnostics in a file.
        let logURL = dataURL.appendingPathComponent("bridge.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil,
                                       attributes: [.posixPermissions: 0o600])
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self else { return }
                guard self.bridgeProcess === proc else { return }
                self.bridgeProcess = nil
                self.bridgeProcessRunning = false
                self.disconnectIPCOnly()
                self.statusDetail = "Bridge encerrou (código \(proc.terminationStatus)). Tentando recuperar…"
            }
        }

        do {
            try await ensureBridgeDependencies(at: bridgeDirectory, environment: env)
            guard shouldMaintainConnection else { return }
            let logHandle = try FileHandle(forWritingTo: logURL)
            defer { try? logHandle.close() }
            process.standardError = logHandle
            process.standardOutput = logHandle
            try process.run()
            bridgeProcess = process
            bridgeProcessRunning = true
            statusDetail = "Aguardando socket do bridge…"

            let ready = await waitForSocket(path: socketPath, timeoutSeconds: 45)
            guard ready else {
                stopBridgeProcess()
                let stderr = (try? String(contentsOf: logURL, encoding: .utf8)) ?? ""
                lastError = "Timeout aguardando \(socketPath). \(stderr.suffix(400))"
                statusDetail = "Bridge não abriu o socket a tempo."
                return
            }

            // Retry connect a few times while tsx boots Baileys.
            for attempt in 1...8 {
                await connect(socketPath: socketPath, token: sessionToken)
                if isConnected { break }
                statusDetail = "Conectando ao IPC… (\(attempt)/8)"
                try await Task.sleep(nanoseconds: 500_000_000)
            }

            if isConnected {
                statusDetail = detailForCurrentSession()
                if sessionStatus.state != .connected, qrPayload == nil {
                    statusDetail = "Aguardando QR Code do WhatsApp…"
                }
            } else {
                statusDetail = "Falha ao falar com o bridge via socket."
            }
        } catch {
            lastError = "Falha ao iniciar bridge: \(error.localizedDescription)"
            statusDetail = lastError ?? "Erro ao iniciar bridge"
            bridgeProcessRunning = false
        }
    }

    func refreshChats() async {
        do {
            let result: ChatsListResult = try await request(method: BridgeRPC.Method.chatsList, params: EmptyParams())
            applyChats(result.chats)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setAutoReply(chatID: String, enabled: Bool) async {
        store?.setAutoReply(chatID: chatID, enabled: enabled)
        if let idx = chats.firstIndex(where: { $0.id == chatID }) {
            chats[idx].autoReply = enabled
        }
        do {
            let _: SetAutoReplyResult = try await request(
                method: BridgeRPC.Method.chatsSetAutoReply,
                params: SetAutoReplyParams(chatId: chatID, enabled: enabled)
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    func syncSelectionToBridge() async {
        guard let store, isConnected || connection != nil else { return }
        let ids = Array(store.selectedChatIDs).sorted()
        do {
            let _: SyncSelectionResult = try await request(
                method: BridgeRPC.Method.chatsSyncSelection,
                params: SyncSelectionParams(chatIds: ids)
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    func syncPipelineConfigToBridge() async {
        guard let store, isConnected || connection != nil else { return }
        do {
            pipelineStatus = try await request(
                method: BridgeRPC.Method.pipelineConfigure,
                params: PipelineConfigureParams(
                    enabled: store.autoReplyEnabled,
                    debounceMs: store.debounceMs,
                    cooldownMs: store.cooldownMs,
                    contextSize: store.contextMessageCount,
                    allowGroups: false,
                    systemPrompt: store.systemPromptPT,
                    modelId: store.preferredModelId
                )
            )
            await refreshModelStatus()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshModelStatus() async {
        do {
            modelStatus = try await request(method: BridgeRPC.Method.modelGetStatus, params: EmptyParams())
            if !isSyncingPreferences, let store, !modelStatus.modelId.isEmpty {
                store.preferredModelId = modelStatus.modelId
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    func configureModel(modelId: String) async {
        store?.preferredModelId = modelId
        do {
            modelStatus = try await request(
                method: BridgeRPC.Method.modelConfigure,
                params: ModelConfigureParams(modelId: modelId)
            )
            await refreshPipelineStatus()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func reloadModel() async {
        do {
            modelStatus = try await request(method: BridgeRPC.Method.modelReload, params: EmptyParams(), timeoutSeconds: 660)
            await refreshPipelineStatus()
        } catch {
            lastError = error.localizedDescription
        }
    }

    func setGlobalAutoReplyEnabled(_ enabled: Bool) async {
        store?.autoReplyEnabled = enabled
        do {
            pipelineStatus = try await request(
                method: BridgeRPC.Method.pipelineSetEnabled,
                params: PipelineSetEnabledParams(enabled: enabled)
            )
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshPipelineStatus() async {
        do {
            pipelineStatus = try await request(method: BridgeRPC.Method.pipelineGetStatus, params: EmptyParams())
        } catch {
            lastError = error.localizedDescription
        }
    }

    func refreshPipelineActivity() async {
        do {
            let result: PipelineActivityListResult = try await request(
                method: BridgeRPC.Method.pipelineGetActivity,
                params: ActivityLimitParams(limit: 40)
            )
            store?.replacePipelineActivities(result.activities)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func reconnectSession() async {
        statusDetail = "Gerando novo QR Code…"
        qrPayload = nil
        do {
            sessionStatus = try await request(method: BridgeRPC.Method.sessionReconnect, params: EmptyParams())
            if sessionStatus.state == .connected {
                qrPayload = nil
                statusDetail = "WhatsApp conectado."
                await refreshChats()
            } else {
                statusDetail = "Escaneie o QR Code pelo WhatsApp."
            }
        } catch {
            lastError = error.localizedDescription
            statusDetail = error.localizedDescription
        }
    }

    func logoutSession() async {
        do {
            sessionStatus = try await request(method: BridgeRPC.Method.sessionLogout, params: EmptyParams())
            qrPayload = nil
            chats = []
            statusDetail = "Conta desconectada. Use Reconectar para novo QR."
        } catch {
            lastError = error.localizedDescription
        }
    }

    func fetchStatus() async {
        do {
            sessionStatus = try await request(method: BridgeRPC.Method.sessionStatus, params: EmptyParams())
            statusDetail = detailForCurrentSession()
        } catch {
            lastError = error.localizedDescription
            disconnectIPCOnly()
        }
    }

    func sendMessage(chatID: String, text: String) async throws -> String {
        let result: MessagesSendResult = try await request(
            method: BridgeRPC.Method.messagesSend,
            params: MessagesSendParams(chatId: chatID, text: text)
        )
        return result.messageId
    }

    // MARK: - Internals

    private struct EmptyParams: Encodable {}
    private struct ActivityLimitParams: Encodable {
        let limit: Int
    }
    private struct HelloResult: Decodable {
        let ok: Bool
        let protocolVersion: Int
    }

    private func detailForCurrentSession() -> String {
        if let err = sessionStatus.lastError, !err.isEmpty { return err }
        switch sessionStatus.state {
        case .connected:
            if let me = sessionStatus.me { return "Conectado como \(me.name)." }
            return "WhatsApp conectado."
        case .qr:
            return "Escaneie o QR Code pelo WhatsApp."
        case .connecting:
            return "Abrindo sessão WhatsApp…"
        case .loggedOut:
            return "Sessão encerrada. Reconecte para gerar QR."
        case .error:
            return lastError ?? "Erro na sessão."
        case .disconnected:
            return isConnected ? "Bridge IPC ok — aguardando WhatsApp." : "Desconectado."
        }
    }

    private func ensureBridgeDependencies(at bridgeDirectory: URL, environment: [String: String]) async throws {
        if FileManager.default.fileExists(atPath: bridgeDirectory.appendingPathComponent("dist/index.js").path),
           FileManager.default.fileExists(atPath: bridgeDirectory.appendingPathComponent("node_modules/@whiskeysockets/baileys/package.json").path) {
            return
        }
        let tsxPackage = bridgeDirectory.appendingPathComponent("node_modules/tsx/package.json")
        if FileManager.default.fileExists(atPath: tsxPackage.path) { return }
        statusDetail = "npm ci no bridge (primeira vez)…"
        let install = Process()
        install.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        install.arguments = ["npm", "ci"]
        install.currentDirectoryURL = bridgeDirectory
        install.environment = environment
        install.standardOutput = FileHandle.nullDevice
        install.standardError = FileHandle.nullDevice
        // Waiting for npm must not block SwiftUI's main actor.
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            install.terminationHandler = { process in
                if process.terminationStatus == 0 {
                    continuation.resume()
                } else {
                    continuation.resume(throwing: BridgeClientError.bootstrapFailed(
                        "npm ci falhou (código \(process.terminationStatus)). Rode npm ci em bridge/ para ver os detalhes."))
                }
            }
            do { try install.run() }
            catch { continuation.resume(throwing: error) }
        }
    }

    private func waitForSocket(path: String, timeoutSeconds: Double) async -> Bool {
        let deadline = Date().addingTimeInterval(timeoutSeconds)
        while Date() < deadline {
            if FileManager.default.fileExists(atPath: path) {
                return true
            }
            if let proc = bridgeProcess, !proc.isRunning {
                return false
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return FileManager.default.fileExists(atPath: path)
    }

    private func startStatusPolling() {
        guard statusPollTask == nil else { return }
        statusPollTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(nanoseconds: 2_500_000_000) }
                catch { return }
                guard let self, self.shouldMaintainConnection else { return }
                if self.isBootstrapping || self.isConnecting || self.isRecovering { continue }
                if !self.isConnected {
                    await self.recoverConnectionIfNeeded()
                    continue
                }
                await self.fetchStatus()
                if self.sessionStatus.state == .connected, self.chats.isEmpty {
                    await self.refreshChats()
                }
            }
        }
    }

    private func recoverConnectionIfNeeded() async {
        guard shouldMaintainConnection, !isRecovering, !isConnecting, Date() >= nextRecoveryAt else { return }
        isRecovering = true
        defer { isRecovering = false }
        recoveryAttempts += 1
        nextRecoveryAt = Date().addingTimeInterval(min(30, pow(2, Double(min(recoveryAttempts, 5)))))
        statusDetail = "Recuperando conexão com o bridge…"
        await connect(socketPath: socketPath, token: sessionToken)
        guard !isConnected, shouldMaintainConnection else { return }
        // Give a live child time to recover; restart only our own unresponsive process.
        if bridgeProcess?.isRunning == true {
            guard recoveryAttempts >= 3 else { return }
            let unresponsive = bridgeProcess
            stopBridgeProcess()
            // Let the old child exit before opening another WhatsApp socket with the same credentials.
            for _ in 0..<15 {
                if unresponsive?.isRunning != true { break }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
            guard shouldMaintainConnection else { return }
        }
        guard let directory = BridgeLocator.resolve() else { return }
        await startBridgeAndConnect(bridgeDirectory: directory, stubWhatsApp: useStubWhatsApp)
    }

    func recoverAfterWake() async {
        guard shouldMaintainConnection else { return }
        nextRecoveryAt = .distantPast
        if isConnected {
            await fetchStatus()
        }
        if !isConnected { await recoverConnectionIfNeeded() }
        else if sessionStatus.state == .disconnected || sessionStatus.state == .connecting {
            await reconnectSession()
        }
    }

    private func stopStatusPolling() {
        statusPollTask?.cancel()
        statusPollTask = nil
    }

    private func disconnectIPCOnly() {
        let previous = connection
        connection = nil
        previous?.cancel()
        isConnected = false
        failPendingRequests(BridgeClientError.notConnected)
    }

    private func failPendingRequests(_ error: Error) {
        let requests = pending
        pending.removeAll()
        for task in requestTimeouts.values { task.cancel() }
        requestTimeouts.removeAll()
        for continuation in requests.values { continuation.resume(throwing: error) }
    }

    private func applyChats(_ incoming: [ChatSummary]) {
        var merged = incoming
        if let store {
            merged = merged.map { chat in
                var c = chat
                c.autoReply = store.isAutoReplyEnabled(for: chat.id)
                return c
            }
        }
        chats = merged
    }

    private func request<T: Decodable>(method: String, params: Encodable, timeoutSeconds: Double = 15) async throws -> T {
        guard let connection else {
            throw BridgeClientError.notConnected
        }
        let id = nextID
        nextID += 1
        let req = JSONRPCRequest(id: id, method: method, params: params)
        let data = try JSONEncoder().encode(req) + Data([0x0A]) // newline

        let responseData: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            requestTimeouts[id] = Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                guard !Task.isCancelled, let self else { return }
                self.requestTimeouts.removeValue(forKey: id)
                self.pending.removeValue(forKey: id)?.resume(throwing: BridgeClientError.requestTimedOut(method))
            }
            connection.send(data)
        }

        let decoded = try JSONDecoder().decode(JSONRPCResponse<T>.self, from: responseData)
        if let error = decoded.error {
            throw error
        }
        guard let result = decoded.result else {
            throw BridgeClientError.emptyResult
        }
        return result
    }

    private func handleIncomingLine(_ line: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { return }

        if let id = obj["id"] as? Int, let cont = pending.removeValue(forKey: id) {
            requestTimeouts.removeValue(forKey: id)?.cancel()
            cont.resume(returning: line)
            return
        }

        guard let method = obj["method"] as? String else { return }
        let paramsData: Data
        if let params = obj["params"] {
            paramsData = (try? JSONSerialization.data(withJSONObject: params)) ?? Data([0x7B, 0x7D])
        } else {
            paramsData = Data([0x7B, 0x7D])
        }

        switch method {
        case BridgeRPC.Method.qrUpdate:
            if let p = try? JSONDecoder().decode(QRUpdateParams.self, from: paramsData) {
                // botchat contract: show image when non-null, hide when null
                qrPayload = p.qr
                if let qr = p.qr, !qr.isEmpty {
                    sessionStatus.state = .qr
                    statusDetail = "Escaneie o QR Code pelo WhatsApp."
                }
            }
        case BridgeRPC.Method.sessionStatus:
            if let p = try? JSONDecoder().decode(SessionStatus.self, from: paramsData) {
                sessionStatus = p
                if p.state == .connected {
                    qrPayload = nil
                    statusDetail = detailForCurrentSession()
                    Task { await refreshChats() }
                } else {
                    statusDetail = detailForCurrentSession()
                }
            }
        case BridgeRPC.Method.chatsUpdated:
            if let p = try? JSONDecoder().decode(ChatsListResult.self, from: paramsData) {
                applyChats(p.chats)
            }
        case BridgeRPC.Method.messagesInbound:
            if let p = try? JSONDecoder().decode(InboundMessage.self, from: paramsData) {
                store?.recordInbound(p)
            }
        case BridgeRPC.Method.pipelineStatus:
            if let p = try? JSONDecoder().decode(PipelineStatus.self, from: paramsData) {
                pipelineStatus = p
                if !isSyncingPreferences { store?.autoReplyEnabled = p.enabled }
            }
        case BridgeRPC.Method.pipelineActivity:
            if let p = try? JSONDecoder().decode(PipelineActivity.self, from: paramsData) {
                store?.recordPipelineActivity(p)
            }
        case BridgeRPC.Method.modelStatus:
            if let p = try? JSONDecoder().decode(ModelStatus.self, from: paramsData) {
                modelStatus = p
                if !isSyncingPreferences, let store, !p.modelId.isEmpty {
                    store.preferredModelId = p.modelId
                }
            }
        default:
            break
        }
    }

    private func stopBridgeProcess() {
        let process = bridgeProcess
        bridgeProcess = nil
        bridgeProcessRunning = false
        guard let process, process.isRunning else { return }
        process.terminate()
        Task {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
    }
}

enum BridgeClientError: LocalizedError {
    case notConnected
    case emptyResult
    case bootstrapFailed(String)
    case requestTimedOut(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Bridge IPC não conectado"
        case .emptyResult: return "Resultado JSON-RPC vazio"
        case .bootstrapFailed(let msg): return msg
        case .requestTimedOut(let method): return "Tempo esgotado aguardando \(method). Verifique ou reinicie o bridge."
        }
    }
}
