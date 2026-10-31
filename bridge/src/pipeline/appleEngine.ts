import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelStatus } from "../protocol/types.js";
import type { ReplyEngine, ReplyRequest } from "./replyEngine.js";

export const APPLE_MODEL_ID = "apple-intelligence";
export const APPLE_MODEL = {
  id: APPLE_MODEL_ID,
  label: "Apple Intelligence (local)",
  hfRepo: "",
  memoryHint: "Modelo local gerenciado pelo macOS. Requer macOS 26+ e Apple Intelligence ativada.",
};

type HelperResponse = { state: "ready" | "unavailable" | "error"; text?: string; error?: string };

export class AppleReplyEngine implements ReplyEngine {
  readonly id = "apple:foundation-models";
  private state: ModelStatus["state"] = "unavailable";
  private lastError: string | null = null;
  private helperPath: string;

  constructor(helperPath = process.env.IAZAP_APPLE_HELPER ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/iazap-apple-engine")) {
    this.helperPath = helperPath;
  }

  private call(payload: object): Promise<HelperResponse> {
    return new Promise((resolve, reject) => {
      const child = execFile(this.helperPath, [], { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error(`Falha no motor Apple Intelligence: ${error.message}`));
        try { resolve(JSON.parse(stdout) as HelperResponse); }
        catch { reject(new Error("Resposta inválida do motor Apple Intelligence.")); }
      });
      child.stdin?.on("error", () => { /* execFile reports failed startup / early exit */ });
      child.stdin?.end(JSON.stringify(payload));
    });
  }

  async refresh(): Promise<ModelStatus> {
    try {
      const result = await this.call({ method: "status" });
      this.state = result.state;
      this.lastError = result.error ?? null;
    } catch (error) {
      this.state = "unavailable";
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    return this.getStatus();
  }

  getStatus(): ModelStatus {
    return {
      backend: "apple", engineId: this.id, modelId: APPLE_MODEL_ID, modelLabel: APPLE_MODEL.label,
      state: this.state, mlxAvailable: false, serviceUrl: null,
      memoryNote: APPLE_MODEL.memoryHint, lastError: this.lastError, availableModels: [APPLE_MODEL],
    };
  }

  async generate(request: ReplyRequest): Promise<string> {
    try {
      const result = await this.call({ method: "generate", systemPrompt: request.systemPrompt, turns: request.turns });
      if (result.error || result.state !== "ready") throw new Error(result.error ?? "Apple Intelligence indisponível.");
      const text = result.text?.trim();
      if (!text) throw new Error("Apple Intelligence retornou uma resposta vazia.");
      this.state = "ready";
      this.lastError = null;
      return text;
    } catch (error) {
      this.state = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      // An explicitly selected Apple model must never silently send a stub or MLX reply.
      throw error;
    }
  }
}
