import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Json } from "./contracts.js";

const options = {
  allErrors: false,
  strict: false,
  validateFormats: false,
} as const;

/** Validate a JSON value against the caller's JSON Schema. */
export function validateAgainstSchema(value: Json, schema: Json, path = "$"): string | null {
  try {
    const dialect =
      schema !== null && typeof schema === "object" && !Array.isArray(schema)
        ? (schema as Record<string, Json>).$schema
        : undefined;
    // A schema belongs to one call. A fresh validator keeps caller-owned $ids
    // and generated validators from accumulating across runs.
    const ajv =
      typeof dialect === "string" && dialect.includes("2020-12")
        ? new Ajv2020(options)
        : typeof dialect === "string" && dialect.includes("2019-09")
          ? new Ajv2019(options)
          : new Ajv(options);
    const validate = ajv.compile(schema as object | boolean);
    if (validate(value)) return null;
    const error = validate.errors?.[0];
    return `${path}${error?.instancePath ?? ""}: ${error?.message ?? "schema validation failed"}`;
  } catch (err) {
    return `${path}: invalid schema: ${err instanceof Error ? err.message : String(err)}`;
  }
}
