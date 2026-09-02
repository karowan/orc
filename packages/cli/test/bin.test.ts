import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(__dirname, "..", "src", "bin.ts");
const TSX = createRequire(path.join(__dirname, "resolver.cjs")).resolve("tsx");
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-cli-"));
  homes.push(home);
  return execFileSync(process.execPath, ["--import", TSX, CLI, "--json", ...args], {
    cwd: home,
    encoding: "utf8",
    env: { ...process.env, ORC_HOME: path.join(home, ".orc") },
    timeout: 30_000,
  });
}

/** Launch a trivial program to completion and read back its manifest. */
function launch(...extraArgs: string[]): Record<string, unknown> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-cli-"));
  homes.push(home);
  const program = path.join(home, "done.orc.ts");
  const orcHome = path.join(home, ".orc");
  fs.writeFileSync(program, "export default async () => ({ done: true });\n");

  const result = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", TSX, CLI, "--json", "launch", "--program-path", program, "--wait", ...extraArgs],
      {
        cwd: home,
        encoding: "utf8",
        env: { ...process.env, ORC_HOME: orcHome },
        timeout: 30_000,
      },
    ),
  ) as { runId: string };
  return JSON.parse(
    fs.readFileSync(path.join(orcHome, "runs", result.runId, "manifest.json"), "utf8"),
  ) as Record<string, unknown>;
}

describe("generated CLI flags", () => {
  it("collects repeated array flags in order", () => {
    // No --context: the run-level slot is optional.
    const manifest = launch("--sandbox-dirs", "first", "--sandbox-dirs", "second");
    expect(manifest.sandboxDirs).toEqual(["first", "second"]);
    expect(manifest).not.toHaveProperty("context");
  });

  it("resolves the generated --read-dirs grants into the manifest, in order", () => {
    const readDirs = launch("--read-dirs", "docs-a", "--read-dirs", "docs-b").readDirs as string[];
    // The child's cwd may be a canonicalized tmpdir, so pin shape and order only.
    expect(readDirs.every((dir) => path.isAbsolute(dir))).toBe(true);
    expect(readDirs.map((dir) => path.basename(dir))).toEqual(["docs-a", "docs-b"]);
  });

  it("carries the optional --context into the manifest", () => {
    expect(launch("--context", "cli ctx").context).toBe("cli ctx");
  });

  it("derives --max-context-bytes and carries it as a number", () => {
    expect(launch("--max-context-bytes", "4096").maxContextBytes).toBe(4096);
  });

  it("accepts --no-* for booleans whose Zod default is true", () => {
    const result = JSON.parse(run("guide", "--no-probe")) as { guide: string };
    expect(result.guide).toContain("# orc — how to write and run a program");
    expect(result.guide).not.toContain("## Available on this machine");
  });

  it("exposes named approval actions through the generated respond command", () => {
    const catalog = JSON.parse(run("commands")) as Array<{
      name: string;
      inputSchema: {
        required?: string[];
        properties?: Record<string, unknown>;
      };
    }>;
    const respond = catalog.find((entry) => entry.name === "respond");
    expect(respond?.inputSchema.properties).toHaveProperty("action");
    expect(respond?.inputSchema.properties).toHaveProperty("behavior");
    expect(respond?.inputSchema.required).toEqual(["runId", "approvalId"]);

    const launchOp = catalog.find((entry) => entry.name === "launch");
    expect(launchOp?.inputSchema.properties).toHaveProperty("maxContextBytes");
    expect(launchOp?.inputSchema.required ?? []).not.toContain("maxContextBytes");
  });
});

describe("launch output", () => {
  it("tells a human when nothing serves the monitor URL it printed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-cli-"));
    homes.push(home);
    const program = path.join(home, "done.orc.ts");
    fs.writeFileSync(program, "export default async () => ({ done: true });\n");
    const out = execFileSync(
      process.execPath,
      ["--import", TSX, CLI, "launch", "--program-path", program, "--wait"],
      { cwd: home, encoding: "utf8", env: { ...process.env, ORC_HOME: path.join(home, ".orc") }, timeout: 30_000 },
    );
    expect(out).toMatch(/^monitor http:\/\/127\.0\.0\.1:\d+\/runs\//m);
    expect(out).toContain("note    no monitor is serving that URL");
    expect(out).toContain("orc open --run-id");
  });
});
