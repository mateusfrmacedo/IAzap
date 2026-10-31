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

const DEFAULT_SYSTEM =
  "Você é o assistente de auto-resposta do IAZAP no WhatsApp. " +
  "Responda SEMPRE em português do Brasil. " +
  "Use o histórico da conversa para manter o contexto. " +
  "Seja breve, natural e no tom de mensagem de WhatsApp (curto). " +
  "Não invente fatos. Não mencione que você é uma IA, salvo se perguntarem. " +
  "Não use markdown elaborado. Uma ou poucas frases bastam.";

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
