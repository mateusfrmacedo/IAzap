/**
 * Auto-reply message pipeline (Phase 3).
 *
 * Flow: inbound → persist → filter → debounce → context → ReplyEngine → send.
 * Anti-loop: never reply to fromMe. Cooldown per chat after a successful send.
 */

import { EventEmitter } from "node:events";
import type {
  InboundMessage,
  PipelineActivity,
  PipelineActivityKind,
  PipelineConfigureParams,
  PipelinePhase,
  PipelineStatus,
} from "../protocol/types.js";
import { MessageStore } from "./messageStore.js";
import {
  defaultSystemPrompt,
  turnsFromStored,
  type ReplyEngine,
} from "./replyEngine.js";

export type SendTextFn = (chatId: string, text: string) => Promise<{ messageId: string }>;

export type PipelineDeps = {
  store: MessageStore;
  engine: ReplyEngine;
  sendText: SendTextFn;
  /** Returns whether chatId is in the selected auto-reply set. */
  isSelected: (chatId: string) => boolean;
  selectedCount: () => number;
  /** Optional: resolve isGroup when simulateInbound does not pass it. */
  isGroup?: (chatId: string) => boolean;
};

export type PipelineOptions = {
  enabled?: boolean;
  debounceMs?: number;
  cooldownMs?: number;
  contextSize?: number;
  allowGroups?: boolean;
  systemPrompt?: string;
  activityLimit?: number;
};

export class MessagePipeline extends EventEmitter {
  private store: MessageStore;
  private engine: ReplyEngine;
  private sendText: SendTextFn;
  private isSelected: (chatId: string) => boolean;
  private selectedCountFn: () => number;
  private isGroupFn?: (chatId: string) => boolean;

  private enabled: boolean;
  private debounceMs: number;
  private cooldownMs: number;
  private contextSize: number;
  private allowGroups: boolean;
  private systemPrompt: string;
  private activityLimit: number;

  private phase: PipelinePhase = "idle";
  private lastError: string | null = null;
  private lastActivityAt: number | null = null;
  private activity: PipelineActivity[] = [];
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private pendingLatest = new Map<string, InboundMessage>();
  private lastSentAt = new Map<string, number>();
  private sendingChats = new Set<string>();
  private generation = 0;
  private chatGenerations = new Map<string, number>();
  private activeReplies = new Map<symbol, "generating" | "sending">();

  constructor(deps: PipelineDeps, opts: PipelineOptions = {}) {
    super();
    this.store = deps.store;
    this.engine = deps.engine;
    this.sendText = deps.sendText;
    this.isSelected = deps.isSelected;
    this.selectedCountFn = deps.selectedCount;
    this.isGroupFn = deps.isGroup;

    this.enabled = opts.enabled ?? false;
    this.debounceMs = opts.debounceMs ?? 1_000;
    this.cooldownMs = opts.cooldownMs ?? 0;
    this.contextSize = opts.contextSize ?? 12;
    this.allowGroups = opts.allowGroups ?? false;
    this.systemPrompt = opts.systemPrompt ?? defaultSystemPrompt();
    this.activityLimit = opts.activityLimit ?? 80;
  }

  getStatus(): PipelineStatus {
    return {
      enabled: this.enabled,
      engineId: this.engine.id,
      phase: this.phase,
      debounceMs: this.debounceMs,
      cooldownMs: this.cooldownMs,
      contextSize: this.contextSize,
      allowGroups: this.allowGroups,
      selectedCount: this.selectedCountFn(),
      pendingChats: this.pendingLatest.size,
      lastActivityAt: this.lastActivityAt,
      lastError: this.lastError,
    };
  }

  getActivity(limit = 40): PipelineActivity[] {
    return this.activity.slice(0, Math.max(1, limit));
  }

  setEnabled(enabled: boolean): PipelineStatus {
    this.enabled = enabled;
    if (!enabled) {
      this.clearDebounces();
      this.setPhase("idle");
    }
    this.emitStatus();
    this.pushActivity({
      kind: enabled ? "inbound" : "skipped_disabled",
      chatId: "*",
      detail: enabled
        ? "Auto-reply global ativado"
        : "Kill switch: auto-reply global desativado",
    });
    return this.getStatus();
  }

  configure(params: PipelineConfigureParams): PipelineStatus {
    if (typeof params.enabled === "boolean") this.enabled = params.enabled;
    if (typeof params.debounceMs === "number" && params.debounceMs >= 0) {
      this.debounceMs = params.debounceMs;
    }
    if (typeof params.cooldownMs === "number" && params.cooldownMs >= 0) {
      this.cooldownMs = params.cooldownMs;
    }
    if (typeof params.contextSize === "number" && params.contextSize >= 1) {
      this.contextSize = Math.min(40, Math.floor(params.contextSize));
    }
    if (typeof params.allowGroups === "boolean") this.allowGroups = params.allowGroups;
    if (typeof params.systemPrompt === "string" && params.systemPrompt.trim()) {
      this.systemPrompt = params.systemPrompt.trim();
    }
    // modelId is handled by ManagedReplyEngine via index.ts / model.configure —
    // pipeline only stores timing/prompt knobs.
    if (params.enabled === false) {
      this.clearDebounces();
      this.setPhase("idle");
    }
    this.emitStatus();
    return this.getStatus();
  }

