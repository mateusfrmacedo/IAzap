import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

it("a slow older model configuration cannot overwrite a newer prompt edit", { timeout: 15000 }, async (t) => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const blocked = new Promise<void>(r => { entered = r; });
  let modelId = "qwen2.5-7b-instruct-4bit";
  const mock = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/v1/configure") {
      modelId = JSON.parse(raw).modelId;
      entered();
      await gate;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ state: "ready", modelId, engineId: `mlx:${modelId}`, mlxAvailable: true }));
  });
  await new Promise<void>(r => mock.listen(0, "127.0.0.1", r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zapia-prompt-sync-"));
  const socketPath = path.join(dir, "rpc.sock");
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../index.ts", import.meta.url))], {
    env: { ...process.env, ZAPIA_STUB_WA: "1", ZAPIA_ENGINE: "auto", ZAPIA_SOCKET: socketPath,
      ZAPIA_TOKEN: "prompt-sync", ZAPIA_AUTH: path.join(dir, "auth"), ZAPIA_DATA: path.join(dir, "data"),
      ZAPIA_MLX_URL: `http://127.0.0.1:${(mock.address() as net.AddressInfo).port}` },
    stdio: "ignore",
  });
  let socket: net.Socket | undefined;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  t.after(async () => {
    release(); socket?.destroy();
    for (const timer of timers) clearTimeout(timer);
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([exited, delay(2000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    mock.closeAllConnections(); mock.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; !fs.existsSync(socketPath); i++) {
    assert.ok(i < 200 && child.exitCode === null, "test bridge did not start");
    await delay(20);
  }
  socket = net.createConnection(socketPath);
  await once(socket, "connect");
  socket.setEncoding("utf8");
  let buffer = "", nextId = 0;
  const pending = new Map<number, (value: any) => void>();
  socket.on("data", data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const done = pending.get(message.id);
      if (done) { pending.delete(message.id); done(message); }
    }
  });
  function call(method: string, params: object = {}): Promise<any> {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 5000);
      timers.add(timer);
      pending.set(id, message => { clearTimeout(timer); timers.delete(timer); message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
      socket!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  await call("session.hello", { token: "prompt-sync", protocolVersion: 1, client: "zapia-macos" });
  const older = call("pipeline.configure", { modelId: "qwen2.5-3b-instruct-4bit", systemPrompt: "Seu nome é Luna." });
  await blocked;
  const prompt = "Seu nome é Mateus.";
  const expected = createHash("sha256").update(prompt).digest("hex");
  assert.equal((await call("pipeline.configure", { systemPrompt: prompt })).systemPromptHash, expected);
  release();
  await older;
  assert.equal((await call("pipeline.getStatus")).systemPromptHash, expected);
});
