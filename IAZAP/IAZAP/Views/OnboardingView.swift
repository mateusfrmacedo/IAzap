import SwiftUI

/// QR / pairing placeholder. Renders the raw Baileys QR string from `qr.update`.
/// Phase 1: textual placeholder; later swap for a real QRCode image (CoreImage).
struct OnboardingView: View {
    @EnvironmentObject private var bridge: BridgeClient

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            Text("Parear WhatsApp")
                .font(.largeTitle.weight(.semibold))

            Text("Escaneie o QR no WhatsApp do telefone (Aparelhos conectados). O bridge Baileys emite `qr.update` via JSON-RPC.")
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            Group {
                if let qr = bridge.qrPayload {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("QR recebido do bridge")
                            .font(.headline)
                        Text(qr)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .padding()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color.primary.opacity(0.06))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        Text("Phase 1: string bruta. Phase seguinte: imagem QRCode.")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                } else {
                    ContentUnavailableView(
                        "Sem QR",
                        systemImage: "qrcode",
                        description: Text("Conecte o bridge (Status) ou inicie `npm run dev` no sidecar.")
                    )
                    .frame(maxWidth: .infinity, minHeight: 220)
                }
            }

            HStack {
                Button("Conectar ao bridge") {
                    Task { await bridge.connect() }
                }
                .buttonStyle(.borderedProminent)

                Button("Atualizar status") {
                    Task { await bridge.connect() }
                }
                .disabled(!bridge.isConnected)
            }

            Spacer()
        }
        .padding(28)
    }
}