  /** Swap the reply engine (e.g. after MLX becomes available). */
  setEngine(engine: ReplyEngine): void {
    this.clearDebounces();
    this.engine = engine;
    this.emitStatus();
  }

  /**
   * Handle an inbound WhatsApp text message (or simulated).
   * Always persists + emits activity; may schedule an auto-reply.
   */
  handleInbound(msg: InboundMessage, meta?: { isGroup?: boolean }): void {
    // WhatsApp can replay messages after reconnect; persisted IDs survive bridge restarts.
    if (this.store.has(msg.chatId, msg.messageId)) return;
    this.store.upsert({
      chatId: msg.chatId,
      messageId: msg.messageId,
      text: msg.text,
      fromMe: msg.fromMe,
      direction: msg.fromMe ? "out" : "in",
      timestamp: msg.timestamp,
    });

    this.pushActivity({
      kind: "inbound",
      chatId: msg.chatId,
      detail: truncate(msg.text, 100),
      messageId: msg.messageId,
    });

    if (msg.fromMe) {
      this.pushActivity({
        kind: "skipped_from_me",
        chatId: msg.chatId,
        detail: "Ignorado (fromMe / anti-loop)",
        messageId: msg.messageId,
      });
      return;
    }

    const isGroup =
      meta?.isGroup ?? this.isGroupFn?.(msg.chatId) ?? msg.chatId.endsWith("@g.us");
    if (isGroup && !this.allowGroups) {
      this.pushActivity({
        kind: "skipped_group",
        chatId: msg.chatId,
        detail: "Grupos desabilitados no MVP",
        messageId: msg.messageId,
      });
      return;
    }

    if (!this.isSelected(msg.chatId)) {
      this.pushActivity({
        kind: "skipped_not_selected",
        chatId: msg.chatId,
        detail: "Chat não está na seleção de auto-reply",
        messageId: msg.messageId,
      });
      return;
    }

    if (!this.enabled) {
      this.pushActivity({
        kind: "skipped_disabled",
        chatId: msg.chatId,
        detail: "Kill switch global desligado",
        messageId: msg.messageId,
      });
      return;
    }

    this.scheduleReply(msg);
  }

  /** Record an outbound message we just sent (context + anti-echo). */
  recordOutbound(chatId: string, messageId: string, text: string, timestamp = Date.now()): void {
    this.store.upsert({
      chatId,
      messageId,
      text,
      fromMe: true,
      direction: "out",
      timestamp,
    });
  }

  private scheduleReply(msg: InboundMessage): void {
    // Invalidate the previous turn immediately, including while this one debounces.
    this.chatGenerations.set(msg.chatId, ++this.generation);
    this.pendingLatest.set(msg.chatId, msg);
    const existing = this.debounceTimers.get(msg.chatId);
    if (existing) {
      clearTimeout(existing);
      this.debounceTimers.delete(msg.chatId);
    }

    // If a send is in flight, keep the latest message until that send settles.
    // This avoids overlapping sends without needing a second inbound to wake the chat.
    if (this.sendingChats.has(msg.chatId)) {
      this.pushActivity({ kind: "debounced", chatId: msg.chatId, detail: "Aguardando envio anterior", messageId: msg.messageId });
      this.emitStatus();
      return;
    }
    const remainingCooldown = Math.max(0, this.cooldownMs - (Date.now() - (this.lastSentAt.get(msg.chatId) ?? 0)));
    const delayMs = Math.max(this.debounceMs, remainingCooldown);
    this.setPhase(remainingCooldown > this.debounceMs ? "cooldown" : "debouncing");
    this.pushActivity({
      kind: remainingCooldown > this.debounceMs ? "queued_cooldown" : "debounced",
      chatId: msg.chatId,
      detail: remainingCooldown > this.debounceMs ? `Resposta agendada em ${delayMs}ms` : `Debounce ${this.debounceMs}ms`,
      messageId: msg.messageId,
    });
    this.emitStatus();

    const timer = setTimeout(() => {
      this.debounceTimers.delete(msg.chatId);
      const latest = this.pendingLatest.get(msg.chatId);
      this.pendingLatest.delete(msg.chatId);
      if (latest) {
        void this.runReply(latest);
      } else if (this.debounceTimers.size === 0) {
        this.setPhase("idle");
        this.emitStatus();
      }
    }, delayMs);

    this.debounceTimers.set(msg.chatId, timer);
  }

