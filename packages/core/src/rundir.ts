import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type { Json, JournalRecord, RunManifest, TraceRecord, ControlMessage } from "./contracts.js";

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
  const rand = Math.random().toString(36).slice(2, 8);
  return `r_${slug}_${rand}`;
}

/**
 * Append-only JSONL file with an explicit fsync mode.
 * The journal uses fsync-per-append (the WAL); the trace sidecar fsyncs only
 * on leaf close records (matching the Go sidecar durability rule).
 */
export class JsonlAppender<T> {
  private fd: number;
  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Torn-tail repair: if a crash left a partial final line (no newline),
    // terminate it so the fragment stays isolated instead of corrupting the
    // next append. Readers skip the unparseable fragment.
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.size > 0) {
        const tail = Buffer.alloc(1);
        const rfd = fs.openSync(filePath, "r");
        fs.readSync(rfd, tail, 0, 1, stat.size - 1);
        fs.closeSync(rfd);
        if (tail[0] !== 0x0a) fs.appendFileSync(filePath, "\n");
      }
    }
    this.fd = fs.openSync(filePath, "a");
  }
  append(record: T, opts?: { fsync?: boolean }): void {
    fs.writeSync(this.fd, JSON.stringify(record) + "\n");
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
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // torn record (crash mid-append) — it was never fsync-acknowledged.
      // Skip it and keep reading: records appended after a repaired tail are valid.
      continue;
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
  };
}

export function createRunDir(manifest: RunManifest, programBundle: string): RunPaths {
  const paths = runPaths(manifest.runId);
  fs.mkdirSync(paths.results, { recursive: true });
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
// Supervisor lock: pid + heartbeat mtime. resume/launch refuse while live.
// ---------------------------------------------------------------------------
const LOCK_STALE_MS = 30_000;

export function acquireLock(paths: RunPaths): { release(): void; beat(): void } {
  if (fs.existsSync(paths.lock)) {
    const stat = fs.statSync(paths.lock);
    const pid = Number(fs.readFileSync(paths.lock, "utf8").trim());
    const fresh = Date.now() - stat.mtimeMs < LOCK_STALE_MS;
    if (fresh && pid && isAlive(pid)) {
      throw new Error(`run is owned by a live supervisor (pid ${pid})`);
    }
  }
  fs.writeFileSync(paths.lock, String(process.pid));
  const interval = setInterval(() => {
    try {
      const now = new Date();
      fs.utimesSync(paths.lock, now, now);
    } catch {
      /* run dir removed */
    }
  }, 5_000);
  interval.unref();
  return {
    beat() {
      const now = new Date();
      fs.utimesSync(paths.lock, now, now);
    },
    release() {
      clearInterval(interval);
      try {
        fs.unlinkSync(paths.lock);
      } catch {
        /* gone */
      }
    },
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
