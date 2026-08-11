/**
 * @karowanorg/orc-sdk/program — type-only surface for program authors. Import with
 * `import type` (runtime imports are rejected by the sandbox).
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type {
  ProgramGraph,
  ProgramGraphEdge,
  ProgramGraphNode,
  ProgramGraphNodeKind,
  ProgramMeta,
} from "@karowanorg/orc-core";

export interface AgentOptions {
  /** Optional trace label — makes waterfall rows read semantically. */
  id?: string;
  /** "claude" | "codex" | a config-registered harness. Default: caller affinity. */
  harness?: string;
  model?: string;
  reasoningEffort?: string;
  /** JSON Schema for structured output. */
  schema?: Json;
  /** Default true. false requires the run's allow-writes grant (fail-closed). */
  readOnly?: boolean;
  /**
   * Retry transient failures using the supervisor's bounded retry budget.
   * Defaults to true for read-only leaves and false for writable leaves.
   * Writable retries re-orient against the current workspace before acting.
   */
  autoRetry?: boolean;
  /** Plain path. Defaults to the run cwd. */
  cwd?: string;
  /** Output-idle watchdog for this call, ms; false disables. */
  idleTimeout?: number | false;
  phase?: string;
}

export interface ParallelSpec extends AgentOptions {
  prompt: string;
}

export interface ParallelOptions {
  /** Stable authored identifier used by monitors to group sibling leaves. */
  id?: string;
  /** Optional human-readable group label. */
  title?: string;
}

export type Settled<T> = { status: "ok"; value: T } | { status: "error"; error: string };

export interface OrcApi {
  agent(prompt: string, opts?: AgentOptions): Promise<Json>;
  /**
   * Independent fan-out: every lane runs to completion (one failing lane never
   * cancels the others) and comes back as a per-lane settled outcome, in order.
   * For fail-fast, use Promise.all over agent() instead.
   */
  parallel(specs: ParallelSpec[], options?: ParallelOptions): Promise<Settled<Json>[]>;
  /** Labels every call made inside fn for the waterfall. */
  phase<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  log(message: string): void;
  /** Envelope helper: collect a failing lane without sinking the run. */
  settle<T>(p: Promise<T>): Promise<Settled<T>>;
  /** Config-registered extension leaves — journaled exactly like agent(). */
  ext: Record<string, (payload?: Json) => Promise<Json>>;
}

export type Program = (api: OrcApi) => Promise<Json>;
