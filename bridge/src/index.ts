/**
 * IAZAP WhatsApp bridge entrypoint (Phase 3).
 *
 * Env:
 *   IAZAP_SOCKET  — Unix socket path (default: $TMPDIR/iazap-bridge.sock)
 *   IAZAP_TOKEN   — session token required by session.hello
 *   IAZAP_AUTH    — Baileys multi-file auth directory
 *                   (default: ~/Library/Application Support/IAZAP/baileys-auth on macOS)
 *   IAZAP_DATA    — SQLite + pipeline data dir
 *                   (default: ~/Library/Application Support/IAZAP/data on macOS)
 *   IAZAP_STUB_WA — if "1", skip real Baileys connect (UI/IPC smoke only)
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { RpcServer } from "./rpc/server.js";
import { WhatsAppSession } from "./whatsapp/session.js";
import type { Chat, InboundMessage, SessionStatus } from "./protocol/types.js";
import { MessageStore } from "./pipeline/messageStore.js";
import { MessagePipeline } from "./pipeline/pipeline.js";
import { StubReplyEngine } from "./pipeline/replyEngine.js";

function defaultAuthDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "IAZAP",
      "baileys-auth",
    );
  }
  return path.join(os.homedir(), ".iazap", "baileys-auth");
}

function defaultDataDir(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "IAZAP",
      "data",
    );
  }
  return path.join(os.homedir(), ".iazap", "data");
}

const socketPath =
  process.env.IAZAP_SOCKET ?? path.join(os.tmpdir(), "iazap-bridge.sock");
const token = process.env.IAZAP_TOKEN ?? "dev-token-change-me";
const authDir = process.env.IAZAP_AUTH ?? defaultAuthDir();
const dataDir = process.env.IAZAP_DATA ?? defaultDataDir();
const stubWa = process.env.IAZAP_STUB_WA === "1";

fs.mkdirSync(authDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

let session: WhatsAppSession | null = null;
let stubStatus: SessionStatus = {
  state: "disconnected",
  me: null,
  lastError: stubWa ? "Stub mode (IAZAP_STUB_WA=1)" : null,
};
const stubAutoReply = new Map<string, boolean>();
const stubChats: Chat[] = [
  {
    id: "5511999999999@s.whatsapp.net",
    name: "Exemplo (stub)",
    isGroup: false,
    autoReply: false,
    lastMessagePreview: "Olá!",
    lastMessageAt: Date.now() - 60_000,
  },
  {
    id: "5511888888888@s.whatsapp.net",
    name: "Maria (stub)",
    isGroup: false,
    autoReply: false,
    lastMessagePreview: "Tudo bem?",
    lastMessageAt: Date.now() - 120_000,
  },
  {
    id: "120363@g.us",
    name: "Grupo stub",
    isGroup: true,
    autoReply: false,
    lastMessagePreview: "oi grupo",
    lastMessageAt: Date.now() - 180_000,
  },
];

const messageStore = new MessageStore(path.join(dataDir, "messages.sqlite"));
const replyEngine = new StubReplyEngine();

function getStatus(): SessionStatus {
  return session ? session.getStatus() : { ...stubStatus };
}

function listChats(): Chat[] {
  if (session) return session.listChats();
  return stubChats.map((c) => ({
    ...c,
    autoReply: stubAutoReply.get(c.id) ?? c.autoReply,
  }));
}

function selectedChatIds(): string[] {
  if (session) return session.selectedChatIds();
  return [...stubAutoReply.entries()].filter(([, v]) => v).map(([id]) => id);
}

function isChatSelected(chatId: string): boolean {
  if (session) return session.selectedChatIds().includes(chatId);
  return stubAutoReply.get(chatId) === true;
}

function isGroupChat(chatId: string): boolean {
  if (session) {
    const chat = session.listChats().find((c) => c.id === chatId);
    if (chat) return chat.isGroup;
  } else {
    const chat = stubChats.find((c) => c.id === chatId);
    if (chat) return chat.isGroup;
  }
  return chatId.endsWith("@g.us");
}

function syncStubSelection(chatIds: string[]): { ok: true; chatIds: string[] } {
  stubAutoReply.clear();
  for (const id of chatIds) stubAutoReply.set(id, true);
  for (const c of stubChats) {
    c.autoReply = stubAutoReply.get(c.id) ?? false;
  }
  return { ok: true as const, chatIds: [...stubAutoReply.keys()] };
}

async function sendMessage(chatId: string, text: string): Promise<{ messageId: string }> {
  if (session) return session.sendText(chatId, text);
  if (stubWa) {
    // Pipeline records outbound after a successful send; stub only fakes the id.
    return { messageId: `stub-out-${Date.now()}` };
  }
  const err = new Error("WhatsApp not connected") as Error & { code: number };
  err.code = -32010;
  throw err;
}

const pipeline = new MessagePipeline(
  {
    store: messageStore,
    engine: replyEngine,
    sendText: sendMessage,
    isSelected: isChatSelected,
    selectedCount: () => selectedChatIds().length,
    isGroup: isGroupChat,
  },
  { enabled: false },
);

const rpc = new RpcServer(token, {
  getStatus,
  listChats,
  setAutoReply: ({ chatId, enabled }) => {
    if (session) session.setAutoReply(chatId, enabled);
    else {
      stubAutoReply.set(chatId, enabled);
      const chat = stubChats.find((c) => c.id === chatId);
      if (chat) chat.autoReply = enabled;
    }
    rpc.notify("pipeline.status", pipeline.getStatus());
    return { ok: true as const, chatId, enabled };
  },
  syncSelection: ({ chatIds }) => {
    if (session) {
      session.syncSelection(chatIds);
      rpc.notify("pipeline.status", pipeline.getStatus());
      return { ok: true as const, chatIds: session.selectedChatIds() };
    }
    const result = syncStubSelection(chatIds);
    rpc.notify("pipeline.status", pipeline.getStatus());
    return result;
  },
  sendMessage: async ({ chatId, text }) => sendMessage(chatId, text),
  reconnect: async () => {
    if (stubWa) {
      stubStatus = { state: "qr", me: null, lastError: null };
      rpc.notify("session.status", stubStatus);
      rpc.notify("qr.update", {
        qr: "IAZAP-STUB-QR-PLACEHOLDER-scan-disabled-in-stub-mode",
      });
      return stubStatus;
    }
    if (!session) {
      session = wireSession(new WhatsAppSession(authDir));
    }
    return session.reconnect();
  },
  logout: async () => {
    if (stubWa) {
      stubStatus = {
        state: "logged_out",
        me: null,
        lastError: null,
      };
      rpc.notify("session.status", stubStatus);
      rpc.notify("qr.update", { qr: null });
      return stubStatus;
    }
    if (!session) {
      session = wireSession(new WhatsAppSession(authDir));
    }
    return session.logout();
  },
  pipelineGetStatus: () => pipeline.getStatus(),
  pipelineSetEnabled: ({ enabled }) => pipeline.setEnabled(enabled),
  pipelineConfigure: (params) => pipeline.configure(params),
  pipelineGetActivity: (limit) => ({ activities: pipeline.getActivity(limit) }),
  pipelineSimulateInbound: async ({ chatId, text, fromMe, isGroup }) => {
    const messageId = `sim-${Date.now()}`;
    const inbound: InboundMessage = {
      chatId,
      messageId,
      text,
      fromMe: Boolean(fromMe),
      timestamp: Date.now(),
    };
    rpc.notify("messages.inbound", inbound);
    pipeline.handleInbound(inbound, {
      isGroup: typeof isGroup === "boolean" ? isGroup : isGroupChat(chatId),
    });
    // Touch stub chat preview
    const chat = stubChats.find((c) => c.id === chatId);
    if (chat) {
      chat.lastMessagePreview = text.slice(0, 120);
      chat.lastMessageAt = inbound.timestamp;
      rpc.notify("chats.updated", { chats: listChats() });
    }
    return { ok: true as const, messageId };
  },
});

pipeline.on("status", (status) => {
  rpc.notify("pipeline.status", status);
});
pipeline.on("activity", (activity) => {
  rpc.notify("pipeline.activity", activity);
});

function wireSession(s: WhatsAppSession): WhatsAppSession {
  s.on("status", (status: SessionStatus) => {
    rpc.notify("session.status", status);
  });
  s.on("qr", (qr: string | null) => {
    rpc.notify("qr.update", { qr });
  });
  s.on("inbound", (msg: InboundMessage) => {
    rpc.notify("messages.inbound", msg);
    pipeline.handleInbound(msg, { isGroup: isGroupChat(msg.chatId) });
  });
  s.on("chats", (chats: Chat[]) => {
    rpc.notify("chats.updated", { chats });
  });
  return s;
}

async function main(): Promise<void> {
  await rpc.listen(socketPath);
  console.error(`[iazap-bridge] listening on ${socketPath}`);
  console.error(`[iazap-bridge] auth dir ${authDir}`);
  console.error(`[iazap-bridge] data dir ${dataDir} (engine=${replyEngine.id})`);

  if (stubWa) {
    stubStatus = {
      state: "connected",
      me: { id: "stub@s.whatsapp.net", name: "Stub WA" },
      lastError: null,
    };
    rpc.notify("session.status", stubStatus);
    rpc.notify("qr.update", { qr: null });
    rpc.notify("chats.updated", { chats: listChats() });
    rpc.notify("pipeline.status", pipeline.getStatus());
    console.error("[iazap-bridge] stub WhatsApp mode — no Baileys socket; pipeline send is local-fake");
    return;
  }

  session = wireSession(new WhatsAppSession(authDir));
  await session.start();
  rpc.notify("pipeline.status", pipeline.getStatus());
}

async function shutdown(): Promise<void> {
  await session?.stop();
  messageStore.close();
  await rpc.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error("[iazap-bridge] fatal", err);
  process.exit(1);
});
