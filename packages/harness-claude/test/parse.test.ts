import { describe, expect, it } from "vitest";
import { extractJson } from "../src/index.js";

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
