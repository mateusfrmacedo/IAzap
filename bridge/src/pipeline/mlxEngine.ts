/**
 * MLX-backed ReplyEngine: calls the local Python mlx-service over HTTP.
 * When the service is down / Metal missing, ManagedReplyEngine falls back to StubReplyEngine.
 */

import { defaultModelId, findModel, MLX_MODELS } from "./models.js";
import {
  StubReplyEngine,
  type ReplyEngine,
  type ReplyRequest,
} from "./replyEngine.js";
import type { ModelStatus, ModelLoadState } from "../protocol/types.js";

export type MlxServiceStatus = {
  backend?: string;
  engineId?: string;
  modelId?: string;
  modelLabel?: string;
  hfRepo?: string;
  state?: string;
  mlxAvailable?: boolean;
  memoryNote?: string;
  lastError?: string | null;
  availableModels?: Array<{
    id: string;
    label: string;
    hfRepo: string;
    memoryHint: string;
    default?: boolean;
  }>;
};

const DEFAULT_MLX_URL = "http://127.0.0.1:8742";

export function defaultMlxServiceUrl(): string {
  return (process.env.ZAPIA_MLX_URL ?? DEFAULT_MLX_URL).replace(/\/$/, "");
}

export class MLXReplyEngine implements ReplyEngine {
  readonly baseUrl: string;
  private modelId: string;
  private lastServiceEngineId: string | null = null;

  constructor(opts?: { baseUrl?: string; modelId?: string }) {
    this.baseUrl = (opts?.baseUrl ?? defaultMlxServiceUrl()).replace(/\/$/, "");
    this.modelId = opts?.modelId ?? defaultModelId();
  }

  get id(): string {
    return this.lastServiceEngineId ?? `mlx:${this.modelId}`;
  }

  getModelId(): string {
    return this.modelId;
  }

  async probe(): Promise<MlxServiceStatus> {
    const res = await fetch(`${this.baseUrl}/v1/status`, {
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) {
      throw new Error(`mlx-service status HTTP ${res.status}`);
    }
    const body = (await res.json()) as MlxServiceStatus;
    if (body.engineId) this.lastServiceEngineId = body.engineId;
    if (body.modelId) this.modelId = body.modelId;
    return body;
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async configure(modelId: string): Promise<MlxServiceStatus> {
    const spec = findModel(modelId);
    this.modelId = spec?.id ?? modelId;
    const res = await fetch(`${this.baseUrl}/v1/configure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: this.modelId }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as MlxServiceStatus & { error?: string };
    if (!res.ok) {
      throw new Error(body.error ?? `configure failed HTTP ${res.status}`);
    }
    if (body.engineId) this.lastServiceEngineId = body.engineId;
    return body;
  }

  async reload(): Promise<MlxServiceStatus> {
    const res = await fetch(`${this.baseUrl}/v1/reload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(600_000), // first HF download can be long
    });
    const body = (await res.json()) as MlxServiceStatus & { error?: string };
    if (!res.ok && body.state === "error") {
      throw new Error(body.lastError ?? body.error ?? `reload failed HTTP ${res.status}`);
    }
    if (body.engineId) this.lastServiceEngineId = body.engineId;
    if (body.modelId) this.modelId = body.modelId;
    return body;
  }

  async generate(req: ReplyRequest): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemPrompt: req.systemPrompt,
        turns: req.turns.map((t) => ({ role: t.role, text: t.text })),
        maxTokens: 192,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json()) as {
      text?: string;
      error?: string;
      engineId?: string;
    };
    if (!res.ok) {
      throw new Error(
        body.error ??
          `MLX generate failed HTTP ${res.status}. Modelo ausente? Rode mlx-service no Mac e POST /v1/reload.`,
      );
    }
    if (body.engineId) this.lastServiceEngineId = body.engineId;
    const text = (body.text ?? "").trim();
    if (!text) throw new Error("MLX retornou texto vazio");
    return text;
  }
}

export type EngineMode = "auto" | "mlx" | "stub";

export function resolveEngineMode(raw?: string): EngineMode {
  const v = (raw ?? process.env.ZAPIA_ENGINE ?? "auto").toLowerCase();
  if (v === "mlx" || v === "stub" || v === "auto") return v;
  return "auto";
}

/**
 * Prefers MLX HTTP service; falls back to stub when unavailable.
 * Exposes model status for RPC `model.*`.
 */
export class ManagedReplyEngine implements ReplyEngine {
  private mlx: MLXReplyEngine;
  private stub = new StubReplyEngine();
  private active: "mlx" | "stub" = "stub";
  private mode: EngineMode;
  private lastError: string | null = null;
  private cachedService: MlxServiceStatus | null = null;
  private modelId: string;

  constructor(opts?: { mode?: EngineMode; baseUrl?: string; modelId?: string }) {
    this.mode = opts?.mode ?? resolveEngineMode();
    this.modelId = opts?.modelId ?? defaultModelId();
    this.mlx = new MLXReplyEngine({
      baseUrl: opts?.baseUrl,
      modelId: this.modelId,
    });
  }

