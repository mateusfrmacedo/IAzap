import net from "node:net";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import type {
  Chat,
  ChatsSetAutoReplyParams,
  ChatsSyncSelectionParams,
  MessagesSendParams,
  ModelConfigureParams,
  ModelStatus,
  PipelineActivity,
  PipelineConfigureParams,
  PipelineSetEnabledParams,
  PipelineSimulateInboundParams,
  PipelineStatus,
  SessionHelloParams,
  SessionStatus,
} from "../protocol/types.js";
import { PROTOCOL_VERSION } from "../protocol/types.js";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export type RpcHandlerContext = {
  authorized: boolean;
};

export type MethodHandlers = {
  automationPreview?: (value: unknown) => unknown;
  automationGet?: () => unknown;
  automationSave?: (value: unknown) => unknown;
  broadcastSend?: (params: {numeros: string; mensagem: string; consentimento: boolean}) => Promise<unknown>;
  getStatus: () => SessionStatus;
  listChats: () => Chat[];
  setAutoReply: (params: ChatsSetAutoReplyParams) => { ok: true; chatId: string; enabled: boolean };
  syncSelection: (params: ChatsSyncSelectionParams) => { ok: true; chatIds: string[] };
  sendMessage: (params: MessagesSendParams) => Promise<{ messageId: string }>;
  reconnect: () => Promise<SessionStatus>;
  logout: () => Promise<SessionStatus>;
  pipelineGetStatus: () => PipelineStatus;
  pipelineSetEnabled: (params: PipelineSetEnabledParams) => PipelineStatus;
  pipelineConfigure: (
    params: PipelineConfigureParams,
  ) => PipelineStatus | Promise<PipelineStatus>;
  pipelineGetActivity: (limit?: number) => { activities: PipelineActivity[] };
  pipelineSimulateInbound: (
    params: PipelineSimulateInboundParams,
  ) => Promise<{ ok: true; messageId: string }>;
  modelGetStatus: () => ModelStatus | Promise<ModelStatus>;
  modelConfigure: (params: ModelConfigureParams) => Promise<ModelStatus>;
  modelReload: () => Promise<ModelStatus>;
};

