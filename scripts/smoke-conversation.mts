// Real local style checks with synthetic messages. Never connects to WhatsApp.
import assert from "node:assert/strict";
import fs from "node:fs";
import { SelectableReplyEngine } from "../bridge/src/pipeline/selectableEngine.js";
import type { ContextTurn } from "../bridge/src/pipeline/replyEngine.js";

const systemPrompt = fs.readFileSync(new URL("../prompts/conversa-natural.txt", import.meta.url), "utf8");
const forbidden = /como posso (?:te )?ajudar|em que posso ajudar|estou aqui para ajudar|posso ajudar em mais|se precisar de algo|pode me chamar quando precisar/i;
const scenarios: ContextTurn[][] = [
  [{ role: "user", text: "oi", timestamp: 1 }],
  [{ role: "assistant", text: "Se precisar de mais alguma coisa, é só chamar!", timestamp: 1 },
   { role: "user", text: "agora entendi", timestamp: 2 }],
  [{ role: "user", text: "hoje foi bem corrido", timestamp: 1 }],
];
const engine = new SelectableReplyEngine({ mode: "mlx" });
await engine.refresh();
for (const modelId of ["apple-intelligence", "qwen2.5-7b-instruct-4bit"]) {
  const status = await engine.setModelId(modelId);
  assert.notEqual(status.backend, "stub");
  for (const turns of scenarios) {
    const text = await engine.generate({ chatId: "synthetic", systemPrompt, turns,
      latestUserText: turns.at(-1)!.text, contextString: turns.map(t => t.text).join("\n") });
    assert.ok(text.trim());
    assert.doesNotMatch(text, forbidden);
    console.log(`${modelId} | ${turns.at(-1)!.text} → ${text}`);
  }
}
