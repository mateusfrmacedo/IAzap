/**
 * End-to-end IPC smoke for Phase 3 pipeline (stub WA).
 *
 * Usage (from bridge/):
 *   npm run smoke:pipeline
 */

import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const bridgeRoot = path.resolve(__dirname, "..");
const socketPath = path.join(os.tmpdir(), `iazap-smoke-${process.pid}.sock`);
const token = "smoke-token";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "iazap-smoke-data-"));

type RpcMsg = {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
  method?: string;
};

class RpcClient {
  private socket: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: RpcMsg) => void; reject: (e: Error) => void }>();

  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line) as RpcMsg;
        if (msg.id != null && this.pending.has(Number(msg.id))) {
          const p = this.pending.get(Number(msg.id))!;
          this.pending.delete(Number(msg.id));
          p.resolve(msg);
        }
      }
    });
  }

  static connect(pathName: string): Promise<RpcClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pathName);
      socket.once("connect", () => resolve(new RpcClient(socket)));
      socket.once("error", reject);
    });
  }

  call(method: string, params: unknown): Promise<RpcMsg> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 8_000);
      this.pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject,
      });
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  end(): void {
    this.socket.end();
  }
}

async function waitForSocket(maxMs = 5_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (fs.existsSync(socketPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("bridge did not create socket");
}

async function main(): Promise<void> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", path.join(bridgeRoot, "src/index.ts")],
    {
      cwd: bridgeRoot,
      env: {
        ...process.env,
        IAZAP_SOCKET: socketPath,
        IAZAP_TOKEN: token,
        IAZAP_STUB_WA: "1",
        IAZAP_DATA: dataDir,
        IAZAP_AUTH: path.join(dataDir, "auth"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString("utf8");
  });

  try {
    await waitForSocket();
    await new Promise((r) => setTimeout(r, 150));

    const client = await RpcClient.connect(socketPath);

    const hello = await client.call("session.hello", {
      token,
      client: "iazap-macos",
      protocolVersion: 1,
    });
    if (hello.error) throw new Error(JSON.stringify(hello.error));

    const chatId = "5511999999999@s.whatsapp.net";
    const sync = await client.call("chats.syncSelection", { chatIds: [chatId] });
    if (sync.error) throw new Error(JSON.stringify(sync.error));

    const cfg = await client.call("pipeline.configure", {
      enabled: true,
      debounceMs: 80,
      cooldownMs: 0,
      contextSize: 6,
    });
    if (cfg.error) throw new Error(JSON.stringify(cfg.error));

    const sim = await client.call("pipeline.simulateInbound", {
      chatId,
      text: "Smoke teste Phase 3",
    });
    if (sim.error) throw new Error(JSON.stringify(sim.error));

    await new Promise((r) => setTimeout(r, 400));

    const activity = await client.call("pipeline.getActivity", { limit: 20 });
    if (activity.error) throw new Error(JSON.stringify(activity.error));
    const activities = (activity.result as { activities: Array<{ kind: string }> }).activities;
    const kinds = activities.map((a) => a.kind);
    if (!kinds.includes("sent")) {
      throw new Error(`expected sent activity, got: ${kinds.join(",")}\n${stderr}`);
    }

    const status = await client.call("pipeline.getStatus", {});
    if (status.error) throw new Error(JSON.stringify(status.error));
    const st = status.result as { enabled: boolean; engineId: string };
    if (!st.enabled || st.engineId !== "stub") {
      throw new Error(`bad status: ${JSON.stringify(st)}`);
    }

    console.log("smoke:pipeline OK", { kinds: kinds.slice(0, 8), engineId: st.engineId });
    client.end();
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    if (fs.existsSync(socketPath)) {
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    }
  }
}

main().catch((err) => {
  console.error("smoke:pipeline FAILED", err);
  process.exit(1);
});
