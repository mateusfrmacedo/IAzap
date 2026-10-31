import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

struct Turn: Decodable { let role: String; let text: String }
struct Request: Decodable {
    let method: String
    let systemPrompt: String?
    let turns: [Turn]?
}

@main
struct AppleReplyHelper {
    static func main() async {
        do {
            let request = try JSONDecoder().decode(Request.self, from: FileHandle.standardInput.readDataToEndOfFile())
            #if canImport(FoundationModels)
            if #available(macOS 26.0, *) {
                try await respond(request)
                return
            }
            #endif
            write(["state": "unavailable", "error": "Apple Intelligence requer macOS 26 ou posterior."])
        } catch {
            write(["state": "error", "error": error.localizedDescription])
        }
    }

    #if canImport(FoundationModels)
    @available(macOS 26.0, *)
    static func respond(_ request: Request) async throws {
        let model = SystemLanguageModel.default
        switch model.availability {
        case .available: break
        case .unavailable(let reason):
            let message: String
            switch reason {
            case .appleIntelligenceNotEnabled: message = "Ative Apple Intelligence nos Ajustes do Sistema."
            case .deviceNotEligible: message = "Este Mac não é compatível com Apple Intelligence."
            case .modelNotReady: message = "O macOS ainda está preparando o modelo da Apple. Tente novamente em instantes."
            @unknown default: message = "Apple Intelligence indisponível: \(reason)."
            }
            write(["state": "unavailable", "error": message])
            return
        }
        if request.method == "status" {
            write(["state": "ready"])
            return
        }
        guard request.method == "generate", let turns = request.turns, !turns.isEmpty else {
            write(["state": "error", "error": "Pedido de geração inválido."])
            return
        }
        let session = LanguageModelSession(model: model, instructions: request.systemPrompt ?? "Responda em português do Brasil, de forma breve e natural.")
        // Each request gets its own session: context cannot leak between WhatsApp chats.
        // Keep a bounded recent history within the on-device model's context window.
        let history = turns.suffix(12).map { turn in
            "\(turn.role == "assistant" ? "Assistente" : "Contato"): \(String(turn.text.suffix(800)))"
        }.joined(separator: "\n")
        let prompt = "Responda à última mensagem do contato usando este histórico de conversa:\n\n\(history)"
        let response = try await session.respond(to: prompt, options: GenerationOptions(maximumResponseTokens: 192))
        write(["state": "ready", "text": response.content])
    }
    #endif

    static func write(_ value: [String: String]) {
        if let data = try? JSONSerialization.data(withJSONObject: value) {
            FileHandle.standardOutput.write(data + Data([0x0A]))
        }
    }
}
