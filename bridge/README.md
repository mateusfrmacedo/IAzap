# IAZAP Bridge (Node + Baileys)

Sidecar that owns the WhatsApp Web multi-device session, runs the **auto-reply pipeline** (Phase 3), and speaks JSON-RPC to the macOS app over a Unix domain socket.

See [`../protocol/PROTOCOL.md`](../protocol/PROTOCOL.md) for the wire format.

## Requirements

- macOS on Apple Silicon (prod); Linux OK for unit/smoke
- Node.js **22+** (`node:sqlite` for context store)

## Setup

```bash
cd bridge
npm install
```

## Run (dev)

```bash
# Full Baileys connect + live pipeline (stub replies until Phase 4)
IAZAP_TOKEN=dev-token-change-me npm run dev

# IPC + pipeline smoke without contacting WhatsApp (send is local-fake)
IAZAP_STUB_WA=1 IAZAP_TOKEN=dev-token-change-me npm run dev
```

Defaults:

| Env | Default |
|---|---|
| `IAZAP_SOCKET` | `$TMPDIR/iazap-bridge.sock` |
| `IAZAP_TOKEN` | `dev-token-change-me` |
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` (macOS) |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` (`messages.sqlite`) |
| `IAZAP_STUB_WA` | unset (real Baileys) |

Auth files are **local only**. Logout (`session.logout`) wipes `IAZAP_AUTH`. Message context DB lives under `IAZAP_DATA`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `tsx watch` — hot reload TypeScript |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run compiled `dist/index.js` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (store, stub engine, pipeline filters/debounce/cooldown) |
| `npm run smoke:pipeline` | Spawn stub bridge, simulate inbound, assert `sent` |

## Pipeline (Phase 3)

```
messages.upsert (Baileys)
        → persist SQLite
        → notify messages.inbound
        → filter fromMe / groups / selection / kill switch
        → debounce per chat
        → build context string
        → ReplyEngine.generate (StubReplyEngine)
        → sock.sendMessage
        → notify pipeline.activity
```

### ReplyEngine plug-in point

```ts
// bridge/src/pipeline/replyEngine.ts
export interface ReplyEngine {
  readonly id: string;
  generate(req: ReplyRequest): Promise<string>;
}

export class StubReplyEngine implements ReplyEngine { /* Phase 3 */ }
// Phase 4: class MLXReplyEngine implements ReplyEngine { ... }
```

Wire the engine in `src/index.ts` (`const replyEngine = new StubReplyEngine()`).

RPC surface: `pipeline.getStatus` / `setEnabled` / `configure` / `getActivity` / `simulateInbound`, plus notifications `pipeline.status` and `pipeline.activity`.

## Phase 3 scope

- Inbound → filter → debounce → context → stub reply → send
- Global kill switch + per-chat selection + cooldown
- SQLite context store + light activity log to the app
- **Not** real MLX / model download
