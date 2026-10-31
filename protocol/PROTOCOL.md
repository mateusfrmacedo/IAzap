# IAZAP Bridge Protocol (Phase 3–4)

JSON-RPC 2.0 over a **Unix domain socket** (preferred) or TCP `127.0.0.1` with a session token.

## Transport

| Setting | Value |
|---|---|
| Default socket | `$TMPDIR/iazap-bridge.sock` (or path passed by the macOS app) |
| Framing | **Newline-delimited** JSON (one JSON-RPC object per line) |
| Auth | First request after connect must be `session.hello` with `token` minted by the app |
| Encoding | UTF-8 |

The macOS app launches the Node bridge as a child process, writes the socket path + token + auth dir to env (`IAZAP_SOCKET`, `IAZAP_TOKEN`, `IAZAP_AUTH`, `IAZAP_DATA`), then connects as JSON-RPC client.

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

### `session.reconnect`

Restart the Baileys socket without wiping auth (unless already logged out).

**Params:** `{}`  
**Result:** `SessionStatus` (same shape as `session.status`)

### `session.logout`

Log out of WhatsApp multi-device and wipe local auth files under `IAZAP_AUTH`. Next reconnect emits a fresh QR.

**Params:** `{}`  
**Result:** `SessionStatus` (typically `logged_out`)

### `qr.update` (notification only)

```json
{ "qr": "2@...." }
```

`qr` is the raw Baileys QR **payload string** for the UI to encode as a QR image (CoreImage / CIFilter). `null` clears the QR once paired.

### `chats.list`

**Params:** `{}`  
**Result:** `{ "chats": Chat[] }`

```ts
type Chat = {
  id: string;          // JID
  name: string;
  isGroup: boolean;
  autoReply: boolean;  // mirror of selection known to bridge
  lastMessagePreview?: string;
  lastMessageAt?: number; // unix ms
}
```

### `chats.updated` (notification only)

Pushed when the bridge chat cache changes (upsert/update/inbound).

```json
{ "chats": [ /* Chat[] */ ] }
```

### `chats.setAutoReply`

**Params:** `{ "chatId": string, "enabled": boolean }`  
**Result:** `{ "ok": true, "chatId": string, "enabled": boolean }`

The Swift `AppStore` / UserDefaults remains the selection source of truth. The bridge mirrors flags so the message pipeline can filter.

### `chats.syncSelection`

Bulk replace the mirrored selection set (enabled JIDs only). Call after `session.hello` so the bridge matches UserDefaults.

**Params:** `{ "chatIds": string[] }`  
**Result:** `{ "ok": true, "chatIds": string[] }`

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

Text-only. Media is ignored by the bridge (or omitted). The bridge also feeds this into the auto-reply pipeline.

### `messages.send`

**Params:** `{ "chatId": string, "text": string }`  
**Result:** `{ "messageId": string }`

Manual/test send. The Phase 3 pipeline also calls the same Baileys path internally after generating a stub (or future MLX) reply.

## Pipeline (Phase 3)

Auto-reply runs **inside the bridge**:

1. Persist inbound text (SQLite under `IAZAP_DATA`)
2. Filter: `fromMe`, groups (off by default), chat not in selection, global kill switch
3. Debounce per chat → build context window → `ReplyEngine.generate` → send
4. Cooldown per chat after a successful send (anti-loop / rate)

`ManagedReplyEngine` prefers the local **mlx-service** (`engineId` like `mlx:qwen2.5-7b-instruct-4bit` or `mlx-mock:…`). If the service is down, it falls back to `StubReplyEngine` (`engineId: "stub"`) unless `IAZAP_ENGINE=mlx` (then generate errors surface in the pipeline).

### `pipeline.getStatus`

**Params:** `{}`  
**Result:** `PipelineStatus`

```ts
type PipelineStatus = {
  enabled: boolean;          // global kill switch
  engineId: string;          // "stub" (Phase 3) | future "mlx-..."
  phase: "idle" | "debouncing" | "generating" | "sending" | "cooldown" | "error";
  debounceMs: number;
  cooldownMs: number;
  contextSize: number;
  allowGroups: boolean;
  selectedCount: number;
  pendingChats: number;
  lastActivityAt: number | null;
  lastError: string | null;
}
```

Also pushed as notification `pipeline.status` when phase / enabled / config changes.

### `pipeline.setEnabled`

Global kill switch (does **not** clear chat selection).

**Params:** `{ "enabled": boolean }`  
**Result:** `PipelineStatus`

### `pipeline.configure`

Partial update of knobs (+ optional `enabled`).

**Params:**

```ts
{
  enabled?: boolean;
  debounceMs?: number;
  cooldownMs?: number;
  contextSize?: number;   // 1..40
  allowGroups?: boolean;
  systemPrompt?: string;  // PT-BR system prompt for the engine
  modelId?: string;       // Phase 4: MLX catalog id (also via model.configure)
}
```

