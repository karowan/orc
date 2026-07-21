import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-mcp-"));
});

describe("orc mcp (stdio)", () => {
  it("lists tools with readOnlyHint discipline and answers orc_list / orc_commands", async () => {
    const repoRoot = path.join(__dirname, "..", "..", "..");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", path.join(repoRoot, "packages", "cli", "src", "bin.ts"), "mcp"],
      env: { ...process.env, ORC_HOME: home } as Record<string, string>,
      cwd: repoRoot,
    });
    const client = new Client({ name: "orc-test-client", version: "0.0.1" });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      const byName = new Map(tools.tools.map((t) => [t.name, t]));
      // all ops present
      for (const name of ["orc_launch", "orc_validate", "orc_status", "orc_wait", "orc_get_result",
        "orc_trace", "orc_list", "orc_cancel", "orc_resume", "orc_approvals", "orc_respond",
        "orc_capabilities", "orc_open", "orc_report", "orc_doctor", "orc_guide", "orc_commands"]) {
        expect(byName.has(name), name).toBe(true);
      }
      // readOnlyHint discipline: launch/resume/respond/cancel promptable, reads auto-allowable
      expect(byName.get("orc_launch")!.annotations?.readOnlyHint).toBe(false);
      expect(byName.get("orc_resume")!.annotations?.readOnlyHint).toBe(false);
      expect(byName.get("orc_respond")!.annotations?.readOnlyHint).toBe(false);
      expect(byName.get("orc_status")!.annotations?.readOnlyHint).toBe(true);
      expect(byName.get("orc_wait")!.annotations?.readOnlyHint).toBe(true);
      // schema plumbed from zod: launch requires programPath + brief
      const launchSchema = byName.get("orc_launch")!.inputSchema as {
        required?: string[];
        properties?: Record<string, unknown>;
      };
      expect(launchSchema.required).toContain("programPath");
      expect(launchSchema.required).toContain("brief");
      expect(launchSchema.properties).toHaveProperty("cwd");

      // calls work end-to-end over stdio
      const list = await client.callTool({ name: "orc_list", arguments: {} });
      expect(JSON.parse((list.content as Array<{ text: string }>)[0].text)).toEqual([]);
      const guide = await client.callTool({ name: "orc_guide", arguments: {} });
      expect((guide.content as Array<{ text: string }>)[0].text).toMatch(/agent\(prompt/);
    } finally {
      await client.close();
    }
  }, 60_000);
});
