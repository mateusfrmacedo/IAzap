/**
 * Baileys WhatsApp session (Phase 2+).
 *
 * QR pairing, reconnect/logout, chat list + auto-reply mirror.
 * Auto-reply orchestration lives in `pipeline/` (Phase 3); MLX is Phase 4.
 */

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
  type WAMessage,
  type Contact,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { Chat, InboundMessage, SessionMe, SessionStatus } from "../protocol/types.js";

const log = pino({ level: process.env.IAZAP_LOG_LEVEL ?? "info" });

export type WhatsAppSessionEvents = {
  status: [SessionStatus];
  qr: [string | null];
  inbound: [InboundMessage];
  chats: [Chat[]];
};

export type SessionDependencies = {
  makeSocket: typeof makeWASocket;
  useAuth: typeof useMultiFileAuthState;
  fetchVersion: typeof fetchLatestBaileysVersion;
  retryBaseMs: number;
  retryMaxMs: number;
  random: () => number;
};

export function reconnectDelay(attempt: number, base = 2_000, max = 30_000, random = Math.random): number {
  return Math.min(max, Math.round(base * 2 ** Math.min(attempt, 10) * (0.8 + 0.4 * random())));
}

export class WhatsAppSession extends EventEmitter {
  private sock: WASocket | null = null;
  private authDir: string;
  private status: SessionStatus = {
    state: "disconnected",
    me: null,
    lastError: null,
  };
  /** JID → auto-reply flag (app is source of truth; mirrored here for pipeline later). */
  private autoReply = new Map<string, boolean>();
  private chatCache = new Map<string, Chat>();
  private contactNames = new Map<string, string>();
  /** When true, connection.close must not soft-reconnect. */
  private intentionalStop = false;
  private startTask: Promise<void> | null = null;
  private epoch = 0;
  private reconnectAttempts = 0;
  private deps: SessionDependencies;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(authDir: string, deps: Partial<SessionDependencies> = {}) {
    super();
    this.authDir = authDir;
    this.deps = { makeSocket: makeWASocket, useAuth: useMultiFileAuthState,
      fetchVersion: fetchLatestBaileysVersion, retryBaseMs: 2_000,
      retryMaxMs: 30_000, random: Math.random, ...deps };
  }

