import SwiftUI

struct ChatListView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("Chats")
                    .font(.largeTitle.weight(.semibold))
                Spacer()
                Button {
                    Task { await bridge.refreshChats() }
                } label: {
                    Label("Atualizar", systemImage: "arrow.clockwise")
                }
                .disabled(!bridge.isConnected)
            }
            .padding([.horizontal, .top], 28)
            .padding(.bottom, 12)

            Text("Ative auto-reply só nas conversas desejadas. Respostas serão em português (pipeline + MLX em fases posteriores).")
                .foregroundStyle(.secondary)
                .padding(.horizontal, 28)
                .padding(.bottom, 16)

            if bridge.chats.isEmpty {
                ContentUnavailableView(
                    "Nenhum chat",
                    systemImage: "bubble.left",
                    description: Text(bridge.isConnected
                        ? "Aguardando chats do Baileys (ou use IAZAP_STUB_WA=1 para dados de exemplo)."
                        : "Conecte o bridge primeiro na tela Status.")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(bridge.chats) { chat in
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
                        }
                        .padding(.vertical, 4)
                    }
                }
                .listStyle(.inset)
            }
        }
    }
}
