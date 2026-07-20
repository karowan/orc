/**
 * The orc CLI — every command is a runtime interpretation of the zod-first
 * operation registry (@orc/ops). No hand-maintained flag lists: flags, help
 * text, and the `orc commands --json` catalog all derive from the op schemas.
 */
import { Command } from "commander";
import { z } from "zod";
import { ALL_OPS, buildRegistry, catalog, runSupervisorChild, type OpContext, type OpDef } from "@orc/ops";
import { MonitorServer } from "@orc/ui";

interface JsonSchemaProp {
  type?: string | string[];
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type?: string | string[] };
}

function flagName(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("orc")
    .description("orc — model-authored orchestration runs: promise-native programs, journaled leaves, live monitoring")
    .option("--json", "machine-readable JSON output")
    .version("0.1.0");

  // Hidden: the detached supervisor entry (`orc _supervise <runId>`).
  program
    .command("_supervise <runId>", { hidden: true })
    .action((runId: string) => runSupervisorChild(runId));

  program
    .command("commands")
    .description("machine-readable catalog of every operation (for agents)")
    .action(() => {
      process.stdout.write(JSON.stringify(catalog(), null, 2) + "\n");
    });

  program
    .command("ui")
    .description("serve the live monitor UI in the foreground")
    .action(async () => {
      const server = new MonitorServer();
      const { url } = await server.start();
      process.stdout.write(`orc monitor: ${url}\n`);
      await new Promise(() => undefined); // foreground until Ctrl-C
    });

  program
    .command("mcp")
    .description("serve the orc operations as MCP tools over stdio")
    .action(async () => {
      const { serveMcp } = await import("@orc/mcp");
      await serveMcp();
    });

  for (const op of ALL_OPS) {
    const schema = z.toJSONSchema(op.input) as {
      properties?: Record<string, JsonSchemaProp>;
      required?: string[];
    };
    const cmd = program.command(op.name).description(op.doc + (op.readOnly ? "" : " [mutating]"));
    const props = schema.properties ?? {};
    // A field with a default is optional on the CLI even though zod lists it as
    // required in JSON Schema (the default satisfies it).
    const required = new Set((schema.required ?? []).filter((k) => props[k]?.default === undefined));
    for (const [key, prop] of Object.entries(props)) {
      const flag = flagName(key);
      const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
      const desc = (prop.description ?? "") + (prop.enum ? ` (${prop.enum.join("|")})` : "");
      if (type === "boolean") {
        cmd.option(`--${flag}`, desc);
        if (prop.default === true) cmd.option(`--no-${flag}`, `disable --${flag}`);
      } else if (type === "array") {
        const itemType = Array.isArray(prop.items?.type) ? prop.items.type[0] : prop.items?.type;
        const spec = `--${flag} <${itemType ?? "value"}...>`;
        if (required.has(key)) cmd.requiredOption(spec, desc);
        else cmd.option(spec, desc);
      } else if (required.has(key)) {
        cmd.requiredOption(`--${flag} <${type ?? "value"}>`, desc);
      } else {
        cmd.option(`--${flag} <${type ?? "value"}>`, desc);
      }
    }
    cmd.action(async (rawOpts: Record<string, unknown>) => {
      const input: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(props)) {
        const camel = key; // commander camelizes back to the original key
        const v = rawOpts[camel];
        if (v === undefined) continue;
        const type = Array.isArray(prop.type) ? prop.type[0] : prop.type;
        input[key] =
          type === "number" || type === "integer"
            ? Number(v)
            : type === "boolean"
              ? Boolean(v)
              : v;
      }
      const registry = await buildRegistry({});
      const ctx: OpContext = { registry };
      try {
        const parsed = op.input.parse(input);
        const result = await (op as OpDef).handler(parsed, ctx);
        const asJson = program.opts().json === true;
        render(op.name, result, asJson);
        // Ops that leave nothing running should let the process exit.
        process.exitCode = 0;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
        process.exitCode = 1;
      }
    });
  }

  await program.parseAsync(process.argv);
}

function render(opName: string, result: unknown, asJson: boolean): void {
  if (asJson || typeof result !== "object" || result === null) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }
  // Human-readable: compact key summaries for the common ops.
  const r = result as Record<string, unknown>;
  if (opName === "guide" && typeof r.guide === "string") {
    process.stdout.write(r.guide + "\n");
    return;
  }
  if (opName === "launch" && r.runId) {
    process.stdout.write(`run     ${String(r.runId)}\n`);
    if (r.monitorUrl) process.stdout.write(`monitor ${String(r.monitorUrl)}\n`);
    if (r.reportPath) process.stdout.write(`report  ${String(r.reportPath)}\n`);
    if (r.requestsWrite && !r.allowWrites) {
      process.stdout.write(`note    program declares write leaves but allow-writes was not granted — they will fail closed\n`);
    }
    return;
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err: unknown) => {
  process.stderr.write(`orc: ${String(err instanceof Error ? err.stack : err)}\n`);
  process.exit(1);
});
