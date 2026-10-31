/**
 * IAZAP WhatsApp bridge entrypoint.
 *
 * Env:
 *   IAZAP_SOCKET  — Unix socket path (default: $TMPDIR/iazap-bridge.sock)
 *   IAZAP_TOKEN   — session token required by session.hello
 *   IAZAP_AUTH    — Baileys multi-file auth directory
 *   IAZAP_STUB_WA — if "1", skip real Baileys connect (UI/IPC smoke only)
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { RpcServer } from "./rpc/server.js";
import { WhatsAppSession } from "./whatsapp/session.js";
import type { Chat, SessionStatus } from "./protocol/types.js";

const socketPath =
  process.env.IAZAP_SOCKET ?? path.join(os.tmpdir(), "iazap-bridge.sock");
const token = process.env.IAZAP_TOKEN ?? "dev-token-change-me";
const authDir =
  process.env.IAZAP_AUTH ?? path.join(os.homedir(), ".iazap", "baileys-auth");
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

const rpc = new RpcServer(token, {
  getStatus,
  listChats,
  setAutoReply: ({ chatId, enabled }) => {
    if (session) session.setAutoReply(chatId, enabled);
    else stubAutoReply.set(chatId, enabled);
    return { ok: true as const, chatId, enabled };
  },
  sendMessage: async ({ chatId, text }) => {
    if (session) return session.sendText(chatId, text);
    const err = new Error("WhatsApp not connected (stub)") as Error & { code: number };
    err.code = -32010;
    throw err;
  },
});

async function main(): Promise<void> {
  await rpc.listen(socketPath);
  console.error(`[iazap-bridge] listening on ${socketPath}`);

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
    console.error("[iazap-bridge] stub WhatsApp mode — no Baileys socket");
    return;
  }

  session = new WhatsAppSession(authDir);
  session.on("status", (status: SessionStatus) => {
    rpc.notify("session.status", status);
  });
  session.on("qr", (qr: string | null) => {
    rpc.notify("qr.update", { qr });
  });
  session.on("inbound", (msg) => {
    rpc.notify("messages.inbound", msg);
  });

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