  get id(): string {
    return this.active === "mlx" ? this.mlx.id : this.stub.id;
  }

  getActiveBackend(): "mlx" | "stub" {
    return this.active;
  }

  async refresh(): Promise<ModelStatus> {
    if (this.mode === "stub") {
      this.active = "stub";
      this.cachedService = null;
      this.lastError = null;
      return this.getStatus();
    }

    try {
      const ok = await this.mlx.health();
      if (!ok) throw new Error("mlx-service health check failed");
      const status = await this.mlx.probe();
      this.cachedService = status;
      if (status.modelId) this.modelId = status.modelId;
      const usable =
        status.state === "ready" ||
        status.state === "not_loaded" ||
        status.state === "loading" ||
        status.mlxAvailable === true;
      if (this.mode === "mlx" || usable) {
        this.active = "mlx";
        this.lastError = status.lastError ?? null;
      } else {
        this.active = "stub";
        this.lastError =
          status.lastError ?? "MLX reportou estado indisponível — usando stub.";
      }
      // Prefer stub only when auto + completely unavailable
      if (this.mode === "auto" && status.state === "unavailable" && !status.mlxAvailable) {
        this.active = "stub";
      }
    } catch (err) {
      this.cachedService = null;
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.mode === "mlx") {
        this.active = "mlx"; // keep mlx id; generate will surface the error
      } else {
        this.active = "stub";
      }
    }
    return this.getStatus();
  }

  getStatus(): ModelStatus {
    const spec = findModel(this.modelId);
    const svc = this.cachedService;
    let state: ModelLoadState;
    if (this.mode === "stub" || this.active === "stub") {
      state = this.cachedService ? "fallback_stub" : "unavailable";
      if (this.mode === "stub") state = "fallback_stub";
    } else if (svc?.state === "ready") state = "ready";
    else if (svc?.state === "loading") state = "loading";
    else if (svc?.state === "not_loaded") state = "not_loaded";
    else if (svc?.state === "error") state = "error";
    else if (this.lastError) state = "error";
    else state = "unavailable";

    const memoryNote =
      svc?.memoryNote ??
      spec?.memoryHint ??
      "Em M1 Pro 16GB prefira 3B se o 7B pressionar a memória unificada.";

    return {
      backend: this.active,
      engineId: this.id,
      modelId: svc?.modelId ?? this.modelId,
      modelLabel: svc?.modelLabel ?? spec?.label ?? this.modelId,
      state,
      mlxAvailable: Boolean(svc?.mlxAvailable) || this.active === "mlx",
      serviceUrl: this.mlx.baseUrl,
      memoryNote,
      lastError: this.lastError ?? svc?.lastError ?? null,
      availableModels: (svc?.availableModels ?? MLX_MODELS).map((m) => ({
        id: m.id,
        label: m.label,
        hfRepo: m.hfRepo,
        memoryHint: m.memoryHint,
      })),
    };
  }

  async setModelId(modelId: string): Promise<ModelStatus> {
    const resolved = findModel(modelId)?.id ?? modelId;
    if (resolved === this.modelId && this.cachedService) {
      // Reconnecting IPC or changing the prompt must not unload the same weights.
      return this.refresh();
    }
    this.modelId = resolved;
    if (this.mode === "stub") {
      return this.getStatus();
    }
    try {
      if (!(await this.mlx.health())) {
        throw new Error(
          `mlx-service offline em ${this.mlx.baseUrl}. Inicie mlx-service no Mac (ver mlx-service/README.md).`,
        );
      }
      this.cachedService = await this.mlx.configure(this.modelId);
      this.active = "mlx";
      this.lastError = this.cachedService.lastError ?? null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.mode === "auto") this.active = "stub";
    }
    return this.getStatus();
  }

  async reload(): Promise<ModelStatus> {
    if (this.mode === "stub") {
      this.lastError = "ZAPIA_ENGINE=stub — reload MLX ignorado.";
      return this.getStatus();
    }
    try {
      if (!(await this.mlx.health())) {
        throw new Error(
          `mlx-service offline em ${this.mlx.baseUrl}. Modelo não pode ser carregado.`,
        );
      }
      this.cachedService = await this.mlx.reload();
      this.active = "mlx";
      this.lastError = this.cachedService.lastError ?? null;
      if (this.cachedService.state === "error") {
        this.lastError =
          this.cachedService.lastError ?? "Falha ao carregar pesos MLX.";
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      if (this.mode === "auto") this.active = "stub";
    }
    return this.getStatus();
  }

  async generate(req: ReplyRequest): Promise<string> {
    if (this.active === "stub" || this.mode === "stub") {
      return this.stub.generate(req);
    }
    try {
      return await this.mlx.generate(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      if (this.mode === "auto") {
        this.active = "stub";
        return this.stub.generate(req);
      }
      throw err;
    }
  }
}
