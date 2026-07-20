import { readManifest, superviseRun } from "@orc/core";
import { writeReport } from "@orc/ui";
import { buildRegistry } from "./registry.js";

async function signalStartup(type: "orc-supervisor-ready" | "orc-supervisor-error", message?: string): Promise<void> {
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
): Promise<void> {
  let lastReportAt = 0;
  let settled = false;
  let startupQueued = false;
  let startupSignaled = false;
  const onUpdate = (id: string) => {
    if (!startupQueued) {
      startupQueued = true;
      // superviseRun also calls onUpdate from its finally block. Deferring one
      // turn lets a preflight rejection win and report an error instead.
      setImmediate(() => {
        if (settled || startupSignaled) return;
        startupSignaled = true;
        void signalStartup("orc-supervisor-ready");
      });
    }
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
    await superviseRun(runId, registry, { onUpdate });
    settled = true;
    if (!startupSignaled) {
      startupSignaled = true;
      await signalStartup("orc-supervisor-ready");
    }
    writeReport(runId);
  } catch (err) {
    settled = true;
    if (!startupSignaled) {
      startupSignaled = true;
      await signalStartup("orc-supervisor-error", String(err instanceof Error ? err.message : err));
    }
    throw err;
  }
}
