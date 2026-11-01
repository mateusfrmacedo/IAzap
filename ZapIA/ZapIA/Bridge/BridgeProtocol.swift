import Foundation

/// Swift mirror of `protocol/types.ts` / PROTOCOL.md (protocolVersion 1, Phase 3–4).
enum BridgeRPC {
    static let protocolVersion = 1
    static let clientName = "zapia-macos"

    enum Method {
        static let sessionHello = "session.hello"
        static let sessionStatus = "session.status"
        static let sessionReconnect = "session.reconnect"
        static let sessionLogout = "session.logout"
        static let chatsList = "chats.list"
        static let chatsSetAutoReply = "chats.setAutoReply"
        static let chatsSyncSelection = "chats.syncSelection"
        static let messagesSend = "messages.send"
        static let pipelineGetStatus = "pipeline.getStatus"
        static let pipelineSetEnabled = "pipeline.setEnabled"
        static let pipelineConfigure = "pipeline.configure"
        static let pipelineGetActivity = "pipeline.getActivity"
        static let pipelineSimulateInbound = "pipeline.simulateInbound"
        static let modelGetStatus = "model.getStatus"
        static let modelConfigure = "model.configure"
        static let modelReload = "model.reload"

        // Notifications (bridge → app)
        static let qrUpdate = "qr.update"
        static let messagesInbound = "messages.inbound"
        static let chatsUpdated = "chats.updated"
        static let pipelineStatus = "pipeline.status"
        static let pipelineActivity = "pipeline.activity"
        static let modelStatus = "model.status"
    }
}

struct JSONRPCRequest: Encodable {
    let jsonrpc = "2.0"
    let id: Int
    let method: String
    let params: AnyEncodable?

    init(id: Int, method: String, params: Encodable? = nil) {
        self.id = id
        self.method = method
        self.params = params.map(AnyEncodable.init)
    }
}

struct JSONRPCResponse<T: Decodable>: Decodable {
    let jsonrpc: String
    let id: Int?
    let result: T?
    let error: JSONRPCErrorBody?
}

struct JSONRPCErrorBody: Decodable, Error {
    let code: Int
    let message: String
}

struct JSONRPCNotification: Decodable {
    let jsonrpc: String
    let method: String
}

struct SessionHelloParams: Encodable {
    let token: String
    let client: String
    let protocolVersion: Int
}

struct ChatsListResult: Decodable {
    let chats: [ChatSummary]
}

struct SetAutoReplyParams: Encodable {
    let chatId: String
    let enabled: Bool
}

struct SetAutoReplyResult: Decodable {
    let ok: Bool
    let chatId: String
    let enabled: Bool
}

struct SyncSelectionParams: Encodable {
    let chatIds: [String]
}

struct SyncSelectionResult: Decodable {
    let ok: Bool
    let chatIds: [String]
}

struct MessagesSendParams: Encodable {
    let chatId: String
    let text: String
}

struct MessagesSendResult: Decodable {
    let messageId: String
}

struct QRUpdateParams: Decodable {
    let qr: String?
}

struct PipelineSetEnabledParams: Encodable {
    let enabled: Bool
}

struct PipelineConfigureParams: Encodable {
    var enabled: Bool?
    var debounceMs: Int?
    var cooldownMs: Int?
    var contextSize: Int?
    var allowGroups: Bool?
    var systemPrompt: String?
    var modelId: String?
}

struct ModelConfigureParams: Encodable {
    let modelId: String
}

struct PipelineActivityListResult: Decodable {
    let activities: [PipelineActivity]
}

struct PipelineSimulateInboundParams: Encodable {
    let chatId: String
    let text: String
    var fromMe: Bool?
    var isGroup: Bool?
}

struct PipelineSimulateInboundResult: Decodable {
    let ok: Bool
    let messageId: String
}

/// Type-erased Encodable wrapper for JSON-RPC params.
struct AnyEncodable: Encodable {
    private let encodeFunc: (Encoder) throws -> Void

    init(_ wrapped: Encodable) {
        encodeFunc = wrapped.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeFunc(encoder)
    }
}
