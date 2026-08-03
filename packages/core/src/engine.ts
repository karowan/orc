/**
 * The deterministic program VM: quickjs-emscripten (sync build) with a
 * host-controlled event loop.
 *
 * Determinism contract (design doc §5.3):
 * - The bootstrap actively strips ambient authority (Date, Math.random,
 *   WeakRef, FinalizationRegistry) — a fresh QuickJS context ships all of them.
 * - orc drives the event loop itself; jobs run only inside drain().
 * - Sequence identity: each agent()/ext.* call gets the next sequence number in
 *   call order. Scheduling is replayed deterministically, so call order is
 *   stable across live execution and replay.
 * - Delivery granularity is part of the replay contract: exactly ONE completion
 *   is resolved per quiescent drain.
 * - The step budget is the interrupt handler's invocation count per turn —
 *   never wall-clock (which would abort replay at a different point than live).
 * - Values cross the boundary as VM-parsed canonical JSON literals; the journal
 *   digest is computed host-side over the exact canonical bytes.
 */
import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSRuntime,
  type QuickJSHandle,
} from "quickjs-emscripten";
import { canonicalJson } from "./canonical.js";
import {
  PolicyError,
  type Json,
  type Policy,
  type ProgramMeta,
  type ThunkSpec,
} from "./contracts.js";
import { normalizeProgramMeta } from "./program-meta.js";

export interface VmHooks {
  /**
   * Called synchronously when the program makes a call. MUST NOT re-enter the
   * VM (no evalCode / executePendingJobs from inside). Record and return.
   */
  onCall(seq: number, spec: ThunkSpec): void;
  onLog(message: string): void;
  onPhase(name: string, state: "started" | "completed" | "failed", scope: number): void;
  onProgramMeta?(meta: ProgramMeta | undefined): void;
}

export type ProgramState =
  | { state: "pending" }
  | { state: "ok"; result: Json }
  | { state: "error"; error: string };

type Deferred = QuickJSDeferredPromise;

