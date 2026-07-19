import { spawn } from "node:child_process";

/** Best-effort: open a URL in the default browser. Failures are ignored. */
export function openInBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* ignore — no browser available */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
