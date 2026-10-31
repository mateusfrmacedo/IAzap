import SwiftUI
import CoreImage
import CoreImage.CIFilterBuiltins
import AppKit

/// Renders a Baileys QR payload string as a scannable QR image via CoreImage.
struct QRCodeImage: View {
    let payload: String
    var dimension: CGFloat = 260

    var body: some View {
        Group {
            if let image = Self.makeImage(from: payload, dimension: dimension) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .frame(width: dimension, height: dimension)
                    .padding(12)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .accessibilityLabel("Código QR do WhatsApp")
            } else {
                Text("Não foi possível gerar a imagem QR.")
                    .foregroundStyle(.secondary)
            }
        }
    }

    static func makeImage(from string: String, dimension: CGFloat) -> NSImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }

        let scale = max(dimension / output.extent.width, 1)
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}