const BOOTSTRAP = String.raw`
"use strict";
(function () {
  var deny = function (name) {
    var f = function () { throw new Error(name + " is not available in orc programs (deterministic sandbox)"); };
    return f;
  };
  var deniedDate = deny("Date");
  deniedDate.now = deny("Date.now");
  deniedDate.parse = deny("Date.parse");
  deniedDate.UTC = deny("Date.UTC");
  globalThis.Date = deniedDate;
  Math.random = deny("Math.random");
  globalThis.WeakRef = undefined;
  globalThis.FinalizationRegistry = undefined;

  var groupCounter = 0;
  var phaseCounter = 0;
  var currentPhase = "";

  function dispatch(spec) {
    if (spec.phase === undefined && currentPhase) spec.phase = currentPhase;
    return __orc_dispatch(JSON.stringify(spec));
  }

  function normTimeout(v) {
    if (v === false) return false;
    if (typeof v === "number") return v;
    return undefined;
  }

  // Dispatch a leaf and, when its completion resolves, restore the phase that
  // was active at CALL time. Correct under concurrency because orc delivers
  // exactly one completion per quiescent drain: the restore microtask runs
  // (and any synchronous agent() calls in the await continuation capture the
  // right phase) before the next completion is ever delivered.
  function dispatchLeaf(spec) {
    var capturedPhase = currentPhase;
    return dispatch(spec).then(
      function (v) { currentPhase = capturedPhase; return v; },
      function (e) { currentPhase = capturedPhase; throw e; }
    );
  }

  globalThis.agent = function (prompt, opts) {
    var o = opts || {};
    return dispatchLeaf({
      kind: "agent",
      prompt: String(prompt),
      id: o.id,
      harness: o.harness,
      model: o.model,
      reasoningEffort: o.reasoningEffort,
      schema: o.schema,
      readOnly: o.readOnly === false ? false : true,
      cwd: o.cwd,
      phase: o.phase,
      idleTimeoutMs: normTimeout(o.idleTimeout),
      groupId: o.__groupId,
    });
  };

  // Independent fan-out: every lane runs to completion and comes back as a
  // settled outcome ({status:"ok",value}|{status:"error",error}), so one lane's
  // failure never cancels or wastes its siblings. The caller decides how to
  // handle partial failure. (For fail-fast, use Promise.all over agent().)
  globalThis.parallel = function (specs) {
    var gid = "g" + ++groupCounter;
    return Promise.all(
      specs.map(function (s) {
        var o = Object.assign({}, s);
        var prompt = o.prompt;
        delete o.prompt;
        o.__groupId = gid; // lane-grouping metadata for the monitor
        return globalThis.settle(globalThis.agent(prompt, o));
      })
    );
  };

  globalThis.settle = function (p) {
    return Promise.resolve(p).then(
      function (v) { return { status: "ok", value: v === undefined ? null : v }; },
      function (e) { return { status: "error", error: String((e && e.message) || e) }; }
    );
  };

  // Lexically scoped ONLY (the rejected persistent-global marker is not offered):
  // phase(name, fn) labels every call made inside fn, and — thanks to the
  // call-time capture + one-per-drain restore above — that holds across awaits
  // and concurrent sibling phases without mislabeling.
  globalThis.phase = function (name, fn) {
    var label = String(name);
    if (typeof fn !== "function") {
      throw new Error(
        'phase(name, fn) requires a function, e.g. phase("' + label + '", () => {...}). ' +
        'For a single call, use the per-call { phase: "' + label + '" } option instead.'
      );
    }
    var scope = ++phaseCounter;
    __orc_phase(label, "started", scope);
    var prev = currentPhase;
    currentPhase = label;
    try {
      var r = fn();
      if (r && typeof r.then === "function") {
        return r.then(
          function (v) {
            currentPhase = prev;
            __orc_phase(label, "completed", scope);
            return v;
          },
          function (e) {
            currentPhase = prev;
            __orc_phase(label, "failed", scope);
            throw e;
          }
        );
      }
      currentPhase = prev;
      __orc_phase(label, "completed", scope);
      return r;
    } catch (e) {
      currentPhase = prev;
      __orc_phase(label, "failed", scope);
      throw e;
    }
  };

  globalThis.log = function (msg) { __orc_log(String(msg)); };

  globalThis.ext = new Proxy({}, {
    get: function (_t, name) {
      return function (payload) {
        return dispatchLeaf({
          kind: "ext:" + String(name),
          payload: payload === undefined ? null : payload,
          readOnly: true, // host overrides from the extension registration
        });
      };
    },
  });

  globalThis.__orc_api = {
    agent: globalThis.agent,
    parallel: globalThis.parallel,
    phase: globalThis.phase,
    log: globalThis.log,
    settle: globalThis.settle,
    ext: globalThis.ext,
  };
})();
`;

const INVOKE = String.raw`
"use strict";
(function () {
  var mod = typeof __orc_mod !== "undefined" ? __orc_mod : undefined;
  var fn = mod && (typeof mod.default === "function" ? mod.default : typeof mod === "function" ? mod : null);
  if (!fn) throw new Error("program has no default-exported function");
  globalThis.__orc_state = "pending";
  globalThis.__orc_result = null;
  Promise.resolve(fn(globalThis.__orc_api)).then(
    function (v) { globalThis.__orc_state = "ok"; globalThis.__orc_result = v === undefined ? null : v; },
    function (e) {
      globalThis.__orc_state = "error";
      // QuickJS Error.stack does NOT include the message line (unlike V8).
      var msg = e && e.message ? String(e.message) : String(e);
      var stack = e && e.stack ? String(e.stack) : "";
      globalThis.__orc_result = stack ? msg + "\n" + stack : msg;
    }
  );
})();
`;

