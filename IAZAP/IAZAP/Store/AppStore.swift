import Foundation
import Combine

/// Local selection store for chats enabled for auto-reply.
/// Source of truth: UserDefaults. Mirrored to the bridge via `chats.syncSelection` / `chats.setAutoReply`.
@MainActor
final class AppStore: ObservableObject {
    private static let selectedKey = "iazap.selectedChatIDs"
    private static let systemPromptKey = "iazap.systemPrompt"
    private static let contextSizeKey = "iazap.contextSize"

    @Published private(set) var selectedChatIDs: Set<String> {
        didSet { persistSelection() }
    }

    @Published var systemPromptPT: String {
        didSet { UserDefaults.standard.set(systemPromptPT, forKey: Self.systemPromptKey) }
    }

    @Published var contextMessageCount: Int {
        didSet { UserDefaults.standard.set(contextMessageCount, forKey: Self.contextSizeKey) }
    }

    /// Recent inbound messages for UI (not persisted yet).
    @Published var recentInbound: [InboundMessage] = []

    init() {
        let saved = UserDefaults.standard.stringArray(forKey: Self.selectedKey) ?? []
        selectedChatIDs = Set(saved)
        systemPromptPT = UserDefaults.standard.string(forKey: Self.systemPromptKey)
            ?? "Você é um assistente que responde no WhatsApp em português do Brasil. Seja breve e natural."
        let ctx = UserDefaults.standard.integer(forKey: Self.contextSizeKey)
        contextMessageCount = ctx > 0 ? ctx : 12
    }

    func isAutoReplyEnabled(for chatID: String) -> Bool {
        selectedChatIDs.contains(chatID)
    }

    func setAutoReply(chatID: String, enabled: Bool) {
        if enabled {
            selectedChatIDs.insert(chatID)
        } else {
            selectedChatIDs.remove(chatID)
        }
    }

    func recordInbound(_ message: InboundMessage) {
        recentInbound.insert(message, at: 0)
        if recentInbound.count > 100 {
            recentInbound = Array(recentInbound.prefix(100))
        }
    }

    private func persistSelection() {
        UserDefaults.standard.set(Array(selectedChatIDs).sorted(), forKey: Self.selectedKey)
    }
}
