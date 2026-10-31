/**
 * Baileys WhatsApp session scaffolding (Phase 1).
 *
 * Real multi-device connect is wired; auth files land under authDir.
 * Auto-reply pipeline / MLX are out of scope here — we only emit QR,
 * session status, chats, and inbound text for the Swift UI.
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { EventEmitter } from "node:events";
import type { Chat, InboundMessage, SessionMe, SessionStatus } from "../protocol/types.js";

const log = pino({ level: process.env.IAZAP_LOG_LEVEL ?? "info" });

export type WhatsAppSessionEvents = {
  status: [SessionStatus];
  qr: [string | null];
  inbound: [InboundMessage];
};

export class WhatsAppSession extends EventEmitter {
  private sock: WASocket | null = null;
  private authDir: string;
  private status: SessionStatus = {
    state: "disconnected",
    me: null,
    lastError: null,
  };
  /** JID → auto-reply flag (mirrored from app in Phase 1). */
  private autoReply = new Map<string, boolean>();
  private chatCache = new Map<string, Chat>();

  constructor(authDir: string) {
    super();
    this.authDir = authDir;
  }

  getStatus(): SessionStatus {
    return { ...this.status };
  }

  listChats(): Chat[] {
    return [...this.chatCache.values()].sort((a, b) => {
      const ta = a.lastMessageAt ?? 0;
      const tb = b.lastMessageAt ?? 0;
      return tb - ta;
    });
  }

  setAutoReply(chatId: string, enabled: boolean): void {
    this.autoReply.set(chatId, enabled);
    const existing = this.chatCache.get(chatId);
    if (existing) {
      this.chatCache.set(chatId, { ...existing, autoReply: enabled });
    }
  }

  async sendText(chatId: string, text: string): Promise<{ messageId: string }> {
    if (!this.sock || this.status.state !== "connected") {
      const err = new Error("WhatsApp not connected") as Error & { code: number };
      err.code = -32010;
      throw err;
    }
    const result = await this.sock.sendMessage(chatId, { text });
    const messageId = result?.key?.id ?? `local-${Date.now()}`;
    return { messageId };
  }

  async start(): Promise<void> {
    this.setStatus({ state: "connecting", me: null, lastError: null });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log),
      },
      logger: log.child({ module: "baileys" }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });

    this.sock.ev.on("creds.update", saveCreds);

    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.setStatus({ state: "qr", me: this.status.me, lastError: null });
        this.emit("qr", qr);
      }

      if (connection === "open") {
        const me = this.resolveMe();
        this.setStatus({ state: "connected", me, lastError: null });
        this.emit("qr", null);
      }

      if (connection === "close") {
        const err = lastDisconnect?.error as
          | (Error & { output?: { statusCode?: number } })
          | undefined;
        const statusCode = err?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          this.setStatus({
            state: "logged_out",
            me: null,
            lastError: "Logged out — scan QR again",
          });
          this.emit("qr", null);
          return;
        }

        this.setStatus({
          state: "disconnected",
          me: null,
          lastError: err?.message ?? "Connection closed",
        });
        // Soft reconnect for transient closes (Phase 1 scaffolding).
        setTimeout(() => {
          void this.start().catch((e) => {
            this.setStatus({
              state: "error",
              me: null,
              lastError: e instanceof Error ? e.message : String(e),
            });
          });
        }, 2_000);
      }
    });

    this.sock.ev.on("chats.upsert", (chats) => {
      for (const c of chats) {
        this.upsertChat(c.id, {
          name: c.name ?? c.id.split("@")[0] ?? c.id,
          isGroup: c.id.endsWith("@g.us"),
        });
      }
    });

    this.sock.ev.on("chats.update", (updates) => {
      for (const u of updates) {
        if (!u.id) continue;
        this.upsertChat(u.id, {
          name: u.name ?? undefined,
          isGroup: u.id.endsWith("@g.us"),
        });
      }
    });

    this.sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages) {
        this.handleInbound(msg);
      }
    });
  }

  async stop(): Promise<void> {
    try {
      this.sock?.end(undefined);
    } catch {
      /* ignore */
    }
    this.sock = null;
    this.setStatus({ state: "disconnected", me: null, lastError: null });
  }

  private resolveMe(): SessionMe | null {
    const id = this.sock?.user?.id;
    if (!id) return null;
    return {
      id,
      name: this.sock?.user?.name ?? id.split(":")[0] ?? id,
    };
  }

  private setStatus(next: SessionStatus): void {
    this.status = next;
    this.emit("status", this.getStatus());
  }

  private upsertChat(
    id: string,
    partial: { name?: string; isGroup?: boolean; lastMessagePreview?: string; lastMessageAt?: number },
  ): void {
    const prev = this.chatCache.get(id);
    const chat: Chat = {
      id,
      name: partial.name ?? prev?.name ?? id.split("@")[0] ?? id,
      isGroup: partial.isGroup ?? prev?.isGroup ?? id.endsWith("@g.us"),
      autoReply: this.autoReply.get(id) ?? prev?.autoReply ?? false,
      lastMessagePreview: partial.lastMessagePreview ?? prev?.lastMessagePreview,
      lastMessageAt: partial.lastMessageAt ?? prev?.lastMessageAt,
    };
    this.chatCache.set(id, chat);
  }

  private handleInbound(msg: WAMessage): void {
    const chatId = msg.key.remoteJid;
    if (!chatId || chatId === "status@broadcast") return;

    const text = extractText(msg);
    if (!text) return;

    const fromMe = Boolean(msg.key.fromMe);
    const timestamp = Number(msg.messageTimestamp ?? Date.now()) * (String(msg.messageTimestamp).length < 13 ? 1000 : 1);
    const messageId = msg.key.id ?? `unknown-${timestamp}`;

    this.upsertChat(chatId, {
      isGroup: chatId.endsWith("@g.us"),
      lastMessagePreview: text.slice(0, 120),
      lastMessageAt: timestamp,
    });

    const inbound: InboundMessage = {
      chatId,
      messageId,
      text,
      fromMe,
      timestamp,
    };
    this.emit("inbound", inbound);
  }
}

function extractText(msg: WAMessage): string | null {
  const m = msg.message;
  if (!m) return null;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage?.caption) return m.imageMessage.caption;
  if (m.videoMessage?.caption) return m.videoMessage.caption;
  return null;
}
