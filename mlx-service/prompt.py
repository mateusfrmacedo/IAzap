"""Chat prompt helpers for Qwen2.5 Instruct (ChatML-style)."""

from __future__ import annotations

from typing import Any

DEFAULT_SYSTEM_PROMPT = 'Você participa de uma conversa casual no WhatsApp. Responda em português do Brasil, de forma breve, espontânea e ligada à última mensagem.\n\nNão escreva como assistente, suporte, consultora ou atendimento. Nunca ofereça ajuda genérica nem envie frases como "Como posso ajudar hoje?", "Em que posso ajudar?", "Estou aqui para ajudar", "Se precisar de algo, é só chamar" ou "Posso ajudar em mais alguma coisa?". Se pedirem algo, responda diretamente, sem anunciar que está ajudando.\n\nUma saudação recebe uma saudação simples. Um comentário recebe uma reação específica. Não transforme toda resposta em pergunta. Normalmente uma ou duas frases curtas bastam. Acompanhe o tom, o uso de minúsculas e a informalidade da conversa. Use humor ou carinho quando fizer sentido, sem intimidade forçada. Use emojis apenas se a outra pessoa usar, sem exagero.\n\nNão repita a mensagem, não faça apresentações, listas, preâmbulos ou despedidas automáticas. Não explique seu processo nem inclua tags ou nomes de ferramentas. Não invente fatos, lembranças, relações, disponibilidade ou compromissos. Se faltar um detalhe indispensável, faça uma pergunta curta. Se perguntarem sobre a automação, responda honestamente.\n\nExemplos de tom, não respostas fixas: "oi" → "oii"; "agora entendi" → "boa!"; "hoje foi puxado" → "poxa, dia daqueles então". Não acrescente uma pergunta automática ao final.'


def build_chatml(system_prompt: str, turns: list[dict[str, Any]]) -> str:
    """Build a ChatML string ending so the model continues as assistant."""
    system = (system_prompt or DEFAULT_SYSTEM_PROMPT).strip()
    parts: list[str] = [
        f"<|im_start|>system\n{system}<|im_end|>",
    ]
    for turn in turns:
        role = turn.get("role") or "user"
        text = str(turn.get("text") or "").strip()
        if not text:
            continue
        if role not in ("user", "assistant", "system"):
            role = "user"
        parts.append(f"<|im_start|>{role}\n{text}<|im_end|>")
    parts.append("<|im_start|>assistant\n")
    return "\n".join(parts)


def mock_portuguese_reply(latest_user: str, turn_count: int) -> str:
    """Deterministic PT-BR reply used when ZAPIA_MLX_MOCK=1 (no Metal)."""
    preview = (latest_user or "").strip().replace("\n", " ")
    if len(preview) > 80:
        preview = preview[:79] + "…"
    if not preview:
        preview = "(mensagem vazia)"
    return (
        f"Entendi: “{preview}”. "
        f"(mock MLX local, {turn_count} msg de contexto) "
        "Posso ajudar em português."
    )
