import type { Json } from "./contracts.js";

/**
 * Minimal JSON Schema validation — enough for extension inputSchema gating and
 * capability/selector checks. Supports: type (incl. nullable arrays), required,
 * properties, enum, items. Returns the first problem string, or null if valid.
 * Not a full validator; deliberately small and dependency-free.
 */
export function validateAgainstSchema(value: Json, schema: Json, path = "$"): string | null {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return null;
  const s = schema as { [k: string]: Json };

  if (s.enum !== undefined && Array.isArray(s.enum)) {
    const ok = s.enum.some((e) => deepEqual(e, value));
    if (!ok) return `${path}: value not in enum ${JSON.stringify(s.enum)}`;
  }

  const types = normalizeType(s.type);
  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    return `${path}: expected type ${types.join("|")}, got ${jsonType(value)}`;
  }

  if (matchesType(value, "object") && value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as { [k: string]: Json };
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (typeof key === "string" && !(key in obj)) return `${path}: missing required property "${key}"`;
      }
    }
    if (s.properties && typeof s.properties === "object" && !Array.isArray(s.properties)) {
      const props = s.properties as { [k: string]: Json };
      for (const [key, sub] of Object.entries(props)) {
        if (key in obj) {
          const problem = validateAgainstSchema(obj[key], sub, `${path}.${key}`);
          if (problem) return problem;
        }
      }
    }
  }

  if (matchesType(value, "array") && Array.isArray(value) && s.items) {
    for (let i = 0; i < value.length; i++) {
      const problem = validateAgainstSchema(value[i], s.items, `${path}[${i}]`);
      if (problem) return problem;
    }
  }
  return null;
}

function normalizeType(t: Json): string[] {
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  return [];
}

function matchesType(value: Json, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true;
  }
}

function jsonType(value: Json): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: Json, b: Json): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
