/**
 * The any-language plugin protocol: a config-registered executable that
 * - answers `--capabilities` with a HarnessCapabilities JSON on stdout, and
 * - accepts a LeafRequest JSON on stdin, emitting HarnessEvent NDJSON on stdout.
 * Registered ONLY via orc.config — never discovered from PATH.
 */
import * as path from "node:path";
import { z } from "zod";
import type { Harness, HarnessCapabilities, HarnessContext, HarnessEvent, LeafRequest } from "@karowanorg/orc-core";

const HarnessCapabilitiesSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  models: z.array(z.object({
    id: z.string(),
    displayName: z.string().optional(),
    reasoningEfforts: z.array(z.string()),
    default: z.boolean().optional(),
  })),
  approvalModes: z.array(z.enum(["manual", "accept-edits", "auto", "bypass"])),
  structuredOutput: z.boolean(),
  sessions: z.boolean(),
  detail: z.string().optional(),
});

export function makeExecHarness(execPath: string, name?: string): Harness {
  const harnessName = name ?? path.basename(execPath).replace(/\.[^.]+$/, "");
  return {
    name: harnessName,
    async discover({ executor }): Promise<HarnessCapabilities> {
      try {
        const res = await executor.run([execPath, "--capabilities"], { timeoutMs: 15_000 });
        if (res.code !== 0) throw new Error(res.stderr || `exit ${res.code}`);
        return HarnessCapabilitiesSchema.parse(JSON.parse(res.stdout));
      } catch (err) {
        return {
          available: false,
          models: [],
          approvalModes: [],
          structuredOutput: false,
          sessions: false,
          detail: `exec harness unavailable: ${String(err instanceof Error ? err.message : err)}`,
        };
      }
    },
    async *invoke(req: LeafRequest, ctx: HarnessContext): AsyncIterable<HarnessEvent> {
      const proc = ctx.executor.spawn([execPath], { cwd: req.cwd, stdin: "pipe" });
      const onAbort = () => proc.kill();
      ctx.signal.addEventListener("abort", onAbort);
      proc.stdin?.end(JSON.stringify(req) + "\n");
      try {
        let buf = "";
        for await (const chunk of proc.stdout) {
          buf += chunk.toString();
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            try {
              yield JSON.parse(line) as HarnessEvent;
            } catch {
              /* tolerate non-event noise */
            }
          }
        }
        const code = await proc.exited;
        if (code !== 0) yield { kind: "error", message: `exec harness exited with code ${code}` };
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        proc.kill();
      }
    },
  };
}
