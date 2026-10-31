import { AppleReplyEngine, APPLE_MODEL, APPLE_MODEL_ID } from "./appleEngine.js";
import { ManagedReplyEngine, type EngineMode } from "./mlxEngine.js";
import { preparePersonaRequest, profileNameReply, forbidsEmoji, removeEmoji } from "./persona.js";
import { stripServiceOffers } from "./conversationStyle.js";
import { defaultModelId } from "./models.js";
import type { ModelStatus } from "../protocol/types.js";
import type { ReplyEngine, ReplyRequest } from "./replyEngine.js";

/** The selected catalog entry determines the backend; MLX remains independently configured. */
export class SelectableReplyEngine implements ReplyEngine {
  private apple: AppleReplyEngine;
  private mlx: ManagedReplyEngine;
  private modelId: string;

  constructor(opts?: { mode?: EngineMode; baseUrl?: string; modelId?: string; appleHelperPath?: string }) {
    this.modelId = opts?.modelId ?? defaultModelId();
    this.apple = new AppleReplyEngine(opts?.appleHelperPath);
    this.mlx = new ManagedReplyEngine({ ...opts, modelId: this.modelId === APPLE_MODEL_ID ? defaultModelId() : this.modelId });
  }

  get id(): string { return this.modelId === APPLE_MODEL_ID ? this.apple.id : this.mlx.id; }

  getStatus(): ModelStatus {
    const selected = this.modelId === APPLE_MODEL_ID ? this.apple.getStatus() : this.mlx.getStatus();
    const mlxModels = this.mlx.getStatus().availableModels.filter((m) => m.id !== APPLE_MODEL_ID);
    return { ...selected, availableModels: [...mlxModels, APPLE_MODEL] };
  }

  async refresh(): Promise<ModelStatus> {
    if (this.modelId === APPLE_MODEL_ID) await this.apple.refresh();
    else await this.mlx.refresh();
    return this.getStatus();
  }

  async setModelId(modelId: string): Promise<ModelStatus> {
    this.modelId = modelId;
    if (modelId === APPLE_MODEL_ID) await this.apple.refresh();
    else await this.mlx.setModelId(modelId);
    return this.getStatus();
  }

  async reload(): Promise<ModelStatus> {
    if (this.modelId === APPLE_MODEL_ID) await this.apple.refresh();
    else await this.mlx.reload();
    return this.getStatus();
  }

  async generate(request: ReplyRequest): Promise<string> {
    const engine = this.modelId === APPLE_MODEL_ID ? this.apple : this.mlx;
    const direct = profileNameReply(request);
    if (direct) return direct;
    const prepared = preparePersonaRequest(request);
    const clean = (text: string) => {
      const conversational = stripServiceOffers(text);
      return forbidsEmoji(request.systemPrompt) ? removeEmoji(conversational) : conversational;
    };
    let reply = clean(await engine.generate(prepared));
    if (reply) return reply;
    // Retry automatically when the entire completion was only a generic service offer.
    // The user should not need to send another message to obtain a real response.
    reply = clean(await engine.generate({
      ...prepared,
      systemPrompt: prepared.systemPrompt + "\nA resposta anterior foi apenas uma oferta genérica de ajuda. Responda diretamente à última mensagem. Para um cumprimento, devolva somente um cumprimento curto.",
    }));
    if (!reply) throw new Error("O modelo retornou apenas frases genéricas de atendimento. Nenhuma foi enviada.");
    return reply;
  }
}
