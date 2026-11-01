import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var bridge: BridgeClient
    @State private var isApplyingModel = false

    var body: some View {
        Form {
            Section("Auto-reply") {
                Toggle("Kill switch global", isOn: Binding(
                    get: { store.autoReplyEnabled },
                    set: { newValue in
                        Task { await bridge.setGlobalAutoReplyEnabled(newValue) }
                    }
                ))
                Text("Chats selecionados: \(store.selectedChatIDs.count)")
                if store.selectedChatIDs.isEmpty {
                    Text("Nenhum chat com auto-reply.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.selectedChatIDs.sorted(), id: \.self) { id in
                        Text(id)
                            .font(.caption.monospaced())
                            .textSelection(.enabled)
                    }
                }
            }

            Section("Prompt (PT-BR)") {
                TextEditor(text: $store.systemPromptPT)
                    .font(.body)
                    .frame(minHeight: 100)
                HStack {
                    Button("Aplicar prompt agora") {
                        Task { await bridge.applySystemPrompt(store.systemPromptPT) }
                    }
                    .disabled(!bridge.isConnected || bridge.isApplyingPrompt || store.systemPromptPT.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Restaurar prompt padrão") {
                        store.systemPromptPT = AppStore.defaultSystemPromptPT
                    }
                }
                if store.systemPromptPT.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Text("Prompt vazio: o último aplicado continua ativo.")
                        .foregroundStyle(.secondary)
                } else if bridge.isApplyingPrompt {
                    ProgressView("Aplicando prompt…")
                } else if bridge.isPromptApplied(store.systemPromptPT) {
                    Label("Prompt ativo nas próximas respostas", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                } else if let error = bridge.promptApplyError {
                    Text(error).foregroundStyle(.red)
                } else {
                    Text(bridge.isConnected ? "Salvo no Mac. A aplicação automática ocorre após uma pausa na edição." : "Salvo no Mac. Será aplicado ao conectar.")
                        .foregroundStyle(.secondary)
                }
                Text("As edições são aplicadas automaticamente. O perfil atual tem prioridade sobre respostas antigas; regras explícitas, como não usar emoji, prevalecem sobre o estilo geral.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Pipeline") {
                Stepper(value: $store.contextMessageCount, in: 4...40) {
                    Text("Mensagens de contexto: \(store.contextMessageCount)")
                }
                Stepper(value: $store.debounceMs, in: 500...10_000, step: 500) {
                    Text("Debounce: \(store.debounceMs) ms")
                }
                Stepper(value: $store.cooldownMs, in: 0...120_000, step: 1000) {
                    Text("Cooldown por chat: \(store.cooldownMs) ms")
                }
                Button("Aplicar no bridge") {
                    Task { await bridge.syncPipelineConfigToBridge() }
                }
                .disabled(!bridge.isConnected)
            }

            Section("Inteligência artificial") {
                Picker("Modelo", selection: $store.preferredModelId) {
                    ForEach(bridge.modelStatus.availableModels) { model in
                        Text(model.label).tag(model.id)
                    }
                }
                .disabled(!bridge.isConnected)

                LabeledContent("Estado") {
                    Text(bridge.modelStatus.state.label)
                }
                LabeledContent("Backend") {
                    Text(bridge.modelStatus.backend == "apple" ? "Apple Intelligence" : bridge.modelStatus.backend == "mlx" ? "Qwen / MLX" : "Demonstração")
                        .font(.body.monospaced())
                }
                LabeledContent("engineId") {
                    Text(bridge.modelStatus.engineId)
                        .font(.caption.monospaced())
                }
                if let url = bridge.modelStatus.serviceUrl {
                    Text("Serviço: \(url)")
                        .font(.caption.monospaced())
                        .textSelection(.enabled)
                }
                Text(bridge.modelStatus.memoryNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let err = bridge.modelStatus.lastError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                HStack {
                    Button("Aplicar modelo") {
                        isApplyingModel = true
                        let modelId = store.preferredModelId
                        Task {
                            await bridge.configureModel(modelId: modelId)
                            isApplyingModel = false
                        }
                    }
                    .disabled(!bridge.isConnected || isApplyingModel)
                    Button(store.preferredModelId == "apple-intelligence" ? "Verificar disponibilidade" : "Carregar modelo") {
                        Task { await bridge.reloadModel() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Atualizar status") {
                        Task { await bridge.refreshModelStatus() }
                    }
                    .disabled(!bridge.isConnected)
                }
                Text("Escolha o modelo e clique em Aplicar modelo para alternar. Apple Intelligence usa o modelo do macOS; Qwen usa o serviço MLX local.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Aviso") {
                Text("ZapIA usa cliente WhatsApp Web não oficial (Baileys). Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade. Inferência é 100% local (sem API de LLM na nuvem).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .padding()
        .frame(minWidth: 420, minHeight: 320)
        .navigationTitle("Ajustes")
    }
}
