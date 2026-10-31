# IAZAP Bridge Protocol (Phase 1)

JSON-RPC 2.0 over a **Unix domain socket** (preferred) or TCP `127.0.0.1` with a session token.

## Transport

| Setting | Value |
|---|---|
| Default socket | `$TMPDIR/iazap-bridge.sock` (or path passed by the macOS app) |
| Framing | **Newline-delimited** JSON (one JSON-RPC object per line) |
| Auth | First request after connect must be `session.hello` with `token` minted by the app |
| Encoding | UTF-8 |

The macOS app launches the Node bridge as a child process, writes the socket path + token to env (`IAZAP_SOCKET`, `IAZAP_TOKEN`), then connects as JSON-RPC client.

Direction model:

- **Request / response**: Swift → Bridge (methods below)
- **Notifications**: Bridge → Swift (`method` present, `id` omitted)

## Common shapes

```ts
// Request
{ "jsonrpc": "2.0", "id": 1, "method": "chats.list", "params": {} }

// Success
{ "jsonrpc": "2.0", "id": 1, "result": { ... } }

// Error
{ "jsonrpc": "2.0", "id": 1, "error": { "code": -32000, "message": "..." } }

// Notification (no id)
{ "jsonrpc": "2.0", "method": "qr.update", "params": { "qr": "..." } }
```

## Methods

### `session.hello`

Authenticate the IPC session.

**Params:** `{ "token": string, "client": "iazap-macos", "protocolVersion": 1 }`  
**Result:** `{ "ok": true, "protocolVersion": 1 }`

### `session.status`

**Params:** `{}`  
**Result:**

```json
{
  "state": "disconnected" | "qr" | "connecting" | "connected" | "logged_out" | "error",
  "me": { "id": "jid@s.whatsapp.net", "name": "Display" } | null,
  "lastError": string | null
}
```

Also pushed as a notification with the same `params` shape when state changes (`method`: `session.status`).

### `qr.update` (notification only)

```json
{ "qr": "2@...." }
```

`qr` is the raw Baileys QR string for the UI to render. `null` clears the QR once paired.

### `chats.list`

**Params:** `{}`  
**Result:** `{ "chats": Chat[] }`

```ts
type Chat = {
  id: string;          // JID
  name: string;
  isGroup: boolean;
  autoReply: boolean;  // mirror of selection known to bridge (app is source of truth in Phase 1)
  lastMessagePreview?: string;
  lastMessageAt?: number; // unix ms
}
```

### `chats.setAutoReply`

**Params:** `{ "chatId": string, "enabled": boolean }`  
**Result:** `{ "ok": true, "chatId": string, "enabled": boolean }`

Phase 1: bridge mirrors the flag for `chats.list`; the Swift `AppStore` / UserDefaults remains the selection source of truth. Later phases push the set into the message pipeline.

### `messages.inbound` (notification only)

```json
{
  "chatId": "jid@s.whatsapp.net",
  "messageId": "BAE5...",
  "text": "oi",
  "fromMe": false,
  "timestamp": 1730000000000
}
```

Text-only in Phase 1. Media is ignored by the bridge (or omitted).

### `messages.send`

**Params:** `{ "chatId": string, "text": string }`  
**Result:** `{ "messageId": string }`

Phase 1 stub may reject with “not connected” until Baileys session is live. Auto-send pipeline is out of scope.

## Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error |
| `-32600` | Invalid request |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32001` | Unauthorized (bad / missing token) |
| `-32010` | WhatsApp not connected |
| `-32000` | Generic bridge error |

## Versioning

`protocolVersion: 1` for Phase 1. Bump when adding required fields or renaming methods. Shared types live in:

- `protocol/types.ts` (TypeScript source of truth for the bridge)
- `IAZAP/IAZAP/Bridge/BridgeProtocol.swift` (Swift mirror)
