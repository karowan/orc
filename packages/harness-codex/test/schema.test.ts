import { describe, expect, it } from "vitest";
import { extractFirstJsonObject, lintStrictOutputSchema, normalizeSchema } from "../src/schema.js";

describe("normalizeSchema", () => {
  it("adds additionalProperties:false, sorts keys, and enforces OpenAI strict mode", () => {
    const norm = normalizeSchema({
      type: "object",
      properties: {
        zebra: { type: "string" },
        alpha: { type: "object", properties: { b: { type: "number" }, a: { type: "number" } } },
      },
      required: ["zebra"],
    }) as Record<string, unknown>;
    expect(norm.additionalProperties).toBe(false);
    expect(Object.keys(norm)).toEqual(["additionalProperties", "properties", "required", "type"]);
    // strict mode: required lists EVERY property, sorted
    expect(norm.required).toEqual(["alpha", "zebra"]);
    const props = norm.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(props)).toEqual(["alpha", "zebra"]);
    expect(props.alpha.additionalProperties).toBe(false);
    // alpha was NOT originally required -> made nullable (type union with null)
    expect(props.alpha.type).toEqual(["object", "null"]);
    // zebra WAS required -> stays a plain string
    expect(props.zebra.type).toBe("string");
  });

  it("keeps a genuinely optional field usable by making it nullable, not dropping it", () => {
    const norm = normalizeSchema({
      type: "object",
      properties: { need: { type: "string" }, gap: { type: "string" } },
      required: ["need"],
    }) as Record<string, unknown>;
    const props = norm.properties as Record<string, Record<string, unknown>>;
    expect(norm.required).toEqual(["gap", "need"]);
    expect(props.gap.type).toEqual(["string", "null"]);
  });

  it("adds null to an enum for an optional enum field", () => {
    const norm = normalizeSchema({
      type: "object",
      properties: { status: { type: "string", enum: ["a", "b"] } },
    }) as Record<string, unknown>;
    const status = (norm.properties as Record<string, Record<string, unknown>>).status;
    expect(status.type).toEqual(["string", "null"]);
    expect(status.enum).toEqual(["a", "b", null]);
  });

  it("preserves an explicit additionalProperties value", () => {
    const norm = normalizeSchema({ type: "object", additionalProperties: true }) as Record<
      string,
      unknown
    >;
    expect(norm.additionalProperties).toBe(true);
  });

  it("recurses through arrays and non-object schemas untouched", () => {
    expect(normalizeSchema({ type: "string" })).toEqual({ type: "string" });
    expect(normalizeSchema({ anyOf: [{ type: "object" }, { type: "null" }] })).toEqual({
      anyOf: [{ additionalProperties: false, type: "object" }, { type: "null" }],
    });
  });
});

describe("extractFirstJsonObject", () => {
  it("extracts a balanced object from surrounding prose", () => {
    expect(extractFirstJsonObject('Sure! Here you go: {"ok":true} hope that helps')).toEqual({
      ok: true,
    });
  });

  it("handles braces inside strings", () => {
    expect(extractFirstJsonObject('x {"msg":"open { and close }","n":1} y')).toEqual({
      msg: "open { and close }",
      n: 1,
    });
  });

  it("skips unparseable brace runs and finds a later object", () => {
    expect(extractFirstJsonObject("{not json} then {\"a\":1}")).toEqual({ a: 1 });
  });

  it("returns undefined when there is no object", () => {
    expect(extractFirstJsonObject("no json here")).toBeUndefined();
    expect(extractFirstJsonObject("{never closes")).toBeUndefined();
  });
});

describe("lintStrictOutputSchema", () => {
  it("passes a fully-specified strict schema", () => {
    expect(
      lintStrictOutputSchema({
        type: "object",
        additionalProperties: false,
        properties: { items: { type: "array", items: { type: "string" } } },
        required: ["items"],
      }),
    ).toEqual([]);
  });

  it("flags an explicit open-ended object (additionalProperties:true)", () => {
    const problems = lintStrictOutputSchema({
      type: "object",
      properties: {
        metrics: { type: "object", additionalProperties: true },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("$.properties.metrics");
    expect(problems[0]).toContain("additionalProperties");
  });

  it("flags additionalProperties given as a sub-schema", () => {
    const problems = lintStrictOutputSchema({
      type: "object",
      additionalProperties: { type: "number" },
    });
    expect(problems).toHaveLength(1);
  });

  it("finds open maps nested inside arrays and properties", () => {
    const problems = lintStrictOutputSchema({
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", additionalProperties: true } },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("rows");
  });

  it("does NOT flag a schema whose object closes additionalProperties", () => {
    expect(
      lintStrictOutputSchema({ type: "object", additionalProperties: false, properties: {} }),
    ).toEqual([]);
  });
});
