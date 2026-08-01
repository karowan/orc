import { readManifest, superviseRun } from "@karowanorg/orc-core";
import { writeReport } from "@karowanorg/orc-ui";
import { buildRegistry } from "./registry.js";

async function signalStartup(
  type: "orc-supervisor-ready" | "orc-supervisor-error",
  message?: string,
): Promise<void> {
  if (typeof process.send !== "function") return;
  await new Promise<void>((resolve) => {
    try {
      process.send!({ type, message }, () => {
        if (process.connected) process.disconnect();
        resolve();
      });
    } catch {
      resolve();
    }
  });
}

/** Package-owned detached-supervisor body, shared by the CLI and SDK child entry. */
export async function runSupervisorChild(
  runId: string,
  registryCwd = process.env.ORC_SUPERVISOR_REGISTRY_CWD,
  startupSignal = signalStartup,
): Promise<void> {
  let lastReportAt = 0;
  let startupSignaled = false;
  const onReady = () => {
    if (!startupSignaled) {
      startupSignaled = true;
      void startupSignal("orc-supervisor-ready");
    }
  };
  const onUpdate = (id: string) => {
    if (Date.now() - lastReportAt <= 1_000) return;
    lastReportAt = Date.now();
    try {
      writeReport(id);
    } catch {
      /* best-effort */
    }
  };
  try {
    const registry = await buildRegistry({ cwd: registryCwd });
    readManifest(runId);
    await superviseRun(runId, registry, { onReady, onUpdate });
    if (!startupSignaled) {
      startupSignaled = true;
      await startupSignal("orc-supervisor-ready");
    }
    writeReport(runId);
  } catch (err) {
    if (!startupSignaled) {
      startupSignaled = true;
      await startupSignal(
        "orc-supervisor-error",
        String(err instanceof Error ? err.message : err),
      );
    }
    throw err;
  }
}