  getStatus(): SessionStatus {
    return { ...this.status, me: this.status.me ? { ...this.status.me } : null };
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
      this.emitChats();
    }
  }

  /** Replace the mirrored selection set (enabled JIDs only). */
  syncSelection(chatIds: string[]): void {
    this.autoReply.clear();
    for (const id of chatIds) {
      this.autoReply.set(id, true);
    }
    for (const [id, chat] of this.chatCache) {
      const enabled = this.autoReply.get(id) ?? false;
      if (chat.autoReply !== enabled) {
        this.chatCache.set(id, { ...chat, autoReply: enabled });
      }
    }
    this.emitChats();
  }

  selectedChatIds(): string[] {
    return [...this.autoReply.entries()].filter(([, v]) => v).map(([id]) => id);
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
    if (this.startTask) return this.startTask;
    this.intentionalStop = false;
    this.clearReconnectTimer();
    const epoch = this.epoch;
    const task = this.openSocket(epoch).catch((err) => {
      if (this.intentionalStop || epoch !== this.epoch) return;
      this.setStatus({ state: "error", me: null,
        lastError: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
    }).finally(() => {
      if (this.startTask === task) this.startTask = null;
    });
    this.startTask = task;
    return task;
  }

  /** Soft reconnect without wiping auth (e.g. after disconnect). */
  async reconnect(): Promise<SessionStatus> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    await this.endSocket();
    await this.startTask;
    this.reconnectAttempts = 0;
    this.intentionalStop = false;
    await this.start();
    return this.getStatus();
  }

  /**
   * Logout from WhatsApp multi-device and wipe local auth files.
   * Next `start`/`reconnect` will emit a fresh QR.
   */
  async logout(): Promise<SessionStatus> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    try {
      if (this.sock) {
        await this.sock.logout();
      }
    } catch (e) {
      log.warn({ err: e }, "logout call failed; wiping auth anyway");
    }
    await this.endSocket();
    wipeAuthDir(this.authDir);
    this.chatCache.clear();
    this.contactNames.clear();
    this.setStatus({
      state: "logged_out",
      me: null,
      lastError: null,
    });
    this.emit("qr", null);
    this.emitChats();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.intentionalStop = true;
    this.clearReconnectTimer();
    await this.endSocket();
    this.setStatus({ state: "disconnected", me: null, lastError: null });
    this.emit("qr", null);
  }

  private async openSocket(epoch: number): Promise<void> {
    fs.mkdirSync(this.authDir, { recursive: true });
    this.setStatus({ state: "connecting", me: null, lastError: null });

    const { state, saveCreds } = await this.deps.useAuth(this.authDir);
    if (this.intentionalStop || epoch !== this.epoch) return;
    const { version } = await this.deps.fetchVersion({ timeout: 5_000 });
    if (this.intentionalStop || epoch !== this.epoch) return;

    const sock = this.deps.makeSocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, log),
      },
      logger: log.child({ module: "baileys" }),
      printQRInTerminal: false,
      syncFullHistory: false,
      markOnlineOnConnect: false,
      connectTimeoutMs: 30_000,
      keepAliveIntervalMs: 20_000,
      getMessage: async () => undefined,
    });

    this.sock = sock;
    const isCurrent = () => this.sock === sock && !this.intentionalStop && epoch === this.epoch;
    sock.ev.on("creds.update", () => {
      if (isCurrent()) void saveCreds().catch((err) => log.error({ err }, "failed to save session credentials"));
    });

    sock.ev.on("connection.update", (update) => {
      if (!isCurrent()) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.setStatus({ state: "qr", me: this.status.me, lastError: null });
        this.emit("qr", qr);
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        const me = this.resolveMe();
        this.setStatus({ state: "connected", me, lastError: null });
        this.emit("qr", null);
        this.emitChats();
      }

      if (connection === "close") {
        const err = lastDisconnect?.error as
          | (Error & { output?: { statusCode?: number } })
          | undefined;
        const statusCode = err?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        this.sock = null;
        this.emit("qr", null);
        if (statusCode === DisconnectReason.connectionReplaced) {
          this.setStatus({ state: "error", me: null,
            lastError: "WhatsApp aberto por outra instância do IAZAP. Feche a outra cópia e use Reconectar." });
          return;
        }

        if (loggedOut) {
          this.setStatus({
            state: "logged_out",
            me: null,
            lastError: "Desconectado — escaneie o QR novamente",
          });
          this.emit("qr", null);
          wipeAuthDir(this.authDir);
          return;
        }

        this.setStatus({
          state: "disconnected",
          me: null,
          lastError: err?.message ?? "Conexão encerrada",
        });
        this.scheduleReconnect();
      }
    });

    sock.ev.on("chats.upsert", (chats) => {
      if (!isCurrent()) return;
      for (const c of chats) {
        this.upsertChat(c.id, {
          name: this.resolveChatName(c.id, c.name),
          isGroup: c.id.endsWith("@g.us"),
          lastMessageAt: c.conversationTimestamp
            ? Number(c.conversationTimestamp) * 1000
            : undefined,
        });
      }
      this.emitChats();
    });

    sock.ev.on("chats.update", (updates) => {
      if (!isCurrent()) return;
      let changed = false;
      for (const u of updates) {
        if (!u.id) continue;
        this.upsertChat(u.id, {
          name: u.name ? this.resolveChatName(u.id, u.name) : undefined,
          isGroup: u.id.endsWith("@g.us"),
          lastMessageAt: u.conversationTimestamp
            ? Number(u.conversationTimestamp) * 1000
            : undefined,
        });
        changed = true;
      }
      if (changed) this.emitChats();
    });

    sock.ev.on("contacts.upsert", (contacts) => {
      if (!isCurrent()) return;
      this.applyContacts(contacts);
    });

    sock.ev.on("contacts.update", (updates) => {
      if (!isCurrent()) return;
      this.applyContacts(updates as Contact[]);
    });

    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (!isCurrent()) return;
      if (type !== "notify" && type !== "append") return;
      for (const msg of messages) {
        this.handleInbound(msg);
      }
    });
  }

  private applyContacts(contacts: Contact[]): void {
    let changed = false;
    for (const c of contacts) {
      if (!c.id) continue;
      const name = c.notify ?? c.name ?? c.verifiedName;
      if (!name) continue;
      this.contactNames.set(c.id, name);
      const chat = this.chatCache.get(c.id);
      if (chat && chat.name !== name && (chat.name === c.id.split("@")[0] || chat.name === c.id)) {
        this.chatCache.set(c.id, { ...chat, name });
        changed = true;
      } else if (chat && name && chat.name !== name) {
        // Prefer contact notify over bare id-derived names
        if (!chat.name || chat.name === c.id.split("@")[0]) {
          this.chatCache.set(c.id, { ...chat, name });
          changed = true;
        }
      }
    }
    if (changed) this.emitChats();
  }

  private resolveChatName(id: string, hint?: string | null): string {
    if (hint && hint.trim()) return hint;
    const fromContact = this.contactNames.get(id);
    if (fromContact) return fromContact;
    return id.split("@")[0] ?? id;
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    if (this.intentionalStop) return;
    const delay = reconnectDelay(this.reconnectAttempts++, this.deps.retryBaseMs, this.deps.retryMaxMs, this.deps.random);
    log.info({ attempt: this.reconnectAttempts, delayMs: delay }, "reconnecting WhatsApp");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.intentionalStop) void this.start();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async endSocket(): Promise<void> {
    this.epoch += 1;
    const sock = this.sock;
    this.sock = null;
    if (!sock) return;
    try {
      sock.end(undefined);
    } catch {
      /* ignore */
    }
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

  private emitChats(): void {
    this.emit("chats", this.listChats());
  }

  private upsertChat(
    id: string,
    partial: {
      name?: string;
      isGroup?: boolean;
      lastMessagePreview?: string;
      lastMessageAt?: number;
    },
  ): void {
    const prev = this.chatCache.get(id);
    const chat: Chat = {
      id,
      name: partial.name ?? prev?.name ?? this.resolveChatName(id),
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
    const rawTs = msg.messageTimestamp;
    const timestamp =
      Number(rawTs ?? Date.now()) * (String(rawTs ?? "").length < 13 ? 1000 : 1);
    const messageId = msg.key.id ?? `unknown-${timestamp}`;

    const pushName = msg.pushName;
    if (pushName && !fromMe) {
      this.contactNames.set(chatId, pushName);
    }

    this.upsertChat(chatId, {
      name: this.resolveChatName(chatId, pushName),
      isGroup: chatId.endsWith("@g.us"),
      lastMessagePreview: text.slice(0, 120),
      lastMessageAt: timestamp,
    });
    this.emitChats();

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

function wipeAuthDir(authDir: string): void {
  try {
    if (!fs.existsSync(authDir)) return;
    for (const entry of fs.readdirSync(authDir)) {
      fs.rmSync(path.join(authDir, entry), { recursive: true, force: true });
    }
  } catch (e) {
    log.warn({ err: e, authDir }, "failed to wipe auth dir");
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
