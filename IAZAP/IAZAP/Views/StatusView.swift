import SwiftUI

struct StatusView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore
    @State private var bridgeDirText = ""

    var body: some View {
        Form {
            Section("Auto-reply (pipeline)") {
                Toggle("Ativar auto-reply global", isOn: Binding(
                    get: { store.autoReplyEnabled },
                    set: { newValue in
                        Task { await bridge.setGlobalAutoReplyEnabled(newValue) }
                    }
                ))
                .disabled(!bridge.isConnected)

                LabeledContent("Motor") {
                    Text(bridge.pipelineStatus.engineId)
                        .font(.body.monospaced())
                }
                LabeledContent("Fase") {
                    Text(bridge.pipelineStatus.phase.label)
                }
                LabeledContent("Pendentes") {
                    Text("\(bridge.pipelineStatus.pendingChats) chat(s)")
                }
                LabeledContent("Selecionados") {
                    Text("\(store.selectedChatIDs.count)")
                }
                if let err = bridge.pipelineStatus.lastError {
                    Text(err)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
                Text("Só responde em chats com toggle ligado · respostas em português.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

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
                if let err = bridge.sessionStatus.lastError ?? bridge.lastError {
                    Text(err)
                        .foregroundStyle(.red)
                        .font(.caption)
                }
            }

            Section("Credenciais / dados (local)") {
                Text("Auth: \(bridge.authDirectoryPath)")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Text("Data: \(bridge.dataDirectoryPath)")
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                Text("Auth = Baileys (apagado no logout). Data = SQLite de contexto do pipeline.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Section("Inteligência artificial") {
                LabeledContent("Estado") {
                    Text(bridge.modelStatus.state.label)
                }
                LabeledContent("Modelo") {
                    Text(bridge.modelStatus.modelLabel)
                }
                LabeledContent("Backend") {
                    Text("\(bridge.modelStatus.backend) · \(bridge.modelStatus.engineId)")
                        .font(.caption.monospaced())
                }
                Text(bridge.modelStatus.memoryNote)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if let err = bridge.modelStatus.lastError {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
                HStack {
                    Button("Atualizar modelo") {
                        Task { await bridge.refreshModelStatus() }
                    }
                    .disabled(!bridge.isConnected)
                    Button("Reload pesos") {
                        Task { await bridge.reloadModel() }
                    }
                    .disabled(!bridge.isConnected)
                }
            }

            Section("Conectar") {
                Text("Detalhe: \(bridge.statusDetail)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("Pasta do bridge (…/IAzap/bridge)", text: $bridgeDirText)
                HStack {
                    Button("Auto-iniciar (recomendado)") {
                        if let url = BridgeLocator.resolve() ?? optionalBridgeURL() {
                            BridgeLocator.remember(url)
                            bridgeDirText = url.path
                        }
                        Task { await bridge.restartBridge(stubWhatsApp: false) }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Conectar ao socket padrão") {
                        Task { await bridge.connect() }
                    }
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
                    Button("Sincronizar seleção + pipeline") {
                        Task {
                            await bridge.syncSelectionToBridge()
                            await bridge.syncPipelineConfigToBridge()
                        }
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
                if !bridge.bridgeDirectoryPath.isEmpty {
                    Text("Bridge: \(bridge.bridgeDirectoryPath)")
                        .font(.caption2.monospaced())
                        .textSelection(.enabled)
                }
            }

            Section("Atividade do pipeline") {
                if store.pipelineActivities.isEmpty {
                    Text("Nenhuma ainda. Ative o kill switch, selecione chats e receba mensagens.")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(store.pipelineActivities.prefix(12)) { act in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(act.kind.label)
                                    .font(.caption.weight(.semibold))
                                Spacer()
                                Text(act.chatId)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Text(act.detail)
                                .font(.caption)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 2)
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
                bridgeDirText = bridge.bridgeDirectoryPath.isEmpty
                    ? (BridgeLocator.resolve()?.path ?? defaultBridgeHint())
                    : bridge.bridgeDirectoryPath
            }
        }
    }

    private func bridgeDirectoryURL() -> URL {
        URL(
            fileURLWithPath: bridgeDirText.isEmpty ? defaultBridgeHint() : bridgeDirText,
            isDirectory: true
        )
    }

    private func optionalBridgeURL() -> URL? {
        let url = bridgeDirectoryURL()
        return BridgeLocator.isBridgePackage(url) ? url : nil
    }

    private func defaultBridgeHint() -> String {
        BridgeLocator.resolve()?.path
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Developer/IAzap/bridge", isDirectory: true)
                .path
    }
}
