# IAZAP

App nativo **macOS** (Apple Silicon) que conecta sua conta WhatsApp pessoal via WhatsApp Web (Baileys), deixa você escolher em quais chats ativar auto-reply, e (em fases posteriores) gera respostas locais em português com **Apple MLX**.

> **Aviso:** o bridge usa cliente WhatsApp Web não oficial. Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade.

## Status (Phase 2 — pareamento + chats)

| Camada | Estado |
|---|---|
| SwiftUI macOS (QR imagem, chats + toggles, status, reconnect/logout) | ✅ Phase 2 |
| Node bridge + Baileys + JSON-RPC (Unix socket) | ✅ real pairing |
| Protocolo compartilhado (`protocol/`) | ✅ v1 (+ reconnect/logout/sync) |
| Pipeline auto-send | ❌ ainda não (Fase 3) |
| Inferência MLX | ❌ ainda não (Fase 4) |

Arquitetura: **SwiftUI + sidecar Node/Baileys + MLX on-device** (MLX depois).

## Layout do repositório

```
IAZAP/                 # App SwiftUI (Xcode)
  IAZAP.xcodeproj/
  IAZAP/               # sources
bridge/                # Sidecar Node + Baileys
protocol/              # JSON-RPC docs + types (TS; espelhado em Swift)
```

## Requisitos (Mac)

- **Apple Silicon** (alvo: M1 Pro / 16GB+)
- **macOS 14+** recomendado (mínimo razoável 13+)
- **Xcode 15+** com toolchain Swift
- **Node.js 20+** (LTS)

## Como rodar Phase 2 no Mac

### 1. Bridge (Node)

```bash
cd bridge
npm install

# Sessão Baileys real — emite qr.update; escaneie no telefone
IAZAP_TOKEN=dev-token-change-me npm run dev

# Smoke IPC sem falar com WhatsApp (QR stub + chats de exemplo)
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev
```

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` |
| `IAZAP_STUB_WA` | unset (Baileys real) |

**Credenciais WhatsApp** ficam só nessa pasta local (`IAZAP_AUTH`). `session.logout` no app apaga o conteúdo. Não sincronize essa pasta (iCloud/backup) se quiser isolar a sessão.

Detalhes: [`bridge/README.md`](bridge/README.md) · protocolo: [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md)

### 2. App (Xcode)

```bash
open IAZAP/IAZAP.xcodeproj
```

1. Scheme **IAZAP** → destino **My Mac**.
2. Run (⌘R).
3. Em **Status**:
   - Com bridge já em `npm run dev`: *Conectar ao socket padrão* (token `dev-token-change-me`).
   - Ou informe a pasta `…/bridge` e use *Iniciar bridge (WhatsApp real)* (o app mint o token e aponta `IAZAP_AUTH` para Application Support).
4. Em **Parear**: escaneie o QR (imagem gerada via CoreImage a partir do payload Baileys).
5. Em **Chats**: lista real após `connected`; toggles de auto-reply persistem em UserDefaults e são espelhados no bridge (`chats.setAutoReply` / `chats.syncSelection`).

Estados de sessão na UI: **desconectado / aguardando QR / conectando / conectado / deslogado / erro**, com **Reconectar** e **Desconectar conta (logout)**.

## IPC em uma frase

JSON-RPC 2.0, newline-delimited, sobre **Unix domain socket**. O app autentica com `session.hello` + token (`IAZAP_TOKEN`).

## Roadmap curto

1. ~~Phase 1 — scaffold UI + bridge + protocolo~~  
2. **Phase 2 (este PR)** — pareamento QR real, lista de chats, toggles, reconnect/logout  
3. **Phase 3** — pipeline (debounce, filtro, anti-loop) + send  
4. **Phase 4** — MLX (Qwen2.5 3B/7B 4-bit) + polimento  

## Licença / uso

Projeto pessoal / experimental. Sem afiliação com Meta/WhatsApp.
