import type { Json } from "@orc/core";
import { validateAgainstSchema } from "@orc/core";

/**
 * Normalize a JSON Schema for codex `outputSchema`.
 *
 * OpenAI structured output (which codex uses) is STRICTER than Claude's:
 * on every object it requires `additionalProperties: false` AND that `required`
 * lists every key in `properties`. A merely-optional field ("gap" not in
 * required) is rejected as `invalid_json_schema`. The documented transform is:
 * make every property required, and for the ones that were originally optional,
 * make them NULLABLE so the model can still omit them by returning null. That
 * preserves the author's intent (optional) while satisfying strict mode.
 */
export function normalizeSchema(schema: Json): Json {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const source: { [k: string]: Json } = { ...schema };
  const isObjectType = source.type === "object";
  const hasProps = source.properties !== null && typeof source.properties === "object";

  let originallyRequired = new Set<string>();
  if (Array.isArray(source.required)) {
    originallyRequired = new Set(source.required.filter((k): k is string => typeof k === "string"));
  }

  const out: { [k: string]: Json } = {};
  const propKeys: string[] = [];

  for (const key of Object.keys(source).sort()) {
    if (key === "properties" && hasProps) {
      const props = source[key] as { [k: string]: Json };
      const sorted: { [k: string]: Json } = {};
      for (const p of Object.keys(props).sort()) {
        propKeys.push(p);
        let normalized = normalizeSchema(props[p]);
        if (!originallyRequired.has(p)) normalized = makeNullable(normalized);
        sorted[p] = normalized;
      }
      out[key] = sorted;
    } else if (key === "required" && hasProps) {
      // replaced below with the full key set (strict mode)
    } else {
      out[key] = normalizeSchema(source[key]);
    }
  }

  // Every object gets additionalProperties:false (unless explicitly set); an
  // object WITH properties additionally requires every key (strict mode).
  if (isObjectType && !("additionalProperties" in source)) out.additionalProperties = false;
  if (hasProps) out.required = [...propKeys].sort();

  // Stable wire form: sorted top-level keys (incl. the injected ones).
  const sortedOut: { [k: string]: Json } = {};
  for (const k of Object.keys(out).sort()) sortedOut[k] = out[k];
  return sortedOut;
}

/**
 * Project Codex's strict-schema output back to the caller's schema semantics.
 * Strict mode represents an omitted optional field as `null`; the original
 * schema generally expects that key to be absent instead.
 */
export function restoreOptionalNulls(value: Json, schema: Json): Json {
  return restoreNode(value, schema, schema, new Set());
}

function restoreNode(value: Json, schema: Json, root: Json, refs: Set<string>): Json {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return value;
  const s = schema as { [k: string]: Json };

  if (typeof s.$ref === "string" && !refs.has(s.$ref)) {
    const target = resolveLocalRef(root, s.$ref);
    if (target !== undefined) {
      refs.add(s.$ref);
      value = restoreNode(value, target, root, refs);
      refs.delete(s.$ref);
    }
  }

  if (Array.isArray(value)) {
    if (s.items !== undefined && !Array.isArray(s.items)) {
      value = value.map((item) => restoreNode(item, s.items!, root, refs));
    }
  } else if (value !== null && typeof value === "object") {
    const properties =
      s.properties !== null && typeof s.properties === "object" && !Array.isArray(s.properties)
        ? (s.properties as { [k: string]: Json })
        : undefined;
    if (properties) {
      const required = new Set(
        Array.isArray(s.required)
          ? s.required.filter((key): key is string => typeof key === "string")
          : [],
      );
      const out = { ...value } as { [k: string]: Json };
      for (const [key, propertySchema] of Object.entries(properties)) {
        if (!(key in out)) continue;
        if (
          out[key] === null &&
          !required.has(key) &&
          !acceptsNull(propertySchema, root)
        ) {
          delete out[key];
        } else {
          out[key] = restoreNode(out[key], propertySchema, root, refs);
        }
      }
      value = out;
    }
  }

  if (Array.isArray(s.allOf)) {
    for (const branch of s.allOf) value = restoreNode(value, branch, root, refs);
  }
  const union = Array.isArray(s.anyOf)
    ? s.anyOf
    : Array.isArray(s.oneOf)
      ? s.oneOf
      : undefined;
  if (union) {
    const original = union.find((branch) => matchesSchema(value, branch, root));
    if (original) return restoreNode(value, original, root, refs);
    for (const branch of union) {
      const candidate = restoreNode(value, branch, root, refs);
      if (matchesSchema(candidate, branch, root)) return candidate;
    }
  }
  return value;
}

