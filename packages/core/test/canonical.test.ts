import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import type { Json } from "../src/contracts.js";

describe("canonical JSON trust boundary", () => {
  it("rejects host values that JSON cannot represent faithfully", () => {
    expect(() => canonicalJson({ x: undefined } as unknown as Json)).toThrow(/unsupported JSON value/);
    expect(() => canonicalJson({ x: Number.NaN } as unknown as Json)).toThrow(/finite/);
    expect(() => canonicalJson(Array(2) as unknown as Json)).toThrow(/sparse/);
    expect(() => canonicalJson(new Date() as unknown as Json)).toThrow(/plain objects/);
    expect(() =>
      canonicalJson(
        Object.defineProperty({}, "changing", {
          enumerable: true,
          get: () => Math.random(),
        }) as Json,
      ),
    ).toThrow(/accessors/);
  });

  it("rejects cycles and excessive nesting before overflowing the host stack", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() => canonicalJson(cyclic as Json)).toThrow(/cycle/);

    let deep: Json = null;
    for (let i = 0; i < 300; i++) deep = [deep];
    expect(() => canonicalJson(deep)).toThrow(/nesting exceeds/);
  });
});
