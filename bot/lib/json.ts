import type { JsonValue } from "@cursor/bdk";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Drop `undefined` so the value satisfies host KV's JSON type. */
export function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
