import Foundation
import Combine

/// Local selection store for chats enabled for auto-reply + pipeline prefs.
/// Selection source of truth: UserDefaults. Mirrored to the bridge via
/// `chats.syncSelection` / `chats.setAutoReply`. Global kill switch mirrored via `pipeline.setEnabled`.
@MainActor
final class AppStore: ObservableObject {
    private static let selectedKey = "iazap.selectedChatIDs"
    private static let systemPromptKey = "iazap.systemPrompt"
    private static let contextSizeKey = "iazap.contextSize"
    private static let autoReplyEnabledKey = "iazap.autoReplyEnabled"
    private static let debounceKey = "iazap.debounceMs"
    private static let cooldownKey = "iazap.cooldownMs"
    private static let modelIdKey = "iazap.modelId"
    private static let tosAcceptedKey = "iazap.tosRiskAccepted"

    static let defaultSystemPromptPT =
        """
        Você participa de uma conversa casual no WhatsApp. Responda em português do Brasil, de forma breve, espontânea e ligada à última mensagem.

        Não escreva como assistente, suporte, consultora ou atendimento. Nunca ofereça ajuda genérica nem envie frases como "Como posso ajudar hoje?", "Em que posso ajudar?", "Estou aqui para ajudar", "Se precisar de algo, é só chamar" ou "Posso ajudar em mais alguma coisa?". Se pedirem algo, responda diretamente, sem anunciar que está ajudando.

        Uma saudação recebe uma saudação simples. Um comentário recebe uma reação específica. Não transforme toda resposta em pergunta. Normalmente uma ou duas frases curtas bastam. Acompanhe o tom, o uso de minúsculas e a informalidade da conversa. Use humor ou carinho quando fizer sentido, sem intimidade forçada. Use emojis apenas se a outra pessoa usar, sem exagero.

        Não repita a mensagem, não faça apresentações, listas, preâmbulos ou despedidas automáticas. Não explique seu processo nem inclua tags ou nomes de ferramentas. Não invente fatos, lembranças, relações, disponibilidade ou compromissos. Se faltar um detalhe indispensável, faça uma pergunta curta. Se perguntarem sobre a automação, responda honestamente.

        Exemplos de tom, não respostas fixas: "oi" → "oii"; "agora entendi" → "boa!"; "hoje foi puxado" → "poxa, dia daqueles então". Não acrescente uma pergunta automática ao final.
        """

    static let defaultModelId = "qwen2.5-7b-instruct-4bit"

    @Published private(set) var selectedChatIDs: Set<String> {
        didSet { persistSelection() }
    }

    /// Global kill switch (default off — user must opt in).
    @Published var autoReplyEnabled: Bool {
        didSet { UserDefaults.standard.set(autoReplyEnabled, forKey: Self.autoReplyEnabledKey) }
    }

    @Published var systemPromptPT: String {
        didSet { UserDefaults.standard.set(systemPromptPT, forKey: Self.systemPromptKey) }
    }

    @Published var contextMessageCount: Int {
        didSet { UserDefaults.standard.set(contextMessageCount, forKey: Self.contextSizeKey) }
    }

    @Published var debounceMs: Int {
        didSet { UserDefaults.standard.set(debounceMs, forKey: Self.debounceKey) }
    }

    @Published var cooldownMs: Int {
        didSet { UserDefaults.standard.set(cooldownMs, forKey: Self.cooldownKey) }
    }

    /// Preferred MLX catalog model id (mirrored to bridge via model.configure / pipeline.configure).
    @Published var preferredModelId: String {
        didSet { UserDefaults.standard.set(preferredModelId, forKey: Self.modelIdKey) }
    }

    /// User acknowledged WhatsApp ToS / ban risk in onboarding.
    @Published var tosRiskAccepted: Bool {
        didSet { UserDefaults.standard.set(tosRiskAccepted, forKey: Self.tosAcceptedKey) }
    }

    /// Recent inbound messages for UI (bridge also persists to SQLite).
    @Published var recentInbound: [InboundMessage] = []

    /// Light pipeline activity log for Status UI.
    @Published var pipelineActivities: [PipelineActivity] = []

    init() {
        let saved = UserDefaults.standard.stringArray(forKey: Self.selectedKey) ?? []
        selectedChatIDs = Set(saved)
        autoReplyEnabled = UserDefaults.standard.bool(forKey: Self.autoReplyEnabledKey)
        systemPromptPT = UserDefaults.standard.string(forKey: Self.systemPromptKey)
            ?? Self.defaultSystemPromptPT
        let ctx = UserDefaults.standard.integer(forKey: Self.contextSizeKey)
        contextMessageCount = ctx > 0 ? ctx : 12
        let deb = UserDefaults.standard.integer(forKey: Self.debounceKey)
        debounceMs = UserDefaults.standard.object(forKey: Self.debounceKey) == nil ? 1000 : max(0, deb)
        let cool = UserDefaults.standard.integer(forKey: Self.cooldownKey)
        cooldownMs = UserDefaults.standard.object(forKey: Self.cooldownKey) == nil ? 0 : max(0, cool)
        preferredModelId = UserDefaults.standard.string(forKey: Self.modelIdKey) ?? Self.defaultModelId
        tosRiskAccepted = UserDefaults.standard.bool(forKey: Self.tosAcceptedKey)
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

    func recordPipelineActivity(_ activity: PipelineActivity) {
        pipelineActivities.insert(activity, at: 0)
        if pipelineActivities.count > 80 {
            pipelineActivities = Array(pipelineActivities.prefix(80))
        }
    }

    func replacePipelineActivities(_ activities: [PipelineActivity]) {
        pipelineActivities = Array(activities.prefix(80))
    }

    private func persistSelection() {
        UserDefaults.standard.set(Array(selectedChatIDs).sorted(), forKey: Self.selectedKey)
    }
}
