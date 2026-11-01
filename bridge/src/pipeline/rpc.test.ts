import { it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RpcServer, type MethodHandlers } from "../rpc/server.js";

it("replays the latest pairing QR only after authentication, including its removal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zapia-qr-"));
  const socketPath = path.join(dir, "rpc.sock");
  const server = new RpcServer("test-token", {} as MethodHandlers);
  await server.listen(socketPath);
  t.after(async () => { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  // Baileys emits QR before the SwiftUI client is ready.
  server.notify("qr.update", { qr: "pairing-qr" });
  const client = net.createConnection(socketPath);
  t.after(() => client.destroy());
  await new Promise<void>((resolve, reject) => { client.once("connect", resolve); client.once("error", reject); });
  client.setEncoding("utf8");
  let buffer = "";
  const messages: Array<{ id?: number; method?: string; params?: { qr: string | null }; error?: { code: number } }> = [];
  client.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
  });
  async function waitFor(check: () => boolean) {
    for (let i = 0; i < 200; i++) { if (check()) return; await delay(5); }
    assert.fail("Timed out waiting for RPC response");
  }
  const hello = (id: number, token: string) => client.write(JSON.stringify({
    jsonrpc: "2.0", id, method: "session.hello", params: { token, protocolVersion: 1 },
  }) + "\n");
  server.notify("qr.update", { qr: "newest-qr" });
  hello(1, "wrong-token");
  await waitFor(() => messages.some((m) => m.id === 1));
  assert.equal(messages.find((m) => m.id === 1)?.error?.code, -32001);
  assert.equal(messages.filter((m) => m.method === "qr.update").length, 0);
  hello(2, "test-token");
  await waitFor(() => messages.some((m) => m.method === "qr.update"));
  assert.equal(messages.find((m) => m.method === "qr.update")?.params?.qr, "newest-qr");
  server.notify("qr.update", { qr: null });
  await waitFor(() => messages.filter((m) => m.method === "qr.update").length === 2);
  hello(3, "test-token");
  await waitFor(() => messages.filter((m) => m.method === "qr.update").length === 3);
  assert.equal(messages.at(-1)?.params?.qr, null);
  // Malformed JSON-RPC must produce an error without killing the bridge.
  client.write("null\n");
  await waitFor(() => messages.some((m) => m.error?.code === -32600));
});
