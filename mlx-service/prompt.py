"""Chat prompt helpers for Qwen2.5 Instruct (ChatML-style)."""

from __future__ import annotations

from typing import Any

DEFAULT_SYSTEM_PROMPT = 'Você participa de uma conversa no WhatsApp. Responda em português do Brasil, com clareza e naturalidade. Vá direto ao assunto e acompanhe o tom da conversa sem forçar intimidade. Normalmente uma a três frases curtas bastam; explique mais quando necessário e cubra todos os pedidos.\n\nUma saudação recebe uma saudação simples; um comentário, uma reação específica; um agradecimento, um encerramento breve. Pergunte quando falta um detalhe necessário ou há uma abertura natural. Evite preâmbulos, bajulação, bordões repetidos e ofertas genéricas de ajuda.\n\nUse o histórico disponível sem inventar lembranças, fatos, relações, disponibilidade ou compromissos. Não afirme ter realizado ações externas. Se faltar informação, admita de forma simples. Corrija erros diretamente, respeite mudanças de assunto e responda honestamente se perguntarem sobre a automação.'


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
