import SwiftUI

/// QR / multi-device pairing. Renders Baileys `qr.update` payload as a CoreImage QR.
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

                Group {
                    switch bridge.sessionStatus.state {
                    case .connected:
                        connectedCard
                    case .qr:
                        qrCard
                    case .connecting:
                        ProgressView("Conectando ao WhatsApp…")
                            .frame(maxWidth: .infinity, minHeight: 180)
                    case .loggedOut:
                        ContentUnavailableView(
                            "Deslogado",
                            systemImage: "rectangle.portrait.and.arrow.right",
                            description: Text("Use Reconectar para gerar um novo QR.")
                        )
                        .frame(maxWidth: .infinity, minHeight: 180)
                    default:
                        if let qr = bridge.qrPayload {
                            qrCardContent(qr)
                        } else {
                            ContentUnavailableView(
                                "Sem QR",
                                systemImage: "qrcode",
                                description: Text("Conecte o bridge na tela Status (sessão real Baileys) e aguarde o QR.")
                            )
                            .frame(maxWidth: .infinity, minHeight: 180)
                        }
                    }
                }

                HStack(spacing: 12) {
                    Button("Conectar ao bridge") {
                        Task { await bridge.connect() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!store.tosRiskAccepted)

                    Button("Reconectar") {
                        Task { await bridge.reconnectSession() }
                    }
                    .disabled(!bridge.isConnected || !store.tosRiskAccepted)

                    Button("Desconectar conta") {
                        Task { await bridge.logoutSession() }
                    }
                    .disabled(!bridge.isConnected)

                    Button("Atualizar status") {
                        Task { await bridge.fetchStatus() }
                    }
                    .disabled(!bridge.isConnected)
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
            Text(bridge.isConnected ? "IPC ok" : "IPC offline")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(Color.primary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 8))
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

    @ViewBuilder
    private var qrCard: some View {
        if let qr = bridge.qrPayload {
            qrCardContent(qr)
        } else {
            ProgressView("Aguardando QR do Baileys…")
                .frame(maxWidth: .infinity, minHeight: 180)
        }
    }

    private func qrCardContent(_ qr: String) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Escaneie este QR")
                .font(.headline)
            HStack {
                Spacer(minLength: 0)
                QRCodeImage(payload: qr, dimension: 280)
                Spacer(minLength: 0)
            }
            DisclosureGroup("Payload bruto (debug)") {
                Text(qr)
                    .font(.system(.caption2, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(.top, 4)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}
