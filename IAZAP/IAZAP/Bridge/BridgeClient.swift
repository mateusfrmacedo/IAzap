import Foundation
import Combine

/// JSON-RPC client over a Unix domain socket (Phase 1 stub + real connect path).
///
/// Launch model (later polished in pipeline phase):
/// 1. Mint token, pick socket path under TMPDIR
/// 2. Spawn `node` bridge with IAZAP_SOCKET / IAZAP_TOKEN
/// 3. Connect, call `session.hello`, subscribe to notifications
@MainActor
final class BridgeClient: ObservableObject {
    @Published var isConnected = false
    @Published var sessionStatus: SessionStatus = .disconnected
    @Published var qrPayload: String?
    @Published var chats: [ChatSummary] = []
    @Published var lastError: String?
    @Published var bridgeProcessRunning = false

    private weak var store: AppStore?
    private var connection: NWUnixConnection?
    private var nextID = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var lineBuffer = Data()
    private var sessionToken = "dev-token-change-me"
    private var socketPath: String = BridgeClient.defaultSocketPath()
    private var bridgeProcess: Process?

    func attach(store: AppStore) {
        self.store = store
    }

    static func defaultSocketPath() -> String {
        let tmp = FileManager.default.temporaryDirectory.path
        return (tmp as NSString).appendingPathComponent("iazap-bridge.sock")
    }

    // MARK: - Public API

    /// Connect to an already-running bridge (typical during Phase 1 manual `npm run dev`).
    func connect(socketPath: String? = nil, token: String? = nil) async {
        if let socketPath { self.socketPath = socketPath }
        if let token { self.sessionToken = token }
        lastError = nil

        do {
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
                    }
                }
            }
            try conn.start()
            self.connection = conn

            // Brief wait for socket accept
            try await Task.sleep(nanoseconds: 150_000_000)

            let hello = SessionHelloParams(
                token: sessionToken,
                client: BridgeRPC.clientName,
                protocolVersion: BridgeRPC.protocolVersion
            )
            let _: HelloResult = try await request(method: BridgeRPC.Method.sessionHello, params: hello)
            sessionStatus = try await request(method: BridgeRPC.Method.sessionStatus, params: EmptyParams())
            await refreshChats()
        } catch {
            lastError = error.localizedDescription
            isConnected = false
        }
    }

    func disconnect() {
        connection?.cancel()
        connection = nil
        isConnected = false
        stopBridgeProcess()
    }

    /// Spawn the Node bridge as a child process, then connect.
    /// `bridgeDirectory` should point at repo `bridge/` (folder with package.json).
    func startBridgeAndConnect(bridgeDirectory: URL, stubWhatsApp: Bool = false) async {
        stopBridgeProcess()
        sessionToken = UUID().uuidString
        socketPath = BridgeClient.defaultSocketPath()

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["npm", "run", "dev"]
        process.currentDirectoryURL = bridgeDirectory

        var env = ProcessInfo.processInfo.environment
        env["IAZAP_SOCKET"] = socketPath
        env["IAZAP_TOKEN"] = sessionToken
        if stubWhatsApp {
            env["IAZAP_STUB_WA"] = "1"
        }
        process.environment = env

        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = errPipe

        do {
            try process.run()
            bridgeProcess = process
            bridgeProcessRunning = true
            // Give tsx a moment to bind the socket
            try await Task.sleep(nanoseconds: 1_200_000_000)
            await connect(socketPath: socketPath, token: sessionToken)
        } catch {
            lastError = "Failed to launch bridge: \(error.localizedDescription)"
            bridgeProcessRunning = false
        }
    }

    func refreshChats() async {
        do {
            let result: ChatsListResult = try await request(method: BridgeRPC.Method.chatsList, params: EmptyParams())
            var merged = result.chats
            if let store {
                merged = merged.map { chat in
                    var c = chat
                    c.autoReply = store.isAutoReplyEnabled(for: chat.id)
                    return c
                }
            }
            chats = merged
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

    func sendMessage(chatID: String, text: String) async throws -> String {
        let result: MessagesSendResult = try await request(
            method: BridgeRPC.Method.messagesSend,
            params: MessagesSendParams(chatId: chatID, text: text)
        )
        return result.messageId
    }

    // MARK: - Internals

    private struct EmptyParams: Encodable {}
    private struct HelloResult: Decodable {
        let ok: Bool
        let protocolVersion: Int
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
        // Notification vs response: presence of "id"
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
                qrPayload = p.qr
                if p.qr != nil {
                    sessionStatus.state = .qr
                }
            }
        case BridgeRPC.Method.sessionStatus:
            if let p = try? JSONDecoder().decode(SessionStatus.self, from: paramsData) {
                sessionStatus = p
            }
        case BridgeRPC.Method.messagesInbound:
            if let p = try? JSONDecoder().decode(InboundMessage.self, from: paramsData) {
                store?.recordInbound(p)
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

    var errorDescription: String? {
        switch self {
        case .notConnected: return "Bridge IPC not connected"
        case .emptyResult: return "Empty JSON-RPC result"
        }
    }
}
