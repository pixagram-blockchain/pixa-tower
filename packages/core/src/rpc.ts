// JSON-RPC client for Pixa nodes with ranking, demotion and failover.

export interface RawOp {
  type: string; // "vote_operation"
  value: Record<string, unknown>;
}

export interface RawBlock {
  previous: string;
  timestamp: string;
  witness: string;
  block_id: string;
  transactions: { operations: RawOp[]; [k: string]: unknown }[];
  transaction_ids: string[];
  [k: string]: unknown;
}

export interface RawVop {
  trx_id: string;
  block: number;
  trx_in_block: number;
  op_in_trx: number;
  virtual_op: boolean;
  timestamp: string;
  op: RawOp;
  operation_id?: number | string;
}

export class RpcError extends Error {
  constructor(
    message: string,
    public node: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

interface NodeState {
  url: string;
  demotedUntil: number;
  errors: number;
  lastHead: number;
  lastMs: number;
}

export interface ChainClientOptions {
  timeoutMs?: number;
  demoteMs?: number;
  fetcher?: typeof fetch;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export class ChainClient {
  private nodes: NodeState[];
  private timeoutMs: number;
  private demoteMs: number;
  private fetcher: typeof fetch;
  private log: (msg: string, data?: Record<string, unknown>) => void;
  public lastNode = "";
  public lastBytes = 0;
  public errorCount = 0;

  constructor(urls: string[], opts: ChainClientOptions = {}) {
    if (urls.length === 0) throw new Error("ChainClient needs at least one node");
    this.nodes = urls.map((url) => ({ url, demotedUntil: 0, errors: 0, lastHead: 0, lastMs: 0 }));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.demoteMs = opts.demoteMs ?? 5 * 60_000;
    this.fetcher = opts.fetcher ?? ((input, init) => fetch(input, init));
    this.log = opts.log ?? (() => {});
  }

  /** Nodes in preference order: healthy first, then by fewest errors and latency. */
  ranked(): NodeState[] {
    const now = Date.now();
    return [...this.nodes].sort((a, b) => {
      const da = a.demotedUntil > now ? 1 : 0;
      const db = b.demotedUntil > now ? 1 : 0;
      if (da !== db) return da - db;
      if (a.errors !== b.errors) return a.errors - b.errors;
      return a.lastMs - b.lastMs;
    });
  }

  demote(url: string, reason: string) {
    const n = this.nodes.find((x) => x.url === url);
    if (!n) return;
    n.demotedUntil = Date.now() + this.demoteMs;
    n.errors++;
    this.errorCount++;
    this.log("node_demoted", { node: url, reason });
  }

  private async callNode<T>(node: NodeState, method: string, params: unknown, timeoutMs: number): Promise<T> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetcher(node.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new RpcError(`fetch failed: ${(e as Error).message}`, node.url, true);
    }
    if (!res.ok) throw new RpcError(`HTTP ${res.status}`, node.url, res.status >= 500 || res.status === 429);
    const text = await res.text();
    this.lastBytes = text.length;
    node.lastMs = Date.now() - started;
    let body: { result?: T; error?: { message?: string } };
    try {
      body = JSON.parse(text);
    } catch {
      throw new RpcError("invalid JSON response", node.url, true);
    }
    if (body.error) {
      const msg = body.error.message ?? JSON.stringify(body.error);
      // A busy node: retry the same node once, then move on.
      const retryable = /database lock|timeout|Internal Error|Bad Gateway/i.test(msg);
      throw new RpcError(msg, node.url, retryable);
    }
    this.lastNode = node.url;
    return body.result as T;
  }

  /** Call with failover across nodes. Non-retryable errors (bad params) are thrown at once. */
  async call<T>(method: string, params: unknown, opts: { timeoutMs?: number; exclude?: string } = {}): Promise<T> {
    const timeout = opts.timeoutMs ?? this.timeoutMs;
    let lastErr: unknown;
    for (const node of this.ranked()) {
      if (opts.exclude && node.url === opts.exclude) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await this.callNode<T>(node, method, params, timeout);
        } catch (e) {
          lastErr = e;
          const err = e as RpcError;
          if (!err.retryable) throw e;
          if (attempt === 0 && /database lock/i.test(err.message)) continue;
          this.demote(node.url, err.message);
          break;
        }
      }
    }
    throw lastErr ?? new Error("no node available");
  }

  get nodeCount() {
    return this.nodes.length;
  }

  // ---- typed helpers ----

  getDynamicGlobalProperties() {
    return this.call<Record<string, unknown>>("condenser_api.get_dynamic_global_properties", []);
  }

  async getBlockRange(start: number, count: number): Promise<{ blocks: RawBlock[]; bytes: number; node: string }> {
    const r = await this.call<{ blocks: RawBlock[] }>(
      "block_api.get_block_range",
      { starting_block_num: start, count },
      { timeoutMs: Math.max(this.timeoutMs, 30_000) },
    );
    return { blocks: r.blocks ?? [], bytes: this.lastBytes, node: this.lastNode };
  }

  async getBlockHeaderId(num: number, exclude?: string): Promise<string | null> {
    const r = await this.call<{ block?: { block_id?: string } }>("block_api.get_block", { block_num: num }, { exclude });
    return r.block?.block_id ?? null;
  }

  /** All virtual ops in [start, end), irreversible only. Nodes accept at most 2,000 blocks per call. */
  async getVirtualOps(start: number, end: number, limit = 1000): Promise<RawVop[]> {
    const out: RawVop[] = [];
    for (let s = start; s < end; s += 2000) out.push(...(await this.getVirtualOpsWindow(s, Math.min(end, s + 2000), limit)));
    return out;
  }

  private async getVirtualOpsWindow(start: number, end: number, limit: number): Promise<RawVop[]> {
    const out: RawVop[] = [];
    let begin = start;
    let opBegin: number | string = 0;
    for (let guard = 0; guard < 10_000; guard++) {
      const params: Record<string, unknown> = {
        block_range_begin: begin,
        block_range_end: end,
        include_reversible: false,
        group_by_block: false,
        limit,
      };
      if (opBegin && opBegin !== "0") params.operation_begin = opBegin;
      const r = await this.call<{ ops: RawVop[]; next_block_range_begin: number; next_operation_begin: number | string }>(
        "account_history_api.enum_virtual_ops",
        params,
        { timeoutMs: Math.max(this.timeoutMs, 30_000) },
      );
      out.push(...(r.ops ?? []));
      const nextOp = r.next_operation_begin;
      const nextBlock = r.next_block_range_begin;
      if (nextOp && nextOp !== "0" && nextOp !== 0) {
        begin = nextBlock;
        opBegin = nextOp;
        continue;
      }
      if (nextBlock && nextBlock < end && nextBlock > begin) {
        begin = nextBlock;
        opBegin = 0;
        continue;
      }
      break;
    }
    // Dedupe on operation_id in case pages overlap.
    const seen = new Set<string>();
    return out.filter((v) => {
      const key = String(v.operation_id ?? `${v.block}:${v.trx_in_block}:${v.op_in_trx}:${v.op.type}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