const STRICT_JSON_SERIALIZER = String.raw`
(function () {
  var isArray = Array.isArray;
  var getPrototypeOf = Object.getPrototypeOf;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var keys = Object.keys;
  var objectPrototype = Object.prototype;
  var stringify = JSON.stringify;
  var isFiniteNumber = Number.isFinite;

  function encode(value, depth, ancestors) {
    if (depth > 256) throw new TypeError("JSON nesting exceeds 256");
    if (value === null || typeof value === "boolean" || typeof value === "string") {
      return stringify(value);
    }
    if (typeof value === "number") {
      if (!isFiniteNumber(value)) throw new TypeError("JSON numbers must be finite");
      return stringify(value);
    }
    if (typeof value !== "object") {
      throw new TypeError("unsupported JSON value: " + typeof value);
    }
    for (var a = 0; a < ancestors.length; a++) {
      if (ancestors[a] === value) throw new TypeError("JSON value contains a cycle");
    }
    ancestors[ancestors.length] = value;
    try {
      var out = "";
      var i;
      if (isArray(value)) {
        out = "[";
        for (i = 0; i < value.length; i++) {
          var item = getOwnPropertyDescriptor(value, i);
          if (!item) throw new TypeError("JSON arrays cannot be sparse");
          if (!("value" in item)) throw new TypeError("JSON properties cannot be accessors");
          if (i) out += ",";
          out += encode(item.value, depth + 1, ancestors);
        }
        return out + "]";
      }
      var prototype = getPrototypeOf(value);
      if (prototype !== objectPrototype && prototype !== null) {
        throw new TypeError("JSON objects must be plain objects");
      }
      var names = keys(value);
      out = "{";
      for (i = 0; i < names.length; i++) {
        var name = names[i];
        var property = getOwnPropertyDescriptor(value, name);
        if (!("value" in property)) throw new TypeError("JSON properties cannot be accessors");
        if (i) out += ",";
        out += stringify(name) + ":" + encode(property.value, depth + 1, ancestors);
      }
      return out + "}";
    } finally {
      ancestors.length -= 1;
    }
  }

  return function (value) { return encode(value, 0, []); };
})()
`;

export class ProgramVM {
  private runtime: QuickJSRuntime;
  private ctx: QuickJSContext;
  private deferreds = new Map<number, Deferred>();
  private nextSeq = 0;
  private stepsRemaining = 0;
  private interrupted = false;
  private disposed = false;
  private jsonParse?: QuickJSHandle;
  private jsonSerialize?: QuickJSHandle;

  private constructor(
    runtime: QuickJSRuntime,
    ctx: QuickJSContext,
    private readonly policy: Policy,
    private readonly hooks: VmHooks,
  ) {
    this.runtime = runtime;
    this.ctx = ctx;
  }

  static async create(bundle: string, policy: Policy, hooks: VmHooks, startSeq = 0): Promise<ProgramVM> {
    const QuickJS = await getQuickJS();
    const runtime = QuickJS.newRuntime();
    let vm: ProgramVM | undefined;
    try {
      runtime.setMemoryLimit(policy.memoryLimitBytes);
      runtime.setMaxStackSize(policy.maxStackBytes);
      const ctx = runtime.newContext();
      vm = new ProgramVM(runtime, ctx, policy, hooks);
      vm.nextSeq = startSeq;
      const json = ctx.getProp(ctx.global, "JSON");
      try {
        // Keep the intrinsic handle outside the program's reach. Sandbox code
        // may replace globalThis.JSON.parse, but replay materialization must
        // still use the original parser.
        vm.jsonParse = ctx.getProp(json, "parse");
      } finally {
        json.dispose();
      }

      const serializer = ctx.evalCode(STRICT_JSON_SERIALIZER, "orc-json.js");
      if ("error" in serializer && serializer.error) {
        const err = ctx.dump(serializer.error);
        serializer.error.dispose();
        throw new Error(`failed to install JSON serializer: ${String(err)}`);
      }
      vm.jsonSerialize = serializer.value;

      runtime.setInterruptHandler(() => {
        vm!.stepsRemaining -= 1;
        if (vm!.stepsRemaining < 0) {
          vm!.interrupted = true;
          return true;
        }
        return false;
      });

      vm.installHostFunctions();
      vm.evalOrThrow(BOOTSTRAP, "orc-bootstrap.js");
      vm.evalOrThrow(bundle, "program.bundle.js");
      vm.hooks.onProgramMeta?.(vm.readProgramMeta());
      vm.evalOrThrow(INVOKE, "orc-invoke.js");
      vm.drain(); // initial turn: run the program to its first quiescent point
      return vm;
    } catch (err) {
      if (vm) vm.dispose();
      else runtime.dispose();
      throw err;
    }
  }

