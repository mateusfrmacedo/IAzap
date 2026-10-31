/**
 * Pluggable reply engine.
 * Phase 3: StubReplyEngine. Phase 4: MLX via ManagedReplyEngine (mlxEngine.ts).
 */

export interface ContextTurn {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

export interface ReplyRequest {
  chatId: string;
  systemPrompt: string;
  /** Chronological turns for the model / stub. */
  turns: ContextTurn[];
  /** Compact context string (also available for stubs / logging). */
  contextString: string;
  latestUserText: string;
}

export interface ReplyEngine {
  /** Stable id reported in pipeline.status (e.g. "stub", "mlx:qwen2.5-7b-instruct-4bit"). */
  readonly id: string;
  generate(req: ReplyRequest): Promise<string>;
}

const DEFAULT_SYSTEM = "Você participa de uma conversa casual no WhatsApp. Responda em português do Brasil, de forma breve, espontânea e ligada à última mensagem.\n\nNão escreva como assistente, suporte, consultora ou atendimento. Nunca ofereça ajuda genérica nem envie frases como \"Como posso ajudar hoje?\", \"Em que posso ajudar?\", \"Estou aqui para ajudar\", \"Se precisar de algo, é só chamar\" ou \"Posso ajudar em mais alguma coisa?\". Se pedirem algo, responda diretamente, sem anunciar que está ajudando.\n\nUma saudação recebe uma saudação simples. Um comentário recebe uma reação específica. Não transforme toda resposta em pergunta. Normalmente uma ou duas frases curtas bastam. Acompanhe o tom, o uso de minúsculas e a informalidade da conversa. Use humor ou carinho quando fizer sentido, sem intimidade forçada. Use emojis apenas se a outra pessoa usar, sem exagero.\n\nNão repita a mensagem, não faça apresentações, listas, preâmbulos ou despedidas automáticas. Não explique seu processo nem inclua tags ou nomes de ferramentas. Não invente fatos, lembranças, relações, disponibilidade ou compromissos. Se faltar um detalhe indispensável, faça uma pergunta curta. Se perguntarem sobre a automação, responda honestamente.\n\nExemplos de tom, não respostas fixas: \"oi\" → \"oii\"; \"agora entendi\" → \"boa!\"; \"hoje foi puxado\" → \"poxa, dia daqueles então\". Não acrescente uma pergunta automática ao final.";

export function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM;
}

/**
 * Placeholder PT-BR engine used when mlx-service is offline / forced via IAZAP_ENGINE=stub.
 */
export class StubReplyEngine implements ReplyEngine {
  readonly id = "stub";

  async generate(req: ReplyRequest): Promise<string> {
    const preview = truncate(req.latestUserText.trim() || "(vazio)", 72);
    const n = req.turns.length;
    return (
      `IAZAP (stub PT-BR): recebi “${preview}”. ` +
      `Usei ${n} msg(ns) de contexto. ` +
      `Inicie mlx-service no Mac para respostas MLX reais.`
    );
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Helper to map stored messages → turns for any ReplyEngine. */
export function turnsFromStored(
  msgs: Array<{ fromMe: boolean; direction?: string; text: string; timestamp: number }>,
): ContextTurn[] {
  return msgs.map((m) => ({
    role: m.fromMe || m.direction === "out" ? ("assistant" as const) : ("user" as const),
    text: m.text,
    timestamp: m.timestamp,
  }));
}
