# IAZAP

App nativo **macOS** (Apple Silicon) que conecta sua conta WhatsApp pessoal via WhatsApp Web (Baileys), deixa você escolher em quais chats ativar auto-reply, e gera respostas **locais** em português com **Apple MLX** (Qwen2.5 4-bit).

> **Aviso:** o bridge usa cliente WhatsApp Web não oficial. Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade. Sem afiliação com Meta/WhatsApp. Inferência **não** usa APIs de LLM na nuvem.

## Status (Phase 4 — MLX local + polish)

| Camada | Estado |
|---|---|
| SwiftUI macOS (QR, ToS onboarding, chats, status, modelo, kill switch) | ✅ Phase 4 |
| Node bridge + Baileys + JSON-RPC (Unix socket) | ✅ |
| Pipeline (filtro, debounce, cooldown, contexto SQLite, send) | ✅ |
| `mlx-service` (Python + mlx-lm) + `ManagedReplyEngine` | ✅ Mac real / stub fallback |
| Protocolo compartilhado (`protocol/`) | ✅ v1 (+ pipeline + model) |

Arquitetura: **SwiftUI + sidecar Node/Baileys + pipeline local + mlx-service (mlx-lm) on-device**.

## Layout do repositório

```
IAZAP/                 # App SwiftUI (Xcode)
bridge/                # Sidecar Node + Baileys + pipeline + MLX client
mlx-service/           # Helper HTTP local (mlx-lm) — Apple Silicon
protocol/              # JSON-RPC docs + types (TS; espelhado em Swift)
```

## Requisitos (Mac M1 Pro)

- **Apple Silicon** (alvo: M1 Pro / 16GB+)
- **macOS 14+** recomendado
- **Xcode 15+**
- **Node.js 22+** (`node:sqlite`)
- **Python 3.10+** com venv para `mlx-service` (Metal)

### Memória (modelo)

| Modelo | Id | Nota M1 Pro 16GB |
|---|---|---|
| **Qwen2.5-7B Instruct 4-bit** (default) | `qwen2.5-7b-instruct-4bit` | Melhor PT-BR; feche apps pesados |
| Qwen2.5-3B Instruct 4-bit | `qwen2.5-3b-instruct-4bit` | Fallback se houver pressão de RAM |

## Como rodar no Mac

### 1. MLX service (inferência)

```bash
cd mlx-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Opcional: pré-baixar pesos (precisa rede + ~4–8GB disco)
python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen2.5-7B-Instruct-4bit')"
# ou o 3B:
# python -c "from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen2.5-3B-Instruct-4bit')"

IAZAP_MLX_AUTOLOAD=1 python server.py
# escuta http://127.0.0.1:8742
```

Detalhes: [`mlx-service/README.md`](mlx-service/README.md).

### 2. Bridge (Node)

```bash
cd bridge
npm install

# Motor: auto (MLX se o serviço estiver up; senão stub)
IAZAP_TOKEN=dev-token-change-me npm run dev

# Forçar stub (sem mlx-service)
IAZAP_ENGINE=stub IAZAP_TOKEN=dev-token-change-me npm run dev

# Smoke IPC + pipeline sem WhatsApp
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev

npm test
npm run smoke:pipeline
```

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` |
| `IAZAP_STUB_WA` | unset |
| `IAZAP_ENGINE` | `auto` (`mlx` \| `stub` \| `auto`) |
| `IAZAP_MLX_URL` | `http://127.0.0.1:8742` |
| `IAZAP_MLX_MODEL` | `qwen2.5-7b-instruct-4bit` |

**Logout** (`session.logout` / UI) apaga só `IAZAP_AUTH`. Contexto SQLite fica em `IAZAP_DATA`.

### 3. App (Xcode)

```bash
open IAZAP/IAZAP.xcodeproj
```

1. Scheme **IAZAP** → **My Mac** → Run.
2. Em **Parear**: aceite o aviso de risco ToS, conecte o bridge, escaneie o QR.
3. Em **Chats**: ligue auto-reply só nos JIDs desejados.
4. Em **Ajustes / Status**: escolha o modelo, **Carregar / reload pesos**, ligue o kill switch global.
5. Receba texto num chat selecionado → debounce → MLX (ou stub) → envio via Baileys.

## Stub vs MLX

| | Stub | MLX |
|---|---|---|
| Quando | `IAZAP_ENGINE=stub`, ou `auto` sem mlx-service | mlx-service up no Mac (Metal) |
| `engineId` | `stub` | `mlx:qwen2.5-…` (ou `mlx-mock:…` com `IAZAP_MLX_MOCK=1`) |
| Qualidade | Placeholder PT-BR | Qwen2.5 instruct local |
| CI / Linux VM | ✅ | Mock HTTP ou fallback stub (sem Metal) |

Fluxo: inbound → filtro (seleção + kill switch) → contexto → **`ManagedReplyEngine`** → `messages.send`.

## IPC

JSON-RPC 2.0, newline-delimited, Unix socket. Métodos: sessão, chats, `pipeline.*`, `model.*`. Ver [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).

## Roadmap

1. ~~Phase 1 — scaffold~~  
2. ~~Phase 2 — QR / chats~~  
3. ~~Phase 3 — pipeline + stub~~  
4. **Phase 4 (este PR)** — MLX local + UI de modelo + ToS + docs  

## Licença / uso

Projeto pessoal / experimental. Sem afiliação com Meta/WhatsApp.
