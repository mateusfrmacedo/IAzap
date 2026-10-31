/**
 * IAZAP shared IPC types — protocolVersion 1 (Phase 3 pipeline + Phase 4 model.*).
 * Keep in sync with ../../protocol/types.ts
 */

export const PROTOCOL_VERSION = 1 as const;

export type SessionState =
  | "disconnected"
  | "qr"
  | "connecting"
  | "connected"
  | "logged_out"
  | "error";

export interface SessionMe {
  id: string;
  name: string;
}

export interface SessionStatus {
  state: SessionState;
  me: SessionMe | null;
  lastError: string | null;
}

export interface Chat {
  id: string;
  name: string;
  isGroup: boolean;
  autoReply: boolean;
  lastMessagePreview?: string;
  lastMessageAt?: number;
}

export interface InboundMessage {
  chatId: string;
  messageId: string;
  text: string;
  fromMe: boolean;
  timestamp: number;
}

/** Client → bridge request params */
export interface SessionHelloParams {
  token: string;
  client: "iazap-macos";
  protocolVersion: typeof PROTOCOL_VERSION;
}

export interface ChatsSetAutoReplyParams {
  chatId: string;
  enabled: boolean;
}

/** Bulk sync of selected JIDs (app is source of truth). */
export interface ChatsSyncSelectionParams {
  chatIds: string[];
}

export interface MessagesSendParams {
  chatId: string;
  text: string;
}

/** Global auto-reply kill switch + timing knobs (+ optional MLX model id). */
export interface PipelineConfigureParams {
  enabled?: boolean;
  debounceMs?: number;
  cooldownMs?: number;
  contextSize?: number;
  allowGroups?: boolean;
  systemPrompt?: string;
  /** Preferred MLX catalog id (e.g. qwen2.5-7b-instruct-4bit). */
  modelId?: string;
}

export interface PipelineSetEnabledParams {
  enabled: boolean;
}

/** Dev/stub: inject an inbound text event into the pipeline. */
export interface PipelineSimulateInboundParams {
  chatId: string;
  text: string;
  fromMe?: boolean;
  isGroup?: boolean;
}

export type PipelinePhase =
  | "idle"
  | "debouncing"
  | "generating"
  | "sending"
  | "cooldown"
  | "error";

export interface PipelineStatus {
  enabled: boolean;
  /** SHA-256 of the trimmed prompt currently in use (no prompt content). */
  systemPromptHash?: string;
  engineId: string;
  phase: PipelinePhase;
  debounceMs: number;
  cooldownMs: number;
  contextSize: number;
  allowGroups: boolean;
  selectedCount: number;
  pendingChats: number;
  lastActivityAt: number | null;
  lastError: string | null;
}

export type PipelineActivityKind =
  | "inbound"
  | "skipped_from_me"
  | "skipped_not_selected"
  | "skipped_group"
  | "skipped_disabled"
  | "skipped_cooldown"
  | "queued_cooldown"
  | "debounced"
  | "generated"
  | "sent"
  | "error";

export interface PipelineActivity {
  id: string;
  at: number;
  kind: PipelineActivityKind;
  chatId: string;
  detail: string;
  messageId?: string;
}

export type ModelLoadState =
  | "unavailable"
  | "not_loaded"
  | "loading"
  | "ready"
  | "error"
  | "fallback_stub";

export interface ModelCatalogEntry {
  id: string;
  label: string;
  hfRepo: string;
  memoryHint: string;
}

export interface ModelStatus {
  backend: "mlx" | "stub" | "apple";
  engineId: string;
  modelId: string;
  modelLabel: string;
  state: ModelLoadState;
  mlxAvailable: boolean;
  serviceUrl: string | null;
  memoryNote: string;
  lastError: string | null;
  availableModels: ModelCatalogEntry[];
}

export interface ModelConfigureParams {
  modelId: string;
}

/** Method names */
export type RequestMethod =
  | "session.hello"
  | "session.status"
  | "session.reconnect"
  | "session.logout"
  | "chats.list"
  | "chats.setAutoReply"
  | "chats.syncSelection"
  | "messages.send"
  | "pipeline.getStatus"
  | "pipeline.setEnabled"
  | "pipeline.configure"
  | "pipeline.getActivity"
  | "pipeline.simulateInbound"
  | "model.getStatus"
  | "model.configure"
  | "model.reload";

export type NotificationMethod =
  | "qr.update"
  | "messages.inbound"
  | "session.status"
  | "chats.updated"
  | "pipeline.status"
  | "pipeline.activity"
  | "model.status";

export type RpcMethod = RequestMethod | NotificationMethod;
