import { it } from "node:test";
import assert from "node:assert/strict";
import { configuredName, forbidsEmoji, removeEmoji, preparePersonaRequest, profileNameReply } from "./persona.js";
import type { ReplyRequest } from "./replyEngine.js";

const profile = "Seu nome é Mateus, você gosta da Apple e de aviões, sua cor favorita é azul. Você não usa emoji nas conversas! Use emojis apenas se a outra pessoa usar.";
const request: ReplyRequest = { chatId: "test", systemPrompt: profile,
  turns: [{ role: "assistant", text: "Meu nome é Alex", timestamp: 1 }, { role: "user", text: "Qual é seu nome?", timestamp: 2 }],
  contextString: "", latestUserText: "Qual é seu nome?" };

it("reads the configured name dynamically and does not infer identity from history", () => {
  assert.equal(configuredName(profile), "Mateus");
  assert.equal(configuredName("Seu nome é João da Silva. Você gosta da Apple."), "João da Silva");
  assert.equal(configuredName("Nome: Luna\nNão use emojis"), "Luna");
  assert.equal(configuredName("Seu nome era Alex."), null);
  assert.equal(profileNameReply(request), "Mateus.");
  assert.equal(profileNameReply({ ...request, latestUserText: "Oi, qual seu nome? 😊" }), "Mateus.");
  assert.equal(profileNameReply({ ...request, systemPrompt: "Seu nome é Luna.", latestUserText: "Como você se chama?" }), "Luna.");
  assert.equal(profileNameReply({ ...request, latestUserText: "Qual é meu nome?" }), null);
  assert.equal(profileNameReply({ ...request, latestUserText: "Qual seu nome e sua cor favorita?" }), null);
  assert.equal(profileNameReply({ ...request, latestUserText: "Você é humano?" }), null);
});
it("explicit no-emoji preferences override generic suggestions to use emojis", () => {
  assert.equal(forbidsEmoji(profile), true);
  assert.equal(forbidsEmoji("Não deve usar nenhum emoji."), true);
  assert.equal(forbidsEmoji("Sem emojis"), true);
  assert.equal(forbidsEmoji("Use emojis apenas se fizer sentido."), false);
  assert.equal(forbidsEmoji("Não use emojis em excesso."), false);
  assert.equal(removeEmoji("Apple, aviões e azul 😄 🇧🇷 👍🏽 👨‍👩‍👧‍👦 1️⃣"), "Apple, aviões e azul");
  assert.equal(removeEmoji("Ação às 14:30, voo 123."), "Ação às 14:30, voo 123.");
});
it("places current profile above conflicting history without deleting conversation turns", () => {
  const prepared = preparePersonaRequest(request);
  assert.ok(prepared.systemPrompt.includes(profile));
  assert.deepEqual(prepared.turns, request.turns);
  assert.equal(request.systemPrompt, profile);
});

it("keeps the latest user message last despite same-second timestamp sorting", () => {
  const user = { role: "user" as const, text: "qual sua cor favorita?", timestamp: 1000 };
  const oldReply = { role: "assistant" as const, text: "Meu nome é Alex.", timestamp: 1700 };
  const prepared = preparePersonaRequest({ ...request, latestUserText: user.text, turns: [user, oldReply] });
  assert.deepEqual(prepared.turns, [oldReply, user]);
  assert.deepEqual([user, oldReply].map(t => t.role), ["user", "assistant"]);
});
