import Foundation

struct MenuOption: Codable, Identifiable {
    var id = UUID().uuidString
    var titulo = ""
    var resposta = ""
    var ativo = true
    var numero = 1
    var cliques = 0
    var subopcoes: [MenuOption] = []
}
struct StaffMember: Codable, Identifiable {
    var id = UUID().uuidString
    var nome = ""
    var ativo = true
}
struct AutomationConfig: Codable {
    struct Notice: Codable { var ativo = false; var texto = "" }
    struct Office: Codable { var ativo = false; var inicio = "08:00"; var fim = "17:00"; var dias = [1,2,3,4,5] }
    struct Human: Codable { var ativo = true }
    struct Settings: Codable {
        var mensagemInicialAtiva = true
        var saudacao = "{saudacao}, {nome}!"
        var avisoGlobal = Notice()
        var expediente = Office()
        var atendimentoHumano = Human()
        var atendentes: [StaffMember] = []
    }
    var mode = "ai"
    var configuracoes = Settings()
    var opcoes: [MenuOption] = []
}
struct BroadcastParams: Encodable {
    let numeros: String
    let mensagem: String
    let consentimento: Bool
}
struct BroadcastResult: Decodable {
    struct Failure: Decodable { let numero: String; let erro: String }
    let enviados: Int
    let falhas: [Failure]
}

indirect enum JSONValue: Codable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([String: JSONValue].self) { self = .object(v) }
        else { self = .array(try c.decode([JSONValue].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
}
