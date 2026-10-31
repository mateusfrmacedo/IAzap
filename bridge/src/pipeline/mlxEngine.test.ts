/**
 * Unit tests for ManagedReplyEngine / MLX HTTP client (mock mlx-service).
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { ManagedReplyEngine, MLXReplyEngine } from "./mlxEngine.js";
import { StubReplyEngine, defaultSystemPrompt } from "./replyEngine.js";

function startMockMlxServer(opts?: { failGenerate?: boolean }): Promise<{
  url: string;
  close: () => Promise<void>;
  calls: string[];
}> {
  const calls: string[] = [];
  let modelId = "qwen2.5-7b-instruct-4bit";
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    calls.push(`${req.method} ${url}`);
    const send = (code: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(data);
    };

    if (req.method === "GET" && url === "/health") {
      send(200, { ok: true });
      return;
    }
    if (req.method === "GET" && url === "/v1/status") {
      send(200, {
        backend: "mock",
        engineId: `mlx-mock:${modelId}`,
        modelId,
        modelLabel: "Mock Qwen",
        state: "ready",
        mlxAvailable: true,
        memoryNote: "mock",
        lastError: null,
        availableModels: [
          {
            id: "qwen2.5-7b-instruct-4bit",
            label: "7B",
            hfRepo: "mlx-community/Qwen2.5-7B-Instruct-4bit",
            memoryHint: "note",
          },
          {
            id: "qwen2.5-3b-instruct-4bit",
            label: "3B",
            hfRepo: "mlx-community/Qwen2.5-3B-Instruct-4bit",
            memoryHint: "note",
          },
        ],
      });
      return;
    }
    if (req.method === "POST" && url === "/v1/configure") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw || "{}") as { modelId?: string };
        if (body.modelId) modelId = body.modelId;
        send(200, {
          backend: "mock",
          engineId: `mlx-mock:${modelId}`,
          modelId,
          modelLabel: modelId,
          state: "not_loaded",
          mlxAvailable: true,
          memoryNote: "mock",
          lastError: null,
          availableModels: [],
        });
      });
      return;
    }
    if (req.method === "POST" && url === "/v1/reload") {
      send(200, {
        backend: "mock",
        engineId: `mlx-mock:${modelId}`,
        modelId,
        modelLabel: modelId,
        state: "ready",
        mlxAvailable: true,
        memoryNote: "mock",
        lastError: null,
        availableModels: [],
      });
      return;
    }
    if (req.method === "POST" && url === "/v1/generate") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (opts?.failGenerate) {
          send(503, { error: "modelo ausente" });
          return;
        }
        const body = JSON.parse(raw || "{}") as {
          turns?: Array<{ role: string; text: string }>;
        };
        const last = [...(body.turns ?? [])].reverse().find((t) => t.role === "user");
        send(200, {
          text: `Resposta MLX mock: ${last?.text ?? ""}`,
          engineId: `mlx-mock:${modelId}`,
        });
      });
      return;
    }
    send(404, { error: "nope" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () =>
          new Promise((r, j) => server.close((err) => (err ? j(err) : r()))),
      });
    });
  });
}

describe("defaultSystemPrompt", () => {
  it("requires Portuguese and WhatsApp-style brevity", () => {
    const p = defaultSystemPrompt();
    assert.match(p, /português/i);
    assert.match(p, /WhatsApp/i);
    assert.match(p, /breve|curto/i);
  });
});

describe("StubReplyEngine (Phase 4 copy)", () => {
  it("mentions mlx-service fallback", async () => {
    const engine = new StubReplyEngine();
    const text = await engine.generate({
      chatId: "x@s.whatsapp.net",
      systemPrompt: "pt",
      turns: [{ role: "user", text: "oi", timestamp: 1 }],
      contextString: "contato: oi",
      latestUserText: "oi",
    });
    assert.match(text, /stub PT-BR/);
    assert.match(text, /mlx-service/);
  });
});

describe("MLXReplyEngine against mock service", () => {
  let mock: Awaited<ReturnType<typeof startMockMlxServer>>;

  before(async () => {
    mock = await startMockMlxServer();
  });

  after(async () => {
    await mock.close();
  });

  it("generates via HTTP", async () => {
    const engine = new MLXReplyEngine({ baseUrl: mock.url });
    const text = await engine.generate({
      chatId: "a@s.whatsapp.net",
      systemPrompt: defaultSystemPrompt(),
      turns: [
        { role: "user", text: "tudo bem?", timestamp: 1 },
      ],
      contextString: "contato: tudo bem?",
      latestUserText: "tudo bem?",
    });
    assert.match(text, /tudo bem/);
    assert.match(engine.id, /mlx-mock/);
  });

  it("configure + reload update status", async () => {
    const engine = new MLXReplyEngine({ baseUrl: mock.url });
    const cfg = await engine.configure("qwen2.5-3b-instruct-4bit");
    assert.equal(cfg.modelId, "qwen2.5-3b-instruct-4bit");
    const reloaded = await engine.reload();
    assert.equal(reloaded.state, "ready");
  });
});

describe("ManagedReplyEngine", () => {
  it("falls back to stub when service is down (auto)", async () => {
    const engine = new ManagedReplyEngine({
      mode: "auto",
      baseUrl: "http://127.0.0.1:1",
    });
    const status = await engine.refresh();
    assert.equal(status.backend, "stub");
    assert.equal(status.engineId, "stub");
    assert.ok(status.lastError);

    const text = await engine.generate({
      chatId: "z@s.whatsapp.net",
      systemPrompt: defaultSystemPrompt(),
      turns: [],
      contextString: "",
      latestUserText: "teste fallback",
    });
    assert.match(text, /stub PT-BR/);
  });

  it("uses mlx when mock service is ready", async () => {
    const mock = await startMockMlxServer();
    try {
      const engine = new ManagedReplyEngine({
        mode: "auto",
        baseUrl: mock.url,
      });
      const status = await engine.refresh();
      assert.equal(status.backend, "mlx");
      assert.match(status.engineId, /mlx/);
      assert.equal(status.state, "ready");

      const text = await engine.generate({
        chatId: "z@s.whatsapp.net",
        systemPrompt: defaultSystemPrompt(),
        turns: [{ role: "user", text: "olá mlx", timestamp: 1 }],
        contextString: "contato: olá mlx",
        latestUserText: "olá mlx",
      });
      assert.match(text, /olá mlx/);
      assert.match(text, /MLX mock/i);
    } finally {
      await mock.close();
    }
  });

  it("mlx mode surfaces generate errors instead of silent stub", async () => {
    const mock = await startMockMlxServer({ failGenerate: true });
    try {
      const engine = new ManagedReplyEngine({
        mode: "mlx",
        baseUrl: mock.url,
      });
      await engine.refresh();
      await assert.rejects(
        () =>
          engine.generate({
            chatId: "z@s.whatsapp.net",
            systemPrompt: defaultSystemPrompt(),
            turns: [{ role: "user", text: "x", timestamp: 1 }],
            contextString: "",
            latestUserText: "x",
          }),
        /modelo ausente|MLX generate/i,
      );
    } finally {
      await mock.close();
    }
  });
});
