// Real local persona checks with fabricated history; never sends WhatsApp messages.
import assert from "node:assert/strict";
import { SelectableReplyEngine } from "../bridge/src/pipeline/selectableEngine.js";
import type { ReplyRequest } from "../bridge/src/pipeline/replyEngine.js";
const systemPrompt = "Seu nome é Mateus, você gosta da Apple e de aviões, sua cor favorita é azul, você não usa emoji nas conversas! Converse em português do Brasil, de forma breve e natural. Use emojis se a outra pessoa usar.";
const history = [
  { role: "user" as const, text: "Como você se chama?", timestamp: 1 },
  { role: "assistant" as const, text: "Me chamo Alex. Gosto de Android e minha cor favorita é verde! 😄", timestamp: 2 },
];
const scenarios = [
  { text: "Qual seu nome?", expected: /Mateus/i },
  { text: "Antes você falou outro nome. Qual é seu nome de verdade?", expected: /Mateus/i },
  { text: "Qual sua cor favorita? 😊", expected: /azul/i },
  { text: "Você gosta de quê?", expected: /Apple/i },
];
const engine = new SelectableReplyEngine({ mode: "mlx" });
await engine.refresh();
for (const modelId of ["apple-intelligence", "qwen2.5-7b-instruct-4bit"]) {
  await engine.setModelId(modelId);
  for (const { text, expected } of scenarios) {
    const req: ReplyRequest = { systemPrompt, chatId: "synthetic-persona", latestUserText: text,
      turns: [...history, { role: "user", text, timestamp: 3 }], contextString: "" };
    const reply = await engine.generate(req);
    assert.match(reply, expected);
    assert.doesNotMatch(reply, /\p{Extended_Pictographic}|\p{Regional_Indicator}/u);
    assert.doesNotMatch(reply, /me chama(?:m)? de Alex|meu nome [ée] Alex|sou (?:o )?Alex/i);
    console.log(`${modelId} | ${text} → ${reply}`);
  }
}
