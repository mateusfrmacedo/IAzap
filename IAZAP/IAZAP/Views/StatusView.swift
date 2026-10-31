import SwiftUI

struct StatusView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore
    @State private var bridgeDirText = ""

    var body: some View {
        Form {
            Section("WhatsApp bridge") {
                LabeledContent("IPC") {
                    Text(bridge.isConnected ? "conectado" : "offline")
                }
                LabeledContent("Sessão") {
                    Text(bridge.sessionStatus.state.label)
                }
                if let me = bridge.sessionStatus.me {
                    LabeledContent("Conta") {
                        Text("\(me.name) (\(me.id))")
                            .textSelection(.enabled)
                    }
                }
                if let err = bridge.sessionStatus.lastError ?? bridge.lastError {
                    Text(err)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }

            Section("Modelo MLX") {
                LabeledContent("Estado") {
                    Text("placeholder — Fase 3")
                        .foregroundStyle(.secondary)
                }
                Text("Inferência local com Qwen2.5 (3B/7B 4-bit) entra depois do pipeline de mensagens.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Conectar") {
                TextField("Pasta do bridge (…/IAzap/bridge)", text: $bridgeDirText)
                HStack {
                    Button("Conectar ao socket padrão") {
                        Task { await bridge.connect() }
                    }
                    Button("Iniciar bridge (stub WA)") {
                        let url = URL(
                            fileURLWithPath: bridgeDirText.isEmpty ? defaultBridgeHint() : bridgeDirText,
                            isDirectory: true
                        )
                        Task { await bridge.startBridgeAndConnect(bridgeDirectory: url, stubWhatsApp: true) }
                    }
                    Button("Desconectar") {
                        bridge.disconnect()
                    }
                }
            }

            Section("Mensagens recentes (inbound)") {
                if store.recentInbound.isEmpty {
                    Text("Nenhuma ainda.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.recentInbound.prefix(8)) { msg in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(msg.chatId)
                                .font(.caption.monospaced())
                            Text(msg.text)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .padding()
        .navigationTitle("Status")
        .onAppear {
            if bridgeDirText.isEmpty {
                bridgeDirText = defaultBridgeHint()
            }
        }
    }

    private func defaultBridgeHint() -> String {
        // Prefer sibling `bridge/` when the app is run from a repo checkout.
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Developer/IAzap/bridge", isDirectory: true)
            .path
    }
}