  private installHostFunctions(): void {
    const { ctx } = this;

    const dispatchFn = ctx.newFunction("__orc_dispatch", (specHandle) => {
      const specJson = ctx.getString(specHandle);
      const spec = JSON.parse(specJson) as ThunkSpec;
      const seq = this.nextSeq++;
      // Record only — never re-enter the VM from a host callback.
      this.hooks.onCall(seq, spec);
      const deferred = ctx.newPromise();
      this.deferreds.set(seq, deferred);
      // Returned to the program as its awaited promise; the handle is owned by
      // the deferred and freed via deferred.dispose() (see deliver/dispose).
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__orc_dispatch", dispatchFn);
    dispatchFn.dispose();

    const logFn = ctx.newFunction("__orc_log", (msgHandle) => {
      this.hooks.onLog(ctx.getString(msgHandle));
    });
    ctx.setProp(ctx.global, "__orc_log", logFn);
    logFn.dispose();

    const phaseFn = ctx.newFunction("__orc_phase", (nameHandle, stateHandle, scopeHandle) => {
      this.hooks.onPhase(
        ctx.getString(nameHandle),
        ctx.getString(stateHandle) as "started" | "completed" | "failed",
        Number(ctx.dump(scopeHandle)),
      );
    });
    ctx.setProp(ctx.global, "__orc_phase", phaseFn);
    phaseFn.dispose();
  }

  private readProgramMeta(): ProgramMeta | undefined {
    const moduleHandle = this.ctx.getProp(this.ctx.global, "__orc_mod");
    const metaHandle = this.ctx.getProp(moduleHandle, "meta");
    moduleHandle.dispose();
    try {
      if (this.ctx.dump(metaHandle) === undefined) return undefined;
      this.resetBudget();
      const serialized = this.ctx.callFunction(this.jsonSerialize!, this.ctx.undefined, metaHandle);
      if ("error" in serialized && serialized.error) {
        const error = this.ctx.dump(serialized.error) as { message?: unknown };
        serialized.error.dispose();
        throw new TypeError(String(error?.message ?? error));
      }
      const json = this.ctx.getString(serialized.value);
      serialized.value.dispose();
      if (this.interrupted) throw new PolicyError("step budget exceeded materializing program meta");
      return normalizeProgramMeta(JSON.parse(json));
    } catch (error) {
      if (error instanceof PolicyError) throw error;
      throw new PolicyError(`invalid program meta: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      metaHandle.dispose();
    }
  }

  private evalOrThrow(code: string, filename: string): void {
    this.resetBudget();
    const result = this.ctx.evalCode(code, filename);
    if ("error" in result && result.error) {
      const err = this.ctx.dump(result.error);
      result.error.dispose();
      throw new Error(`program error in ${filename}: ${typeof err === "object" ? JSON.stringify(err) : String(err)}`);
    }
    result.value.dispose();
    if (this.interrupted) throw new PolicyError(`step budget exceeded in ${filename}`);
  }

  private resetBudget(): void {
    this.stepsRemaining = this.policy.stepBudgetPerTurn;
    this.interrupted = false;
  }

  /** Drain the VM job queue to quiescence. One turn = one step budget. */
  drain(): void {
    this.resetBudget();
    // executePendingJobs runs queued promise jobs; loop defensively.
    for (;;) {
      const res = this.runtime.executePendingJobs();
      if ("error" in res && res.error) {
        const err = this.ctx.dump(res.error);
        res.error.dispose();
        throw new Error(`program job error: ${typeof err === "object" ? JSON.stringify(err) : String(err)}`);
      }
      const executed = "value" in res ? res.value : 0;
      if (this.interrupted) throw new PolicyError("step budget exceeded");
      if (executed === 0) return;
    }
  }

  /**
   * Deliver exactly one completion, then drain to quiescence.
   * This one-per-drain policy is replay-visible and frozen (§5.3).
   */
  deliver(seq: number, outcome: { status: "ok"; value: Json } | { status: "error"; error: string }): void {
    const deferred = this.deferreds.get(seq);
    if (!deferred) throw new Error(`no pending call with seq ${seq}`);
    this.deferreds.delete(seq);
    this.resetBudget();
    if (outcome.status === "ok") {
      const bytes = canonicalJson(outcome.value);
      const source = this.ctx.newString(bytes);
      const parsed = this.ctx.callFunction(this.jsonParse!, this.ctx.undefined, source);
      source.dispose();
      if ("error" in parsed && parsed.error) {
        const err = this.ctx.dump(parsed.error);
        parsed.error.dispose();
        deferred.dispose();
        if (this.interrupted) {
          throw new PolicyError(`step budget exceeded materializing result for call ${seq}`);
        }
        throw new Error(`failed to materialize result for seq ${seq}: ${JSON.stringify(err)}`);
      }
      deferred.resolve(parsed.value);
      parsed.value.dispose();
    } else {
      const error = this.ctx.newError(outcome.error);
      deferred.reject(error);
      error.dispose();
    }
    deferred.dispose(); // frees the deferred's resolve/reject/handle
    if (this.interrupted) throw new PolicyError(`step budget exceeded materializing result for call ${seq}`);
    this.drain();
  }

  /** Sequence numbers of calls made but not yet delivered. */
  pendingSeqs(): number[] {
    return [...this.deferreds.keys()].sort((a, b) => a - b);
  }

  state(): ProgramState {
    const stateHandle = this.ctx.getProp(this.ctx.global, "__orc_state");
    const state = this.ctx.dump(stateHandle) as string;
    stateHandle.dispose();
    if (state === "pending") return { state: "pending" };
    const handle = this.ctx.getProp(this.ctx.global, "__orc_result");
    if (state === "ok") {
      this.resetBudget();
      const serialized = this.ctx.callFunction(this.jsonSerialize!, this.ctx.undefined, handle);
      handle.dispose();
      if ("error" in serialized && serialized.error) {
        const err = this.ctx.dump(serialized.error) as { message?: unknown };
        serialized.error.dispose();
        return {
          state: "error",
          error: `program result is not valid JSON: ${String(err?.message ?? err)}`,
        };
      }
      const json = this.ctx.getString(serialized.value);
      serialized.value.dispose();
      if (this.interrupted) return { state: "error", error: "step budget exceeded materializing program result" };
      return { state: "ok", result: JSON.parse(json) as Json };
    }
    const value = this.ctx.dump(handle);
    handle.dispose();
    return { state: "error", error: String(value) };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Undelivered deferreds (e.g. validate previews, deadlocks): free them so
    // the runtime disposes cleanly (avoids the QuickJS gc_obj_list assertion).
    for (const d of this.deferreds.values()) {
      try {
        d.dispose();
      } catch {
        /* already consumed */
      }
    }
    this.deferreds.clear();
    this.jsonParse?.dispose();
    this.jsonSerialize?.dispose();
    try {
      this.ctx.dispose();
    } catch {
      /* leaked handles on release builds are silent; best effort */
    }
    try {
      this.runtime.dispose();
    } catch {
      /* ditto */
    }
  }
}
