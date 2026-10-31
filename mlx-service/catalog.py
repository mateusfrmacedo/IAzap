"""Known MLX chat models for IAZAP (Qwen2.5 4-bit community builds)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelSpec:
    id: str
    label: str
    hf_repo: str
    memory_hint: str
    default: bool = False


# Default: 7B 4-bit when RAM allows; 3B is the M1 Pro–friendly fallback.
MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="qwen2.5-7b-instruct-4bit",
        label="Qwen2.5-7B Instruct (4-bit)",
        hf_repo="mlx-community/Qwen2.5-7B-Instruct-4bit",
        memory_hint=(
            "Melhor coerência em PT-BR. Em M1 Pro 16GB: ~5–7GB de pesos + "
            "overhead; feche apps pesados. Se houver pressão de memória, use o 3B."
        ),
        default=True,
    ),
    ModelSpec(
        id="qwen2.5-3b-instruct-4bit",
        label="Qwen2.5-3B Instruct (4-bit)",
        hf_repo="mlx-community/Qwen2.5-3B-Instruct-4bit",
        memory_hint=(
            "Fallback mais leve para M1 Pro 16GB (~2–3GB de pesos). "
            "Latência menor; qualidade PT-BR boa para replies curtos."
        ),
    ),
)


def default_model_id() -> str:
    for m in MODELS:
        if m.default:
            return m.id
    return MODELS[0].id


def get_model(model_id: str) -> ModelSpec | None:
    for m in MODELS:
        if m.id == model_id or m.hf_repo == model_id:
            return m
    return None


def catalog_dicts() -> list[dict]:
    return [
        {
            "id": m.id,
            "label": m.label,
            "hfRepo": m.hf_repo,
            "memoryHint": m.memory_hint,
            "default": m.default,
        }
        for m in MODELS
    ]
