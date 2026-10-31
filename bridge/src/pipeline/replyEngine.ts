/**
 * Pluggable reply engine. Phase 3 ships StubReplyEngine (PT-BR placeholder).
 * Phase 4 swaps in an MLX-backed implementation behind the same interface.
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
  /** Stable id reported in pipeline.status (e.g. "stub", "mlx-qwen2.5-3b"). */
  readonly id: string;
  generate(req: ReplyRequest): Promise<string>;
}

const DEFAULT_SYSTEM =
  "Você é um assistente que responde no WhatsApp em português do Brasil. Seja breve e natural.";

export function defaultSystemPrompt(): string {
  return DEFAULT_SYSTEM;
}

/**
 * Phase 3 stub: returns a short Portuguese acknowledgement that mentions
 * context size + a preview of the latest user text. No network / no MLX.
 */
export class StubReplyEngine implements ReplyEngine {
  readonly id = "stub";

  async generate(req: ReplyRequest): Promise<string> {
    const preview = truncate(req.latestUserText.trim() || "(vazio)", 72);
    const n = req.turns.length;
    return (
      `IAZAP (stub PT-BR): recebi “${preview}”. ` +
      `Usei ${n} msg(ns) de contexto. ` +
      `Na Fase 4 isso será gerado pelo MLX local.`
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
