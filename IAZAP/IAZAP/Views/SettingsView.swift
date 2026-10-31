import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Form {
            Section("Auto-reply") {
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
                Text("Usado na Fase 3 (MLX). Editável já agora.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Contexto") {
                Stepper(value: $store.contextMessageCount, in: 4...40) {
                    Text("Mensagens de contexto: \(store.contextMessageCount)")
                }
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
