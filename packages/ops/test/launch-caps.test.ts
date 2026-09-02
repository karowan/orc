import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildRegistry, launch } from "@karowanorg/orc-ops";
import { MAX_COMMANDS_CEILING, readManifest } from "@karowanorg/orc-core";

describe("launch --max-commands", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.ORC_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-launch-caps-"));
    process.env.ORC_HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("accepts values up to the ceiling and rejects the rest at the schema", () => {
    expect(launch.input.parse({ programPath: "p.orc.ts", maxCommands: MAX_COMMANDS_CEILING }).maxCommands).toBe(MAX_COMMANDS_CEILING);
    expect(() => launch.input.parse({ programPath: "p.orc.ts", maxCommands: MAX_COMMANDS_CEILING + 1 })).toThrow();
    expect(() => launch.input.parse({ programPath: "p.orc.ts", maxCommands: 0 })).toThrow();
    expect(() => launch.input.parse({ programPath: "p.orc.ts", maxCommands: 1.5 })).toThrow();
  });

  it("reaches the run manifest", async () => {
    const program = path.join(home, "done.orc.ts");
    fs.writeFileSync(program, "export default async () => ({ done: true });\n");
    const registry = await buildRegistry({ cwd: home });
    const r = await launch.handler(
      launch.input.parse({ programPath: program, cwd: home, maxCommands: 7, wait: true }),
      { registry },
    );
    expect(readManifest(r.runId).maxCommands).toBe(7);
  });
});
