# IAZAP Bridge (Node + Baileys)

Sidecar that owns the WhatsApp Web multi-device session, runs the **auto-reply pipeline**, talks to **mlx-service** for Portuguese replies (Phase 4), and speaks JSON-RPC to the macOS app over a Unix domain socket.

See [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) and [`../mlx-service/README.md`](../mlx-service/README.md).

## Requirements

- macOS on Apple Silicon (prod); Linux OK for unit/smoke + stub/mock
- Node.js **22+** (`node:sqlite` for context store)
- Optional: `mlx-service` on `http://127.0.0.1:8742` for real MLX

## Setup

```bash
cd bridge
npm install
```

## Run

O app macOS costuma chamar `npm run serve` sozinho (filho do processo). Manual:

```bash
# Estável (sem watch) — o que o app spawna
IAZAP_TOKEN=dev-token-change-me npm run serve

# Dev com reload
IAZAP_TOKEN=dev-token-change-me npm run dev

# Force stub
IAZAP_ENGINE=stub IAZAP_TOKEN=dev-token-change-me npm run serve

# IPC + pipeline smoke without contacting WhatsApp
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run serve
```

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` (macOS) |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` (`messages.sqlite`) |
| `IAZAP_STUB_WA` | unset (real Baileys) |
| `IAZAP_ENGINE` | `auto` |
| `IAZAP_MLX_URL` | `http://127.0.0.1:8742` |
| `IAZAP_MLX_MODEL` | `qwen2.5-7b-instruct-4bit` |

## Scripts

| Script | What it does |
|---|---|
| `npm run serve` | `tsx src/index.ts` (sem watch — usado pelo app) |
| `npm run dev` | `tsx watch` |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (store, stub, pipeline, MLX client/fallback) |
| `npm run smoke:pipeline` | Spawn stub bridge, simulate inbound, assert `sent` |

## Pipeline

```
messages.upsert (Baileys)
        → persist SQLite
        → filter fromMe / groups / selection / kill switch
        → debounce per chat
        → ManagedReplyEngine (MLX HTTP or StubReplyEngine)
        → sock.sendMessage
        → notify pipeline.activity / model.status
```

RPC: `pipeline.*` + `model.getStatus` / `model.configure` / `model.reload`.
