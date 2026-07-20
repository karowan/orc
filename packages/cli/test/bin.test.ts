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

describe("generated CLI flags", () => {
  it("collects repeated array flags in order", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-cli-"));
    homes.push(home);
    const program = path.join(home, "done.orc.ts");
    const orcHome = path.join(home, ".orc");
    fs.writeFileSync(program, "export default async () => ({ done: true });\n");

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "--import",
          TSX,
          CLI,
          "--json",
          "launch",
          "--program-path",
          program,
          "--brief",
          "test",
          "--wait",
          "--sandbox-dirs",
          "first",
          "--sandbox-dirs",
          "second",
        ],
        {
          cwd: home,
          encoding: "utf8",
          env: { ...process.env, ORC_HOME: orcHome },
          timeout: 30_000,
        },
      ),
    ) as { runId: string };
    const manifest = JSON.parse(
      fs.readFileSync(path.join(orcHome, "runs", result.runId, "manifest.json"), "utf8"),
    ) as { sandboxDirs: string[] };

    expect(manifest.sandboxDirs).toEqual(["first", "second"]);
  });

  it("accepts --no-* for booleans whose Zod default is true", () => {
    const result = JSON.parse(run("guide", "--no-probe")) as { guide: string };
    expect(result.guide).toContain("# orc — how to write and run a program");
    expect(result.guide).not.toContain("## Available on this machine");
  });
});