**Result:** `PipelineStatus`

### `pipeline.getActivity`

**Params:** `{ "limit"?: number }`  
**Result:** `{ "activities": PipelineActivity[] }` (newest first)

```ts
type PipelineActivity = {
  id: string;
  at: number;
  kind:
    | "inbound"
    | "skipped_from_me"
    | "skipped_not_selected"
    | "skipped_group"
    | "skipped_disabled"
    | "skipped_cooldown"
    | "debounced"
    | "generated"
    | "sent"
    | "error";
  chatId: string;
  detail: string;
  messageId?: string;
}
```

### `pipeline.activity` (notification only)

Pushed for each activity entry (same shape as one `PipelineActivity`).

### `pipeline.simulateInbound`

Dev / stub helper: inject a text inbound into the pipeline (and notify `messages.inbound`). Useful with `IAZAP_STUB_WA=1` where send is faked locally.

**Params:** `{ "chatId": string, "text": string, "fromMe"?: boolean, "isGroup"?: boolean }`  
**Result:** `{ "ok": true, "messageId": string }`

## Model / MLX (Phase 4)

Inference runs in **`mlx-service/`** (Python + `mlx-lm` on Apple Silicon). The bridge calls it over `http://127.0.0.1:8742` and exposes status to the app.

### `model.getStatus`

**Params:** `{}`  
**Result:** `ModelStatus`

```ts
type ModelLoadState =
  | "unavailable" | "not_loaded" | "loading" | "ready" | "error" | "fallback_stub";

type ModelStatus = {
  backend: "mlx" | "stub";
  engineId: string;
  modelId: string;
  modelLabel: string;
  state: ModelLoadState;
  mlxAvailable: boolean;
  serviceUrl: string | null;
  memoryNote: string;       // M1 Pro guidance
  lastError: string | null;
  availableModels: Array<{
    id: string; label: string; hfRepo: string; memoryHint: string;
  }>;
}
```

Also pushed as notification `model.status` after configure/reload/startup.

### `model.configure`

**Params:** `{ "modelId": string }` — catalog id (`qwen2.5-7b-instruct-4bit` | `qwen2.5-3b-instruct-4bit`) or HF repo  
**Result:** `ModelStatus`

### `model.reload`

Trigger weight load / HF download via mlx-service.  
**Params:** `{}`  
**Result:** `ModelStatus`

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

## Auth / data files

| Env | Default (macOS) | Contents |
|---|---|---|
| `IAZAP_AUTH` | `~/Library/Application Support/IAZAP/baileys-auth` | Baileys multi-file creds |
| `IAZAP_DATA` | `~/Library/Application Support/IAZAP/data` | `messages.sqlite` context store |

`session.logout` deletes contents of `IAZAP_AUTH` only (message DB kept unless the user wipes Application Support).

## Versioning

`protocolVersion: 1` — Phase 3–4 add pipeline + model methods/notifications without breaking older clients that ignore unknown notifications. Shared types live in:

- `protocol/types.ts` (TypeScript source of truth for the bridge)
- `IAZAP/IAZAP/Bridge/BridgeProtocol.swift` (Swift mirror)

## Reconexão do cliente e QR

Após `session.hello` autenticado, o servidor reenvia o último estado de
`session.status`, `qr.update`, `chats.updated`, `pipeline.status` e `model.status`
que já tiver sido emitido. Isso evita perder um QR gerado antes da conexão do app.
`qr.update` com `qr: null` substitui o código anterior e também é reenviado.
Clientes ainda não autenticados não recebem notificações.

## Modelo Apple Intelligence

`model.configure` aceita `modelId: "apple-intelligence"`. O status usa
`backend: "apple"` e `engineId: "apple:foundation-models"`. O mesmo catálogo
inclui os modelos Qwen/MLX. Para Apple, `model.reload` verifica disponibilidade
do modelo do sistema, e `serviceUrl` é `null`. A geração Apple indisponível/recusada
reporta erro e não envia respostas de demonstração. Não altera o protocolo v1.

## Intervalo entre respostas

`cooldownMs` não descarta mais mensagens recebidas no intervalo: `queued_cooldown`
indica uma resposta pendente, que será executada automaticamente ao final da espera.
`pendingChats` inclui chats aguardando um envio anterior. O padrão é cooldown 0 ms
e debounce 1000 ms. `skipped_cooldown` é mantido no enum por compatibilidade.

## Confirmação do prompt ativo

`pipeline.status`/`pipeline.getStatus` incluem `systemPromptHash`, campo opcional
compatível com clientes antigos. É SHA-256, em hexadecimal, do prompt ativo sem
espaços externos e normalizado em Unicode NFC. O conteúdo do prompt não é incluído
nesse status. Atualizações do prompt são aplicadas ao receber `pipeline.configure`,
antes de aguardar configurações lentas do modelo, para que uma edição antiga não
sobrescreva outra mais recente. Alterar o texto invalida gerações ainda não enviadas.
