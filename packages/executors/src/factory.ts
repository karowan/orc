import type { Executor } from "@orc/core";
import { LocalExecutor } from "./local.js";
import { SshExecutor } from "./ssh.js";

const sshCache = new Map<string, Executor>();
let localSingleton: Executor | undefined;

/**
 * Executor for a host: undefined => the local host, otherwise an ssh
 * destination string ("frank", "user@host"). Instances are cached per host.
 */
export function executorFor(host: string | undefined): Executor {
  if (host === undefined || host === "") {
    return (localSingleton ??= new LocalExecutor());
  }
  let executor = sshCache.get(host);
  if (!executor) {
    executor = new SshExecutor(host);
    sshCache.set(host, executor);
  }
  return executor;
}

/** Test seam: drop all cached executors. */
export function resetExecutorCache(): void {
  sshCache.clear();
  localSingleton = undefined;
}
