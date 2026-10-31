/**
 * MLX model catalog mirrored for the bridge / UI (weights live in mlx-service).
 */

export type ModelSpec = {
  id: string;
  label: string;
  hfRepo: string;
  memoryHint: string;
  default?: boolean;
};

export const MLX_MODELS: ModelSpec[] = [
  {
    id: "qwen2.5-7b-instruct-4bit",
    label: "Qwen2.5-7B Instruct (4-bit)",
    hfRepo: "mlx-community/Qwen2.5-7B-Instruct-4bit",
    memoryHint:
      "Melhor coerência em PT-BR. Em M1 Pro 16GB: ~5–7GB de pesos + overhead; feche apps pesados. Se houver pressão de memória, use o 3B.",
    default: true,
  },
  {
    id: "qwen2.5-3b-instruct-4bit",
    label: "Qwen2.5-3B Instruct (4-bit)",
    hfRepo: "mlx-community/Qwen2.5-3B-Instruct-4bit",
    memoryHint:
      "Fallback mais leve para M1 Pro 16GB (~2–3GB de pesos). Latência menor; qualidade PT-BR boa para replies curtos.",
  },
];

export function defaultModelId(): string {
  return MLX_MODELS.find((m) => m.default)?.id ?? MLX_MODELS[0]!.id;
}

export function findModel(id: string): ModelSpec | undefined {
  return MLX_MODELS.find((m) => m.id === id || m.hfRepo === id);
}
