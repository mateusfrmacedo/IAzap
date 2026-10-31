import { it } from "node:test";
import assert from "node:assert/strict";
import { stripServiceOffers } from "./conversationStyle.js";

it("removes stock service closings and keeps the conversational reply", () => {
  assert.equal(stripServiceOffers("Ótimo! Agora você pode me chamar quando precisar de verdade! 😄"), "Ótimo! 😄");
  assert.equal(stripServiceOffers("A reunião é amanhã. Se precisar de algo, é só chamar!"), "A reunião é amanhã.");
  assert.equal(stripServiceOffers("Como posso ajudar hoje?"), "");
  assert.equal(stripServiceOffers("Olá, como posso te ajudar hoje?"), "");
  assert.equal(stripServiceOffers("Estou aqui para ajudar! 😊"), "");
});
it("preserves substantive conversation, requests for help, and quoted phrases", () => {
  assert.equal(stripServiceOffers("tenta reiniciar o app e abrir de novo"), "tenta reiniciar o app e abrir de novo");
  assert.equal(stripServiceOffers('A expressão "como posso ajudar?" soa formal.'), 'A expressão "como posso ajudar?" soa formal.');
  assert.equal(stripServiceOffers("Se quiser sair hoje, a previsão é de chuva."), "Se quiser sair hoje, a previsão é de chuva.");
});
