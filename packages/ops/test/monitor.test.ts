import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openMonitor } from "@orc/ops";
import { MonitorServer, portForHome } from "@orc/ui";

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
        executorFor() {
          throw new Error("not used");
        },
      },
    });
    expect(result.url).toBe(started.url);
  });
});
