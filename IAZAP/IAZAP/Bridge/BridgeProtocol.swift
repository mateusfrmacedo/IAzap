import Foundation

/// Swift mirror of `protocol/types.ts` / PROTOCOL.md (protocolVersion 1).
enum BridgeRPC {
    static let protocolVersion = 1
    static let clientName = "iazap-macos"

    enum Method {
        static let sessionHello = "session.hello"
        static let sessionStatus = "session.status"
        static let chatsList = "chats.list"
        static let chatsSetAutoReply = "chats.setAutoReply"
        static let messagesSend = "messages.send"

        // Notifications (bridge → app)
        static let qrUpdate = "qr.update"
        static let messagesInbound = "messages.inbound"
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
    // params decoded per-method by callers
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
