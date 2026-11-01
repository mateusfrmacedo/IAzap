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

const DEFAULT_SYSTEM = "Você participa de uma conversa no WhatsApp. Responda em português do Brasil, com clareza e naturalidade. Vá direto ao assunto e acompanhe o tom da conversa sem forçar intimidade. Normalmente uma a três frases curtas bastam; explique mais quando necessário e cubra todos os pedidos.\n\nUma saudação recebe uma saudação simples; um comentário, uma reação específica; um agradecimento, um encerramento breve. Pergunte quando falta um detalhe necessário ou há uma abertura natural. Evite preâmbulos, bajulação, bordões repetidos e ofertas genéricas de ajuda.\n\nUse o histórico disponível sem inventar lembranças, fatos, relações, disponibilidade ou compromissos. Não afirme ter realizado ações externas. Se faltar informação, admita de forma simples. Corrija erros diretamente, respeite mudanças de assunto e responda honestamente se perguntarem sobre a automação.";

export function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM;
}

/**
 * Placeholder PT-BR engine used when mlx-service is offline / forced via ZAPIA_ENGINE=stub.
 */
export class StubReplyEngine implements ReplyEngine {
  readonly id = "stub";

  async generate(req: ReplyRequest): Promise<string> {
    const preview = truncate(req.latestUserText.trim() || "(vazio)", 72);
    const n = req.turns.length;
    return (
      `ZapIA (stub PT-BR): recebi “${preview}”. ` +
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
