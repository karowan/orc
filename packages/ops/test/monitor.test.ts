import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildRegistry, launch, openMonitor } from "@karowanorg/orc-ops";
import { MonitorServer, portForHome } from "@karowanorg/orc-ui";

describe("open monitor discovery", () => {
  let home: string;
  let previousHome: string | undefined;
  let blocker: http.Server | undefined;
  let monitor: MonitorServer | undefined;

  beforeEach(() => {
    previousHome = process.env.ORC_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-monitor-discovery-"));
    process.env.ORC_HOME = home;
  });

  afterEach(async () => {
    await monitor?.stop();
    if (blocker) {
      await new Promise<void>((resolve) => blocker!.close(() => resolve()));
    }
    if (previousHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("ignores unrelated HTTP servers and returns the monitor fallback port", async () => {
    blocker = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" }).end("some other service");
    });
    await new Promise<void>((resolve, reject) => {
      blocker!.once("error", reject);
      blocker!.listen(portForHome(home), "127.0.0.1", resolve);
    });

    monitor = new MonitorServer();
    const started = await monitor.start();
    expect(started.port).toBe(portForHome(home) + 1);

    const result = await openMonitor.handler({ browser: false }, {
      registry: {
        harnesses: new Map(),
        extensions: new Map(),
        defaultHarness: "none",
        executor: new Proxy({} as never, {
          get() {
            throw new Error("not used");
          },
        }),
      },
    });
    expect(result.url).toBe(started.url);
  });
});

describe("launch monitor reporting", () => {
  let home: string;
  let previousHome: string | undefined;
  let monitor: MonitorServer | undefined;

  beforeEach(() => {
    previousHome = process.env.ORC_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "orc-launch-monitor-"));
    process.env.ORC_HOME = home;
  });

  afterEach(async () => {
    await monitor?.stop();
    monitor = undefined;
    if (previousHome === undefined) delete process.env.ORC_HOME;
    else process.env.ORC_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function launchTrivial(): Promise<{ runId: string; monitorUrl: string; monitorRunning: boolean }> {
    const program = path.join(home, "done.orc.ts");
    fs.writeFileSync(program, "export default async () => ({ done: true });\n");
    const registry = await buildRegistry({ cwd: home });
    return launch.handler(
      { programPath: program, cwd: home, allowWrites: false, approvalMode: "auto", sandbox: false, networkAccess: false, wait: true },
      { registry },
    );
  }

  it("says no monitor is running and prints the deterministic URL", async () => {
    const cold = await launchTrivial();
    expect(cold.monitorRunning).toBe(false);
    expect(cold.monitorUrl).toBe(`http://127.0.0.1:${portForHome(home)}/runs/${cold.runId}`);
  });

  it("reports the live monitor's actual URL, fallback port included", async () => {
    const blocker = http.createServer((_req, res) => res.writeHead(200).end("other"));
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(portForHome(home), "127.0.0.1", resolve);
    });
    try {
      monitor = new MonitorServer();
      const started = await monitor.start();
      const warm = await launchTrivial();
      expect(warm.monitorRunning).toBe(true);
      expect(warm.monitorUrl).toBe(`${started.url}/runs/${warm.runId}`);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
