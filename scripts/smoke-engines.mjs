// Real local generation with Apple and MLX; WhatsApp transport is always simulated.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'zapia-engines-'));
const socketPath = path.join(runtime, 'bridge.sock');
let logs = '';
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: path.join(root, 'bridge'),
  env: { ...process.env, ZAPIA_STUB_WA: '1', ZAPIA_ENGINE: 'auto', ZAPIA_SOCKET: socketPath,
    ZAPIA_TOKEN: 'engine-smoke', ZAPIA_AUTH: path.join(runtime, 'auth'), ZAPIA_DATA: path.join(runtime, 'data'),
    ZAPIA_APPLE_HELPER: process.env.ZAPIA_APPLE_HELPER ?? path.join(root, 'bridge/bin/zapia-apple-engine') },
  stdio: ['ignore', 'ignore', 'pipe'],
});
child.stderr.on('data', data => logs += data);
let socket;
try {
  for (let i = 0; !fs.existsSync(socketPath); i++) {
    if (i > 200 || child.exitCode !== null) throw new Error(`Bridge startup failed: ${logs}`);
    await delay(50);
  }
  socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.setEncoding('utf8');
  let buffer = '', nextId = 0;
  const pending = new Map();
  socket.on('data', data => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      const done = pending.get(msg.id);
      if (done) { pending.delete(msg.id); done(msg); }
    }
  });
  async function call(method, params = {}) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout ${method}`)), 180000);
      pending.set(id, msg => { clearTimeout(timer); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
      socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  await call('session.hello', { token: 'engine-smoke', client: 'zapia-macos', protocolVersion: 1 });
  const chatId = '5511999999999@s.whatsapp.net';
  await call('chats.syncSelection', { chatIds: [chatId] });
  await call('pipeline.configure', { enabled: true, debounceMs: 0, cooldownMs: 0 });
  for (const modelId of ['apple-intelligence', 'qwen2.5-7b-instruct-4bit']) {
    const status = await call('model.configure', { modelId });
    if (modelId !== 'apple-intelligence') await call('model.reload');
    assert.equal(status.backend, modelId === 'apple-intelligence' ? 'apple' : 'mlx');
    const before = await call('pipeline.getActivity', { limit: 80 });
    const previous = new Set(before.activities.map(a => a.id));
    await call('pipeline.simulateInbound', { chatId, text: 'Diga olá e me deseje um bom dia em português.' });
    let sent;
    for (let i = 0; i < 600; i++) {
      const activity = await call('pipeline.getActivity', { limit: 80 });
      const fresh = activity.activities.filter(a => !previous.has(a.id));
      const error = fresh.find(a => a.kind === 'error');
      if (error) throw new Error(error.detail);
      sent = fresh.find(a => a.kind === 'sent');
      if (sent) break;
      await delay(100);
    }
    assert.ok(sent, `No generated reply for ${modelId}`);
    assert.doesNotMatch(sent.detail, /stub PT-BR/);
    console.log(`PASS ${modelId}: ${sent.detail}`);
  }
} finally {
  socket?.destroy();
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  fs.rmSync(runtime, { recursive: true, force: true });
}
