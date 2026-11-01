import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { AppleReplyEngine, APPLE_MODEL_ID } from "./appleEngine.js";
import { SelectableReplyEngine } from "./selectableEngine.js";
import type { ReplyRequest } from "./replyEngine.js";

const request: ReplyRequest = {
  chatId: "local-test", systemPrompt: "Responda em português.",
  turns: [{ role: "user", text: "Olá", timestamp: 1 }],
  latestUserText: "Olá", contextString: "contato: Olá",
};

function helper(t: { after: (fn: () => void) => void }, result?: object, malformed = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zapia-apple-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "helper.cjs");
  fs.writeFileSync(file, `#!${process.execPath}\nlet input='';process.stdin.on('data',s=>input+=s);process.stdin.on('end',()=>{const r=JSON.parse(input);console.log(${malformed ? "'invalid-json'" : result ? JSON.stringify(JSON.stringify(result)) : "JSON.stringify(r.method==='status'?{state:'ready'}:{state:'ready',text:r.systemPrompt+' '+r.turns.at(-1).text})"});});\n`, { mode: 0o700 });
  return file;
}

it("Apple helper receives prompt/history and reports its own backend", async (t) => {
  const engine = new AppleReplyEngine(helper(t));
  assert.equal((await engine.refresh()).state, "ready");
  assert.equal(engine.getStatus().backend, "apple");
  assert.equal(await engine.generate(request), "Responda em português. Olá");
});

it("Apple unavailability never falls back to stub or MLX", async (t) => {
  const engine = new SelectableReplyEngine({ mode: "stub", appleHelperPath: helper(t, { state: "unavailable", error: "Ative Apple Intelligence" }) });
  const status = await engine.setModelId(APPLE_MODEL_ID);
  assert.equal(status.backend, "apple");
  assert.equal(status.state, "unavailable");
  await assert.rejects(engine.generate(request), /Ative Apple Intelligence/);
  assert.equal(engine.id, "apple:foundation-models");
});

it("missing helper and malformed responses surface actionable errors", async (t) => {
  const missing = new AppleReplyEngine("/nonexistent/zapia-apple-engine");
  assert.equal((await missing.refresh()).state, "unavailable");
  await assert.rejects(missing.generate(request), /motor Apple Intelligence/);
  const invalid = new AppleReplyEngine(helper(t, undefined, true));
  await assert.rejects(invalid.generate(request), /Resposta inválida/);
  const empty = new AppleReplyEngine(helper(t, { state: "ready", text: " " }));
  await assert.rejects(empty.generate(request), /resposta vazia/);
});

it("switches MLX → Apple → MLX without passing Apple IDs to the Python service", async (t) => {
  let modelId = "qwen2.5-7b-instruct-4bit";
  const configured: string[] = [];
  const server = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    if (req.url === "/v1/configure") {
      modelId = JSON.parse(raw).modelId;
      configured.push(modelId);
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/generate" ? { text: "Resposta Qwen" } : {
      state: "ready", modelId, engineId: `mlx:${modelId}`, mlxAvailable: true,
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const engine = new SelectableReplyEngine({ baseUrl: `http://127.0.0.1:${address.port}`, mode: "auto", appleHelperPath: helper(t) });
  assert.equal((await engine.refresh()).backend, "mlx");
  assert.equal(await engine.generate(request), "Resposta Qwen");
  assert.ok(engine.getStatus().availableModels.some((m) => m.id === APPLE_MODEL_ID));
  assert.equal((await engine.setModelId(APPLE_MODEL_ID)).state, "ready");
  assert.match(await engine.generate(request), /Olá/);
  assert.equal(configured.length, 0);
  assert.equal((await engine.reload()).backend, "apple");
  assert.equal((await engine.setModelId(modelId)).backend, "mlx");
  assert.deepEqual(configured, []); // Switching back preserves the already-configured MLX model.
  assert.equal(await engine.generate(request), "Resposta Qwen");
});

it("retries a generic-only completion automatically, without another incoming message", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zapia-style-retry-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "helper.cjs");
  const counter = path.join(dir, "calls");
  fs.writeFileSync(file, `#!${process.execPath}\nconst fs=require('node:fs');let raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=JSON.parse(raw);if(r.method==='status'){console.log(JSON.stringify({state:'ready'}));return;}const file=${JSON.stringify(counter)};const count=fs.existsSync(file)?Number(fs.readFileSync(file,'utf8'))+1:1;fs.writeFileSync(file,String(count));console.log(JSON.stringify({state:'ready',text:count===1?'Como posso ajudar hoje?':'oii'}));});\n`, { mode: 0o700 });
  const engine = new SelectableReplyEngine({ appleHelperPath: file });
  await engine.setModelId(APPLE_MODEL_ID);
  assert.equal(await engine.generate(request), "oii");
  assert.equal(fs.readFileSync(counter, "utf8"), "2");
});

it("uses the explicit name and enforces no emoji even when the engine returns them", async (t) => {
  const engine = new SelectableReplyEngine({ appleHelperPath: helper(t, { state: "ready", text: "Apple e aviões 😄 🇧🇷" }) });
  await engine.setModelId(APPLE_MODEL_ID);
  const systemPrompt = "Seu nome é Mateus, você gosta da Apple e aviões. Você não usa emoji nas conversas! Use emojis quando fizer sentido.";
  assert.equal(await engine.generate({ ...request, systemPrompt, latestUserText: "Qual é seu nome?" }), "Mateus.");
  assert.equal(await engine.generate({ ...request, systemPrompt, latestUserText: "Do que você gosta?" }), "Apple e aviões");
});

it("does not shortcut a name question when another inbound request is still in the same block", async (t) => {
  const engine = new SelectableReplyEngine({ appleHelperPath: helper(t, { state: "ready", text: "Mateus. Minha cor favorita é azul." }) });
  await engine.setModelId(APPLE_MODEL_ID);
  const reply = await engine.generate({ ...request, systemPrompt: "Seu nome é Mateus. Sua cor favorita é azul.",
    turns: [{ role: "user", text: "qual sua cor favorita?", timestamp: 1 }, { role: "user", text: "qual seu nome?", timestamp: 2 }],
    latestUserText: "qual seu nome?" });
  assert.match(reply, /azul/);
});

it("excludes stale model self-descriptions only for direct profile questions", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zapia-profile-context-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "helper.cjs");
  fs.writeFileSync(file, `#!${process.execPath}\nlet raw='';process.stdin.on('data',c=>raw+=c);process.stdin.on('end',()=>{const r=JSON.parse(raw);console.log(JSON.stringify({state:'ready',text:r.turns?.map(t=>t.text).join(' | ')}));});\n`, { mode: 0o700 });
  const engine = new SelectableReplyEngine({ appleHelperPath: file });
  await engine.setModelId(APPLE_MODEL_ID);
  const turns = [{ role: "assistant" as const, text: "Gosto de Android.", timestamp: 1 }];
  const profileRequest = { ...request, systemPrompt: "Seu nome é Mateus. Você gosta da Apple.", turns };
  assert.equal(await engine.generate({ ...profileRequest, latestUserText: "Você gosta de quê?" }), "Você gosta de quê?");
  assert.match(await engine.generate({ ...profileRequest, latestUserText: "do que você gosta nesse projeto?" }), /Android/);
});
