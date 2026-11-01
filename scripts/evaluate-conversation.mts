// Synthetic, local-only conversation checks. Does not connect to WhatsApp or read chats.
import fs from "node:fs";
import assert from "node:assert/strict";
import { SelectableReplyEngine } from "../bridge/src/pipeline/selectableEngine.js";
import type { ContextTurn } from "../bridge/src/pipeline/replyEngine.js";

const systemPrompt = "Seu nome é Mateus. Você gosta da Apple e de aviões. Sua cor favorita é azul. Sem emojis. Converse de forma natural e breve.";
const forbidden = /como posso (?:te )?ajudar|em que posso ajudar|estou aqui para ajudar|posso ajudar em mais|se precisar de algo|precisando de mais alguma coisa/i;
const rows: Array<{ model: string; scenario: string; input: string; reply: string; ms: number; error?: string }> = [];
const engine = new SelectableReplyEngine({ mode: "mlx" });
const models = (process.env.ZAPIA_EVAL_MODELS ?? "apple-intelligence,qwen2.5-7b-instruct-4bit").split(",");
const user = (text: string, timestamp = 1): ContextTurn => ({ role: "user", text, timestamp });
const assistant = (text: string, timestamp = 2): ContextTurn => ({ role: "assistant", text, timestamp });
for (const model of models) {
  const status = await engine.setModelId(model);
  assert.notEqual(status.backend, "stub", "evaluation must use a real model");
  async function check(scenario: string, turns: ContextTurn[], validate: (reply: string) => void): Promise<string> {
    const input = turns.at(-1)!.text, start = Date.now();
    let reply = "", error: string | undefined;
    try {
      reply = await engine.generate({ chatId: `synthetic-${scenario}`, systemPrompt, turns: turns.slice(-12), latestUserText: input, contextString: "" });
      assert.ok(reply.trim());
      assert.doesNotMatch(reply, forbidden);
      assert.doesNotMatch(reply, /\p{Extended_Pictographic}|\p{Regional_Indicator}/u);
      validate(reply);
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    rows.push({ model, scenario, input, reply, ms: Date.now() - start, ...(error ? { error } : {}) });
    console.log(`${error ? "FAIL" : "PASS"} ${model} | ${scenario} | ${reply}${error ? ` | ${error}` : ""}`);
    return reply;
  }
  await check("saudacao", [user("oi")], reply => {
    assert.ok(reply.split(/\s+/).length <= 18);
    assert.doesNotMatch(reply, /(?:ol[aá]|oi)[,!]?\s+Mateus/i, "must not greet the contact using the speaker's name");
  });
  await check("relato-do-dia", [user("hoje foi bem corrido")], reply => {
    assert.doesNotMatch(reply, /não (?:tenho|sei)|qual [eé]|agradeço|at[eé] logo|voar|voo|Apple/i);
  });
  const flow: ContextTurn[] = [user("me explica em duas linhas o que é uma API")];
  const explanation = await check("explicacao", flow, reply => assert.match(reply, /sistemas?|programas?|aplic|comunic|dados/i));
  flow.push(assistant(explanation), user("não entendi, dá um exemplo mais simples", 3));
  const simpler = await check("simplificar", flow, reply => {
    assert.ok(reply !== explanation);
    assert.match(reply, /exemplo|imagin|pensa|como|app|restaurante|gar[cç]om/i);
  });
  flow.push(assistant(simpler, 4), user("boa, valeu, era só isso", 5));
  await check("encerramento", flow, reply => {
    assert.ok(reply.split(/\s+/).length <= 16);
    assert.doesNotMatch(reply, /\?/);
    assert.doesNotMatch(reply, /obrigad[oa] pel[ao] (?:explica[cç][aã]o|esclarecimento)|necessidade de explica[cç][aã]o/i, "closing must acknowledge thanks, not invert who gave the explanation");
  });
  await check("sem-agenda", [user("agenda uma reunião amanhã às 15h com Marcos")], reply => {
    assert.match(reply, /n[aã]o (?:consigo|posso|tenho acesso)|sem (?:acesso|ferramenta)|n[aã]o.*(?:ferramenta|acesso).*agenda/i);
    assert.doesNotMatch(reply, /(?:j[aá] )?(?:agendei|marquei|est[aá] agendad|reuni[aã]o confirmada)/i);
  });
  const missing = Array.from({ length: 6 }, (_, i) => [user(`teste neutro ${i}`, i * 2), assistant("certo", i * 2 + 1)]).flat();
  await check("contexto-ausente", [...missing, user("qual era o sabor favorito que te falei no começo?", 20)], reply => {
    assert.match(reply, /n[aã]o|lembra|qual|conta/i);
    assert.doesNotMatch(reply, /chocolate|morango|baunilha|nunca.*contou|n[aã]o.*contou/i);
    assert.doesNotMatch(reply, /azul|Apple|avi[oõ]es/i, "missing preference must not bring unrelated profile facts into the reply");
  });
  await check("bloco-de-pedidos", [user("qual sua cor favorita?"), user("e você gosta de quê?", 2)], reply => {
    assert.match(reply, /azul/i); assert.match(reply, /Apple/i); assert.match(reply, /avi[oõ]es|avia[cç][aã]o/i);
  });
  await check("correcao-explicita", [user("o evento é terça"), assistant("O evento é quarta."), user("era terça, não quarta", 3)], reply => {
    assert.match(reply, /ter[cç]a/i); assert.doesNotMatch(reply, /\?/);
  });
  await check("mudar-assunto", [user("me explica API"), assistant("API conecta sistemas."), user("esquece API, qual sua cor favorita?", 3)], reply => {
    assert.match(reply, /azul/i); assert.doesNotMatch(reply, /API|sistemas/i);
    assert.doesNotMatch(reply, /(?:a )?sua cor favorita/i, "speaker and contact must remain distinct");
  });
}
if (process.env.ZAPIA_EVAL_OUTPUT) fs.writeFileSync(process.env.ZAPIA_EVAL_OUTPUT, JSON.stringify({ date: "2026-11-01", synthetic: true, rows }, null, 2) + "\n");
assert.equal(rows.filter(row => row.error).length, 0, "some conversation scenarios failed; inspect the outputs");
