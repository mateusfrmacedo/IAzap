/**
 * IAZAP shared IPC types — protocolVersion 1 (Phase 2 additive methods).
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

/** Method names */
export type RequestMethod =
  | "session.hello"
  | "session.status"
  | "session.reconnect"
  | "session.logout"
  | "chats.list"
  | "chats.setAutoReply"
  | "chats.syncSelection"
  | "messages.send";

export type NotificationMethod =
  | "qr.update"
  | "messages.inbound"
  | "session.status"
  | "chats.updated";

export type RpcMethod = RequestMethod | NotificationMethod;
