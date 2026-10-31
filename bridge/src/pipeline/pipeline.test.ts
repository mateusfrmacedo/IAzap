/**
 * Unit tests for MessageStore + MessagePipeline + StubReplyEngine.
 * Run: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MessageStore } from "./messageStore.js";
import { MessagePipeline } from "./pipeline.js";
import { StubReplyEngine, turnsFromStored } from "./replyEngine.js";
import type { InboundMessage } from "../protocol/types.js";

function tmpDb(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iazap-pipeline-"));
  return path.join(dir, "messages.sqlite");
}

function inbound(partial: Partial<InboundMessage> & Pick<InboundMessage, "chatId" | "text">): InboundMessage {
  return {
    messageId: partial.messageId ?? `m-${Math.random().toString(36).slice(2)}`,
    fromMe: partial.fromMe ?? false,
    timestamp: partial.timestamp ?? Date.now(),
    chatId: partial.chatId,
    text: partial.text,
  };
}

describe("StubReplyEngine", () => {
  it("returns Portuguese stub mentioning context", async () => {
    const engine = new StubReplyEngine();
    const text = await engine.generate({
      chatId: "x@s.whatsapp.net",
      systemPrompt: "pt",
      turns: [
        { role: "user", text: "oi", timestamp: 1 },
        { role: "assistant", text: "olá", timestamp: 2 },
      ],
      contextString: "contato: oi\neu: olá",
      latestUserText: "tudo bem?",
    });
    assert.match(text, /IAZAP \(stub PT-BR\)/);
    assert.match(text, /tudo bem/);
    assert.match(text, /2 msg/);
    assert.match(text, /mlx-service/i);
  });
});

describe("MessageStore", () => {
  let store: MessageStore;
  let dbPath: string;

  before(() => {
    dbPath = tmpDb();
    store = new MessageStore(dbPath);
  });

  after(() => {
    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("persists and returns chronological context", () => {
    const chat = "5511@s.whatsapp.net";
    store.upsert({
      chatId: chat,
      messageId: "1",
      text: "primeiro",
      fromMe: false,
      direction: "in",
      timestamp: 1000,
    });
    store.upsert({
      chatId: chat,
      messageId: "2",
      text: "segundo",
      fromMe: true,
      direction: "out",
      timestamp: 2000,
    });
    const recent = store.recent(chat, 10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0]!.text, "primeiro");
    assert.equal(recent[1]!.text, "segundo");
    const ctx = store.buildContextString(chat, 10);
    assert.match(ctx, /contato: primeiro/);
    assert.match(ctx, /eu: segundo/);
    const turns = turnsFromStored(recent);
    assert.equal(turns[0]!.role, "user");
    assert.equal(turns[1]!.role, "assistant");
  });
});

describe("MessagePipeline", () => {
  it("ignores fromMe and non-selected chats; sends stub after debounce", async () => {
    const dbPath = tmpDb();
    const store = new MessageStore(dbPath);
    const selected = new Set<string>(["sel@s.whatsapp.net"]);
    const sent: Array<{ chatId: string; text: string }> = [];

    const pipeline = new MessagePipeline(
      {
        store,
        engine: new StubReplyEngine(),
        sendText: async (chatId, text) => {
          sent.push({ chatId, text });
          return { messageId: `out-${sent.length}` };
        },
        isSelected: (id) => selected.has(id),
        selectedCount: () => selected.size,
      },
      { enabled: true, debounceMs: 50, cooldownMs: 0, contextSize: 8 },
    );

    const activities: string[] = [];
    pipeline.on("activity", (a: { kind: string }) => activities.push(a.kind));

    pipeline.handleInbound(inbound({ chatId: "sel@s.whatsapp.net", text: "ping", fromMe: true }));
    assert.ok(activities.includes("skipped_from_me"));

    pipeline.handleInbound(inbound({ chatId: "other@s.whatsapp.net", text: "oi" }));
    assert.ok(activities.includes("skipped_not_selected"));

    pipeline.handleInbound(
      inbound({ chatId: "group@g.us", text: "grupo" }),
      { isGroup: true },
    );
    assert.ok(activities.includes("skipped_group"));

    pipeline.handleInbound(inbound({ chatId: "sel@s.whatsapp.net", text: "olá stub" }));
    assert.ok(activities.includes("debounced"));

    await new Promise((r) => setTimeout(r, 120));

    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.chatId, "sel@s.whatsapp.net");
    assert.match(sent[0]!.text, /olá stub/);
    assert.ok(activities.includes("generated"));
    assert.ok(activities.includes("sent"));

    const status = pipeline.getStatus();
    assert.equal(status.engineId, "stub");
    assert.equal(status.enabled, true);

    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("respects global kill switch and cooldown", async () => {
    const dbPath = tmpDb();
    const store = new MessageStore(dbPath);
    const selected = new Set(["c@s.whatsapp.net"]);
    let sends = 0;

    const pipeline = new MessagePipeline(
      {
        store,
        engine: new StubReplyEngine(),
        sendText: async () => {
          sends += 1;
          return { messageId: `o-${sends}` };
        },
        isSelected: (id) => selected.has(id),
        selectedCount: () => selected.size,
      },
      { enabled: false, debounceMs: 20, cooldownMs: 5_000 },
    );

    const kinds: string[] = [];
    pipeline.on("activity", (a: { kind: string }) => kinds.push(a.kind));

    pipeline.handleInbound(inbound({ chatId: "c@s.whatsapp.net", text: "a" }));
    assert.ok(kinds.includes("skipped_disabled"));
    assert.equal(sends, 0);

    pipeline.setEnabled(true);
    pipeline.handleInbound(inbound({ chatId: "c@s.whatsapp.net", text: "b" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sends, 1);

    pipeline.handleInbound(inbound({ chatId: "c@s.whatsapp.net", text: "c" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(sends, 1);
    assert.ok(kinds.includes("skipped_cooldown"));

    store.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });
});
