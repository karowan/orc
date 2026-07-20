import { createHash } from "node:crypto";
import type { Json } from "./contracts.js";

/**
 * Canonical JSON: sorted object keys, no whitespace. One rule used for
 * journal digests, result content-addressing, and spec hashing.
 * Numbers pass through JS semantics; integers beyond 2^53 are a pinned design
 * decision (host-side only — programs receive f64 like any JSON consumer).
 */
export function canonicalJson(value: Json): string {
  return stringify(value, 0, new WeakSet<object>());
}

const MAX_JSON_DEPTH = 256;

function stringify(v: Json, depth: number, ancestors: WeakSet<object>): string {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`JSON nesting exceeds ${MAX_JSON_DEPTH}`);
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new TypeError("JSON numbers must be finite");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") throw new TypeError(`unsupported JSON value: ${typeof v}`);
  if (ancestors.has(v)) throw new TypeError("JSON value contains a cycle");

  ancestors.add(v);
  try {
    if (Array.isArray(v)) {
      const items: string[] = [];
      for (let i = 0; i < v.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(v, i);
        if (!descriptor) throw new TypeError("JSON arrays cannot be sparse");
        if (!("value" in descriptor)) throw new TypeError("JSON properties cannot be accessors");
        items.push(stringify(descriptor.value as Json, depth + 1, ancestors));
      }
      return `[${items.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(v);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JSON objects must be plain objects");
    }
    const keys = Object.keys(v).sort();
    return `{${keys
      .map((k) => {
        const descriptor = Object.getOwnPropertyDescriptor(v, k)!;
        if (!("value" in descriptor)) throw new TypeError("JSON properties cannot be accessors");
        return `${JSON.stringify(k)}:${stringify(descriptor.value as Json, depth + 1, ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(v);
  }
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
