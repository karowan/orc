import { createHash } from "node:crypto";
import type { Json } from "./contracts.js";

/**
 * Canonical JSON: sorted object keys, no whitespace. One rule used for
 * journal digests, result content-addressing, and spec hashing.
 * Numbers pass through JS semantics; integers beyond 2^53 are a pinned design
 * decision (host-side only — programs receive f64 like any JSON consumer).
 */
export function canonicalJson(value: Json): string {
  return stringify(value);
}

function stringify(v: Json): string {
  if (v === null || typeof v === "number" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stringify).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stringify(v[k] as Json)}`).join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestJson(value: Json): string {
  return sha256Hex(canonicalJson(value));
}

export function boundString(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8") + `…(truncated ${buf.byteLength - maxBytes} bytes)`;
}
