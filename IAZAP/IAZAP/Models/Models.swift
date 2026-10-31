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

enum PipelinePhase: String, Codable, Sendable {
    case idle
    case debouncing
    case generating
    case sending
    case cooldown
    case error

    var label: String {
        switch self {
        case .idle: return "Ocioso"
        case .debouncing: return "Debounce"
        case .generating: return "Gerando"
        case .sending: return "Enviando"
        case .cooldown: return "Cooldown"
        case .error: return "Erro"
        }
    }
}

struct PipelineStatus: Codable, Hashable, Sendable {
    var enabled: Bool
    var engineId: String
    var phase: PipelinePhase
    var debounceMs: Int
    var cooldownMs: Int
    var contextSize: Int
    var allowGroups: Bool
    var selectedCount: Int
    var pendingChats: Int
    var lastActivityAt: Double?
    var lastError: String?

    static let placeholder = PipelineStatus(
        enabled: false,
        engineId: "stub",
        phase: .idle,
        debounceMs: 3000,
        cooldownMs: 15000,
        contextSize: 12,
        allowGroups: false,
        selectedCount: 0,
        pendingChats: 0,
        lastActivityAt: nil,
        lastError: nil
    )
}

enum PipelineActivityKind: String, Codable, Sendable {
    case inbound
    case skippedFromMe = "skipped_from_me"
    case skippedNotSelected = "skipped_not_selected"
    case skippedGroup = "skipped_group"
    case skippedDisabled = "skipped_disabled"
    case skippedCooldown = "skipped_cooldown"
    case debounced
    case generated
    case sent
    case error

    var label: String {
        switch self {
        case .inbound: return "Inbound"
        case .skippedFromMe: return "Skip fromMe"
        case .skippedNotSelected: return "Skip (não selecionado)"
        case .skippedGroup: return "Skip grupo"
        case .skippedDisabled: return "Skip (kill switch)"
        case .skippedCooldown: return "Skip cooldown"
        case .debounced: return "Debounce"
        case .generated: return "Gerado"
        case .sent: return "Enviado"
        case .error: return "Erro"
        }
    }
}

struct PipelineActivity: Identifiable, Codable, Hashable, Sendable {
    var id: String
    var at: Double
    var kind: PipelineActivityKind
    var chatId: String
    var detail: String
    var messageId: String?
}
