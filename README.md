# IAZAP

App nativo **macOS** (Apple Silicon) que conecta sua conta WhatsApp pessoal via WhatsApp Web (Baileys), deixa você escolher em quais chats ativar auto-reply, e (em fases posteriores) gera respostas locais em português com **Apple MLX**.

> **Aviso:** o bridge usa cliente WhatsApp Web não oficial. Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade.

## Status (Phase 3 — pipeline + send stub)

| Camada | Estado |
|---|---|
| SwiftUI macOS (QR, chats, status, kill switch, atividade) | ✅ Phase 3 |
| Node bridge + Baileys + JSON-RPC (Unix socket) | ✅ |
| Pipeline (filtro, debounce, cooldown, contexto SQLite, send) | ✅ stub engine |
| Protocolo compartilhado (`protocol/`) | ✅ v1 (+ pipeline) |
| Inferência MLX | ❌ ainda não (Fase 4) |

Arquitetura: **SwiftUI + sidecar Node/Baileys + pipeline local + MLX on-device** (MLX depois).

## Layout do repositório

```
IAZAP/                 # App SwiftUI (Xcode)
  IAZAP.xcodeproj/
  IAZAP/               # sources
bridge/                # Sidecar Node + Baileys + pipeline
protocol/              # JSON-RPC docs + types (TS; espelhado em Swift)
```

## Requisitos (Mac)

- **Apple Silicon** (alvo: M1 Pro / 16GB+)
- **macOS 14+** recomendado (mínimo razoável 13+)
- **Xcode 15+** com toolchain Swift
- **Node.js 22+** (usa `node:sqlite` para o store de contexto)

## Como rodar Phase 3 no Mac

### 1. Bridge (Node)

```bash
cd bridge
npm install

# Sessão Baileys real — pipeline envia via messages.send após stub
IAZAP_TOKEN=dev-token-change-me npm run dev

# Smoke IPC + pipeline sem WhatsApp (send fake local)
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev

# Testes unitários do pipeline / store / stub
npm test

# Smoke E2E IPC (sobe bridge stub, simula inbound, espera "sent")
npm run smoke:pipeline
```

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` (`messages.sqlite`) |
| `IAZAP_STUB_WA` | unset (Baileys real) |

**Credenciais WhatsApp** ficam só em `IAZAP_AUTH`. `session.logout` apaga o conteúdo. O histórico de contexto do pipeline fica em `IAZAP_DATA` (local).

Detalhes: [`bridge/README.md`](bridge/README.md) · protocolo: [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md)

### 2. App (Xcode)

```bash
open IAZAP/IAZAP.xcodeproj
```

1. Scheme **IAZAP** → destino **My Mac**.
2. Run (⌘R).
3. Em **Status**:
   - Com bridge já em `npm run dev`: *Conectar ao socket padrão* (token `dev-token-change-me`).
   - Ou informe a pasta `…/bridge` e use *Iniciar bridge (WhatsApp real)*.
4. Em **Parear**: escaneie o QR.
5. Em **Chats**: ative auto-reply só nos JIDs desejados.
6. Em **Status / Ajustes**: ligue o **kill switch global** (“Ativar auto-reply global”). Sem isso o pipeline só registra e ignora.
7. Receba uma mensagem de texto num chat selecionado → após debounce o stub responde em português e envia via Baileys.

Estados de sessão na UI: **desconectado / aguardando QR / conectando / conectado / deslogado / erro**, com **Reconectar** e **Desconectar conta (logout)**. Toolbar mostra `auto-reply on/off`.

## Pipeline em uma frase

Inbound Baileys → RPC + SQLite → filtra (`fromMe`, grupo, seleção, kill switch) → debounce → contexto → **StubReplyEngine** (PT-BR) → `messages.send`.

### Stub vs MLX (Fase 4)

No bridge, `ReplyEngine` é a interface:

- Phase 3: `StubReplyEngine` (`engineId: "stub"`) — placeholder PT-BR com preview do contexto.
- Phase 4: implementar p.ex. `MLXReplyEngine` com a mesma assinatura `generate(ReplyRequest)` e registrar no lugar do stub em `bridge/src/index.ts`. O app já mostra `engineId` e não precisa mudar o protocolo para a troca do motor.

## IPC em uma frase

JSON-RPC 2.0, newline-delimited, sobre **Unix domain socket**. O app autentica com `session.hello` + token (`IAZAP_TOKEN`). Métodos novos: `pipeline.*`.

## Roadmap curto

1. ~~Phase 1 — scaffold UI + bridge + protocolo~~  
2. ~~Phase 2 — pareamento QR real, lista de chats, toggles, reconnect/logout~~  
3. **Phase 3 (este PR)** — pipeline (debounce, filtro, anti-loop, contexto) + send stub  
4. **Phase 4** — MLX (Qwen2.5 3B/7B 4-bit) + polimento  

## Licença / uso

Projeto pessoal / experimental. Sem afiliação com Meta/WhatsApp.
