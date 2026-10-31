import SwiftUI

/// Parear screen — botchat-style state→UI: status + detail + one big QR (hidden when null).
struct OnboardingView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @EnvironmentObject private var store: AppStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Parear WhatsApp")
                    .font(.largeTitle.weight(.semibold))

                tosDisclaimer

                Text("Abra o WhatsApp no telefone → Aparelhos conectados → Conectar um aparelho, e escaneie o QR abaixo.")
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                statusBanner

                qrOrStateArea

                actionRow

                if let err = bridge.lastError, !err.isEmpty, bridge.qrPayload == nil {
                    Text(err)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                }

                if !store.tosRiskAccepted {
                    Text("Aceite o aviso de risco acima para habilitar o pareamento.")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }

                Text("Credenciais Baileys ficam locais em:\n\(bridge.authDirectoryPath)\nLogout apaga essa pasta. Inferência MLX é local (sem LLM na nuvem).")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            .padding(28)
        }
        .onAppear {
            Task {
                if !bridge.isConnected, !bridge.isBootstrapping {
                    await bridge.bootstrapOnLaunch()
                }
            }
        }
    }

    private var tosDisclaimer: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Risco WhatsApp / Termos de Uso", systemImage: "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            Text(
                "O IAZAP conecta sua conta via cliente WhatsApp Web não oficial (Baileys). " +
                "Isso pode violar os Termos de Serviço do WhatsApp/Meta e pode resultar em " +
                "banimento temporário ou permanente da conta, desafios de segurança ou quebra " +
                "do protocolo sem aviso. Não somos parceiros oficiais da Meta. Uso sob sua " +
                "responsabilidade — auto-reply só em chats que você selecionar."
            )
            .font(.callout)
            .fixedSize(horizontal: false, vertical: true)
            Toggle("Li e aceito o risco de uso não oficial", isOn: $store.tosRiskAccepted)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var statusBanner: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 10) {
                Circle()
                    .fill(bridge.sessionStatus.state.color)
                    .frame(width: 10, height: 10)
                Text(bridge.sessionStatus.state.label)
                    .font(.headline)
                if let me = bridge.sessionStatus.me {
                    Text("· \(me.name)")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(bridge.isConnected ? "IPC ok" : (bridge.isBootstrapping ? "Iniciando…" : "IPC offline"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if bridge.bridgeProcessRunning {
                    Text("· bridge filho")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Text(bridge.statusDetail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var qrOrStateArea: some View {
        if bridge.sessionStatus.state == .connected {
            connectedCard
        } else if let qr = bridge.qrPayload, !qr.isEmpty {
            // botchat: one big image; hide when null
            VStack(spacing: 16) {
                Text("Escaneie este QR")
                    .font(.headline)
                HStack {
                    Spacer(minLength: 0)
                    QRCodeImage(payload: qr, dimension: 320)
                    Spacer(minLength: 0)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity)
            .background(Color.primary.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        } else if bridge.isBootstrapping || bridge.sessionStatus.state == .connecting || bridge.sessionStatus.state == .qr {
            ProgressView(bridge.statusDetail.isEmpty ? "Aguardando QR…" : bridge.statusDetail)
                .frame(maxWidth: .infinity, minHeight: 200)
        } else if bridge.sessionStatus.state == .loggedOut {
            ContentUnavailableView(
                "Deslogado",
                systemImage: "rectangle.portrait.and.arrow.right",
                description: Text("Use “Gerar novo QR” para parear de novo.")
            )
            .frame(maxWidth: .infinity, minHeight: 180)
        } else {
            ContentUnavailableView(
                bridge.isConnected ? "Aguardando QR" : "Bridge offline",
                systemImage: "qrcode",
                description: Text(
                    bridge.isConnected
                        ? "O Baileys deve emitir o QR em instantes."
                        : "O app tenta iniciar o bridge automaticamente. Se falhar, use o botão abaixo."
                )
            )
            .frame(maxWidth: .infinity, minHeight: 180)
        }
    }

    private var connectedCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Sessão conectada", systemImage: "checkmark.seal.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.green)
            if let me = bridge.sessionStatus.me {
                Text("\(me.name)")
                Text(me.id)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            Text("Vá em Chats para ativar auto-reply por conversa.")
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.green.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private var actionRow: some View {
        HStack(spacing: 12) {
            Button(bridge.isConnected ? "Atualizar status" : "Iniciar bridge e gerar QR") {
                Task {
                    if bridge.isConnected {
                        await bridge.fetchStatus()
                    } else {
                        await bridge.restartBridge()
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!store.tosRiskAccepted && !bridge.isConnected)

            Button("Gerar novo QR") {
                Task { await bridge.reconnectSession() }
            }
            .disabled(!bridge.isConnected || !store.tosRiskAccepted)

            Button("Desconectar conta") {
                Task { await bridge.logoutSession() }
            }
            .disabled(!bridge.isConnected)

            if bridge.bridgeProcessRunning {
                Button("Reiniciar bridge") {
                    Task { await bridge.restartBridge() }
                }
            }
        }
    }
}
