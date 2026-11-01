import SwiftUI
import UniformTypeIdentifiers

struct AutomationView: View {
    @EnvironmentObject private var bridge: BridgeClient
    @State private var config = AutomationConfig()
    @State private var loaded = false
    @State private var busy = false
    @State private var feedback = ""
    @State private var importing = false
    @State private var recipients = ""
    @State private var message = ""
    @State private var consent = false
    @State private var confirmSend = false
    @State private var sending = false
    @State private var broadcastFeedback = ""

    var body: some View {
        Form {
            Section {
                Picker("Modo de resposta", selection: $config.mode) {
                    Text("Inteligência artificial").tag("ai")
                    Text("Menu programado").tag("menu")
                    Text("Menu + IA para texto livre").tag("hybrid")
                }
                Text("Ative o auto-reply global e selecione as conversas em Chats. Menus e IA usam a mesma conta do WhatsApp.")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("Salvar atendimento") { Task { await save() } }.buttonStyle(.borderedProminent)
                    Button("Importar do BotChat…") { importing = true }
                    Button("Recarregar") { Task { await load() } }
                    if busy { ProgressView().controlSize(.small) }
                }.disabled(busy || !loaded)
                if !feedback.isEmpty { Text(feedback).textSelection(.enabled) }
            } header: { Text("Atendimento") }
            Section("Saudação e avisos") {
                Toggle("Enviar saudação na primeira mensagem", isOn: $config.configuracoes.mensagemInicialAtiva)
                TextField("Saudação", text: $config.configuracoes.saudacao)
                Text("Use {saudacao} e {nome} para personalizar.").font(.caption).foregroundStyle(.secondary)
                Toggle("Mostrar aviso global", isOn: $config.configuracoes.avisoGlobal.ativo)
                TextField("Aviso", text: $config.configuracoes.avisoGlobal.texto, axis: .vertical)
            }
            Section("Expediente dos menus") {
                Toggle("Restringir atendimento ao expediente", isOn: $config.configuracoes.expediente.ativo)
                HStack {
                    TextField("Início (HH:mm)", text: $config.configuracoes.expediente.inicio)
                    TextField("Fim (HH:mm)", text: $config.configuracoes.expediente.fim)
                }
                HStack {
                    ForEach(0..<7) { day in
                        Toggle(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"][day], isOn: Binding(
                            get: { config.configuracoes.expediente.dias.contains(day) },
                            set: { enabled in
                                config.configuracoes.expediente.dias.removeAll { $0 == day }
                                if enabled { config.configuracoes.expediente.dias.append(day) }
                            }
                        )).toggleStyle(.button)
                    }
                }
                Text("Horários seguem o fuso do Mac. Um período como 22:00–06:00 termina no dia seguinte.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Respostas programadas") {
                if config.opcoes.isEmpty { Text("Adicione as opções que aparecerão no menu do WhatsApp.").foregroundStyle(.secondary) }
                ForEach($config.opcoes) { $option in
                    DisclosureGroup(option.titulo.isEmpty ? "Nova resposta" : option.titulo) {
                        Toggle("Ativa", isOn: $option.ativo)
                        TextField("Título", text: $option.titulo)
                        TextField("Resposta", text: $option.resposta, axis: .vertical)
                        Stepper("Ordem: \(option.numero)", value: $option.numero, in: 1...100)
                        Text("\(option.cliques) seleções").font(.caption).foregroundStyle(.secondary)
                        ForEach($option.subopcoes) { $sub in
                            VStack(alignment: .leading) {
                                Toggle("Sub-resposta ativa", isOn: $sub.ativo)
                                TextField("Título da sub-resposta", text: $sub.titulo)
                                TextField("Texto da sub-resposta", text: $sub.resposta, axis: .vertical)
                                Button("Excluir sub-resposta", role: .destructive) { option.subopcoes.removeAll { $0.id == sub.id } }
                            }.padding(.leading)
                        }
                        Button("Adicionar sub-resposta") { option.subopcoes.append(MenuOption(numero: option.subopcoes.count+1)) }
                        Button("Excluir resposta", role: .destructive) { config.opcoes.removeAll { $0.id == option.id } }
                    }
                }
                Button("Adicionar resposta") { config.opcoes.append(MenuOption(numero: (config.opcoes.map(\.numero).max() ?? 0)+1)) }
            }
            Section("Atendimento humano") {
                Toggle("Exibir opção de atendimento humano", isOn: $config.configuracoes.atendimentoHumano.ativo)
                ForEach($config.configuracoes.atendentes) { $staff in
                    HStack {
                        Toggle("Ativo", isOn: $staff.ativo).labelsHidden()
                        TextField("Nome do atendente", text: $staff.nome)
                        Button("Excluir", role: .destructive) { config.configuracoes.atendentes.removeAll { $0.id == staff.id } }
                    }
                }
                Button("Adicionar atendente") { config.configuracoes.atendentes.append(StaffMember()) }
                Text("Ao escolher um atendente, a conversa fica pausada até você enviar !encerrar no WhatsApp. Uma mensagem manual pausa menus e IA por 30 minutos sem interação.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section("Comunicados") {
                TextField("Números com DDD, um por linha (máximo 30)", text: $recipients, axis: .vertical).lineLimit(3...5)
                TextField("Mensagem", text: $message, axis: .vertical).lineLimit(3...8)
                Toggle("Os contatos autorizaram o recebimento", isOn: $consent)
                Button(sending ? "Enviando…" : "Revisar envio…") { confirmSend = true }
                    .disabled(sending || !consent || recipients.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if !broadcastFeedback.isEmpty { Text(broadcastFeedback).textSelection(.enabled) }
            }
        }
        .formStyle(.grouped)
        .navigationTitle("Atendimento")
        .task { await load() }
        .disabled(!loaded)
        .overlay { if !loaded { VStack { ProgressView(); Text(feedback); Button("Tentar novamente") { Task { await load() } } }.padding() } }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            Task {
                do {
                    let url = try result.get()
                    let granted = url.startAccessingSecurityScopedResource()
                    defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let data = try Data(contentsOf: url)
                    // Import is saved only by the explicit Save action, after review.
                    config = try await bridge.previewAutomationImport(data)
                    feedback = "Importação carregada. Revise os dados e clique em Salvar atendimento."
                } catch { feedback = error.localizedDescription }
            }
        }
        .alert("Enviar comunicado?", isPresented: $confirmSend) {
            Button("Cancelar", role: .cancel) {}
            Button("Enviar") { Task { await broadcast() } }
        } message: { Text("\(recipients)\n\n\(message)\n\nO envio pausará as respostas automáticas nesses contatos por 30 minutos.") }
    }
    private func load() async {
        busy = true
        defer { busy = false }
        do { config = try await bridge.getAutomation(); loaded = true; feedback = "" }
        catch { feedback = error.localizedDescription }
    }
    private func save() async {
        busy = true
        defer { busy = false }
        do { config = try await bridge.saveAutomation(config); feedback = "Atendimento salvo e aplicado." }
        catch { feedback = error.localizedDescription }
    }
    private func broadcast() async {
        sending = true
        defer { sending = false }
        do {
            let result = try await bridge.sendBroadcast(BroadcastParams(numeros: recipients, mensagem: message, consentimento: consent))
            broadcastFeedback = "Enviados: \(result.enviados). Falhas: \(result.falhas.count)." + result.falhas.map { "\n\($0.numero): \($0.erro)" }.joined()
            consent = false
        } catch { broadcastFeedback = error.localizedDescription }
    }
}
