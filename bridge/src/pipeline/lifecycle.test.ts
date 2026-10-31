import { it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { MessageStore } from "./messageStore.js";
import { MessagePipeline } from "./pipeline.js";
import type { ReplyRequest } from "./replyEngine.js";

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for pipeline");
}

function harness(t: { after: (fn: () => void) => void }, debounceMs = 0) {
  const store = new MessageStore(":memory:");
  const jobs: Array<{ req: ReplyRequest; resolve: (text: string) => void }> = [];
  const sent: Array<{ chatId: string; text: string }> = [];
  const selected = new Set(["a", "b"]);
  const pipeline = new MessagePipeline({
    store,
    engine: {
      id: "controlled",
      generate: (req) => new Promise<string>((resolve) => jobs.push({ req, resolve })),
    },
    sendText: async (chatId, text) => {
      sent.push({ chatId, text });
      return { messageId: `out-${sent.length}` };
    },
    isSelected: (id) => selected.has(id),
    selectedCount: () => selected.size,
  }, { enabled: true, debounceMs, cooldownMs: 0 });
  t.after(() => { pipeline.setEnabled(false); store.close(); });
  let id = 0;
  const receive = (chatId = "a", text = "oi") => pipeline.handleInbound({
    chatId, text, messageId: String(++id), fromMe: false, timestamp: Date.now(),
  });
  return { pipeline, jobs, sent, selected, receive };
}

for (const disable of ["setEnabled", "configure"] as const) {
  it(`cancels in-flight replies via ${disable}, even after re-enabling`, async (t) => {
    const h = harness(t);
    h.receive();
    await waitFor(() => h.jobs.length === 1);
    if (disable === "setEnabled") h.pipeline.setEnabled(false);
    else h.pipeline.configure({ enabled: false });
    h.pipeline.setEnabled(true);
    h.jobs[0]!.resolve("cancelled reply");
    await delay(20);
    assert.equal(h.sent.length, 0);
  });
}

it("lets different chats finish independently", async (t) => {
  const h = harness(t);
  h.receive("a");
  await waitFor(() => h.jobs.length === 1);
  h.receive("b");
  await waitFor(() => h.jobs.length === 2);
  h.jobs[0]!.resolve("reply a");
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.pipeline.getStatus().phase, "generating");
  h.jobs[1]!.resolve("reply b");
  await waitFor(() => h.sent.length === 2);
  assert.deepEqual(h.sent.map((s) => s.chatId), ["a", "b"]);
  assert.equal(h.pipeline.getStatus().phase, "idle");
});

it("drops a stale reply as soon as a newer message arrives during generation", async (t) => {
  const h = harness(t, 50);
  h.receive("a", "primeira");
  await waitFor(() => h.jobs.length === 1);
  h.receive("a", "segunda");
  h.jobs[0]!.resolve("stale reply");
  await delay(10);
  assert.equal(h.sent.length, 0);
  await waitFor(() => h.jobs.length === 2);
  h.jobs[1]!.resolve("latest reply");
  await waitFor(() => h.sent.length === 1);
  assert.equal(h.sent[0]!.text, "latest reply");
});

it("rechecks chat selection after generation", async (t) => {
  const h = harness(t);
  h.receive();
  await waitFor(() => h.jobs.length === 1);
  h.selected.delete("a");
  h.jobs[0]!.resolve("unwanted reply");
  await delay(20);
  assert.equal(h.sent.length, 0);
  assert.equal(h.pipeline.getStatus().phase, "idle");
});

it("cancels a reply when the user changes the engine", async (t) => {
  const h = harness(t);
  h.receive();
  await waitFor(() => h.jobs.length === 1);
  h.pipeline.setEngine({ id: "replacement", generate: async () => "new engine" });
  h.jobs[0]!.resolve("old engine");
  await delay(20);
  assert.equal(h.sent.length, 0);
  assert.equal(h.pipeline.getStatus().engineId, "replacement");
});
