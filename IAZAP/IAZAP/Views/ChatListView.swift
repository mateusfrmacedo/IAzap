import SwiftUI

struct ChatListView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore
    @State private var filterGroups = true
    @State private var query = ""

    private var visibleChats: [ChatSummary] {
        bridge.chats.filter { chat in
            if filterGroups && chat.isGroup { return false }
            if query.isEmpty { return true }
            let q = query.lowercased()
            return chat.name.lowercased().contains(q) || chat.id.lowercased().contains(q)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Chats")
                    .font(.largeTitle.weight(.semibold))
                Spacer()
                Toggle("Ocultar grupos", isOn: $filterGroups)
                    .toggleStyle(.checkbox)
                Button {
                    Task { await bridge.refreshChats() }
                } label: {
                    Label("Atualizar", systemImage: "arrow.clockwise")
                }
                .disabled(!bridge.isConnected)
            }
            .padding([.horizontal, .top], 28)
            .padding(.bottom, 12)

            Text("Ative auto-reply só nas conversas desejadas. Também é preciso ligar o kill switch global em Status/Ajustes.")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 28)
                .padding(.bottom, 8)

            TextField("Filtrar por nome ou JID", text: $query)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 28)
                .padding(.bottom, 16)

            if !bridge.isConnected {
                ContentUnavailableView(
                    "Bridge offline",
                    systemImage: "antenna.radiowaves.left.and.right",
                    description: Text("Conecte o bridge na tela Status (WhatsApp real) e pareie o QR.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if bridge.sessionStatus.state != .connected && bridge.chats.isEmpty {
                ContentUnavailableView(
                    "Aguardando sessão",
                    systemImage: "qrcode",
                    description: Text("Estado: \(bridge.sessionStatus.state.label). Escaneie o QR em Parear.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if visibleChats.isEmpty {
                ContentUnavailableView(
                    "Nenhum chat",
                    systemImage: "bubble.left",
                    description: Text("A lista preenche após o connect (eventos Baileys). Toque em Atualizar ou envie/receba uma mensagem.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(visibleChats) { chat in
                        HStack(alignment: .center, spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(chat.name)
                                        .font(.headline)
                                    if chat.isGroup {
                                        Text("grupo")
                                            .font(.caption2)
                                            .padding(.horizontal, 6)
                                            .padding(.vertical, 2)
                                            .background(Color.secondary.opacity(0.15))
                                            .clipShape(RoundedRectangle(cornerRadius: 4))
                                    }
                                }
                                if let preview = chat.lastMessagePreview {
                                    Text(preview)
                                        .font(.subheadline)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }
                                Text(chat.id)
                                    .font(.caption2.monospaced())
                                    .foregroundStyle(.tertiary)
                                    .textSelection(.enabled)
                            }
                            Spacer()
                            Toggle(
                                "Auto-reply",
                                isOn: Binding(
                                    get: { store.isAutoReplyEnabled(for: chat.id) },
                                    set: { newValue in
                                        Task { await bridge.setAutoReply(chatID: chat.id, enabled: newValue) }
                                    }
                                )
                            )
                            .labelsHidden()
                            .toggleStyle(.switch)
                            .help("Ativar auto-reply neste chat")
                        }
                        .padding(.vertical, 4)
                    }
                }
                .listStyle(.inset)
            }
        }
    }
}