export class RpcServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients = new Set<net.Socket>();
  private authorizedClients = new Set<net.Socket>();
  private retained = new Map<string, unknown>();
  private expectedToken: string;
  private handlers: MethodHandlers;

  constructor(expectedToken: string, handlers: MethodHandlers) {
    super();
    this.expectedToken = expectedToken;
    this.handlers = handlers;
  }

  async listen(socketPath: string): Promise<void> {
    if (fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }

    this.server = net.createServer((socket) => this.onConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => {
        this.server!.off("error", reject);
        try {
          fs.chmodSync(socketPath, 0o600);
        } catch {
          /* best-effort on non-Unix */
        }
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    for (const c of this.clients) {
      c.destroy();
    }
    this.clients.clear();
    this.authorizedClients.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  /** Push a JSON-RPC notification to all connected clients. */
  notify(method: string, params: unknown): void {
    // Pairing can emit a QR before the app has completed its IPC handshake.
    if (["qr.update", "session.status", "chats.updated", "pipeline.status", "model.status"].includes(method)) {
      this.retained.set(method, params);
    }
    const line = JSON.stringify({ jsonrpc: "2.0", method, params } satisfies JsonRpcNotification) + "\n";
    for (const c of this.authorizedClients) {
      if (!c.destroyed) c.write(line);
    }
  }

  private onConnection(socket: net.Socket): void {
    this.clients.add(socket);
    const ctx: RpcHandlerContext = { authorized: false };
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        await this.handleLine(socket, ctx, line);
      }
    });

    const remove = () => {
      this.clients.delete(socket);
      this.authorizedClients.delete(socket);
    };
    socket.on("close", remove);
    socket.on("error", remove);
  }

  private async handleLine(socket: net.Socket, ctx: RpcHandlerContext, line: string): Promise<void> {
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line) as JsonRpcRequest;
    } catch {
      this.write(socket, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (!req || typeof req !== "object" || req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      this.write(socket, {
        jsonrpc: "2.0",
        id: req?.id ?? null,
        error: { code: -32600, message: "Invalid Request" },
      });
      return;
    }

    // Notifications from client are ignored.
    if (req.id === undefined || req.id === null) {
      return;
    }

    try {
      const result = await this.dispatch(ctx, req.method, req.params);
      this.write(socket, { jsonrpc: "2.0", id: req.id, result });
      if (req.method === "session.hello" && ctx.authorized) {
        this.authorizedClients.add(socket);
        for (const [method, params] of this.retained) {
          socket.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        }
      }
    } catch (err) {
      const { code, message } = normalizeError(err);
      this.write(socket, {
        jsonrpc: "2.0",
        id: req.id,
        error: { code, message },
      });
    }
  }

  private async dispatch(ctx: RpcHandlerContext, method: string, params: unknown): Promise<unknown> {
    if (method === "session.hello") {
      const p = params as SessionHelloParams;
      if (!p || p.token !== this.expectedToken) {
        throw rpcError(-32001, "Unauthorized");
      }
      if (p.protocolVersion !== PROTOCOL_VERSION) {
        throw rpcError(-32602, `Unsupported protocolVersion (want ${PROTOCOL_VERSION})`);
      }
      ctx.authorized = true;
      return { ok: true, protocolVersion: PROTOCOL_VERSION };
    }

    if (!ctx.authorized) {
      throw rpcError(-32001, "Call session.hello first");
    }

    switch (method) {
      case "automation.preview":
        if (!this.handlers.automationPreview) throw rpcError(-32601, "Unavailable");
        return this.handlers.automationPreview(params);
      case "automation.get":
        if (!this.handlers.automationGet) throw rpcError(-32601, "Unavailable");
        return this.handlers.automationGet();
      case "automation.save":
        if (!this.handlers.automationSave) throw rpcError(-32601, "Unavailable");
        return this.handlers.automationSave(params);
      case "broadcast.send": {
        const p = params as {numeros: string; mensagem: string; consentimento: boolean};
        if (!p || typeof p.numeros !== 'string' || typeof p.mensagem !== 'string' || typeof p.consentimento !== 'boolean') throw rpcError(-32602, "Invalid params");
        if (!this.handlers.broadcastSend) throw rpcError(-32601, "Unavailable");
        return await this.handlers.broadcastSend(p);
      }
      case "session.status":
        return this.handlers.getStatus();
      case "session.reconnect":
        return await this.handlers.reconnect();
      case "session.logout":
        return await this.handlers.logout();
      case "chats.list":
        return { chats: this.handlers.listChats() };
      case "chats.setAutoReply": {
        const p = params as ChatsSetAutoReplyParams;
        if (!p?.chatId || typeof p.enabled !== "boolean") {
          throw rpcError(-32602, "Invalid params");
        }
        return this.handlers.setAutoReply(p);
      }
      case "chats.syncSelection": {
        const p = params as ChatsSyncSelectionParams;
        if (!p || !Array.isArray(p.chatIds) || p.chatIds.some((id) => typeof id !== "string")) {
          throw rpcError(-32602, "Invalid params");
        }
        return this.handlers.syncSelection(p);
      }
      case "messages.send": {
        const p = params as MessagesSendParams;
        if (!p?.chatId || typeof p.text !== "string") {
          throw rpcError(-32602, "Invalid params");
        }
        return await this.handlers.sendMessage(p);
      }
      case "pipeline.getStatus":
        return this.handlers.pipelineGetStatus();
      case "pipeline.setEnabled": {
        const p = params as PipelineSetEnabledParams;
        if (!p || typeof p.enabled !== "boolean") {
          throw rpcError(-32602, "Invalid params");
        }
        return this.handlers.pipelineSetEnabled(p);
      }
      case "pipeline.configure": {
        const p = (params ?? {}) as PipelineConfigureParams;
        if (typeof p !== "object" || p === null) {
          throw rpcError(-32602, "Invalid params");
        }
        return await this.handlers.pipelineConfigure(p);
      }
      case "pipeline.getActivity": {
        const p = (params ?? {}) as { limit?: number };
        return this.handlers.pipelineGetActivity(p.limit);
      }
      case "pipeline.simulateInbound": {
        const p = params as PipelineSimulateInboundParams;
        if (!p?.chatId || typeof p.text !== "string") {
          throw rpcError(-32602, "Invalid params");
        }
        return await this.handlers.pipelineSimulateInbound(p);
      }
      case "model.getStatus":
        return await this.handlers.modelGetStatus();
      case "model.configure": {
        const p = params as ModelConfigureParams;
        if (!p?.modelId || typeof p.modelId !== "string") {
          throw rpcError(-32602, "Invalid params");
        }
        return await this.handlers.modelConfigure(p);
      }
      case "model.reload":
        return await this.handlers.modelReload();
      default:
        throw rpcError(-32601, `Method not found: ${method}`);
    }
  }

  private write(socket: net.Socket, msg: JsonRpcSuccess | JsonRpcError): void {
    if (!socket.destroyed) {
      socket.write(JSON.stringify(msg) + "\n");
    }
  }
}

function rpcError(code: number, message: string): Error & { code: number } {
  const e = new Error(message) as Error & { code: number };
  e.code = code;
  return e;
}

function normalizeError(err: unknown): { code: number; message: string } {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    const e = err as { code: number; message: string };
    return { code: e.code, message: e.message };
  }
  return { code: -32000, message: err instanceof Error ? err.message : String(err) };
}
