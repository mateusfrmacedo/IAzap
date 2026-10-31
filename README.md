# IAZAP

App nativo **macOS** (Apple Silicon) que conecta sua conta WhatsApp pessoal via WhatsApp Web (Baileys), deixa você escolher em quais chats ativar auto-reply, e gera respostas **locais** em português com **Apple MLX** (Qwen2.5 4-bit).

> **Aviso:** o bridge usa cliente WhatsApp Web não oficial. Isso pode violar os Termos do WhatsApp/Meta e há risco de banimento da conta. Uso sob sua responsabilidade. Sem afiliação com Meta/WhatsApp. Inferência **não** usa APIs de LLM na nuvem.

## Começar em 3 passos (QR no app)

No Mac (Apple Silicon), a partir da raiz do repo:

```bash
git pull
./scripts/run-mac.sh
```

Ou só Xcode:

```bash
cd bridge && npm install && cd ..
open IAZAP/IAZAP.xcodeproj
```

1. Scheme **IAZAP** → destino **My Mac** → **Run** (▶).
2. Em **Parear**: aceite o aviso de risco ToS.
3. O app **inicia o bridge Node sozinho** (sem Terminal separado), escuta `$TMPDIR/iazap-bridge.sock` com `IAZAP_TOKEN=dev-token-change-me`, e mostra o **QR grande** assim que o Baileys emitir `qr.update`.
4. No telefone: WhatsApp → Aparelhos conectados → Conectar um aparelho → escaneie.
5. Status vira **Conectado**; o QR some (mesmo contrato visual do BotChat).

Não precisa abrir outro Terminal para o bridge. Se o bridge já estiver rodando (`npm run serve`), o app só conecta no socket.

## App instalável (Apple Silicon)

Para gerar um `.dmg` (arrastar para Aplicativos) e um `.zip`:

```bash
./scripts/package-mac.sh
# Saída: dist-mac/IAZAP-apple-silicon.dmg e .zip
```

O pacote inclui Node e o bridge compilado com dependências de produção. O usuário
não precisa de Xcode, Node, npm ou do checkout para parear o WhatsApp. O bridge
usa os recursos do próprio app e grava seus logs em `IAZAP_DATA/bridge.log`.
Requer macOS 14+ e Apple Silicon.

Esta versão de teste usa assinatura ad-hoc. Distribuição pública sem alertas do
Gatekeeper ainda exige um certificado **Developer ID Application** e notarização
Apple; esses passos não são executados pelo script. A inferência MLX e os pesos
continuam opcionais e exigem a configuração descrita abaixo. Sem o serviço,
o motor retorna mensagens de demonstração identificadas como stub.

### Verificação

```bash
cd bridge
npm ci
npm run build
npm test
npm run smoke:pipeline
cd ..
python3 -m unittest discover -s mlx-service -v
./scripts/smoke-bootstrap.sh
# Depois de empacotar:
./scripts/smoke-package.sh
```

O teste nativo usa WhatsApp simulado e diretórios temporários; não pareia contas.
O bridge conserva o QR mais recente e o reenvia após `session.hello`, inclusive
quando o cliente conecta depois da geração do código.

## Status

| Camada | Estado |
|---|---|
| SwiftUI macOS (Parear QR in-app, auto-bridge, ToS, chats, status, modelo) | ✅ |
| Node bridge + Baileys + JSON-RPC (Unix socket) | ✅ |
| Pipeline (filtro, debounce, cooldown, contexto SQLite, send) | ✅ |
| `mlx-service` (Python + mlx-lm) + `ManagedReplyEngine` | ✅ Mac real / stub fallback |
| Protocolo compartilhado (`protocol/`) | ✅ v1 (+ pipeline + model) |
| App icon (Assets AppIcon) | ✅ |

Arquitetura: **SwiftUI + sidecar Node/Baileys (filho do app) + pipeline local + mlx-service (mlx-lm) on-device**.

## Layout do repositório

```
IAZAP/                 # App SwiftUI (Xcode)
bridge/                # Sidecar Node + Baileys + pipeline + MLX client
mlx-service/           # Helper HTTP local (mlx-lm) — Apple Silicon
protocol/              # JSON-RPC docs + types (TS; espelhado em Swift)
scripts/run-mac.sh     # npm install bridge + open/build/launch
```

## Requisitos (Mac M1 Pro)

- **Apple Silicon** (alvo: M1 Pro / 16GB+)
- **macOS 14+** recomendado
- **Xcode 15+**
- **Node.js 22.13+** (`node:sqlite` sem flag experimental)
- **Python 3.10+** com venv para `mlx-service` (Metal) — só para respostas MLX reais

### Memória (modelo)

| Modelo | Id | Nota M1 Pro 16GB |
|---|---|---|
| **Qwen2.5-7B Instruct 4-bit** (default) | `qwen2.5-7b-instruct-4bit` | Melhor PT-BR; feche apps pesados |
| Qwen2.5-3B Instruct 4-bit | `qwen2.5-3b-instruct-4bit` | Fallback se houver pressão de RAM |

## Fluxo depois do QR

1. Em **Chats**: ligue auto-reply só nos JIDs desejados.
2. Em **Ajustes / Status**: escolha o modelo, **Reload pesos**, ligue o kill switch global.
3. (Opcional) suba o `mlx-service` para respostas reais; sem ele o motor cai no stub PT-BR.
4. Receba texto num chat selecionado → debounce → MLX (ou stub) → envio via Baileys.

## MLX service (opcional na primeira conexão)

```bash
cd mlx-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
IAZAP_MLX_AUTOLOAD=1 python server.py
# http://127.0.0.1:8742
```

Detalhes: [`mlx-service/README.md`](mlx-service/README.md).

## Bridge manual (só se quiser Terminal)

```bash
cd bridge
npm install
IAZAP_TOKEN=dev-token-change-me npm run serve   # estável (sem watch)
# ou: npm run dev   # tsx watch
```

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` |
| `IAZAP_BRIDGE_DIR` | resolvido pelo app (scheme / `bridge-root.txt` / pasta do repo) |
| `IAZAP_STUB_WA` | unset |
| `IAZAP_ENGINE` | `auto` (`mlx` \| `stub` \| `auto`) |
| `IAZAP_MLX_URL` | `http://127.0.0.1:8742` |
| `IAZAP_MLX_MODEL` | `qwen2.5-7b-instruct-4bit` |

**Logout** (`session.logout` / UI) apaga só `IAZAP_AUTH`. Contexto SQLite fica em `IAZAP_DATA`.

## Stub vs MLX

| | Stub | MLX |
|---|---|---|
| Quando | `IAZAP_ENGINE=stub`, ou `auto` sem mlx-service | mlx-service up no Mac (Metal) |
| `engineId` | `stub` | `mlx:qwen2.5-…` |
| Qualidade | Placeholder PT-BR | Qwen2.5 instruct local |

## IPC

JSON-RPC 2.0, newline-delimited, Unix socket. Notificação `qr.update` alimenta o QR na tela Parear. Ver [`protocol/PROTOCOL.md`](protocol/PROTOCOL.md).

## Pareamento (inspirado no BotChat)

Mantemos **Baileys** (não whatsapp-web.js/Chromium). A UX copia o contrato do BotChat: estado de conexão + linha de detalhe + **uma imagem QR grande** (some quando `null` / conectado). O app gerencia o processo do bridge como filho.

## Licença / uso

Projeto pessoal / experimental. Sem afiliação com Meta/WhatsApp.
