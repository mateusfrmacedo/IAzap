import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WhatsAppSession, reconnectDelay, type SessionDependencies } from "../whatsapp/session.js";

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 300; i++) { if (check()) return; await delay(5); }
  assert.fail("Session did not recover");
}
function setup(t: { after: (fn: () => Promise<void>) => void }, overrides: Partial<SessionDependencies> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iazap-session-"));
  fs.writeFileSync(path.join(dir, "keep-auth"), "test credentials");
  const sockets: Array<{ ev: EventEmitter; end: () => void; user: { id: string; name: string } }> = [];
  const deps = {
    retryBaseMs: 5, retryMaxMs: 15, random: () => 0.5,
    useAuth: (async () => ({ state: { creds: {}, keys: {} }, saveCreds: async () => {} })) as unknown as SessionDependencies["useAuth"],
    fetchVersion: async () => ({ version: [2, 3000, 1] as [number, number, number], isLatest: true }),
    makeSocket: (() => {
      const socket = { ev: new EventEmitter(), end: () => {}, user: { id: "test", name: "Test" } };
      sockets.push(socket);
      return socket;
    }) as unknown as SessionDependencies["makeSocket"], ...overrides,
  };
  const session = new WhatsAppSession(dir, deps);
  t.after(async () => { await session.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { session, sockets, dir };
}
const close = (ev: EventEmitter, code: number) => ev.emit("connection.update", {
  connection: "close", lastDisconnect: { error: { message: "network failure", output: { statusCode: code } } },
});

it("backs off failed attempts without exceeding the delay cap", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 99].map(n => reconnectDelay(n, 2000, 30000, () => .5)), [2000, 4000, 8000, 16000, 30000, 30000]);
});
it("keeps retrying if reconnect setup fails, preserving credentials", async (t) => {
  let attempts = 0;
  const h = setup(t, { fetchVersion: async () => {
    if (++attempts < 3) throw new Error("temporary network failure");
    return { version: [2, 3000, 1], isLatest: true };
  } });
  await h.session.start();
  await waitFor(() => h.sockets.length === 1);
  h.sockets[0]!.ev.emit("connection.update", { connection: "open" });
  assert.equal(h.session.getStatus().state, "connected");
  assert.ok(fs.existsSync(path.join(h.dir, "keep-auth")));
});
it("recovers a dropped connection and ignores stale socket events", async (t) => {
  const h = setup(t);
  await h.session.start();
  close(h.sockets[0]!.ev, 408);
  await waitFor(() => h.sockets.length === 2);
  h.sockets[1]!.ev.emit("connection.update", { connection: "open" });
  close(h.sockets[0]!.ev, 408);
  h.sockets[0]!.ev.emit("messages.upsert", { type: "notify", messages: [] });
  await delay(30);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.session.getStatus().state, "connected");
  assert.ok(fs.existsSync(path.join(h.dir, "keep-auth")));
});
it("does not reconnect a logged-out or replaced session", async (t) => {
  for (const code of [401, 440]) {
    const h = setup(t);
    await h.session.start();
    close(h.sockets[0]!.ev, code);
    await delay(30);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.session.getStatus().state, code === 401 ? "logged_out" : "error");
    if (code === 440) assert.ok(fs.existsSync(path.join(h.dir, "keep-auth")));
  }
});
it("stop cancels an asynchronous startup and scheduled retry", async (t) => {
  let resolve!: (value: { version: [number, number, number]; isLatest: boolean }) => void;
  const h = setup(t, { fetchVersion: () => new Promise(r => { resolve = r; }) });
  const starting = h.session.start();
  await waitFor(() => Boolean(resolve));
  await h.session.stop();
  resolve({ version: [2, 3000, 1], isLatest: true });
  await starting;
  await delay(30);
  assert.equal(h.sockets.length, 0);
  const retrying = setup(t);
  await retrying.session.start();
  close(retrying.sockets[0]!.ev, 408);
  await retrying.session.stop();
  await delay(30);
  assert.equal(retrying.sockets.length, 1);
});
