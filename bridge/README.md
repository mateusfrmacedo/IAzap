# IAZAP Bridge (Node + Baileys)

Sidecar that owns the WhatsApp Web multi-device session and speaks JSON-RPC to the macOS app over a Unix domain socket.

See [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) for the wire format.

## Requirements

- macOS on Apple Silicon
- Node.js **20+** (LTS)

## Setup

```bash
cd bridge
npm install
```

## Run (dev)

```bash
# Full Baileys connect (QR via RPC notification `qr.update`)
IAZAP_TOKEN=dev-token-change-me npm run dev

# IPC-only smoke without contacting WhatsApp
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev
```

Defaults:

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` (macOS) |
| `IAZAP_STUB_WA` | unset (real Baileys) |

Auth files are **local only**. Logout (`session.logout`) wipes that directory.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch` — hot reload TypeScript |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |

## Phase 2 scope

- Real QR pairing, session status, reconnect/logout
- Chat list + `chats.updated` notifications
- Auto-reply selection mirror (`chats.setAutoReply`, `chats.syncSelection`)
- Inbound text notifications
- **Not** auto-reply pipeline or MLX

The Swift app is expected to spawn this process with a fresh token, socket path, and Application Support auth dir.
