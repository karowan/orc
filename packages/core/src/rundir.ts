import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { Executor, Json, JournalRecord, RunManifest, TraceRecord, ControlMessage } from "./contracts.js";

/** State home: ~/.orc or $ORC_HOME. One run = one directory under runs/. */
export function orcHome(): string {
  return process.env.ORC_HOME ?? path.join(os.homedir(), ".orc");
}

export function runsDir(): string {
  return path.join(orcHome(), "runs");
}

export function runDir(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error(`invalid run id: ${runId}`);
  return path.join(runsDir(), runId);
}

export function newRunId(name?: string): string {
  const slug = (name ?? "run").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "run";
  const rand = randomBytes(8).toString("hex");
  return `r_${slug}_${rand}`;
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) {
    const written = fs.writeSync(fd, data, offset, data.byteLength - offset);
    if (written === 0) throw new Error("failed to make progress writing record");
    offset += written;
  }
}

function readFully(fd: number, data: Buffer, length: number, position: number): number {
  let offset = 0;
  while (offset < length) {
    const read = fs.readSync(fd, data, offset, length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return offset;
}

function truncateUnterminatedTail(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const fd = fs.openSync(filePath, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return;
    const last = Buffer.allocUnsafe(1);
    if (readFully(fd, last, 1, size - 1) !== 1) return;
    if (last[0] === 0x0a) return;

    const chunk = Buffer.allocUnsafe(Math.min(size, 64 * 1024));
    for (let end = size; end > 0; ) {
      const start = Math.max(0, end - chunk.byteLength);
      const read = readFully(fd, chunk, end - start, start);
      const newline = chunk.subarray(0, read).lastIndexOf(0x0a);
      if (newline >= 0) {
        fs.ftruncateSync(fd, start + newline + 1);
        return;
      }
      end = start;
    }
    fs.ftruncateSync(fd, 0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append-only JSONL file with an explicit fsync mode.
 * The journal uses fsync-per-append (the WAL); the trace sidecar fsyncs only
 * on leaf close records.
 */
export class JsonlAppender<T> {
  private fd: number;
  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // A record without its newline was never committed. Remove it before the
    // next append so corruption cannot become an accepted interior line.
    truncateUnterminatedTail(filePath);
    this.fd = fs.openSync(filePath, "a");
  }
  append(record: T, opts?: { fsync?: boolean }): void {
    writeAll(this.fd, Buffer.from(JSON.stringify(record) + "\n"));
    if (opts?.fsync !== false) fs.fsyncSync(this.fd);
  }
  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      /* already closed */
    }
  }
}

/** Read a JSONL file tolerating a torn final line (crash-during-append). */
export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8");
  const out: T[] = [];
  const lines = raw.split("\n");
  // The final split element is either empty (committed newline) or the one
  // uncommitted crash fragment readers are allowed to ignore.
  lines.pop();
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch (err) {
      throw new Error(
        `malformed JSONL record in ${filePath} at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return out;
}

export interface RunPaths {
  dir: string;
  manifest: string;
  program: string;
  journal: string;
  traces: string;
  control: string;
  results: string;
  report: string;
  lock: string;
  supervisorPid: string;
  pgids: string;
}

export function runPaths(runId: string): RunPaths {
  const dir = runDir(runId);
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    program: path.join(dir, "program.bundle.js"),
    journal: path.join(dir, "journal.jsonl"),
    traces: path.join(dir, "traces.jsonl"),
    control: path.join(dir, "control.jsonl"),
    results: path.join(dir, "results"),
    report: path.join(dir, "report.html"),
    lock: path.join(dir, "supervisor.lock"),
    supervisorPid: path.join(dir, "supervisor.pid"),
    pgids: path.join(dir, "pgids.jsonl"),
  };
}

export function createRunDir(manifest: RunManifest, programBundle: string): RunPaths {
  const paths = runPaths(manifest.runId);
  fs.mkdirSync(runsDir(), { recursive: true });
  fs.mkdirSync(paths.dir);
  fs.mkdirSync(paths.results);
  fs.writeFileSync(paths.program, programBundle);
  fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2));
  return paths;
}

export function readManifest(runId: string): RunManifest {
  return JSON.parse(fs.readFileSync(runPaths(runId).manifest, "utf8")) as RunManifest;
}

export function listRuns(): RunManifest[] {
  const dir = runsDir();
  if (!fs.existsSync(dir)) return [];
  const out: RunManifest[] = [];
  for (const entry of fs.readdirSync(dir)) {
    try {
      out.push(readManifest(entry));
    } catch {
      /* skip malformed */
    }
  }
  return out.sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** Content-addressed result body storage. */
export function writeResult(paths: RunPaths, body: Json): { sha: string; sizeBytes: number } {
  const canonical = canonicalJson(body);
  const sha = sha256Hex(canonical);
  const file = path.join(paths.results, `${sha}.json`);
  if (!fs.existsSync(file)) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, canonical);
    const fd = fs.openSync(tmp, "r+");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  }
  return { sha, sizeBytes: Buffer.byteLength(canonical) };
}

export function readResult(paths: RunPaths, sha: string): Json {
  const file = path.join(paths.results, `${sha}.json`);
  const raw = fs.readFileSync(file, "utf8");
  if (sha256Hex(raw) !== sha) throw new Error(`result body digest mismatch for ${sha}`);
  return JSON.parse(raw) as Json;
}

export function readJournal(runId: string): JournalRecord[] {
  return readJsonl<JournalRecord>(runPaths(runId).journal);
}

export function readTraces(runId: string): TraceRecord[] {
  return readJsonl<TraceRecord>(runPaths(runId).traces);
}

export function readControl(runId: string): ControlMessage[] {
  return readJsonl<ControlMessage>(runPaths(runId).control);
}

export function appendControl(runId: string, msg: ControlMessage): void {
  const appender = new JsonlAppender<ControlMessage>(runPaths(runId).control);
  appender.append(msg, { fsync: true });
  appender.close();
}

// ---------------------------------------------------------------------------
// Hard-cancel trail: the supervisor's pid and the executor children's process
// groups, kept durable so an out-of-band canceller can reap a run whose
// supervisor is dead or wedged and can no longer cooperate.
// ---------------------------------------------------------------------------

/** Record the owning supervisor's pid. Overwritten by every (re)acquisition. */
export function writeSupervisorPid(paths: RunPaths, pid: number): void {
  fs.writeFileSync(paths.supervisorPid, `${pid}\n`);
}

export function readSupervisorPid(paths: RunPaths): number | undefined {
  if (!fs.existsSync(paths.supervisorPid)) return undefined;
  const pid = Number(fs.readFileSync(paths.supervisorPid, "utf8").trim());
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** One executor child's process group: recorded on spawn, released on exit. */
export interface PgidRecord {
  t: "spawn" | "exit";
  pgid: number;
  atMs: number;
}

export function appendPgid(paths: RunPaths, record: PgidRecord): void {
  const appender = new JsonlAppender<PgidRecord>(paths.pgids);
  try {
    appender.append(record, { fsync: true });
  } finally {
    appender.close();
  }
}

/** Process groups spawned for this run that have no recorded exit. */
export function livePgids(paths: RunPaths): number[] {
  const live = new Set<number>();
  for (const record of readJsonl<PgidRecord>(paths.pgids)) {
    if (record.t === "spawn") live.add(record.pgid);
    else live.delete(record.pgid);
  }
  return [...live];
}

/**
 * Run-scoped executor wrapper handed to leaves: executor children are detached
 * process-group leaders (pid === pgid — that is what makes Proc.kill's
 * group-wide TERM→KILL possible), and a hard cancel must be able to find those
 * groups after the supervisor is gone. `run()` probes are awaited to
 * completion by their callers and are deliberately not recorded.
 */
export function withPgidRecording(executor: Executor, paths: RunPaths): Executor {
  return {
    spawn(cmd, opts) {
      const proc = executor.spawn(cmd, opts);
      const pgid = proc.pid;
      if (pgid !== undefined) {
        appendPgid(paths, { t: "spawn", pgid, atMs: Date.now() });
        void proc.exited.then(() => {
          try {
            appendPgid(paths, { t: "exit", pgid, atMs: Date.now() });
          } catch {
            /* a stale live record only means a later no-op kill */
          }
        });
      }
      return proc;
    },
    run: (cmd, opts) => executor.run(cmd, opts),
    exists: (target) => executor.exists(target),
    readFile: (target) => executor.readFile(target),
    writeFile: (target, data) => executor.writeFile(target, data),
  };
}

// ---------------------------------------------------------------------------
// Supervisor lock: a platform advisory lock held by a tiny child process.
// ---------------------------------------------------------------------------
const LOCK_READY = "orc-lock-ready:";
const LOCK_HOLDER = `process.stdout.write(${JSON.stringify(LOCK_READY)}+process.pid+"\\n");process.stdin.resume()`;

export async function acquireLock(
  paths: RunPaths,
): Promise<{ release(): Promise<void>; beat(): void; lost: Promise<never>; holderPid: number }> {
  fs.mkdirSync(path.dirname(paths.lock), { recursive: true });
  const command =
    process.platform === "darwin"
      ? ["/usr/bin/lockf", "-k", "-s", "-t", "0", paths.lock]
      : process.platform === "linux"
        ? ["flock", "-n", paths.lock]
        : undefined;
  if (!command) {
    throw new Error(`supervisor locking is unsupported on ${process.platform}`);
  }
  command.push(process.execPath, "-e", LOCK_HOLDER);
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {
    /* acquisition/exit paths report the child outcome */
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const spawnFailed = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });
  let holderPid: number | undefined;
  let acquireTimer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => {
        const onData = () => {
          const match = stdout.match(/orc-lock-ready:(\d+)\n/);
          if (!match) return;
          holderPid = Number(match[1]);
          child.stdout.removeListener("data", onData);
          resolve();
        };
        child.stdout.on("data", onData);
      }),
      exited.then(({ code, signal }) => {
        throw new Error(
          code === 75 || (process.platform === "linux" && code === 1)
            ? "run is owned by a live supervisor"
            : `failed to acquire supervisor lock (${signal ?? code}): ${stderr.trim()}`,
        );
      }),
      spawnFailed,
      new Promise<never>((_, reject) => {
        acquireTimer = setTimeout(
          () => reject(new Error("timed out acquiring supervisor lock")),
          5_000,
        );
        acquireTimer.unref();
      }),
    ]);
  } catch (err) {
    child.stdin.end();
    child.kill();
    await exited;
    throw err;
  } finally {
    if (acquireTimer) clearTimeout(acquireTimer);
  }

  let released = false;
  const lost: Promise<never> = exited.then(({ code, signal }) => {
    if (!released) {
      throw new Error(`supervisor lock holder exited unexpectedly (${signal ?? code})`);
    }
    return new Promise<never>(() => undefined);
  });
  void lost.catch(() => undefined);
  return {
    holderPid: holderPid!,
    lost,
    beat() {
      if (child.exitCode !== null) throw new Error("supervisor lock was lost");
    },
    async release() {
      if (released) return;
      released = true;
      child.stdin.end();
      await exited;
    },
  };
}
