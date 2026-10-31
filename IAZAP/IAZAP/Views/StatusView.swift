import SwiftUI

struct StatusView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore
    @State private var bridgeDirText = ""

    var body: some View {
        Form {
            Section("WhatsApp") {
                LabeledContent("IPC") {
                    Text(bridge.isConnected ? "conectado" : "offline")
                }
                LabeledContent("Sessão") {
                    HStack(spacing: 6) {
                        Circle()
                            .fill(bridge.sessionStatus.state.color)
                            .frame(width: 8, height: 8)
                        Text(bridge.sessionStatus.state.label)
                    }
                }
                if let me = bridge.sessionStatus.me {
                    LabeledContent("Conta") {
                        Text("\(me.name) (\(me.id))")
                            .textSelection(.enabled)
                    }
                }
                LabeledContent("Auto-reply JIDs") {
                    Text("\(store.selectedChatIDs.count)")
                }
                if let err = bridge.sessionStatus.lastError ?? bridge.lastError {
                    Text(err)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }

            Section("Credenciais (local)") {
                Text(bridge.authDirectoryPath)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Text("Arquivos Baileys (creds + keys). Apagados em Desconectar conta.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
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
                    Button("Iniciar bridge (WhatsApp real)") {
                        let url = bridgeDirectoryURL()
                        Task { await bridge.startBridgeAndConnect(bridgeDirectory: url, stubWhatsApp: false) }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Iniciar bridge (stub)") {
                        let url = bridgeDirectoryURL()
                        Task { await bridge.startBridgeAndConnect(bridgeDirectory: url, stubWhatsApp: true) }
                    }
                }
                HStack {
                    Button("Reconectar sessão") {
                        Task { await bridge.reconnectSession() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Desconectar conta (logout)") {
                        Task { await bridge.logoutSession() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Sincronizar seleção") {
                        Task { await bridge.syncSelectionToBridge() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Desconectar IPC") {
                        bridge.disconnect()
                    }
                }
                if bridge.bridgeProcessRunning {
                    Text("Processo Node do bridge em execução (filho do app).")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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

    private func bridgeDirectoryURL() -> URL {
        URL(
            fileURLWithPath: bridgeDirText.isEmpty ? defaultBridgeHint() : bridgeDirText,
            isDirectory: true
        )
    }

    private func defaultBridgeHint() -> String {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Developer/IAzap/bridge", isDirectory: true)
            .path
    }
}
