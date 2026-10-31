"""Chat prompt helpers for Qwen2.5 Instruct (ChatML-style)."""

from __future__ import annotations

from typing import Any

DEFAULT_SYSTEM_PROMPT = (
    "Você é o assistente de auto-resposta do IAZAP no WhatsApp. "
    "Responda SEMPRE em português do Brasil. "
    "Use o histórico da conversa para manter o contexto. "
    "Seja breve, natural e no tom de mensagem de WhatsApp (curto). "
    "Não invente fatos. Não mencione que você é uma IA, salvo se perguntarem. "
    "Não use markdown elaborado. Uma ou poucas frases bastam."
)


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
    """Deterministic PT-BR reply used when IAZAP_MLX_MOCK=1 (no Metal)."""
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
