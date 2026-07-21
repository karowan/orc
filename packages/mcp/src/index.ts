/**
 * The orc stdio MCP server. Tools are the operation registry verbatim — zod
 * schemas pass to the MCP SDK natively (no conversion), and read-only ops
 * carry readOnlyHint so a client policy of "auto-allow read-only" only ever
 * prompts on launch/resume/respond/cancel.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ALL_OPS, buildRegistry, catalog, type OpContext, type OpDef } from "@karowanorg/orc-ops";

export async function serveMcp(): Promise<void> {
  const server = new McpServer({ name: "orc", version: "0.1.0" });
  let clientName: string | undefined;

  for (const op of ALL_OPS) {
    server.registerTool(
      `orc_${op.name.replace(/-/g, "_")}`,
      {
        description: op.doc,
        inputSchema: (op.input as z.ZodObject<z.ZodRawShape>).shape,
        annotations: { readOnlyHint: op.readOnly },
      },
      async (args: Record<string, unknown>) => {
        const registry = await buildRegistry({ mcpClientName: clientName });
        const ctx: OpContext = { registry, mcpClientName: clientName };
        try {
          const parsed = op.input.parse(args);
          const result = await (op as OpDef).handler(parsed, ctx);
          // The guide reads best as raw markdown, not JSON-wrapped.
          const text =
            op.name === "guide" && result && typeof (result as { guide?: unknown }).guide === "string"
              ? (result as { guide: string }).guide
              : JSON.stringify(result, null, 2);
          return { content: [{ type: "text" as const, text }] };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `error: ${String(err instanceof Error ? err.message : err)}` }],
            isError: true,
          };
        }
      },
    );
  }

  server.registerTool(
    "orc_commands",
    {
      description: "Machine-readable catalog of every orc operation (names, docs, input schemas).",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => ({ content: [{ type: "text" as const, text: JSON.stringify(catalog(), null, 2) }] }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Capture clientInfo for caller-affinity harness defaulting.
  clientName = server.server.getClientVersion()?.name;
}
