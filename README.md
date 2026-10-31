# IAZAP

App nativo **macOS** (Apple Silicon) que conecta sua conta WhatsApp pessoal via WhatsApp Web (Baileys), deixa você escolher em quais chats ativar auto-reply, e (em fases posteriores) gera respostas locais em português com **Apple MLX**.

> **Aviso:** o bridge usa cliente WhatsApp Web não oficial. Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade.

## Status (Phase 1 scaffold)

| Camada | Estado |
|---|---|
| SwiftUI macOS (onboarding/QR stub, chats + toggles, status, settings) | ✅ skeleton |
| Node bridge + Baileys + JSON-RPC (Unix socket) | ✅ scaffolding |
| Protocolo compartilhado (`protocol/`) | ✅ v1 |
| Pipeline auto-send | ❌ ainda não |
| Inferência MLX | ❌ ainda não (Fase 3) |

Arquitetura completa: ver o plano do projeto (docs internos) — resumo: **SwiftUI + sidecar Node/Baileys + MLX on-device**.

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

MLX entra depois; não é necessário para rodar o scaffold da Phase 1.

## Como rodar no Mac

### 1. Bridge (Node)

```bash
cd bridge
npm install

# Smoke IPC sem falar com WhatsApp (QR stub + chats de exemplo)
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev

# Ou sessão Baileys real (emite qr.update; escaneie no telefone)
IAZAP_TOKEN=dev-token-change-me npm run dev
```

Socket padrão: `$TMPDIR/iazap-bridge.sock`  
Auth Baileys: `~/.iazap/baileys-auth`  
Detalhes: [`bridge/README.md`](bridge/README.md) · protocolo: [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md)

### 2. App (Xcode)

```bash
open IAZAP/IAZAP.xcodeproj
```

1. Selecione o scheme **IAZAP** (destino: My Mac).
2. Run (⌘R).
3. Em **Status** → *Conectar ao socket padrão* (com o bridge já rodando), ou informe a pasta `…/bridge` e use *Iniciar bridge (stub WA)*.

Telas Phase 1:

- **Parear** — placeholder do QR (`qr.update`)
- **Chats** — lista + toggles de auto-reply (persistidos no app)
- **Status** — IPC / sessão WA / placeholder MLX
- **Ajustes** — prompt PT-BR e tamanho de contexto (usados na Fase 3)

## IPC em uma frase

JSON-RPC 2.0, newline-delimited, sobre **Unix domain socket**. O app autentica com `session.hello` + token (`IAZAP_TOKEN`).

## Roadmap curto

1. **Phase 1 (este PR)** — scaffold UI + bridge + protocolo  
2. **Phase 2** — pareamento estável, lista real, receive/display texto  
3. **Phase 3** — pipeline (debounce, filtro, anti-loop) + send  
4. **Phase 4** — MLX (Qwen2.5 3B/7B 4-bit) + polimento

## Licença / uso

Projeto pessoal / experimental. Sem afiliação com Meta/WhatsApp.
