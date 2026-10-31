/**
 * IAZAP WhatsApp bridge entrypoint (Phase 2).
 *
 * Env:
 *   IAZAP_SOCKET  — Unix socket path (default: $TMPDIR/iazap-bridge.sock)
 *   IAZAP_TOKEN   — session token required by session.hello
 *   IAZAP_AUTH    — Baileys multi-file auth directory
 *                   (default: ~/Library/Application Support/IAZAP/baileys-auth on macOS)
 *   IAZAP_STUB_WA — if "1", skip real Baileys connect (UI/IPC smoke only)
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { RpcServer } from "./rpc/server.js";
import { WhatsAppSession } from "./whatsapp/session.js";
import type { Chat, SessionStatus } from "./protocol/types.js";

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

const socketPath =
  process.env.IAZAP_SOCKET ?? path.join(os.tmpdir(), "iazap-bridge.sock");
const token = process.env.IAZAP_TOKEN ?? "dev-token-change-me";
const authDir = process.env.IAZAP_AUTH ?? defaultAuthDir();
const stubWa = process.env.IAZAP_STUB_WA === "1";

fs.mkdirSync(authDir, { recursive: true });

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
];

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

function syncStubSelection(chatIds: string[]): { ok: true; chatIds: string[] } {
  stubAutoReply.clear();
  for (const id of chatIds) stubAutoReply.set(id, true);
  for (const c of stubChats) {
    c.autoReply = stubAutoReply.get(c.id) ?? false;
  }
  return { ok: true as const, chatIds: [...stubAutoReply.keys()] };
}

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
    return { ok: true as const, chatId, enabled };
  },
  syncSelection: ({ chatIds }) => {
    if (session) {
      session.syncSelection(chatIds);
      return { ok: true as const, chatIds: session.selectedChatIds() };
    }
    return syncStubSelection(chatIds);
  },
  sendMessage: async ({ chatId, text }) => {
    if (session) return session.sendText(chatId, text);
    const err = new Error("WhatsApp not connected (stub)") as Error & { code: number };
    err.code = -32010;
    throw err;
  },
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
});

function wireSession(s: WhatsAppSession): WhatsAppSession {
  s.on("status", (status: SessionStatus) => {
    rpc.notify("session.status", status);
  });
  s.on("qr", (qr: string | null) => {
    rpc.notify("qr.update", { qr });
  });
  s.on("inbound", (msg) => {
    rpc.notify("messages.inbound", msg);
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

  if (stubWa) {
    stubStatus = {
      state: "qr",
      me: null,
      lastError: null,
    };
    rpc.notify("session.status", stubStatus);
    rpc.notify("qr.update", {
      qr: "IAZAP-STUB-QR-PLACEHOLDER-scan-disabled-in-stub-mode",
    });
    rpc.notify("chats.updated", { chats: listChats() });
    console.error("[iazap-bridge] stub WhatsApp mode — no Baileys socket");
    return;
  }

  session = wireSession(new WhatsAppSession(authDir));
  await session.start();
}

async function shutdown(): Promise<void> {
  await session?.stop();
  await rpc.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

main().catch((err) => {
  console.error("[iazap-bridge] fatal", err);
  process.exit(1);
});