function matchesSchema(value: Json, schema: Json, root: Json): boolean {
  if (
    schema === null ||
    typeof schema !== "object" ||
    Array.isArray(schema) ||
    root === null ||
    typeof root !== "object" ||
    Array.isArray(root)
  ) {
    return validateAgainstSchema(value, schema) === null;
  }
  const rootSchema = root as { [k: string]: Json };
  return (
    validateAgainstSchema(value, {
      ...schema,
      ...("$defs" in rootSchema && !("$defs" in schema) ? { $defs: rootSchema.$defs } : {}),
      ...("definitions" in rootSchema && !("definitions" in schema)
        ? { definitions: rootSchema.definitions }
        : {}),
    }) === null
  );
}

function resolveLocalRef(root: Json, ref: string): Json | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: Json | undefined = root;
  for (const raw of ref.slice(2).split("/")) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    node = (node as { [k: string]: Json })[key];
  }
  return node;
}

/**
 * Statically flag the parts of a JSON Schema that OpenAI/codex strict output
 * REJECTS and that `normalizeSchema` cannot auto-fix without changing meaning.
 *
 * The one construct that can't be repaired is an open-ended object — a map with
 * `additionalProperties: true` (or a sub-schema). Strict mode can only describe
 * a fixed set of keys, so the only faithful fix is the author's: replace the map
 * with an array of typed records (e.g. `{ name, value }`). `normalizeSchema`
 * injects `additionalProperties: false` only when the key is ABSENT, so an
 * explicit open map survives to a runtime `invalid_json_schema` — which this
 * lint turns into an up-front `orc validate` problem instead.
 */
export function lintStrictOutputSchema(schema: Json): string[] {
  const problems: string[] = [];
  walk(schema, "$");
  return problems;

  function walk(node: Json, path: string): void {
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    const o = node as { [k: string]: Json };
    const isObject = o.type === "object" || (o.properties != null && typeof o.properties === "object");
    if (isObject && "additionalProperties" in o && o.additionalProperties !== false) {
      problems.push(
        `${path}: open-ended object (additionalProperties is not false) — codex strict structured output can't express arbitrary keys; replace the map with an array of typed records, e.g. [{ name, value }]`,
      );
    }
    for (const [k, v] of Object.entries(o)) walk(v, path === "$" ? `$.${k}` : `${path}.${k}`);
  }
}

/** Make a property schema accept null (optional-in-strict-mode). */
function makeNullable(schema: Json): Json {
  if (schema === false) return { type: "null" };
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const s = { ...schema } as { [k: string]: Json };
  if (acceptsNull(s)) return s;
  return { anyOf: [s, { type: "null" }] };
}

function acceptsNull(schema: Json, root: Json = schema, seen = new Set<object>()): boolean {
  if (typeof schema === "boolean") return schema;
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return false;
  if (seen.has(schema)) return true;
  seen.add(schema);
  const s = schema as { [k: string]: Json };
  let allowed = true;

  if (typeof s.type === "string") allowed &&= s.type === "null";
  else if (Array.isArray(s.type)) allowed &&= s.type.includes("null");
  if (Array.isArray(s.enum)) allowed &&= s.enum.includes(null);
  if ("const" in s) allowed &&= s.const === null;
  if (typeof s.$ref === "string") {
    const target = resolveLocalRef(root, s.$ref);
    allowed &&= target !== undefined && acceptsNull(target, root, seen);
  }
  if (Array.isArray(s.allOf)) {
    allowed &&= s.allOf.every((branch) => acceptsNull(branch, root, seen));
  }
  if (Array.isArray(s.anyOf)) {
    allowed &&= s.anyOf.some((branch) => acceptsNull(branch, root, seen));
  }
  if (Array.isArray(s.oneOf)) {
    allowed &&=
      s.oneOf.filter((branch) => acceptsNull(branch, root, new Set(seen))).length === 1;
  }
  if (s.not !== undefined) allowed &&= !acceptsNull(s.not, root, new Set(seen));
  seen.delete(schema);
  return allowed;
}

/**
 * Extract the first balanced top-level JSON object from free text and parse
 * it. Returns undefined when no parseable object exists.
 */
export function extractFirstJsonObject(text: string): Json | undefined {
  let start = text.indexOf("{");
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1)) as Json;
          } catch {
            break; // unbalanced-in-spirit; retry from the next brace
          }
        }
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return undefined;
}
