/**
 * @karowanorg/orc-sdk — the embedded TypeScript SDK. Types are inferred from the zod-first
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
  guide as guideOp,
  respondApproval as respondOp,
  listApprovals as listApprovalsOp,
  validate as validateOp,
  type OpContext,
} from "@karowanorg/orc-ops";
import {
  readTraces,
  openApprovals,
  statusForRun,
  type ApprovalAction,
  type ApprovalResponse,
  type Json,
  type RunStatus,
  type UiPresentation,
} from "@karowanorg/orc-core";

export type LaunchInput = z.input<typeof launchOp.input>;
export type ValidateInput = z.input<typeof validateOp.input>;

export type RunEvent =
  | { kind: "status"; status: RunStatus }
  | {
      kind: "approval-requested";
      approvalId: string;
      toolName: string;
      input: Json;
      presentation?: UiPresentation;
      actions?: ApprovalAction[];
      respond(decision: ApprovalResponse): Promise<void>;
    }
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
    const input = waitOp.input.parse({ runId: this.runId, timeoutSeconds });
    const ctx = await this.orc.ctx();
    return (await waitOp.handler(input, ctx)).status;
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
            presentation: approval.presentation,
            actions: approval.actions,
            respond: async (d) => {
              const input = respondOp.input.parse({
                ...d,
                runId: this.runId,
                approvalId: approval.id,
              });
              await respondOp.handler(
                input,
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
    // Parse applies the op defaults: cooperative grace first, then hard cancel.
    await cancelOp.handler(cancelOp.input.parse({ runId: this.runId }), ctx);
  }
}

export class Orc {
  private context?: OpContext;
  constructor(private readonly opts: { defaultHarness?: string; cwd?: string } = {}) {}

  /** @internal */
  async ctx(): Promise<OpContext> {
    this.context ??= {
      registry: await buildRegistry({ cwd: this.opts.cwd, defaultHarness: this.opts.defaultHarness }),
      registryCwd: this.opts.cwd,
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
    await resumeOp.handler(resumeOp.input.parse({ runId, wait }), ctx);
    return new OrcRun(this, runId);
  }

  async capabilities(): Promise<unknown> {
    const ctx = await this.ctx();
    return capabilitiesOp.handler({ refresh: false }, ctx);
  }

  async guide(options: { probe?: boolean; includeCli?: boolean } = {}): Promise<string> {
    const ctx = await this.ctx();
    const result = await guideOp.handler(guideOp.input.parse(options), ctx);
    return result.guide;
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

  async respond(
    runId: string,
    approvalId: string,
    decision: ApprovalResponse,
  ): Promise<void> {
    const ctx = await this.ctx();
    await respondOp.handler(
      respondOp.input.parse({ ...decision, runId, approvalId }),
      ctx,
    );
  }
}
