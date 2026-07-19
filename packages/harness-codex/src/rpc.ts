import type { Proc } from "@orc/core/src/contracts.js";

export type RpcId = number | string;

interface RpcMessage {
  jsonrpc?: string;
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcClientOptions {
  /** Server -> client notification (method, params). */
  onNotification?: (method: string, params: unknown) => void;
  /**
   * Server -> client request. The resolved value is sent back as the JSON-RPC
   * result; a rejection is sent as a JSON-RPC error.
   */
  onServerRequest?: (method: string, params: unknown) => Promise<unknown>;
  log?: (message: string) => void;
}

/**
 * Minimal newline-delimited JSON-RPC 2.0 client over a Proc's stdio.
 * Hand-rolled on purpose: the same client works locally and across ssh,
 * because the executor provides the pipes.
 */
export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<
    RpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly proc: Proc,
    private readonly opts: JsonRpcClientOptions = {},
  ) {
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    void proc.exited.then((code) => this.failAll(new Error(`app-server exited (code ${code})`)));
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private send(msg: object): void {
    if (this.closed || !this.proc.stdin) return;
    try {
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.opts.log?.(`rpc write failed: ${String(err)}`);
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        this.opts.log?.(`rpc: unparseable line: ${line.slice(0, 200)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: RpcMessage): void {
    if (msg.id !== undefined && msg.method === undefined) {
      // Response to one of our requests.
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.message} (rpc ${msg.error.code})`));
      else entry.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method !== undefined) {
      // Server -> client request (approvals etc.).
      const id = msg.id;
      const handler = this.opts.onServerRequest;
      if (!handler) {
        this.respondError(id, -32601, `no handler for ${msg.method}`);
        return;
      }
      handler(msg.method, msg.params).then(
        (result) => this.respond(id, result),
        (err: unknown) => this.respondError(id, -32603, String(err)),
      );
      return;
    }
    if (msg.method !== undefined) {
      this.opts.onNotification?.(msg.method, msg.params);
    }
  }

  private failAll(err: Error): void {
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }
}
