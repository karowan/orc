import * as fs from "node:fs";
import type {
  Executor,
  Harness,
  HarnessCapabilities,
  HarnessEvent,
  LeafRequest,
  Json,
  Proc,
} from "../../src/contracts.js";
import type { Registry } from "../../src/supervisor.js";

/** Minimal executor: never actually used by the fake harness. */
export const fakeExecutor: Executor = {
  spawn(): Proc {
    throw new Error("fakeExecutor.spawn not implemented");
  },
  async run(cmd: string[]) {
    // git status probes during re-orient land here
    return { code: 1, stdout: "", stderr: `fake executor: ${cmd[0]} unavailable` };
  },
  async exists() {
    return false;
  },
  async readFile(): Promise<string> {
    throw new Error("no files");
  },
  async writeFile(): Promise<void> {
    /* noop */
  },
};

export interface FakeHarnessOptions {
  /** Per-seq artificial latency in ms (default 0). */
  latency?: (seq: number) => number;
  /** Seqs that should fail. */
  failSeqs?: number[];
  /** Custom error message for a failing seq (default `fake failure for seq N`). */
  failMessage?: (seq: number) => string;
  /** Harness stderr lines to emit per invocation via ctx.log (hlog channel). */
  harnessLogLines?: string[];
  /** Estimated USD cost reported in each leaf's usage event. */
  costPerLeafUsd?: number;
  /** Seqs that fail their first N invocations then succeed (flaky). */
  flaky?: Record<number, number>;
  /** Deterministic result builder. */
  result?: (req: LeafRequest) => Json;
  /** If set, append one line per invocation: `${seq}:${attempt}:${promptPrefix}` */
  invocationLog?: string;
  /** Tool calls (open+close pairs) to emit per invocation (default 1). */
  toolCallsPerLeaf?: number;
  /** Delay engine: setTimeout by default. */
  name?: string;
}

export function makeFakeHarness(opts: FakeHarnessOptions = {}): Harness {
  const invokeCounts = new Map<number, number>();
  return {
    name: opts.name ?? "fake",
    async discover(): Promise<HarnessCapabilities> {
      return {
        available: true,
        version: "0.0.0-fake",
        models: [{ id: "fake-1", reasoningEfforts: ["low"], default: true }],
        approvalModes: ["manual", "accept-edits", "auto", "bypass"],
        structuredOutput: true,
        sessions: false,
      };
    },
    async *invoke(req: LeafRequest, ctx?: { log?: (m: string) => void }): AsyncIterable<HarnessEvent> {
      if (opts.invocationLog) {
        fs.appendFileSync(opts.invocationLog, `${req.seq}:${req.prompt.slice(0, 60).replace(/\n/g, " ")}\n`);
      }
      for (const line of opts.harnessLogLines ?? []) ctx?.log?.(line);
      const wait = opts.latency?.(req.seq) ?? 0;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const calls = opts.toolCallsPerLeaf ?? 1;
      for (let i = 0; i < calls; i++) {
        const id = calls === 1 ? `t${req.seq}` : `t${req.seq}-${i}`;
        yield { kind: "tool-call-open", id, name: "FakeTool", atMs: Date.now() };
        yield { kind: "tool-call-close", id, status: "ok", atMs: Date.now() };
      }
      const n = (invokeCounts.get(req.seq) ?? 0) + 1;
      invokeCounts.set(req.seq, n);
      if (opts.flaky && opts.flaky[req.seq] !== undefined && n <= opts.flaky[req.seq]) {
        yield { kind: "error", message: `flaky failure ${n} for seq ${req.seq}` };
        return;
      }
      if (opts.failSeqs?.includes(req.seq)) {
        yield { kind: "error", message: opts.failMessage?.(req.seq) ?? `fake failure for seq ${req.seq}` };
        return;
      }
      const value = opts.result ? opts.result(req) : { seq: req.seq, echo: req.prompt.slice(0, 40) };
      yield {
        kind: "usage",
        tokensIn: 10,
        tokensOut: 5,
        ...(opts.costPerLeafUsd !== undefined ? { costUsd: opts.costPerLeafUsd, costEstimated: true } : {}),
      };
      yield { kind: "result", output: value };
    },
  };
}

export function makeRegistry(harness: Harness, extras?: Partial<Registry>): Registry {
  return {
    harnesses: new Map([[harness.name, harness]]),
    extensions: extras?.extensions ?? new Map(),
    defaultHarness: harness.name,
    executor: fakeExecutor,
    ...extras,
  };
}

/** Deterministic PRNG for fuzzed latencies. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
