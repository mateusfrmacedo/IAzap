import Foundation
import Combine

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

    private weak var store: AppStore?
    private var connection: NWUnixConnection?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var sessionToken = BridgeClient.defaultToken
    private var socketPath: String = BridgeClient.defaultSocketPath()
    private var bridgeProcess: Process?
    private var statusPollTask: Task<Void, Never>?
    private var didBootstrap = false

    func attach(store: AppStore) {
        self.store = store
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
        if let socketPath { self.socketPath = socketPath }
        if let token { self.sessionToken = token }
        lastError = nil

        do {
            connection?.cancel()
            let conn = NWUnixConnection(path: self.socketPath)
            conn.onLine = { [weak self] line in
                Task { @MainActor in
                    self?.handleIncomingLine(line)
                }
            }
            conn.onState = { [weak self] ready, error in
                Task { @MainActor in
                    self?.isConnected = ready
                    if let error {
                        self?.lastError = error
                        self?.isConnected = false
                        self?.statusDetail = "IPC offline: \(error)"
                    }
                }
            }
            try conn.start()
            self.connection = conn

            try await Task.sleep(nanoseconds: 200_000_000)

            let hello = SessionHelloParams(
                token: sessionToken,
                client: BridgeRPC.clientName,
                protocolVersion: BridgeRPC.protocolVersion
            )
            let _: HelloResult = try await request(method: BridgeRPC.Method.sessionHello, params: hello)
            isConnected = true
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
            isConnected = false
            connection?.cancel()
            connection = nil
        }
    }

    func disconnect() {
        stopStatusPolling()
        disconnectIPCOnly()
        stopBridgeProcess()
        statusDetail = "Parado"
    }

    /// Spawn the Node bridge as a child process, then connect.
    func startBridgeAndConnect(bridgeDirectory: URL, stubWhatsApp: Bool = false) async {
        stopBridgeProcess()
        // Keep the shared default token so out-of-box matches README / Terminal.
        if ProcessInfo.processInfo.environment["IAZAP_TOKEN"] == nil {
            sessionToken = Self.defaultToken
        }
        socketPath = BridgeClient.defaultSocketPath()
        // Remove stale socket so the child can bind.
        try? FileManager.default.removeItem(atPath: socketPath)

        let authURL = BridgeClient.defaultAuthDirectory()
        let dataURL = BridgeClient.defaultDataDirectory()
        try? FileManager.default.createDirectory(at: authURL, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: dataURL, withIntermediateDirectories: true)
        authDirectoryPath = authURL.path
        dataDirectoryPath = dataURL.path
        bridgeDirectoryPath = bridgeDirectory.path
        BridgeLocator.remember(bridgeDirectory)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        // Prefer non-watch serve so the child stays stable under the app.
        process.arguments = ["npm", "run", "serve"]
        process.currentDirectoryURL = bridgeDirectory

        var env = ProcessInfo.processInfo.environment
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

        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = errPipe
        process.terminationHandler = { [weak self] proc in
            Task { @MainActor in
                guard let self else { return }
                if self.bridgeProcess === proc || self.bridgeProcess == nil {
                    self.bridgeProcessRunning = false
                    if self.isConnected == false {
                        self.statusDetail = "Bridge encerrou (código \(proc.terminationStatus))."
                    }
                }
            }
        }

        do {
            try ensureBridgeDependencies(at: bridgeDirectory)
            try process.run()
            bridgeProcess = process
            bridgeProcessRunning = true
            statusDetail = "Aguardando socket do bridge…"

            let ready = await waitForSocket(path: socketPath, timeoutSeconds: 45)
            guard ready else {
                let stderr = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
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
            if let store, !modelStatus.modelId.isEmpty {
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
            modelStatus = try await request(method: BridgeRPC.Method.modelReload, params: EmptyParams())
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

    private func ensureBridgeDependencies(at bridgeDirectory: URL) throws {
        let nodeModules = bridgeDirectory.appendingPathComponent("node_modules", isDirectory: true)
        if FileManager.default.fileExists(atPath: nodeModules.path) { return }
        statusDetail = "npm install no bridge (primeira vez)…"
        let install = Process()
        install.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        install.arguments = ["npm", "install"]
        install.currentDirectoryURL = bridgeDirectory
        install.standardOutput = Pipe()
        install.standardError = Pipe()
        try install.run()
        install.waitUntilExit()
        if install.terminationStatus != 0 {
            throw BridgeClientError.bootstrapFailed("npm install falhou (código \(install.terminationStatus)).")
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
        stopStatusPolling()
        statusPollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_500_000_000)
                guard let self, self.isConnected else { continue }
                // Keep UI in sync if a notification was missed.
                await self.fetchStatus()
                if self.sessionStatus.state == .connected, self.chats.isEmpty {
                    await self.refreshChats()
                }
            }
        }
    }

    private func stopStatusPolling() {
        statusPollTask?.cancel()
        statusPollTask = nil
    }

    private func disconnectIPCOnly() {
        connection?.cancel()
        connection = nil
        isConnected = false
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

    private func request<T: Decodable>(method: String, params: Encodable) async throws -> T {
        guard let connection else {
            throw BridgeClientError.notConnected
        }
        let id = nextID
        nextID += 1
        let req = JSONRPCRequest(id: id, method: method, params: params)
        let data = try JSONEncoder().encode(req) + Data([0x0A]) // newline

        let responseData: Data = try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
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
                store?.autoReplyEnabled = p.enabled
            }
        case BridgeRPC.Method.pipelineActivity:
            if let p = try? JSONDecoder().decode(PipelineActivity.self, from: paramsData) {
                store?.recordPipelineActivity(p)
            }
        case BridgeRPC.Method.modelStatus:
            if let p = try? JSONDecoder().decode(ModelStatus.self, from: paramsData) {
                modelStatus = p
                if let store, !p.modelId.isEmpty {
                    store.preferredModelId = p.modelId
                }
            }
        default:
            break
        }
    }

    private func stopBridgeProcess() {
        bridgeProcess?.terminate()
        bridgeProcess = nil
        bridgeProcessRunning = false
    }
}

enum BridgeClientError: LocalizedError {
    case notConnected
    case emptyResult
    case bootstrapFailed(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Bridge IPC não conectado"
        case .emptyResult: return "Resultado JSON-RPC vazio"
        case .bootstrapFailed(let msg): return msg
        }
    }
}