  private async runReply(msg: InboundMessage): Promise<void> {
    if (!this.enabled) {
      this.pushActivity({
        kind: "skipped_disabled",
        chatId: msg.chatId,
        detail: "Kill switch durante debounce",
        messageId: msg.messageId,
      });
      this.finishIdleIfQuiet();
      return;
    }

    if (!this.isSelected(msg.chatId)) {
      this.pushActivity({
        kind: "skipped_not_selected",
        chatId: msg.chatId,
        detail: "Seleção removida durante debounce",
        messageId: msg.messageId,
      });
      this.finishIdleIfQuiet();
      return;
    }

    const last = this.lastSentAt.get(msg.chatId) ?? 0;
    const since = Date.now() - last;
    if (since < this.cooldownMs || this.sendingChats.has(msg.chatId)) {
      // A send/configuration may have changed the deadline since the timer was set.
      this.scheduleReply(msg);
      return;
    }

    const gen = this.chatGenerations.get(msg.chatId);
    const job = Symbol(msg.chatId);
    this.activeReplies.set(job, "generating");
    try {
      this.setPhase("generating");
      this.emitStatus();

      const recent = this.store.recent(msg.chatId, this.contextSize);
      const contextString = this.store.buildContextString(msg.chatId, this.contextSize);
      const reply = (
        await this.engine.generate({
          chatId: msg.chatId,
          systemPrompt: this.systemPrompt,
          turns: turnsFromStored(recent),
          contextString,
          latestUserText: msg.text,
        })
      ).trim();

      if (!reply) {
        throw new Error("Resposta vazia do motor");
      }

      this.pushActivity({
        kind: "generated",
        chatId: msg.chatId,
        detail: truncate(reply, 120),
        messageId: msg.messageId,
      });

      if (gen !== this.chatGenerations.get(msg.chatId)) {
        // Newer inbound superseded this turn before send.
        return;
      }

      // Selection and the kill switch can change while inference is running.
      if (!this.enabled || !this.isSelected(msg.chatId)) return;
      if (!this.allowGroups && (this.isGroupFn?.(msg.chatId) ?? msg.chatId.endsWith("@g.us"))) return;

      this.activeReplies.set(job, "sending");
      this.sendingChats.add(msg.chatId);
      this.setPhase("sending");
      this.emitStatus();

      const { messageId } = await this.sendText(msg.chatId, reply);
      this.recordOutbound(msg.chatId, messageId, reply);
      this.lastSentAt.set(msg.chatId, Date.now());
      this.lastError = null;

      this.pushActivity({
        kind: "sent",
        chatId: msg.chatId,
        detail: truncate(reply, 120),
        messageId,
      });
    } catch (err) {
      if (gen !== this.chatGenerations.get(msg.chatId)) return;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      this.setPhase("error");
      this.pushActivity({
        kind: "error",
        chatId: msg.chatId,
        detail: message,
        messageId: msg.messageId,
      });
      this.emitStatus();
    } finally {
      if (this.activeReplies.get(job) === "sending") {
        this.sendingChats.delete(msg.chatId);
        const queued = this.pendingLatest.get(msg.chatId);
        if (queued && this.enabled && !this.debounceTimers.has(msg.chatId)) this.scheduleReply(queued);
      }
      this.activeReplies.delete(job);
      if (this.chatGenerations.get(msg.chatId) === gen) this.chatGenerations.delete(msg.chatId);
      this.finishIdleIfQuiet();
    }
  }

  private finishIdleIfQuiet(): void {
    if (!this.enabled) this.setPhase("idle");
    else if ([...this.activeReplies.values()].includes("sending")) this.setPhase("sending");
    else if (this.activeReplies.size > 0) this.setPhase("generating");
    else if (this.debounceTimers.size > 0) this.setPhase("debouncing");
    else this.setPhase(this.lastError ? "error" : "idle");
    this.emitStatus();
  }

  private clearDebounces(): void {
    // Invalidates already-running generations too, even after an off/on toggle.
    this.chatGenerations.clear();
    for (const t of this.debounceTimers.values()) clearTimeout(t);
    this.debounceTimers.clear();
    this.pendingLatest.clear();
  }

  private setPhase(phase: PipelinePhase): void {
    this.phase = phase;
  }

  private emitStatus(): void {
    this.emit("status", this.getStatus());
  }

  private pushActivity(partial: {
    kind: PipelineActivityKind;
    chatId: string;
    detail: string;
    messageId?: string;
  }): void {
    const entry: PipelineActivity = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      kind: partial.kind,
      chatId: partial.chatId,
      detail: partial.detail,
      messageId: partial.messageId,
    };
    this.activity.unshift(entry);
    if (this.activity.length > this.activityLimit) {
      this.activity.length = this.activityLimit;
    }
    this.lastActivityAt = entry.at;
    this.emit("activity", entry);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
