import { describe, expect, it } from "vitest";
import { extractJson, pathWithin } from "../src/index.js";

describe("extractJson", () => {
  it("parses clean JSON", () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true });
  });
  it("scans prose for the last balanced object", () => {
    expect(extractJson('Here you go:\n{"a":1} and then {"b":{"c":2}} done')).toEqual({ b: { c: 2 } });
  });
  it("falls back to text wrapper", () => {
    expect(extractJson("no json here")).toEqual({ text: "no json here" });
  });
  it("handles nested braces in strings", () => {
    expect(extractJson('x {"s":"has } brace","n":1}')).toEqual({ s: "has } brace", n: 1 });
  });
});

describe("pathWithin (write sandbox confinement)", () => {
  const roots = ["/srv/repo", "/home/u/.cache"];
  it("allows paths at or under an allowed root", () => {
    expect(pathWithin("/srv/repo/src/a.ts", roots)).toBe(true);
    expect(pathWithin("/srv/repo", roots)).toBe(true);
    expect(pathWithin("/home/u/.cache/go/build", roots)).toBe(true);
  });
  it("denies paths outside every root", () => {
    expect(pathWithin("/etc/passwd", roots)).toBe(false);
    expect(pathWithin("/home/u/.ssh/config", roots)).toBe(false);
    // prefix trickery: /srv/repo-evil must NOT match /srv/repo
    expect(pathWithin("/srv/repo-evil/x", roots)).toBe(false);
  });
  it("resolves relative and .. traversal before checking", () => {
    expect(pathWithin("/srv/repo/../repo/ok.ts", roots)).toBe(true);
    expect(pathWithin("/srv/repo/../../etc/x", roots)).toBe(false);
  });
});
