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
                Text("Enviado ao bridge via pipeline.configure. Stub ignora o texto; MLX (Fase 4) usará.")
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

            Section("Motor de resposta") {
                Text("Atual: StubReplyEngine (PT-BR placeholder).")
                Text("Fase 4: implementar a mesma interface ReplyEngine com mlx-swift e registrar no bridge no lugar do stub.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Aviso") {
                Text("IAZAP usa cliente WhatsApp Web não oficial (Baileys). Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade.")
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
