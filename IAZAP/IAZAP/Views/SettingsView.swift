import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var bridge: BridgeClient

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
                Button("Restaurar prompt padrão") {
                    store.systemPromptPT = AppStore.defaultSystemPromptPT
                }
                Text("Enviado ao bridge via pipeline.configure e usado pelo MLX (stub ignora o texto).")
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

            Section("Modelo MLX") {
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
                    Text(bridge.modelStatus.backend)
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
                        Task { await bridge.configureModel(modelId: store.preferredModelId) }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Carregar / reload pesos") {
                        Task { await bridge.reloadModel() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Atualizar status") {
                        Task { await bridge.refreshModelStatus() }
                    }
                    .disabled(!bridge.isConnected)
                }
                Text("No Mac: rode `python server.py` em mlx-service (Metal). Sem serviço → fallback stub.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Aviso") {
                Text("IAZAP usa cliente WhatsApp Web não oficial (Baileys). Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade. Inferência é 100% local (sem API de LLM na nuvem).")
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
