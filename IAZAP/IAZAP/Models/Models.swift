import Foundation
import SwiftUI

enum SessionState: String, Codable, Sendable {
    case disconnected
    case qr
    case connecting
    case connected
    case loggedOut = "logged_out"
    case error

    var label: String {
        switch self {
        case .disconnected: return "Desconectado"
        case .qr: return "Aguardando QR"
        case .connecting: return "Conectando"
        case .connected: return "Conectado"
        case .loggedOut: return "Deslogado"
        case .error: return "Erro"
        }
    }

    var color: Color {
        switch self {
        case .connected: return .green
        case .qr, .connecting: return .orange
        case .error, .loggedOut: return .red
        case .disconnected: return .secondary
        }
    }
}

struct SessionMe: Codable, Hashable, Sendable {
    var id: String
    var name: String
}

struct SessionStatus: Codable, Hashable, Sendable {
    var state: SessionState
    var me: SessionMe?
    var lastError: String?

    static let disconnected = SessionStatus(state: .disconnected, me: nil, lastError: nil)
}

struct ChatSummary: Identifiable, Codable, Hashable, Sendable {
    var id: String
    var name: String
    var isGroup: Bool
    var autoReply: Bool
    var lastMessagePreview: String?
    var lastMessageAt: Double?
}

struct InboundMessage: Identifiable, Codable, Hashable, Sendable {
    var chatId: String
    var messageId: String
    var text: String
    var fromMe: Bool
    var timestamp: Double

    var id: String { messageId }
}
