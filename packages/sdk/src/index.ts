/**
 * @orc/sdk — the embedded TypeScript SDK. Types are inferred from the zod-first
 * operation registry; the Orc class is a thin ergonomic layer over the same op
 * handlers the CLI and MCP call.
 */
import { z } from "zod";
import {
  buildRegistry,
  launch as launchOp,
  status as statusOp,
  wait as waitOp,
  getResult as getResultOp,
  resume as resumeOp,
  cancel as cancelOp,
  capabilities as capabilitiesOp,
  respondApproval as respondOp,
  listApprovals as listApprovalsOp,
  validate as validateOp,
  type OpContext,
} from "@orc/ops";
import { readTraces, openApprovals, statusForRun, type Json, type RunStatus } from "@orc/core";

export type LaunchInput = z.infer<typeof launchOp.input>;
export type ValidateInput = z.infer<typeof validateOp.input>;

export type RunEvent =
  | { kind: "status"; status: RunStatus }
  | { kind: "approval-requested"; approvalId: string; toolName: string; input: Json; respond(d: { behavior: "allow" | "deny"; message?: string }): Promise<void> }
  | { kind: "done"; status: RunStatus };

export class OrcRun {
  constructor(
    private readonly orc: Orc,
    readonly runId: string,
  ) {}

  async status(): Promise<RunStatus> {
    return statusForRun(this.runId);
  }

  async wait(timeoutSeconds = 300): Promise<RunStatus> {
    const ctx = await this.orc.ctx();
    for (;;) {
      const res = await waitOp.handler({ runId: this.runId, timeoutSeconds }, ctx);
      if (!res.timedOut) return res.status;
    }
  }

  /** Typed event stream: status ticks, answerable approvals, terminal done. */
  async *watch(pollMs = 1000): AsyncIterable<RunEvent> {
    const ctx = await this.orc.ctx();
    const seenApprovals = new Set<string>();
    for (;;) {
      const s = statusForRun(this.runId);
      for (const approval of openApprovals(readTraces(this.runId))) {
        if (!seenApprovals.has(approval.id)) {
          seenApprovals.add(approval.id);
          yield {
            kind: "approval-requested",
            approvalId: approval.id,
            toolName: approval.toolName,
            input: approval.input,
            respond: async (d) => {
              await respondOp.handler(
                { runId: this.runId, approvalId: approval.id, behavior: d.behavior, message: d.message },
                ctx,
              );
            },
          };
        }
      }
      if (s.state !== "running") {
        yield { kind: "done", status: s };
        return;
      }
      yield { kind: "status", status: s };
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  async result(): Promise<Json> {
    const ctx = await this.orc.ctx();
    const res = await getResultOp.handler({ runId: this.runId }, ctx);
    return res.body;
  }

  async cancel(): Promise<void> {
    const ctx = await this.orc.ctx();
    await cancelOp.handler({ runId: this.runId }, ctx);
  }
}

export class Orc {
  private context?: OpContext;
  constructor(private readonly opts: { defaultHarness?: string; cwd?: string } = {}) {}

  /** @internal */
  async ctx(): Promise<OpContext> {
    this.context ??= {
      registry: await buildRegistry({ cwd: this.opts.cwd, defaultHarness: this.opts.defaultHarness }),
    };
    return this.context;
  }

  async launch(input: LaunchInput): Promise<OrcRun & { info: Awaited<ReturnType<typeof launchOp.handler>> }> {
    const ctx = await this.ctx();
    const info = await launchOp.handler(launchOp.input.parse(input), ctx);
    const run = new OrcRun(this, info.runId) as OrcRun & { info: typeof info };
    run.info = info;
    return run;
  }

  async validate(input: ValidateInput): Promise<Awaited<ReturnType<typeof validateOp.handler>>> {
    const ctx = await this.ctx();
    return validateOp.handler(validateOp.input.parse(input), ctx);
  }

  async resume(runId: string, wait = false): Promise<OrcRun> {
    const ctx = await this.ctx();
    await resumeOp.handler({ runId, wait }, ctx);
    return new OrcRun(this, runId);
  }

  async capabilities(host?: string): Promise<unknown> {
    const ctx = await this.ctx();
    return capabilitiesOp.handler({ host, refresh: false }, ctx);
  }

  run(runId: string): OrcRun {
    return new OrcRun(this, runId);
  }

  async status(runId: string): Promise<RunStatus> {
    const ctx = await this.ctx();
    return statusOp.handler({ runId }, ctx);
  }

  async approvals(runId: string) {
    const ctx = await this.ctx();
    return listApprovalsOp.handler({ runId }, ctx);
  }
}
